import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMigrationTestDatabase, runMigrations } from "./support/migration-fixture";

/**
 * #1681, design note 52496: one nullable column on mail_in_sender_addresses,
 * `last_forward_unsigned_at`, set when a sender_unsigned row is filed for the
 * address and cleared when a forward from it attributes. The migration adds
 * it with no default, so every address that existed before reads as "nothing
 * unsigned seen" (the relay page's `checked`), and nothing is backfilled.
 */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** The tags that existed before #1681, whatever the new migration is called. */
const BEFORE = ["0000_baseline", "0001_approval_request", "0002_whats_new_seen_version"];

async function migrationsBeforeFeature(): Promise<string> {
  const source = resolve(process.cwd(), "drizzle");
  const target = await mkdtemp(join(tmpdir(), "orbit-sender-unsigned-migrations-"));
  cleanups.push(() => rm(target, { recursive: true, force: true }));
  await cp(source, target, { recursive: true });
  const journalPath = join(target, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => BEFORE.includes(entry.tag));
  await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n");
  return target;
}

describe("migration: mail_in_sender_addresses.last_forward_unsigned_at (#1681, note 52496)", () => {
  it("adds a nullable timestamptz column with no default, and leaves existing addresses null", async () => {
    const database = await createMigrationTestDatabase("sender_unsigned_column");
    cleanups.push(() => database.cleanup());
    await runMigrations(database.url, await migrationsBeforeFeature());

    const [{ id: userId }] = await database.client.unsafe(
      `INSERT INTO "users" ("email_enc", "email_index", "display_name") VALUES ('mdv1.a.b.c', 'sender-unsigned-existing', 'Existing') RETURNING "id"`,
    );
    const [{ id: senderId }] = await database.client.unsafe(
      `INSERT INTO "mail_in_sender_addresses" ("user_id", "address_enc", "address_index", "verified_at")
       VALUES ($1, 'mdv1.a.b.c', 'sender-unsigned-existing-index', now()) RETURNING "id"`,
      [String(userId)],
    );

    await runMigrations(database.url, resolve(process.cwd(), "drizzle"));

    const columns = await database.client.unsafe(
      `SELECT is_nullable, data_type, column_default FROM information_schema.columns
        WHERE table_name = 'mail_in_sender_addresses' AND column_name = 'last_forward_unsigned_at'`,
    );
    expect(columns).toHaveLength(1);
    expect(columns[0]).toMatchObject({ is_nullable: "YES", data_type: "timestamp with time zone", column_default: null });

    const [row] = await database.client.unsafe(
      `SELECT "last_forward_unsigned_at" FROM "mail_in_sender_addresses" WHERE "id" = $1`,
      [String(senderId)],
    );
    expect(row.last_forward_unsigned_at).toBeNull();
  });
});
