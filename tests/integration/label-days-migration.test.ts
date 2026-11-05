import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMigrationTestDatabase, runMigrations } from "./support/migration-fixture";

/**
 * #1461: user_preferences.label_days, the days within which a planet shows its
 * name. Integer, not null, default 30, check 0..365. The pattern is
 * whats-new-migration.test.ts: a real database, the checked-in migrations.
 */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function migrated(name: string) {
  const database = await createMigrationTestDatabase(name);
  cleanups.push(() => database.cleanup());
  await runMigrations(database.url, resolve(process.cwd(), "drizzle"));
  return database;
}

async function insertUser(database: Awaited<ReturnType<typeof migrated>>, index: string): Promise<string> {
  const [{ id }] = await database.client.unsafe(
    `INSERT INTO "users" ("email_enc", "email_index", "display_name") VALUES ('mdv1.a.b.c', $1, 'Label') RETURNING "id"`,
    [index],
  );
  return String(id);
}

describe("migration for user_preferences.label_days", () => {
  it("adds an integer, not-null column that defaults to 30", async () => {
    const database = await migrated("label_days_column");
    const [column] = await database.client.unsafe(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_preferences' AND column_name = 'label_days'`,
    );
    expect(column).toBeDefined();
    expect(column.data_type).toBe("integer");
    expect(column.is_nullable).toBe("NO");
    expect(String(column.column_default)).toBe("30");

    const id = await insertUser(database, "label-default");
    await database.client.unsafe(`INSERT INTO "user_preferences" ("user_id") VALUES ($1)`, [id]);
    const [row] = await database.client.unsafe(`SELECT "label_days" FROM "user_preferences" WHERE "user_id" = $1`, [id]);
    expect(row.label_days).toBe(30);
  });

  it.each([0, 1, 365])("accepts %i", async (days) => {
    const database = await migrated(`label_days_ok_${days}`);
    const id = await insertUser(database, `label-ok-${days}`);
    await database.client.unsafe(`INSERT INTO "user_preferences" ("user_id", "label_days") VALUES ($1, $2)`, [id, days]);
    const [row] = await database.client.unsafe(`SELECT "label_days" FROM "user_preferences" WHERE "user_id" = $1`, [id]);
    expect(row.label_days).toBe(days);
  });

  it.each([366, -1])("refuses %i with a check violation", async (days) => {
    const database = await migrated(`label_days_bad_${Math.abs(days)}`);
    const id = await insertUser(database, `label-bad-${Math.abs(days)}`);
    await expect(
      database.client.unsafe(`INSERT INTO "user_preferences" ("user_id", "label_days") VALUES ($1, $2)`, [id, days]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses an update to 366 and null on an existing row", async () => {
    const database = await migrated("label_days_update");
    const id = await insertUser(database, "label-update");
    await database.client.unsafe(`INSERT INTO "user_preferences" ("user_id") VALUES ($1)`, [id]);
    await expect(
      database.client.unsafe(`UPDATE "user_preferences" SET "label_days" = 366 WHERE "user_id" = $1`, [id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      database.client.unsafe(`UPDATE "user_preferences" SET "label_days" = NULL WHERE "user_id" = $1`, [id]),
    ).rejects.toMatchObject({ code: "23502" });
  });
});
