import { afterEach, describe, expect, it } from "vitest";
import {
  BASELINE_MIGRATION_TAG,
  EXPECTED_ENUMS,
  EXPECTED_CONSTRAINTS,
  EXPECTED_INDEXES,
  EXPECTED_POSTGRES_MAJOR,
  EXPECTED_TABLE_COLUMNS,
  createBaselineMigrationDirectory,
  createInvalidMigrationDirectory,
  createMigrationTestDatabase,
  loadMigrationFixture,
  readAppliedMigrationHashes,
  readExpectedMigrationHashes,
  readPostgresMajor,
  readSchemaContract,
  readFixtureSnapshot,
  runMigrations,
  runMigrationsWithActionableError,
  verifyMigrationPrefix,
} from "./support/migration-fixture";

const databases: Array<Awaited<ReturnType<typeof createMigrationTestDatabase>>> = [];
const temporaryDirectories: Array<{ cleanup(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.cleanup()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => directory.cleanup()));
});

describe("PostgreSQL migration evidence", () => {
  it("migrates every current migration into a fresh PostgreSQL 17 database", async () => {
    const database = await createMigrationTestDatabase("fresh");
    databases.push(database);

    await runMigrations(database.url, "drizzle");

    expect(await readPostgresMajor(database.client)).toBe(EXPECTED_POSTGRES_MAJOR);
    expect(await readAppliedMigrationHashes(database.client)).toEqual(await readExpectedMigrationHashes("drizzle"));
    expect((await readSchemaContract(database.client)).enums).toEqual(EXPECTED_ENUMS);
    expect((await readSchemaContract(database.client)).tables).toEqual(EXPECTED_TABLE_COLUMNS);
    expect((await readSchemaContract(database.client)).constraints).toEqual(EXPECTED_CONSTRAINTS);
    expect((await readSchemaContract(database.client)).indexes).toEqual(EXPECTED_INDEXES);
  });

  it("upgrades the supported baseline, preserves fixture data, and is idempotent", async () => {
    const database = await createMigrationTestDatabase("baseline");
    databases.push(database);
    await verifyMigrationPrefix("drizzle");
    const baselineDirectory = await createBaselineMigrationDirectory("drizzle");
    temporaryDirectories.push(baselineDirectory);

    await runMigrations(database.url, baselineDirectory.path);
    expect(await readAppliedMigrationHashes(database.client)).toEqual(await readExpectedMigrationHashes(baselineDirectory.path));
    await loadMigrationFixture(database.client);
    const beforeUpgrade = await readFixtureSnapshot(database.client);

    await runMigrations(database.url, "drizzle");
    expect(await readAppliedMigrationHashes(database.client)).toEqual(await readExpectedMigrationHashes("drizzle"));
    expect((await readSchemaContract(database.client)).enums).toEqual(EXPECTED_ENUMS);
    expect((await readSchemaContract(database.client)).tables).toEqual(EXPECTED_TABLE_COLUMNS);
    expect((await readSchemaContract(database.client)).constraints).toEqual(EXPECTED_CONSTRAINTS);
    expect((await readSchemaContract(database.client)).indexes).toEqual(EXPECTED_INDEXES);
    const expectedAfterUpgrade = structuredClone(beforeUpgrade);
    const legacyReceipt = expectedAfterUpgrade.imap_ingestion_messages.find((row) => row.review_item_id);
    if (!legacyReceipt) throw new Error("The migration fixture must include a legacy prototype receipt");
    expect(legacyReceipt.status).toBe("completed");
    const discardedReceipt = expectedAfterUpgrade.imap_ingestion_messages.find((row) => row.id === "e0000000-0000-4000-8000-000000000002");
    const unresolvedReceipt = expectedAfterUpgrade.imap_ingestion_messages.find((row) => row.id === "e0000000-0000-4000-8000-000000000003");
    if (!discardedReceipt || !unresolvedReceipt) throw new Error("The migration fixture must include discarded and unresolved legacy receipts");
    expect(discardedReceipt.status).toBe("discarded");
    unresolvedReceipt.status = "failed";
    unresolvedReceipt.failure_code = "legacy_review_item";
    expect(await readFixtureSnapshot(database.client)).toEqual(expectedAfterUpgrade);
    const legacyContract = await database.client.unsafe(`
      SELECT id, status, failure_code, approved_item_id
      FROM imap_ingestion_messages
      WHERE id IN ('e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000003')
      ORDER BY id
    `);
    expect(legacyContract).toEqual([
      { id: "e0000000-0000-4000-8000-000000000001", status: "completed", failure_code: null, approved_item_id: "40000000-0000-4000-8000-000000000001" },
      { id: "e0000000-0000-4000-8000-000000000002", status: "discarded", failure_code: null, approved_item_id: null },
      { id: "e0000000-0000-4000-8000-000000000003", status: "failed", failure_code: "legacy_review_item", approved_item_id: null },
    ]);

    const beforeRerun = {
      journal: await readAppliedMigrationHashes(database.client),
      schema: await readSchemaContract(database.client),
      data: await readFixtureSnapshot(database.client),
    };
    await runMigrations(database.url, "drizzle");
    expect({
      journal: await readAppliedMigrationHashes(database.client),
      schema: await readSchemaContract(database.client),
      data: await readFixtureSnapshot(database.client),
    }).toEqual(beforeRerun);
    expect(BASELINE_MIGRATION_TAG).toBe("0017_imap_recipient_alias_index");
  });

  it("reports an invalid next migration without recording it", async () => {
    const database = await createMigrationTestDatabase("failure");
    databases.push(database);
    await runMigrations(database.url, "drizzle");
    const beforeFailure = await readAppliedMigrationHashes(database.client);
    const invalidDirectory = await createInvalidMigrationDirectory("drizzle");
    temporaryDirectories.push(invalidDirectory);

    let failure: unknown;
    try {
      await runMigrationsWithActionableError(database.url, invalidDirectory.path);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(new RegExp(`Migration ${invalidDirectory.failedTag} failed:`));
    expect((failure as Error).message.length).toBeLessThan(500);
    expect((failure as Error).message).not.toContain("fixture-document");
    expect(await readAppliedMigrationHashes(database.client)).toEqual(beforeFailure);
  });
});
