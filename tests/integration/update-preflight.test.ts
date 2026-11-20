import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sql as drizzleSql } from "drizzle-orm";
import { getDb } from "@/db";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { CONTRACT_PRECONDITIONS, runUpdatePreflight, type ContractPrecondition } from "../../src/db/contract-preconditions";
import { createMigrationTestDatabase, runMigrations } from "./support/migration-fixture";

/* #1779, build note 58520 (A): `orbit update --preflight` asks the live
   database whether the release's contract migrations would refuse. The engine
   command calls `runUpdatePreflight` from src/db/contract-preconditions.ts with
   a query port (SQL in, rows of text cells out) and the migrations folder. A
   precondition is checked only when its migration ships in the image's folder and is not applied (#1854 A-R1).
   No drop migration exists in this change, so the "already applied" case is
   shown with a fake entry whose tag IS applied and whose SQL would fail. */

const MIGRATIONS = resolve(process.cwd(), "drizzle");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Database = Awaited<ReturnType<typeof createMigrationTestDatabase>>;

async function migrated(name: string, folder = MIGRATIONS): Promise<Database> {
  const database = await createMigrationTestDatabase(name);
  cleanups.push(() => database.cleanup());
  await runMigrations(database.url, folder);
  return database;
}

function portOf(database: Database, issued: string[] = []) {
  return async (sql: string): Promise<string[][]> => {
    issued.push(sql);
    const rows = await database.client.unsafe(sql).values();
    return rows.map((row) => row.map((cell) => String(cell)));
  };
}

async function household(database: Database): Promise<string> {
  const [{ id }] = await database.client.unsafe(`INSERT INTO "households" ("name") VALUES ('Preflight') RETURNING "id"`);
  return String(id);
}

async function document(database: Database, householdId: string, plain: string | null, sealed: string | null) {
  await database.client.unsafe(
    `INSERT INTO "documents" ("id", "household_id", "display_name", "media_type", "size_bytes", "content_sha256", "content_sha256_sealed")
     VALUES ($1, $2, 'a.pdf', 'application/pdf', 10, $3, $4)`,
    [randomUUID(), householdId, plain, sealed],
  );
}

async function folderWithExtraMigration(tag: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "orbit-preflight-extra-"));
  cleanups.push(() => rm(folder, { recursive: true, force: true }));
  await cp(MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ idx: number; when: number; tag: string; version?: string; breakpoints?: boolean }> };
  const last = journal.entries[journal.entries.length - 1];
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag });
  await writeFile(journalPath, JSON.stringify(journal));
  await writeFile(join(folder, `${tag}.sql`), "SELECT 1;\n");
  return folder;
}

/** A folder that ships the real contract's migration, as the release carrying the drop would. */
const shippedContractFolder = () => folderWithExtraMigration(CONTRACT_PRECONDITIONS[0].migrationTag);

describe("runUpdatePreflight on a real database (#1779)", () => {
  it("is blocked, rows=1, for a migrated database holding one plain-hashed document", async () => {
    const database = await migrated("preflight_plain");
    const home = await household(database);
    await document(database, home, "a".repeat(64), null);
    await document(database, home, null, "mdv1.a.b.c");
    const result = await runUpdatePreflight({ query: portOf(database), migrationsFolder: await shippedContractFolder() });
    expect(result.ready).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toBe("update-preflight: blocked documents.content_sha256 rows=1");
    expect(result.lines.length, "the remedy follows on further lines").toBeGreaterThan(1);
  });

  it("counts every plain row", async () => {
    const database = await migrated("preflight_plain_many");
    const home = await household(database);
    for (let index = 0; index < 3; index += 1) await document(database, home, `${index}`.repeat(64).slice(0, 64), null);
    const result = await runUpdatePreflight({ query: portOf(database), migrationsFolder: await shippedContractFolder() });
    expect(result.lines[0]).toBe("update-preflight: blocked documents.content_sha256 rows=3");
  });

  it("is ready when every row is sealed or has no plain hash", async () => {
    const database = await migrated("preflight_sealed");
    const home = await household(database);
    await document(database, home, null, "mdv1.a.b.c");
    await document(database, home, null, null);
    const result = await runUpdatePreflight({ query: portOf(database), migrationsFolder: MIGRATIONS });
    expect(result).toMatchObject({ ready: true, exitCode: 0, lines: ["update-preflight: ready"] });
  });

  it("is ready on an empty documents table", async () => {
    const database = await migrated("preflight_empty");
    const result = await runUpdatePreflight({ query: portOf(database), migrationsFolder: MIGRATIONS });
    expect(result.lines).toEqual(["update-preflight: ready"]);
  });

  it("is ready when the journal is behind by other migrations and no row is plain", async () => {
    const behind = await mkdtemp(join(tmpdir(), "orbit-preflight-behind-"));
    cleanups.push(() => rm(behind, { recursive: true, force: true }));
    await cp(MIGRATIONS, behind, { recursive: true });
    const journalPath = join(behind, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: unknown[] };
    journal.entries = journal.entries.slice(0, -1);
    await writeFile(journalPath, JSON.stringify(journal));
    const database = await migrated("preflight_behind", behind);
    const [{ count }] = await database.client.unsafe(`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`);
    expect(Number(count)).toBe(journal.entries.length);
    const result = await runUpdatePreflight({ query: portOf(database), migrationsFolder: MIGRATIONS });
    expect(result.lines).toEqual(["update-preflight: ready"]);
  });

  it("writes nothing: every statement it sends is a read, and the rows are untouched", async () => {
    const database = await migrated("preflight_readonly");
    const home = await household(database);
    await document(database, home, "c".repeat(64), null);
    const issued: string[] = [];
    await runUpdatePreflight({ query: portOf(database, issued), migrationsFolder: await shippedContractFolder() });
    expect(issued.some((sql) => sql.includes("content_sha256"))).toBe(true);
    for (const sql of issued) expect(sql.trim()).toMatch(/^(SELECT|WITH|SHOW)\b/iu);
    for (const sql of issued) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/iu);
    const [row] = await database.client.unsafe(`SELECT content_sha256 FROM documents`);
    expect(row.content_sha256).toBe("c".repeat(64));
  });

  it("skips a precondition whose migration tag is already in the journal, without running its SQL", async () => {
    const database = await migrated("preflight_applied_tag");
    const journal = JSON.parse(await readFile(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    const applied: ContractPrecondition = {
      migrationTag: journal.entries[0].tag,
      column: "gone_table.gone_column",
      description: "a column whose drop is already applied",
      pendingSql: "SELECT count(*) FROM gone_table WHERE gone_column IS NOT NULL",
      remedy: ["never shown"],
    };
    const issued: string[] = [];
    const result = await runUpdatePreflight({ query: portOf(database, issued), migrationsFolder: MIGRATIONS, preconditions: [applied] });
    expect(result.lines).toEqual(["update-preflight: ready"]);
    expect(issued.some((sql) => sql.includes("gone_table"))).toBe(false);
  });

  const plainHashPrecondition = (migrationTag: string): ContractPrecondition => ({
    migrationTag,
    column: "documents.content_sha256",
    description: "plain hashes",
    pendingSql: "SELECT count(*) FROM documents WHERE content_sha256 IS NOT NULL",
    remedy: ["wait for the running version to finish"],
  });

  it("checks a precondition whose migration ships in this image but is not applied yet, and blocks on its count", async () => {
    const database = await migrated("preflight_pending_tag");
    const home = await household(database);
    await document(database, home, "d".repeat(64), null);
    const tag = "9999_pending_contract";
    const folder = await folderWithExtraMigration(tag);
    const result = await runUpdatePreflight({ query: portOf(database), migrationsFolder: folder, preconditions: [plainHashPrecondition(tag)] });
    expect(result.lines[0]).toBe("update-preflight: blocked documents.content_sha256 rows=1");
    expect(result.lines).toContain("wait for the running version to finish");
  });

  it("skips a precondition whose tag is in no migration in the folder, even with pending rows, and never issues its SQL", async () => {
    const database = await migrated("preflight_unshipped_tag");
    const home = await household(database);
    await document(database, home, "e".repeat(64), null);
    const issued: string[] = [];
    const result = await runUpdatePreflight({
      query: portOf(database, issued),
      migrationsFolder: MIGRATIONS,
      preconditions: [plainHashPrecondition("9999_not_in_this_image")],
    });
    expect(result.lines).toEqual(["update-preflight: ready"]);
    expect(issued.some((sql) => sql.includes("content_sha256"))).toBe(false);
  });

  it("ships a precondition for documents.content_sha256", () => {
    expect(CONTRACT_PRECONDITIONS.map((entry) => entry.column)).toContain("documents.content_sha256");
    const entry = CONTRACT_PRECONDITIONS.find((candidate) => candidate.column === "documents.content_sha256")!;
    expect(entry.pendingSql).toMatch(/content_sha256\s+IS\s+NOT\s+NULL/iu);
    expect(entry.remedy.length).toBeGreaterThan(0);
  });
});

/* #1931 (ruling #1779 note 67344, item 4): one predicate, `content_sha256 IS NOT NULL`, no regex.
   A damaged plain value blocks the preflight until a maintenance cycle has reported and cleared it. This runs
   against the integration database, the one the maintenance cycle works on. */
describe("a damaged plain document hash and the preflight (#1931)", () => {
  it("is blocked, rows=1, while a document holds 'not-a-hash', and ready once a maintenance cycle has run", async () => {
    const folder = await shippedContractFolder();
    const query = async (text: string): Promise<string[][]> => {
      const rows = await getDb().execute(drizzleSql.raw(text));
      return [...rows].map((row) => Object.values(row as Record<string, unknown>).map((cell) => String(cell)));
    };
    const fixture = await createIntegrationFixture("preflight-damaged-hash");
    const { runDocumentMaintenanceCycle } = await import("@/server/document-worker");
    await getDb().execute(drizzleSql`delete from documents where content_sha256 is not null`);
    const householdId = fixture.household.id;
    const documentId = randomUUID();
    try {
      await getDb().execute(drizzleSql`
        insert into documents (id, household_id, display_name, media_type, size_bytes, content_sha256)
        values (${documentId}, ${householdId}, 'a.pdf', 'application/pdf', 10, 'not-a-hash')`);
      const blocked = await runUpdatePreflight({ query, migrationsFolder: folder });
      expect(blocked.ready).toBe(false);
      expect(blocked.lines[0]).toBe("update-preflight: blocked documents.content_sha256 rows=1");

      for (let guard = 0; guard < 20; guard += 1) {
        await runDocumentMaintenanceCycle();
        const rows = await getDb().execute<{ n: number }>(drizzleSql`select count(*)::int as n from documents where content_sha256 is not null`);
        if (Number(rows[0]!.n) === 0) break;
      }
      const ready = await runUpdatePreflight({ query, migrationsFolder: folder });
      expect(ready).toMatchObject({ ready: true, exitCode: 0, lines: ["update-preflight: ready"] });
    } finally {
      await getDb().execute(drizzleSql`delete from documents where id = ${documentId}`);
      await fixture.cleanup();
      await cleanupIntegrationEnvironment();
    }
  });

  it("the remedy says that a value Orbit cannot read is reported and cleared by the background work", () => {
    const entry = CONTRACT_PRECONDITIONS.find((candidate) => candidate.column === "documents.content_sha256")!;
    expect(entry.remedy.join(" ")).toMatch(/clear/iu);
  });
});
