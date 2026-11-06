import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMigrationTestDatabase, runMigrations } from "./support/migration-fixture";

/**
 * #1462: user_preferences.sky_driver, what sets a planet's distance from the
 * sun. Text, not null, default 'due', check 'due' or 'warning'. The pattern is
 * label-days-migration.test.ts: a real database, the checked-in migrations.
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
    `INSERT INTO "users" ("email_enc", "email_index", "display_name") VALUES ('mdv1.a.b.c', $1, 'Driver') RETURNING "id"`,
    [index],
  );
  return String(id);
}

describe("migration for user_preferences.sky_driver", () => {
  it("adds a text, not-null column that defaults to 'due'", async () => {
    const database = await migrated("sky_driver_column");
    const [column] = await database.client.unsafe(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_preferences' AND column_name = 'sky_driver'`,
    );
    expect(column).toBeDefined();
    expect(column.data_type).toBe("text");
    expect(column.is_nullable).toBe("NO");
    expect(String(column.column_default)).toContain("'due'");

    const id = await insertUser(database, "driver-default");
    await database.client.unsafe(`INSERT INTO "user_preferences" ("user_id") VALUES ($1)`, [id]);
    const [row] = await database.client.unsafe(`SELECT "sky_driver" FROM "user_preferences" WHERE "user_id" = $1`, [id]);
    expect(row.sky_driver).toBe("due");
  });

  it.each(["due", "warning"])("accepts '%s'", async (value) => {
    const database = await migrated(`sky_driver_ok_${value}`);
    const id = await insertUser(database, `driver-ok-${value}`);
    await database.client.unsafe(`INSERT INTO "user_preferences" ("user_id", "sky_driver") VALUES ($1, $2)`, [id, value]);
    const [row] = await database.client.unsafe(`SELECT "sky_driver" FROM "user_preferences" WHERE "user_id" = $1`, [id]);
    expect(row.sky_driver).toBe(value);
  });

  it.each(["soon", ""])("refuses '%s' with a check violation", async (value) => {
    const database = await migrated(`sky_driver_bad_${value || "empty"}`);
    const id = await insertUser(database, `driver-bad-${value || "empty"}`);
    await expect(
      database.client.unsafe(`INSERT INTO "user_preferences" ("user_id", "sky_driver") VALUES ($1, $2)`, [id, value]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses an update to 'soon' and to null on an existing row", async () => {
    const database = await migrated("sky_driver_update");
    const id = await insertUser(database, "driver-update");
    await database.client.unsafe(`INSERT INTO "user_preferences" ("user_id") VALUES ($1)`, [id]);
    await expect(
      database.client.unsafe(`UPDATE "user_preferences" SET "sky_driver" = 'soon' WHERE "user_id" = $1`, [id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      database.client.unsafe(`UPDATE "user_preferences" SET "sky_driver" = NULL WHERE "user_id" = $1`, [id]),
    ).rejects.toMatchObject({ code: "23502" });
  });
});
