import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMigrationTestDatabase,
  runMigrations,
} from "./support/migration-fixture";

/**
 * Migration 0002's backfill (#1618): everyone who existed before the what's-new
 * notice has `v0.0.0`, including a user with no user_preferences row, so
 * people who were here before the feature see the first notes.
 */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A copy of the checked-in migrations holding only 0000 and 0001: the schema before the feature. */
async function migrationsBeforeFeature(): Promise<string> {
  const source = resolve(process.cwd(), "drizzle");
  const target = await mkdtemp(join(tmpdir(), "orbit-whats-new-migrations-"));
  cleanups.push(() => rm(target, { recursive: true, force: true }));
  await cp(source, target, { recursive: true });
  const journalPath = join(target, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.tag === "0000_baseline" || entry.tag === "0001_approval_request");
  await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n");
  return target;
}

describe("migration 0002 what's-new backfill", () => {
  it("gives every existing user v0.0.0, inserting a preferences row where none existed", async () => {
    const database = await createMigrationTestDatabase("whats_new_backfill");
    cleanups.push(() => database.cleanup());
    await runMigrations(database.url, await migrationsBeforeFeature());

    const [{ present }] = await database.client.unsafe(
      `SELECT count(*)::int AS present FROM information_schema.columns
        WHERE table_name = 'user_preferences' AND column_name = 'whats_new_seen_version'`,
    );
    expect(present).toBe(0);

    const insertUser = async (index: string) => String((await database.client.unsafe(
      `INSERT INTO "users" ("email_enc", "email_index", "display_name") VALUES ('mdv1.a.b.c', $1, 'Existing') RETURNING "id"`,
      [index],
    ))[0].id);
    const withPreferences = await insertUser("backfill-with-preferences");
    const withoutPreferences = await insertUser("backfill-without-preferences");
    await database.client.unsafe(`INSERT INTO "user_preferences" ("user_id") VALUES ($1)`, [withPreferences]);

    await runMigrations(database.url, resolve(process.cwd(), "drizzle"));

    const rows = await database.client.unsafe(
      `SELECT "user_id", "whats_new_seen_version" FROM "user_preferences" WHERE "user_id" IN ($1, $2)`,
      [withPreferences, withoutPreferences],
    );
    const byUser = new Map(rows.map((row) => [String(row.user_id), row.whats_new_seen_version]));
    expect(byUser.get(withPreferences)).toBe("v0.0.0");
    expect(byUser.get(withoutPreferences)).toBe("v0.0.0");
  });

  it("leaves the column nullable with no default for accounts created afterwards", async () => {
    const database = await createMigrationTestDatabase("whats_new_new_account");
    cleanups.push(() => database.cleanup());
    await runMigrations(database.url, resolve(process.cwd(), "drizzle"));

    const [{ id }] = await database.client.unsafe(
      `INSERT INTO "users" ("email_enc", "email_index", "display_name") VALUES ('mdv1.a.b.c', 'new-after', 'New') RETURNING "id"`,
    );
    await database.client.unsafe(`INSERT INTO "user_preferences" ("user_id") VALUES ($1)`, [id]);
    const [row] = await database.client.unsafe(`SELECT "whats_new_seen_version" FROM "user_preferences" WHERE "user_id" = $1`, [id]);
    expect(row.whats_new_seen_version).toBeNull();
  });
});
