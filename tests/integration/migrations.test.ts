import { randomUUID } from "node:crypto";
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
  createMigrationDirectoryThroughTag,
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

type MigrationTestClient = Awaited<ReturnType<typeof createMigrationTestDatabase>>["client"];

async function insertFixtureHousehold(client: MigrationTestClient, id: string): Promise<void> {
  await client.unsafe(`INSERT INTO "households" (id, name) VALUES ($1, $2)`, [id, "Synthetic readiness household"]);
}

async function insertFixtureDocument(client: MigrationTestClient, params: {
  householdId: string;
  lifecycle: string;
  scanStatus: string;
  displayName: string;
  contentSha256: string;
}): Promise<void> {
  await client.unsafe(
    `INSERT INTO "documents" ("household_id", "display_name", "media_type", "size_bytes", "content_sha256", "lifecycle", "scan_status")
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [params.householdId, params.displayName, "application/pdf", 128, params.contentSha256, params.lifecycle, params.scanStatus],
  );
}

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
    const afterUpgrade = await readFixtureSnapshot(database.client);
    const migratedUnresolvedReceipt = afterUpgrade.imap_ingestion_messages.find((row) => row.id === unresolvedReceipt.id);
    if (!migratedUnresolvedReceipt) throw new Error("The unresolved legacy receipt must survive migration");
    expect(migratedUnresolvedReceipt.updated_at).not.toBe(unresolvedReceipt.updated_at);
    unresolvedReceipt.updated_at = migratedUnresolvedReceipt.updated_at;
    expect(afterUpgrade).toEqual(expectedAfterUpgrade);
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
    expect(await database.client.unsafe(`
      SELECT user_id, generation, alias_sha256, status, active_until
      FROM imap_recipient_aliases
      ORDER BY user_id, generation
    `)).toEqual([{
      user_id: "10000000-0000-4000-8000-000000000001",
      generation: 0,
      alias_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "legacy_inactive",
      active_until: expect.any(Date),
    }]);

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

  it("installs the document readiness invariant and enforces it for openable lifecycles", async () => {
    const database = await createMigrationTestDatabase("readiness");
    databases.push(database);
    await runMigrations(database.url, "drizzle");

    const [constraintRow] = await database.client.unsafe(`
      SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE c.conname = 'document_openable_scan_status_valid' AND t.relname = 'documents'
    `);
    expect(constraintRow?.definition).toContain("lifecycle");
    expect(constraintRow?.definition).toContain("scan_status");

    const householdId = randomUUID();
    await insertFixtureHousehold(database.client, householdId);

    const rejectedCombinations = [
      { lifecycle: "available", scanStatus: "pending" },
      { lifecycle: "available", scanStatus: "error" },
      { lifecycle: "available", scanStatus: "infected" },
      { lifecycle: "pending_deletion", scanStatus: "pending" },
      { lifecycle: "pending_deletion", scanStatus: "error" },
      { lifecycle: "pending_deletion", scanStatus: "infected" },
    ];
    for (const [index, combination] of rejectedCombinations.entries()) {
      await expect(insertFixtureDocument(database.client, {
        householdId,
        ...combination,
        displayName: `fixture-rejected-${index}.pdf`,
        contentSha256: `${index}`.repeat(64).slice(0, 64),
      })).rejects.toThrow(/document_openable_scan_status_valid/);
    }

    const acceptedCombinations = [
      { lifecycle: "available", scanStatus: "clean" },
      { lifecycle: "available", scanStatus: "skipped" },
      { lifecycle: "receiving", scanStatus: "pending" },
    ];
    for (const [index, combination] of acceptedCombinations.entries()) {
      await expect(insertFixtureDocument(database.client, {
        householdId,
        ...combination,
        displayName: `fixture-accepted-${index}.pdf`,
        contentSha256: `a${index}`.repeat(32).slice(0, 64),
      })).resolves.toBeUndefined();
    }
  });

  it("stops the readiness migration before touching an existing unsafe row, without exposing document data", async () => {
    const database = await createMigrationTestDatabase("readiness-legacy");
    databases.push(database);
    await verifyMigrationPrefix("drizzle");
    const throughTagDirectory = await createMigrationDirectoryThroughTag("drizzle", "0021_imap_notification_deliveries");
    temporaryDirectories.push(throughTagDirectory);

    await runMigrations(database.url, throughTagDirectory.path);
    const beforeAttempt = await readAppliedMigrationHashes(database.client);

    const householdId = randomUUID();
    const legacyDisplayName = "fixture-legacy-unsafe-document.pdf";
    const legacyHash = "9".repeat(64);
    await insertFixtureHousehold(database.client, householdId);
    await insertFixtureDocument(database.client, {
      householdId,
      lifecycle: "available",
      scanStatus: "pending",
      displayName: legacyDisplayName,
      contentSha256: legacyHash,
    });

    let failure: unknown;
    try {
      await runMigrationsWithActionableError(database.url, "drizzle");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/Migration 0022_document_readiness_invariant failed:/);
    expect(message).toContain("document_openable_scan_status_valid");
    expect(message).toContain("1 row");
    expect(message.length).toBeLessThan(500);
    expect(message).not.toContain(legacyDisplayName);
    expect(message).not.toContain(legacyHash);

    expect(await readAppliedMigrationHashes(database.client)).toEqual(beforeAttempt);
    const [constraintRow] = await database.client.unsafe(`
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE c.conname = 'document_openable_scan_status_valid' AND t.relname = 'documents'
    `);
    expect(constraintRow).toBeUndefined();

    const legacyRows = await database.client.unsafe(
      `SELECT "lifecycle", "scan_status", "display_name", "content_sha256" FROM "documents" WHERE "household_id" = $1`,
      [householdId],
    );
    expect(legacyRows).toEqual([{
      lifecycle: "available",
      scan_status: "pending",
      display_name: legacyDisplayName,
      content_sha256: legacyHash,
    }]);
  });
});
