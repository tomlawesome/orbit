import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMigrationTestDatabase, runMigrations } from "./support/migration-fixture";

/**
 * #1871: the migration adds `documents.bound_at` (timestamptz, nullable, no
 * default) and backfills it in the same file:
 *  - item_id not null -> bound_at = created_at;
 *  - item_id null, delete_after not null, lifecycle not pending_deletion /
 *    deleted -> a staged upload: stays null;
 *  - every other item_id-null row (hold cleared, or pending_deletion /
 *    deleted) -> bound_at = created_at (treated as kept).
 * Shape of archive-retention-migration-1792.test.ts: seed on the previous
 * schema, then apply the rest.
 */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** The last tag that existed before #1871, whatever the new migration is called. */
const LAST_BEFORE = "0019_sign_in_approval_sends";

async function migrationsBeforeFeature(): Promise<string> {
  const source = resolve(process.cwd(), "drizzle");
  const target = await mkdtemp(join(tmpdir(), "orbit-bound-at-migrations-"));
  cleanups.push(() => rm(target, { recursive: true, force: true }));
  await cp(source, target, { recursive: true });
  const journalPath = join(target, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
  const last = journal.entries.findIndex((entry) => entry.tag === LAST_BEFORE);
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n");
  return target;
}

type Seed = { name: string; itemId: string | null; deleteAfter: string | null; lifecycle: string; createdAt: string };

describe("migration: documents.bound_at (#1871)", () => {
  it("adds a nullable timestamptz column with no default, on a fresh database", async () => {
    const database = await createMigrationTestDatabase("bound_at_fresh");
    cleanups.push(() => database.cleanup());
    await runMigrations(database.url, resolve(process.cwd(), "drizzle"));
    const [column] = await database.client.unsafe(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'bound_at'`,
    );
    expect(column).toBeDefined();
    expect(column.data_type).toBe("timestamp with time zone");
    expect(column.is_nullable).toBe("YES");
    expect(column.column_default, "a default would mark every new staged upload bound").toBeNull();
  });

  it("backfills each row shape: bound and every ambiguous item-less row -> created_at, a live staged hold -> null", async () => {
    // Catches a backfill that leaves kept rows null (they would get a staged hold on restore and be purged)
    // or marks live staged uploads bound (nothing would ever expire them).
    const database = await createMigrationTestDatabase("bound_at_backfill");
    cleanups.push(() => database.cleanup());
    await runMigrations(database.url, await migrationsBeforeFeature());
    const [{ exists }] = await database.client.unsafe(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'bound_at') AS exists`,
    );
    expect(exists, "the seed runs on the schema before the feature").toBe(false);

    const future = "2099-01-01T00:00:00Z";
    const rows: Seed[] = [
      { name: "bound", itemId: randomUUID(), deleteAfter: null, lifecycle: "available", createdAt: "2026-01-01T10:00:00Z" },
      { name: "bound-with-leftover-hold", itemId: randomUUID(), deleteAfter: future, lifecycle: "available", createdAt: "2026-01-02T10:00:00Z" },
      { name: "staged-available", itemId: null, deleteAfter: future, lifecycle: "available", createdAt: "2026-01-03T10:00:00Z" },
      { name: "staged-receiving", itemId: null, deleteAfter: future, lifecycle: "receiving", createdAt: "2026-01-04T10:00:00Z" },
      { name: "kept-orphan-hold-cleared", itemId: null, deleteAfter: null, lifecycle: "available", createdAt: "2026-01-05T10:00:00Z" },
      { name: "ambiguous-pending-deletion", itemId: null, deleteAfter: future, lifecycle: "pending_deletion", createdAt: "2026-01-06T10:00:00Z" },
      { name: "ambiguous-deleted", itemId: null, deleteAfter: null, lifecycle: "deleted", createdAt: "2026-01-07T10:00:00Z" },
    ];
    const householdId = randomUUID();
    await database.client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL session_replication_role = replica`);
      await tx.unsafe(`INSERT INTO "households" (id, name) VALUES ($1, 'Backfill household')`, [householdId]);
      for (const seed of rows) {
        await tx.unsafe(
          `INSERT INTO "documents" ("household_id", "item_id", "display_name", "media_type", "size_bytes", "content_sha256", "lifecycle", "scan_status", "delete_after", "created_at")
           VALUES ($1, $2, $3, 'application/pdf', 128, $4, $5, 'clean', $6, $7)`,
          [householdId, seed.itemId, seed.name, "a".repeat(64), seed.lifecycle, seed.deleteAfter, seed.createdAt],
        );
      }
    });

    await runMigrations(database.url, resolve(process.cwd(), "drizzle"));

    const result = await database.client.unsafe(
      `SELECT display_name AS name, bound_at, created_at FROM "documents" WHERE household_id = $1`, [householdId],
    );
    const byName = new Map(result.map((row) => [row.name as string, row]));
    const expectBound = (name: string) => {
      const row = byName.get(name)!;
      expect(row.bound_at, name).not.toBeNull();
      expect((row.bound_at as Date).getTime(), `${name} bound_at equals created_at`).toBe((row.created_at as Date).getTime());
    };
    for (const name of ["bound", "bound-with-leftover-hold", "kept-orphan-hold-cleared", "ambiguous-pending-deletion", "ambiguous-deleted"]) {
      expectBound(name);
    }
    expect(byName.get("staged-available")!.bound_at, "a live staged hold stays unclaimed").toBeNull();
    expect(byName.get("staged-receiving")!.bound_at, "a live staged hold stays unclaimed").toBeNull();
  });
});
