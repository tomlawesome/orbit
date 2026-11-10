import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMigrationTestDatabase, runMigrations } from "./support/migration-fixture";

/**
 * #1792 (spec-security-fixes.md 2.2, L17): migration 0013 creates
 * `instance_archive_retention`, a singleton row holding the three export
 * settings (null = the default), with CHECKs repeating the allowed ranges,
 * seeded with all three null and version 1 in the same migration. No audit
 * row is written by the migration. Shape of mail-limit-migration-1388.test.ts.
 */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const GIB = 1_073_741_824;
/** The last tag that existed before #1792, whatever the new migration is called. */
const LAST_BEFORE = "0012_archive_import_lease";

async function migrationsBeforeFeature(): Promise<string> {
  const source = resolve(process.cwd(), "drizzle");
  const target = await mkdtemp(join(tmpdir(), "orbit-archive-retention-migrations-"));
  cleanups.push(() => rm(target, { recursive: true, force: true }));
  await cp(source, target, { recursive: true });
  const journalPath = join(target, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
  const last = journal.entries.findIndex((entry) => entry.tag === LAST_BEFORE);
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n");
  return target;
}

const SELECT_ROW = `SELECT "retention_hours", "max_per_household", "max_total_bytes", "version" FROM "instance_archive_retention"`;
const SEEDED = [{ retention_hours: null, max_per_household: null, max_total_bytes: null, version: "1" }];

describe("migration: instance_archive_retention (#1792)", () => {
  it("is journal entry 13, right after 0012_archive_import_lease", async () => {
    // Catches the migration missing from the journal (it would never run).
    const journal = JSON.parse(await readFile(resolve(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    const at = journal.entries.findIndex((entry) => entry.tag === LAST_BEFORE);
    expect(journal.entries[at + 1]).toMatchObject({ idx: 13, tag: "0013_archive_retention" });
  });

  it("upgrades an install on 0012 to exactly one row, all three settings null, version 1, and writes no audit row", async () => {
    // Catches a migration that seeds nothing (every read would be the missing-row 500) or seeds values (the defaults could never follow the quota).
    const database = await createMigrationTestDatabase("archive_retention_upgrade");
    cleanups.push(() => database.cleanup());
    await runMigrations(database.url, await migrationsBeforeFeature());
    await runMigrations(database.url, resolve(process.cwd(), "drizzle"));
    expect(await database.client.unsafe(SELECT_ROW)).toEqual(SEEDED);
    const audits = await database.client.unsafe(`SELECT 1 FROM "audit_log" WHERE "entity_type" = 'instance_archive_retention' OR "action" LIKE 'instance_archive_retention%'`);
    expect(audits).toHaveLength(0);
  });

  it("seeds exactly one row on a fresh database", async () => {
    const database = await createMigrationTestDatabase("archive_retention_fresh");
    cleanups.push(() => database.cleanup());
    await runMigrations(database.url, resolve(process.cwd(), "drizzle"));
    expect(await database.client.unsafe(SELECT_ROW)).toEqual(SEEDED);
    const [row] = await database.client.unsafe(`SELECT "id", "updated_at" FROM "instance_archive_retention"`);
    expect(row.id, "an id for audit_log.entity_id").toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("refuses values outside the allowed ranges with its CHECKs, and accepts the ends of each range", async () => {
    // Catches a table that would hold a setting the engine cannot honour.
    const database = await createMigrationTestDatabase("archive_retention_checks");
    cleanups.push(() => database.cleanup());
    await runMigrations(database.url, resolve(process.cwd(), "drizzle"));
    const set = (column: string, value: number) => database.client.unsafe(`UPDATE "instance_archive_retention" SET "${column}" = $1`, [value]);

    for (const [column, value] of [
      ["retention_hours", 0], ["retention_hours", 721],
      ["max_per_household", 0], ["max_per_household", 11],
      ["max_total_bytes", GIB - 1], ["max_total_bytes", 102_400 * GIB + 1],
    ] as const) {
      await expect(set(column, value), `${column} = ${value}`).rejects.toThrow(/check/iu);
    }
    for (const [column, value] of [
      ["retention_hours", 1], ["retention_hours", 720],
      ["max_per_household", 1], ["max_per_household", 10],
      ["max_total_bytes", GIB], ["max_total_bytes", 102_400 * GIB],
    ] as const) {
      await expect(set(column, value), `${column} = ${value}`).resolves.toBeDefined();
    }
  });

  it("is a singleton: a second row is refused", async () => {
    const database = await createMigrationTestDatabase("archive_retention_singleton");
    cleanups.push(() => database.cleanup());
    await runMigrations(database.url, resolve(process.cwd(), "drizzle"));
    await expect(database.client.unsafe(`INSERT INTO "instance_archive_retention" DEFAULT VALUES`)).rejects.toThrow();
    expect(await database.client.unsafe(SELECT_ROW)).toHaveLength(1);
  });
});
