import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMigrationTestDatabase, runMigrations } from "./support/migration-fixture";

/**
 * #1390 review round, ruling 10: migration 0012 (the import lease column and
 * `portable_archives.size_bytes` widened to bigint) runs on a database that
 * already holds portable_archives and portable_archive_imports rows, and the
 * values survive. Pattern: mail-limit-migration-1388.test.ts, an install on
 * the prior schema, then upgraded. The prior schema is the checked-in folder
 * cut off after 0011 (the stacked #1771 migration; 0012 is this one).
 */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** The last tag before the archive-lease migration. */
const LAST_BEFORE = "0011_document_content_hash_sealed";
const INT4_MAX = 2_147_483_647;

async function migrationsBeforeFeature(): Promise<string> {
  const source = resolve(process.cwd(), "drizzle");
  const target = await mkdtemp(join(tmpdir(), "orbit-archive-lease-migrations-"));
  cleanups.push(() => rm(target, { recursive: true, force: true }));
  await cp(source, target, { recursive: true });
  const journalPath = join(target, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
  const last = journal.entries.findIndex((entry) => entry.tag === LAST_BEFORE);
  expect(last, `${LAST_BEFORE} is in the journal`).toBeGreaterThanOrEqual(0);
  expect(journal.entries.length, "there is a migration after it to test").toBeGreaterThan(last + 1);
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n");
  return target;
}

describe("migration 0012 on a database that already holds archive rows (#1390 ruling 10)", () => {
  it("keeps every value of existing portable_archives and portable_archive_imports rows, leaves lease_renewed_at null, and widens size_bytes", async () => {
    // Catches a migration that rewrites, defaults or drops existing rows (the column type change rewrites the table).
    const database = await createMigrationTestDatabase("archive_lease_existing");
    cleanups.push(() => database.cleanup());
    await runMigrations(database.url, await migrationsBeforeFeature());
    const sql = database.client;

    const [{ id: householdId }] = await sql.unsafe(`INSERT INTO "households" ("name") VALUES ('Archive lease') RETURNING "id"`);
    const [{ id: userId }] = await sql.unsafe(`INSERT INTO "users" ("display_name") VALUES ('Archivist') RETURNING "id"`);

    const archives = [
      { key: "archive-key-small", sha: "a".repeat(64), size: 1, documents: false },
      { key: "archive-key-max-int4", sha: "b".repeat(64), size: INT4_MAX, documents: true },
    ];
    for (const archive of archives) {
      await sql.unsafe(
        `INSERT INTO "portable_archives" ("household_id", "requested_by_user_id", "storage_key", "content_sha256", "size_bytes", "includes_documents", "expires_at", "downloaded_at", "purged_at")
         VALUES ($1, $2, $3, $4, $5, $6, '2030-01-02T03:04:05Z', '2030-01-01T00:00:00Z', NULL)`,
        [householdId, userId, archive.key, archive.sha, archive.size, archive.documents],
      );
    }
    const sectionId = "11111111-1111-4111-8111-111111111111";
    const itemId = "22222222-2222-4222-8222-222222222222";
    const imports = [
      { outcome: "completed", finished: "2030-01-01T01:00:00Z", sections: [sectionId], items: [itemId] },
      { outcome: null, finished: null, sections: [], items: [] },
      { outcome: "rolled_back", finished: "2030-01-01T02:00:00Z", sections: [], items: [itemId] },
    ];
    for (const [index, row] of imports.entries()) {
      await sql.unsafe(
        `INSERT INTO "portable_archive_imports" ("household_id", "actor_user_id", "started_at", "finished_at", "outcome", "created_section_ids", "created_item_ids")
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [householdId, userId, `2030-01-01T0${index}:00:00Z`, row.finished, row.outcome, row.sections, row.items],
      );
    }
    const archivesBefore = await sql.unsafe(`SELECT "id", "storage_key", "content_sha256", "size_bytes"::text AS size_bytes, "includes_documents", "expires_at", "downloaded_at", "purged_at", "created_at" FROM "portable_archives" ORDER BY "storage_key"`);
    const importsBefore = await sql.unsafe(`SELECT "id", "started_at", "finished_at", "outcome", "created_section_ids", "created_item_ids" FROM "portable_archive_imports" ORDER BY "started_at"`);
    expect(archivesBefore).toHaveLength(2);
    expect(importsBefore).toHaveLength(3);

    await runMigrations(database.url, resolve(process.cwd(), "drizzle"));

    const archivesAfter = await sql.unsafe(`SELECT "id", "storage_key", "content_sha256", "size_bytes"::text AS size_bytes, "includes_documents", "expires_at", "downloaded_at", "purged_at", "created_at" FROM "portable_archives" ORDER BY "storage_key"`);
    expect(archivesAfter, "portable_archives rows are unchanged, size_bytes value included").toEqual(archivesBefore);
    const importsAfter = await sql.unsafe(`SELECT "id", "started_at", "finished_at", "outcome", "created_section_ids", "created_item_ids" FROM "portable_archive_imports" ORDER BY "started_at"`);
    expect(importsAfter, "portable_archive_imports rows are unchanged").toEqual(importsBefore);

    const leases = await sql.unsafe(`SELECT "lease_renewed_at" FROM "portable_archive_imports"`);
    expect(leases.every((row) => row.lease_renewed_at === null), "existing rows have no heartbeat yet (null, read from started_at)").toBe(true);
    const [column] = await sql.unsafe(`SELECT data_type FROM information_schema.columns WHERE table_name = 'portable_archives' AND column_name = 'size_bytes'`);
    expect(column.data_type).toBe("bigint");
    // The widened column takes a household-sized archive, and the old rows still read as numbers.
    await sql.unsafe(
      `INSERT INTO "portable_archives" ("household_id", "requested_by_user_id", "storage_key", "content_sha256", "size_bytes", "expires_at") VALUES ($1, $2, 'archive-key-5gib', $3, 5368709137, now())`,
      [householdId, userId, "c".repeat(64)],
    );
    const [big] = await sql.unsafe(`SELECT "size_bytes"::text AS size_bytes FROM "portable_archives" WHERE "storage_key" = 'archive-key-5gib'`);
    expect(big.size_bytes).toBe("5368709137");
  }, 120_000);
});
