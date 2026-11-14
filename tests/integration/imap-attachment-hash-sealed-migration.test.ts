import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMigrationTestDatabase, runMigrations } from "./support/migration-fixture";

/* #1778, build note A (design note 58551), "expand": one migration
   - on `imap_ingestion_attachments` adds `content_sha256_sealed text` and
     `content_index text`, makes `content_sha256` nullable, adds the unique
     index `imap_attachment_message_index_unique (message_id, content_index)`
     and drops `imap_attachment_message_hash_unique`;
   - on `imap_ingestion_messages` drops `imap_message_recipient_content_idx`
     and the `content_sha256` column.
   It moves no data: sealing needs a key SQL does not have. Dropping the plain
   attachment column is #1835, a later release, so it must still be there.
   The migration number is not fixed, so it is found by the index it adds. */

const MIGRATIONS = resolve(process.cwd(), "drizzle");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function expandMigration(): Promise<{ tag: string; sql: string } | undefined> {
  for (const name of (await readdir(MIGRATIONS)).filter((file) => file.endsWith(".sql")).sort()) {
    const sql = await readFile(join(MIGRATIONS, name), "utf8");
    if (/imap_attachment_message_index_unique/u.test(sql)) return { tag: name.replace(/\.sql$/u, ""), sql };
  }
  return undefined;
}

async function requireExpandMigration() {
  const found = await expandMigration();
  expect(found, "a migration in drizzle/ adds imap_attachment_message_index_unique").toBeDefined();
  return found!;
}

type Database = Awaited<ReturnType<typeof createMigrationTestDatabase>>;

async function migrated(name: string) {
  const database = await createMigrationTestDatabase(name);
  cleanups.push(() => database.cleanup());
  await runMigrations(database.url, MIGRATIONS);
  return database;
}

async function columnOf(database: Database, table: string, column: string) {
  const [row] = await database.client.unsafe(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return row;
}

async function indexExists(database: Database, name: string): Promise<boolean> {
  const rows = await database.client.unsafe(`SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows.length > 0;
}

async function insertMessage(database: Database, withPlainHash: string | null): Promise<string> {
  const id = randomUUID();
  const hashColumn = withPlainHash === null ? "" : `, "content_sha256"`;
  const hashValue = withPlainHash === null ? "" : `, '${withPlainHash}'`;
  await database.client.unsafe(
    `INSERT INTO "imap_ingestion_messages" ("id", "mailbox", "mailbox_uid_validity", "mailbox_uid", "recipient_alias_sha256", "status", "expires_at"${hashColumn})
     VALUES ($1, 'INBOX', 'v1', $2, 'alias', 'pending_review', now() + interval '1 day'${hashValue})`,
    [id, Math.floor(Math.random() * 1_000_000_000)],
  );
  return id;
}

async function insertAttachment(
  database: Database,
  messageId: string,
  { plain = null, contentIndex = null }: { plain?: string | null; contentIndex?: string | null },
) {
  const id = randomUUID();
  /* Before the migration the index column does not exist, so a row for the upgrade test is written without it. */
  const hasIndex = (await columnOf(database, "imap_ingestion_attachments", "content_index")) !== undefined;
  const columns = ["id", "message_id", "display_name", "media_type", "size_bytes", "content_sha256", "storage_key", "ciphertext_size", "envelope_version", "content_iv", "content_auth_tag", "wrapped_dek", "wrap_iv", "wrap_auth_tag", "key_id"];
  const values: unknown[] = [id, messageId, "a.pdf", "application/pdf", 10, plain, `key-${id}`, 20, 1, "iv", "tag", "dek", "wiv", "wtag", "key"];
  if (hasIndex) { columns.push("content_index"); values.push(contentIndex); }
  await database.client.unsafe(
    `INSERT INTO "imap_ingestion_attachments" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${values.map((_, position) => `$${position + 1}`).join(", ")})`,
    values as never,
  );
  return id;
}

describe("the expand migration for mail-in attachment hashes (#1778)", () => {
  it("is one migration, found by the unique index it adds, and it is in the journal", async () => {
    const found = await requireExpandMigration();
    const journal = JSON.parse(await readFile(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    expect(journal.entries.map((entry) => entry.tag)).toContain(found.tag);
  });

  it("adds content_sha256_sealed and content_index to imap_ingestion_attachments as nullable text with no default", async () => {
    const database = await migrated("imap_attachment_hash_new_columns");
    for (const name of ["content_sha256_sealed", "content_index"]) {
      const column = await columnOf(database, "imap_ingestion_attachments", name);
      expect(column, `${name} exists`).toBeDefined();
      expect(column.data_type).toBe("text");
      expect(column.is_nullable).toBe("YES");
      expect(column.column_default).toBeNull();
    }
  });

  it("makes imap_ingestion_attachments.content_sha256 nullable and keeps it: the drop is #1835, a later release", async () => {
    const database = await migrated("imap_attachment_hash_plain_nullable");
    const plain = await columnOf(database, "imap_ingestion_attachments", "content_sha256");
    expect(plain, "the plain column is still there in this release").toBeDefined();
    expect(plain.data_type).toBe("text");
    expect(plain.is_nullable).toBe("YES");
  });

  it("drops imap_ingestion_messages.content_sha256 and imap_message_recipient_content_idx outright", async () => {
    const database = await migrated("imap_message_hash_dropped");
    expect(await columnOf(database, "imap_ingestion_messages", "content_sha256")).toBeUndefined();
    expect(await indexExists(database, "imap_message_recipient_content_idx")).toBe(false);
  });

  it("keeps the message's own dedupe (mailbox, uidvalidity, uid), which never used the hash", async () => {
    const database = await migrated("imap_message_uid_unique_kept");
    expect(await indexExists(database, "imap_message_mailbox_uid_unique")).toBe(true);
  });

  it("replaces the per-mail unique index: the new one is there, the old one is not", async () => {
    const database = await migrated("imap_attachment_unique_swapped");
    expect(await indexExists(database, "imap_attachment_message_index_unique")).toBe(true);
    expect(await indexExists(database, "imap_attachment_message_hash_unique")).toBe(false);
    const [index] = await database.client.unsafe(
      `SELECT i.indisunique AS "unique",
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS columns
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'imap_attachment_message_index_unique'`);
    expect(index.unique).toBe(true);
    expect(index.columns).toEqual(["message_id", "content_index"]);
  });

  it("refuses two attachments of one mail with the same content_index", async () => {
    const database = await migrated("imap_attachment_equal_index");
    const message = await insertMessage(database, null);
    await insertAttachment(database, message, { contentIndex: "bidx1.same" });
    await expect(insertAttachment(database, message, { contentIndex: "bidx1.same" })).rejects.toThrow(/imap_attachment_message_index_unique|duplicate key/u);
  });

  it("allows the same content_index on two different mails", async () => {
    const database = await migrated("imap_attachment_equal_index_two_mails");
    const first = await insertMessage(database, null);
    const second = await insertMessage(database, null);
    await insertAttachment(database, first, { contentIndex: "bidx1.same" });
    await expect(insertAttachment(database, second, { contentIndex: "bidx1.same" })).resolves.toBeTruthy();
  });

  it("allows any number of attachments of one mail with a NULL content_index (a row the backfill has not reached)", async () => {
    const database = await migrated("imap_attachment_null_index");
    const message = await insertMessage(database, null);
    await insertAttachment(database, message, { plain: "a".repeat(64) });
    await insertAttachment(database, message, { plain: "a".repeat(64) });
    await insertAttachment(database, message, {});
    const [{ n }] = await database.client.unsafe(`SELECT count(*)::int AS n FROM imap_ingestion_attachments WHERE message_id = $1`, [message]);
    expect(n).toBe(3);
  });

  it("moves no data and drops no table: it has no UPDATE, INSERT, DELETE or DROP TABLE, and drops no attachment column", async () => {
    const { sql } = await requireExpandMigration();
    const statements = sql.replace(/--.*$/gmu, "");
    expect(statements).not.toMatch(/\bUPDATE\b/iu);
    expect(statements).not.toMatch(/\bINSERT\b/iu);
    expect(statements).not.toMatch(/\bDELETE\b/iu);
    expect(statements).not.toMatch(/\bDROP\s+TABLE\b/iu);
    const dropped = [...statements.matchAll(/ALTER\s+TABLE\s+"?(\w+)"?\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/giu)].map((match) => `${match[1]}.${match[2]}`);
    expect(dropped, "the only column dropped is the message-level hash").toEqual(["imap_ingestion_messages.content_sha256"]);
  });

  it("applied over a database that holds held attachments, leaves every plain attachment hash exactly as it was and seals none", async () => {
    const found = await requireExpandMigration();
    /* The journal as it stood before this migration, so the upgrade is a real one. */
    const before = await mkdtemp(join(tmpdir(), "orbit-attachment-hash-before-"));
    cleanups.push(() => rm(before, { recursive: true, force: true }));
    await cp(MIGRATIONS, before, { recursive: true });
    const journalPath = join(before, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
    const position = journal.entries.findIndex((entry) => entry.tag === found.tag);
    expect(position, "the migration is in the journal").toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, position);
    await writeFile(journalPath, JSON.stringify(journal));

    const database = await createMigrationTestDatabase("imap_attachment_hash_upgrade");
    cleanups.push(() => database.cleanup());
    await runMigrations(database.url, before);
    expect(await columnOf(database, "imap_ingestion_attachments", "content_sha256_sealed")).toBeUndefined();
    const message = await insertMessage(database, "f".repeat(64));
    await insertAttachment(database, message, { plain: "0".repeat(64) });
    await insertAttachment(database, message, { plain: "1".repeat(64) });

    await runMigrations(database.url, MIGRATIONS);

    const rows = await database.client.unsafe(
      `SELECT content_sha256 AS plain, content_sha256_sealed AS sealed, content_index AS "index"
         FROM imap_ingestion_attachments WHERE message_id = $1 ORDER BY content_sha256`, [message]);
    expect(rows.map((row) => row.plain)).toEqual(["0".repeat(64), "1".repeat(64)]);
    expect(rows.every((row) => row.sealed === null && row.index === null), "sealing and indexing are the backfill's job").toBe(true);
    expect(await columnOf(database, "imap_ingestion_messages", "content_sha256")).toBeUndefined();
  });
});
