import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_PRECONDITIONS, runUpdatePreflight } from "../../src/db/contract-preconditions";
import { createMigrationTestDatabase, runMigrations } from "./support/migration-fixture";

/* #1932, spec: #1811 ruling (note 67362) item 3. CONTRACT_PRECONDITIONS gains
   an entry, printed as `imap_ingestion_attachments.purge_pending`, counting
   `assigned` + `purge_pending` attachments whose document is `scanning`,
   `rejected` or missing. The marker migration (#1811 part C) does not exist,
   so the entry's tag is read from the entry and a stand-in migration with that
   tag is added to a copy of the migrations folder, as update-preflight.test.ts
   does for the first entry. */

const MIGRATIONS = resolve(process.cwd(), "drizzle");
const COLUMN = "imap_ingestion_attachments.purge_pending";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Database = Awaited<ReturnType<typeof createMigrationTestDatabase>>;

const entry = () => CONTRACT_PRECONDITIONS.find((candidate) => candidate.column === COLUMN);

async function folderWithMarker(): Promise<string> {
  const tag = entry()?.migrationTag;
  expect(tag, `CONTRACT_PRECONDITIONS has an entry for ${COLUMN}`).toBeTruthy();
  const folder = await mkdtemp(join(tmpdir(), "orbit-preflight-settle-"));
  cleanups.push(() => rm(folder, { recursive: true, force: true }));
  await cp(MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ idx: number; when: number; tag: string }> };
  const last = journal.entries[journal.entries.length - 1];
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag: tag! });
  await writeFile(journalPath, JSON.stringify(journal));
  await writeFile(join(folder, `${tag}.sql`), "SELECT 1;\n");
  return folder;
}

async function migrated(name: string, folder = MIGRATIONS): Promise<Database> {
  const database = await createMigrationTestDatabase(name);
  cleanups.push(() => database.cleanup());
  await runMigrations(database.url, folder);
  return database;
}

const portOf = (database: Database) => async (sql: string): Promise<string[][]> =>
  (await database.client.unsafe(sql).values()).map((row) => row.map((cell) => String(cell)));

type DocumentState = "scanning" | "rejected" | "available" | "missing";

/** One mailbox attachment `assigned` + `purge_pending`, whose document is in the given state. */
async function seedTransfer(database: Database, documentState: DocumentState): Promise<void> {
  const [{ id: householdId }] = await database.client.unsafe(`INSERT INTO "households" ("name") VALUES ('Settle') RETURNING "id"`);
  const messageId = randomUUID();
  await database.client.unsafe(
    `INSERT INTO "imap_ingestion_messages" ("id", "mailbox", "mailbox_uid_validity", "mailbox_uid", "recipient_alias_sha256", "household_id", "expires_at", "status")
     VALUES ($1, 'private', 'v', 1, 'alias', $2, now() + interval '1 day', 'recoverable')`,
    [messageId, householdId],
  );
  const documentId = randomUUID();
  await database.client.unsafe(
    `INSERT INTO "documents" ("id", "household_id", "display_name", "media_type", "size_bytes", "lifecycle", "scan_status")
     VALUES ($1, $2, 'a.pdf', 'application/pdf', 10, $3::document_lifecycle, $4::document_scan_status)`,
    [documentId, householdId, documentState === "missing" ? "rejected" : documentState, documentState === "available" ? "clean" : "error"],
  );
  await database.client.unsafe(
    `INSERT INTO "imap_ingestion_attachments" ("id", "message_id", "display_name", "media_type", "size_bytes", "storage_key", "ciphertext_size", "envelope_version", "content_iv", "content_auth_tag", "wrapped_dek", "wrap_iv", "wrap_auth_tag", "key_id", "status", "assigned_document_id", "purge_pending")
     VALUES ($1, $2, 'a.pdf', 'application/pdf', 10, $3, 10, 1, 'iv', 'tag', 'dek', 'wiv', 'wtag', 'key', 'assigned', $4, true)`,
    [randomUUID(), messageId, `held/${randomUUID()}`, documentId],
  );
  // Deleting the document row nulls the attachment's link (ON DELETE SET NULL): the "no row" case.
  if (documentState === "missing") await database.client.unsafe(`DELETE FROM "documents" WHERE "id" = $1`, [documentId]);
}

describe("update preflight: stuck mail transfers (#1932, #1811 item 3)", () => {
  it("ships an entry printed as imap_ingestion_attachments.purge_pending with a remedy", () => {
    const found = entry();
    expect(found).toBeDefined();
    expect(found!.remedy.join(" ")).toContain("Leave Orbit running with the scanner reachable and run the update again later.");
  });

  for (const state of ["scanning", "rejected", "missing"] as const) {
    it(`is blocked, rows=1, for an assigned/purge_pending attachment whose document is ${state}`, async () => {
      const database = await migrated(`settle_blocked_${state}`);
      await seedTransfer(database, state);
      const result = await runUpdatePreflight({ query: portOf(database), migrationsFolder: await folderWithMarker() });
      expect(result.ready).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.lines[0]).toBe(`update-preflight: blocked ${COLUMN} rows=1`);
      expect(result.lines.length).toBeGreaterThan(1);
    });
  }

  it("is ready for an assigned/purge_pending attachment whose document is available (the purge-failed shape)", async () => {
    const database = await migrated("settle_available");
    await seedTransfer(database, "available");
    const result = await runUpdatePreflight({ query: portOf(database), migrationsFolder: await folderWithMarker() });
    expect(result).toMatchObject({ ready: true, exitCode: 0, lines: ["update-preflight: ready"] });
  });

  it("is ready once the entry's migration tag is in the journal, even with a stuck row", async () => {
    // Stands in for "ready once the migration tag is in the journal": the marker
    // migration does not exist yet, so the stand-in folder's migration is applied.
    const folder = await folderWithMarker();
    const database = await migrated("settle_applied", folder);
    await seedTransfer(database, "rejected");
    const result = await runUpdatePreflight({ query: portOf(database), migrationsFolder: folder });
    expect(result.lines).toEqual(["update-preflight: ready"]);
  });

  it("does nothing while no migration in the image carries the entry's tag, even with a stuck row", async () => {
    expect(entry()).toBeDefined();
    const database = await migrated("settle_unshipped");
    await seedTransfer(database, "rejected");
    const result = await runUpdatePreflight({ query: portOf(database), migrationsFolder: MIGRATIONS });
    expect(result.lines).toEqual(["update-preflight: ready"]);
  });
});
