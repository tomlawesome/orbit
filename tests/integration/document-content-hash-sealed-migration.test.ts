import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMigrationTestDatabase, runMigrations } from "./support/migration-fixture";

/* #1771, build note 55084, "Expand": one migration adds
   `documents.content_sha256_sealed` (text, nullable) and makes
   `documents.content_sha256` nullable. The plaintext column stays: dropping it
   is the later contract release, and the migration never moves data, because
   sealing needs the household key, which SQL does not have.
   The migration number is not fixed, so it is found by the column it adds. */

const MIGRATIONS = resolve(process.cwd(), "drizzle");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function sealingMigration(): Promise<{ tag: string; sql: string } | undefined> {
  for (const name of (await readdir(MIGRATIONS)).filter((file) => file.endsWith(".sql")).sort()) {
    const sql = await readFile(join(MIGRATIONS, name), "utf8");
    if (/content_sha256_sealed/u.test(sql)) return { tag: name.replace(/\.sql$/u, ""), sql };
  }
  return undefined;
}

async function requireSealingMigration() {
  const found = await sealingMigration();
  expect(found, "a migration in drizzle/ adds documents.content_sha256_sealed").toBeDefined();
  return found!;
}

async function migrated(name: string) {
  const database = await createMigrationTestDatabase(name);
  cleanups.push(() => database.cleanup());
  await runMigrations(database.url, MIGRATIONS);
  return database;
}

async function columnOf(database: Awaited<ReturnType<typeof migrated>>, column: string) {
  const [row] = await database.client.unsafe(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = $1`,
    [column],
  );
  return row;
}

async function insertHousehold(database: Awaited<ReturnType<typeof migrated>>): Promise<string> {
  const [{ id }] = await database.client.unsafe(`INSERT INTO "households" ("name") VALUES ('Sealed hash') RETURNING "id"`);
  return String(id);
}

async function insertDocument(database: Awaited<ReturnType<typeof migrated>>, householdId: string, plain: string | null, sealed?: string | null) {
  const id = randomUUID();
  if (sealed === undefined) {
    await database.client.unsafe(
      `INSERT INTO "documents" ("id", "household_id", "display_name", "media_type", "size_bytes", "content_sha256")
       VALUES ($1, $2, 'a.pdf', 'application/pdf', 10, $3)`,
      [id, householdId, plain],
    );
  } else {
    await database.client.unsafe(
      `INSERT INTO "documents" ("id", "household_id", "display_name", "media_type", "size_bytes", "content_sha256", "content_sha256_sealed")
       VALUES ($1, $2, 'a.pdf', 'application/pdf', 10, $3, $4)`,
      [id, householdId, plain, sealed],
    );
  }
  return id;
}

describe("the expand migration for sealed content hashes (#1771)", () => {
  it("is one migration, found by the column it adds, and it is in the journal", async () => {
    const found = await requireSealingMigration();
    const journal = JSON.parse(await readFile(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    expect(journal.entries.map((entry) => entry.tag)).toContain(found.tag);
  });

  it("adds documents.content_sha256_sealed as a nullable text column with no default", async () => {
    const database = await migrated("sealed_hash_column");
    const column = await columnOf(database, "content_sha256_sealed");
    expect(column, "the column exists").toBeDefined();
    expect(column.data_type).toBe("text");
    expect(column.is_nullable).toBe("YES");
    expect(column.column_default).toBeNull();
  });

  it("makes documents.content_sha256 nullable, and keeps it: the drop is a later release", async () => {
    const database = await migrated("sealed_hash_plain_nullable");
    const plain = await columnOf(database, "content_sha256");
    expect(plain, "the plaintext column is still there in this release").toBeDefined();
    expect(plain.data_type).toBe("text");
    expect(plain.is_nullable).toBe("YES");
  });

  it("accepts a new-style row (sealed, no plain), an old-style row (plain, no sealed), and both", async () => {
    const database = await migrated("sealed_hash_row_shapes");
    const household = await insertHousehold(database);
    const sealedOnly = await insertDocument(database, household, null, "mdv1.a.b.c");
    const plainOnly = await insertDocument(database, household, "a".repeat(64));
    const both = await insertDocument(database, household, "b".repeat(64), "mdv1.d.e.f");
    const rows = await database.client.unsafe(
      `SELECT id, content_sha256 AS plain, content_sha256_sealed AS sealed FROM documents WHERE household_id = $1`, [household]);
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    expect(byId.get(sealedOnly)).toMatchObject({ plain: null, sealed: "mdv1.a.b.c" });
    expect(byId.get(plainOnly)).toMatchObject({ plain: "a".repeat(64), sealed: null });
    expect(byId.get(both)).toMatchObject({ plain: "b".repeat(64), sealed: "mdv1.d.e.f" });
  });

  it("keeps the blind index and its lookup index", async () => {
    const database = await migrated("sealed_hash_keeps_index");
    expect(await columnOf(database, "content_index")).toBeDefined();
    const [index] = await database.client.unsafe(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'documents' AND indexname = 'document_household_content_index_idx'`);
    expect(index).toBeDefined();
  });

  it("moves no data: it has no UPDATE, no INSERT, no DELETE and drops nothing, because SQL cannot seal", async () => {
    const { sql } = await requireSealingMigration();
    const statements = sql.replace(/--.*$/gmu, "");
    expect(statements).not.toMatch(/\bUPDATE\b/iu);
    expect(statements).not.toMatch(/\bINSERT\b/iu);
    expect(statements).not.toMatch(/\bDELETE\b/iu);
    expect(statements).not.toMatch(/\bDROP\s+COLUMN\b/iu);
    expect(statements).not.toMatch(/\bDROP\s+TABLE\b/iu);
  });

  it("applied over a database that already holds documents, leaves every plain hash exactly as it was and seals none", async () => {
    const found = await requireSealingMigration();
    /* The journal as it stood before this migration, so the upgrade is a real one. */
    const before = await mkdtemp(join(tmpdir(), "orbit-sealed-hash-before-"));
    cleanups.push(() => rm(before, { recursive: true, force: true }));
    await cp(MIGRATIONS, before, { recursive: true });
    const journalPath = join(before, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
    const index = journal.entries.findIndex((entry) => entry.tag === found.tag);
    expect(index, "the migration is in the journal").toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, index);
    await writeFile(journalPath, JSON.stringify(journal));

    const database = await createMigrationTestDatabase("sealed_hash_upgrade");
    cleanups.push(() => database.cleanup());
    await runMigrations(database.url, before);
    expect(await columnOf(database as never, "content_sha256_sealed")).toBeUndefined();
    const household = await insertHousehold(database as never);
    const kept = [randomUUID(), randomUUID()];
    for (const [position, id] of kept.entries()) {
      await database.client.unsafe(
        `INSERT INTO "documents" ("id", "household_id", "display_name", "media_type", "size_bytes", "content_sha256")
         VALUES ($1, $2, 'old.pdf', 'application/pdf', 10, $3)`,
        [id, household, String(position).repeat(64)],
      );
    }

    await runMigrations(database.url, MIGRATIONS);

    const rows = await database.client.unsafe(
      `SELECT id, content_sha256 AS plain, content_sha256_sealed AS sealed FROM documents WHERE household_id = $1 ORDER BY content_sha256`, [household]);
    expect(rows.map((row) => row.plain)).toEqual(["0".repeat(64), "1".repeat(64)]);
    expect(rows.every((row) => row.sealed === null), "sealing is the backfill's job, never the migration's").toBe(true);
  });
});
