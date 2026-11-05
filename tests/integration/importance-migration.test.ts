import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMigrationTestDatabase, runMigrations } from "./support/migration-fixture";

/**
 * #1463: items.importance (nullable text, check 'low' | 'normal' | 'high';
 * existing rows stay null), user_preferences.planet_size (text, not null,
 * default 'cost', check 'cost' | 'importance') and
 * user_preferences.importance_offer_dismissed (boolean, not null, default
 * false). The pattern is sky-driver-migration.test.ts: a real database, the
 * checked-in migrations. The items are inserted with foreign keys not enforced
 * (the test is about the column, not the household around it).
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

type Database = Awaited<ReturnType<typeof migrated>>;

async function insertUser(database: Database, index: string): Promise<string> {
  const [{ id }] = await database.client.unsafe(
    `INSERT INTO "users" ("email_enc", "email_index", "display_name") VALUES ('mdv1.a.b.c', $1, 'Importance') RETURNING "id"`,
    [index],
  );
  return String(id);
}

/** An item row with only what the table insists on, foreign keys switched off for the one statement. */
async function insertItem(database: Database, importance: string | null | "omit") {
  const columns = ['"household_id"', '"section_id"', '"currency"', ...(importance === "omit" ? [] : ['"importance"'])];
  const values = [randomUUID(), randomUUID(), "GBP", ...(importance === "omit" ? [] : [importance])];
  const marks = values.map((_, i) => `$${i + 1}`).join(", ");
  return database.client.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL session_replication_role = replica`);
    return tx.unsafe(`INSERT INTO "items" (${columns.join(", ")}) VALUES (${marks}) RETURNING "importance"`, values);
  });
}

describe("migration for items.importance", () => {
  it("adds a nullable text column", async () => {
    const database = await migrated("importance_column");
    const [column] = await database.client.unsafe(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'items' AND column_name = 'importance'`,
    );
    expect(column).toBeDefined();
    expect(column.data_type).toBe("text");
    expect(column.is_nullable).toBe("YES");
    expect(column.column_default).toBeNull();
  });

  it("leaves a row that never mentions it null (the existing rows read back as not set)", async () => {
    const database = await migrated("importance_null");
    const [row] = await insertItem(database, "omit");
    expect(row.importance).toBeNull();
  });

  it.each(["low", "normal", "high", null])("accepts %s", async (value) => {
    const database = await migrated(`importance_ok_${value ?? "null"}`);
    const [row] = await insertItem(database, value);
    expect(row.importance).toBe(value);
  });

  it.each(["urgent", "", "High", "medium"])("refuses '%s' with a check violation", async (value) => {
    const database = await migrated(`importance_bad_${value || "empty"}`);
    await expect(insertItem(database, value)).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses an update to 'urgent' on an existing row", async () => {
    const database = await migrated("importance_update");
    await insertItem(database, "low");
    await expect(database.client.unsafe(`UPDATE "items" SET "importance" = 'urgent'`)).rejects.toMatchObject({ code: "23514" });
  });
});

describe("migration for user_preferences.planet_size", () => {
  it("adds a text, not-null column that defaults to 'cost'", async () => {
    const database = await migrated("planet_size_column");
    const [column] = await database.client.unsafe(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_preferences' AND column_name = 'planet_size'`,
    );
    expect(column).toBeDefined();
    expect(column.data_type).toBe("text");
    expect(column.is_nullable).toBe("NO");
    expect(String(column.column_default)).toContain("'cost'");

    const id = await insertUser(database, "planet-size-default");
    await database.client.unsafe(`INSERT INTO "user_preferences" ("user_id") VALUES ($1)`, [id]);
    const [row] = await database.client.unsafe(`SELECT "planet_size" FROM "user_preferences" WHERE "user_id" = $1`, [id]);
    expect(row.planet_size).toBe("cost");
  });

  it.each(["cost", "importance"])("accepts '%s'", async (value) => {
    const database = await migrated(`planet_size_ok_${value}`);
    const id = await insertUser(database, `planet-size-ok-${value}`);
    await database.client.unsafe(`INSERT INTO "user_preferences" ("user_id", "planet_size") VALUES ($1, $2)`, [id, value]);
    const [row] = await database.client.unsafe(`SELECT "planet_size" FROM "user_preferences" WHERE "user_id" = $1`, [id]);
    expect(row.planet_size).toBe(value);
  });

  it.each(["big", ""])("refuses '%s' with a check violation", async (value) => {
    const database = await migrated(`planet_size_bad_${value || "empty"}`);
    const id = await insertUser(database, `planet-size-bad-${value || "empty"}`);
    await expect(
      database.client.unsafe(`INSERT INTO "user_preferences" ("user_id", "planet_size") VALUES ($1, $2)`, [id, value]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses an update to null on an existing row", async () => {
    const database = await migrated("planet_size_update");
    const id = await insertUser(database, "planet-size-update");
    await database.client.unsafe(`INSERT INTO "user_preferences" ("user_id") VALUES ($1)`, [id]);
    await expect(
      database.client.unsafe(`UPDATE "user_preferences" SET "planet_size" = NULL WHERE "user_id" = $1`, [id]),
    ).rejects.toMatchObject({ code: "23502" });
  });
});

describe("migration for user_preferences.importance_offer_dismissed", () => {
  it("adds a boolean, not-null column that defaults to false", async () => {
    const database = await migrated("offer_dismissed_column");
    const [column] = await database.client.unsafe(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_preferences' AND column_name = 'importance_offer_dismissed'`,
    );
    expect(column).toBeDefined();
    expect(column.data_type).toBe("boolean");
    expect(column.is_nullable).toBe("NO");
    expect(String(column.column_default)).toContain("false");

    const id = await insertUser(database, "offer-default");
    await database.client.unsafe(`INSERT INTO "user_preferences" ("user_id") VALUES ($1)`, [id]);
    const [row] = await database.client.unsafe(`SELECT "importance_offer_dismissed" FROM "user_preferences" WHERE "user_id" = $1`, [id]);
    expect(row.importance_offer_dismissed).toBe(false);
  });

  it("stores true, and refuses null on an existing row", async () => {
    const database = await migrated("offer_dismissed_true");
    const id = await insertUser(database, "offer-true");
    await database.client.unsafe(`INSERT INTO "user_preferences" ("user_id", "importance_offer_dismissed") VALUES ($1, true)`, [id]);
    const [row] = await database.client.unsafe(`SELECT "importance_offer_dismissed" FROM "user_preferences" WHERE "user_id" = $1`, [id]);
    expect(row.importance_offer_dismissed).toBe(true);
    await expect(
      database.client.unsafe(`UPDATE "user_preferences" SET "importance_offer_dismissed" = NULL WHERE "user_id" = $1`, [id]),
    ).rejects.toMatchObject({ code: "23502" });
  });
});
