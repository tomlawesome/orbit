import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_PRECONDITIONS, runUpdatePreflight, type ContractPrecondition } from "../../src/db/contract-preconditions";
import { createMigrationTestDatabase, runMigrations } from "./support/migration-fixture";

/* #1779, build note 58520 (A): `orbit update --preflight` asks the live
   database whether the release's contract migrations would refuse. The engine
   command calls `runUpdatePreflight` from src/db/contract-preconditions.ts with
   a query port (SQL in, rows of text cells out) and the migrations folder. A
   precondition is checked only while its migration tag is not in the journal.
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

describe("runUpdatePreflight on a real database (#1779)", () => {
  it("is blocked, rows=1, for a migrated database holding one plain-hashed document", async () => {
    const database = await migrated("preflight_plain");
    const home = await household(database);
    await document(database, home, "a".repeat(64), null);
    await document(database, home, null, "mdv1.a.b.c");
    const result = await runUpdatePreflight({ query: portOf(database), migrationsFolder: MIGRATIONS });
    expect(result.ready).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toBe("update-preflight: blocked documents.content_sha256 rows=1");
    expect(result.lines.length, "the remedy follows on further lines").toBeGreaterThan(1);
  });

  it("counts every plain row", async () => {
    const database = await migrated("preflight_plain_many");
    const home = await household(database);
    for (let index = 0; index < 3; index += 1) await document(database, home, `${index}`.repeat(64).slice(0, 64), null);
    const result = await runUpdatePreflight({ query: portOf(database), migrationsFolder: MIGRATIONS });
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
    await runUpdatePreflight({ query: portOf(database, issued), migrationsFolder: MIGRATIONS });
    expect(issued.length).toBeGreaterThan(0);
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

  it("still checks a precondition whose tag is not in the journal, and blocks on its count", async () => {
    const database = await migrated("preflight_pending_tag");
    const home = await household(database);
    await document(database, home, "d".repeat(64), null);
    const pending: ContractPrecondition = {
      migrationTag: "9999_not_yet_applied",
      column: "documents.content_sha256",
      description: "plain hashes",
      pendingSql: "SELECT count(*) FROM documents WHERE content_sha256 IS NOT NULL",
      remedy: ["wait for the running version to finish"],
    };
    const result = await runUpdatePreflight({ query: portOf(database), migrationsFolder: MIGRATIONS, preconditions: [pending] });
    expect(result.lines[0]).toBe("update-preflight: blocked documents.content_sha256 rows=1");
    expect(result.lines).toContain("wait for the running version to finish");
  });

  it("ships a precondition for documents.content_sha256", () => {
    expect(CONTRACT_PRECONDITIONS.map((entry) => entry.column)).toContain("documents.content_sha256");
    const entry = CONTRACT_PRECONDITIONS.find((candidate) => candidate.column === "documents.content_sha256")!;
    expect(entry.pendingSql).toMatch(/content_sha256\s+IS\s+NOT\s+NULL/iu);
    expect(entry.remedy.length).toBeGreaterThan(0);
  });
});
