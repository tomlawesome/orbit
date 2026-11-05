import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMigrationTestDatabase, runMigrations } from "./support/migration-fixture";

/**
 * #1466 (colour part): sections.colour, nullable text, checked to one of
 * 'home' | 'vehicles' | 'devices' | 'services'. Existing rows stay null and
 * the old `accent` column is left alone. The pattern is
 * label-days-migration.test.ts: a real database, the checked-in migrations.
 * The migration's file number is the builder's (it follows #1463's 0005); this
 * file runs the whole folder and so does not name it.
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

async function insertHousehold(database: Awaited<ReturnType<typeof migrated>>): Promise<string> {
  const [{ id }] = await database.client.unsafe(`INSERT INTO "households" ("name") VALUES ('Colour') RETURNING "id"`);
  return String(id);
}

async function insertSection(database: Awaited<ReturnType<typeof migrated>>, householdId: string, slug: string, colour?: string | null) {
  return database.client.unsafe(
    colour === undefined
      ? `INSERT INTO "sections" ("household_id", "slug", "name") VALUES ($1, $2, 'S') RETURNING "id"`
      : `INSERT INTO "sections" ("household_id", "slug", "name", "colour") VALUES ($1, $2, 'S', $3) RETURNING "id"`,
    colour === undefined ? [householdId, slug] : [householdId, slug, colour],
  );
}

describe("migration for sections.colour", () => {
  it("adds a nullable text column with no default, and leaves accent alone", async () => {
    const database = await migrated("section_colour_column");
    const columns = await database.client.unsafe(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sections' AND column_name IN ('colour', 'accent')`,
    );
    const colour = columns.find((one: { column_name: string }) => one.column_name === "colour");
    expect(colour).toBeDefined();
    expect(colour.data_type).toBe("text");
    expect(colour.is_nullable).toBe("YES");
    expect(colour.column_default).toBeNull();
    expect(columns.some((one: { column_name: string }) => one.column_name === "accent")).toBe(true);
  });

  it("leaves a section inserted without a colour null", async () => {
    const database = await migrated("section_colour_null");
    const household = await insertHousehold(database);
    const [{ id }] = await insertSection(database, household, "plain");
    const [row] = await database.client.unsafe(`SELECT "colour" FROM "sections" WHERE "id" = $1`, [id]);
    expect(row.colour).toBeNull();
  });

  it.each(["home", "vehicles", "devices", "services", null])("accepts %s", async (colour) => {
    const database = await migrated(`section_colour_ok_${colour}`);
    const household = await insertHousehold(database);
    const [{ id }] = await insertSection(database, household, "ok", colour);
    const [row] = await database.client.unsafe(`SELECT "colour" FROM "sections" WHERE "id" = $1`, [id]);
    expect(row.colour).toBe(colour);
  });

  it.each(["sage", "", "Home"])("refuses %j with a check violation", async (colour) => {
    const database = await migrated(`section_colour_bad_${colour || "empty"}`);
    const household = await insertHousehold(database);
    await expect(insertSection(database, household, "bad", colour)).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses an update to sage on an existing row", async () => {
    const database = await migrated("section_colour_update");
    const household = await insertHousehold(database);
    const [{ id }] = await insertSection(database, household, "upd");
    await expect(
      database.client.unsafe(`UPDATE "sections" SET "colour" = 'sage' WHERE "id" = $1`, [id]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
