import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXPECTED_ENUMS,
  EXPECTED_CONSTRAINTS,
  EXPECTED_INDEXES,
  EXPECTED_POSTGRES_MAJOR,
  EXPECTED_TABLE_COLUMNS,
  createInvalidMigrationDirectory,
  createMigrationTestDatabase,
  readAppliedMigrationHashes,
  readExpectedMigrationHashes,
  readPostgresMajor,
  readSchemaContract,
  runMigrations,
  runMigrationsWithActionableError,
} from "./support/migration-fixture";
import { MigrationIntegrityError, verifyMigrationIntegrity, verifyMigrationJournalComplete } from "../../src/db/migration-integrity";

type MigrationTestClient = Awaited<ReturnType<typeof createMigrationTestDatabase>>["client"];

async function insertFixtureHousehold(client: MigrationTestClient, id: string): Promise<void> {
  await client.unsafe(`INSERT INTO "households" (id, name) VALUES ($1, $2)`, [id, "Synthetic readiness household"]);
}

/* The plaintext address column is gone (#1403 slice E); an account is
   identified by its blind index, so the fixture supplies a stand-in for one. */
async function insertFixtureUser(client: MigrationTestClient, emailIndex: string): Promise<string> {
  const [row] = await client.unsafe(
    `INSERT INTO "users" ("email_enc", "email_index", "display_name") VALUES ('mdv1.a.b.c', $1, $2) RETURNING "id"`,
    [emailIndex, "Fixture user"],
  );
  return String(row.id);
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
  it("migrates every current migration into a fresh PostgreSQL 18 database", async () => {
    const database = await createMigrationTestDatabase("fresh");
    databases.push(database);

    await verifyMigrationIntegrity(database.client, "drizzle");
    await runMigrations(database.url, "drizzle");
    await verifyMigrationJournalComplete(database.client, "drizzle");

    expect(await readPostgresMajor(database.client)).toBe(EXPECTED_POSTGRES_MAJOR);
    expect(await readAppliedMigrationHashes(database.client)).toEqual(await readExpectedMigrationHashes("drizzle"));
    expect((await readSchemaContract(database.client)).enums).toEqual(EXPECTED_ENUMS);
    expect((await readSchemaContract(database.client)).tables).toEqual(EXPECTED_TABLE_COLUMNS);
    expect((await readSchemaContract(database.client)).constraints).toEqual(EXPECTED_CONSTRAINTS);
    expect((await readSchemaContract(database.client)).indexes).toEqual(EXPECTED_INDEXES);

    /* 0028 seeds the inactive maintenance singleton unconditionally
       (orbit#522): unlike 0027's primary administrator, there is no
       existing-installation ambiguity to resolve, so every fresh database
       gets exactly one inactive row and no audit event. */
    // postgres.js returns bigint columns as strings by default (precision
    // safety), unlike drizzle's mapped reads elsewhere in this suite.
    const maintenanceRows = await database.client.unsafe(`SELECT "singleton", "active", "version" FROM "instance_maintenance"`);
    expect(maintenanceRows).toEqual([{ singleton: true, active: false, version: "1" }]);

    /* 0033 seeds the contact singleton unconditionally too (#860): every
       fresh instance starts with no public contact address, which is a
       supported, working state rather than an absent row. */
    const contactRows = await database.client.unsafe(`SELECT "singleton", "public_address", "version" FROM "instance_contact"`);
    expect(contactRows).toEqual([{ singleton: true, public_address: null, version: "1" }]);

    /* 0047 seeds the mail-probe singleton unconditionally too (#1071): every
       fresh instance starts with neither test ever having run, a supported,
       working state (a pill that says so, not an absent row). */
    const mailProbeRows = await database.client.unsafe(
      `SELECT "singleton", "mailbox_result", "relay_result" FROM "mail_probe_results"`,
    );
    expect(mailProbeRows).toEqual([{ singleton: true, mailbox_result: null, relay_result: null }]);

    /* 0049 seeds the upload-limit singleton unconditionally too (#1285):
       every fresh instance starts with no administrator override, so the
       limit is DOCUMENT_MAX_BYTES until someone chooses otherwise. */
    const uploadLimitRows = await database.client.unsafe(
      `SELECT "singleton", "max_bytes", "version" FROM "instance_upload_limit"`,
    );
    expect(uploadLimitRows).toEqual([{ singleton: true, max_bytes: null, version: "1" }]);
  });

  it("fails closed on checksum drift", async () => {
    const database = await createMigrationTestDatabase("integrity");
    databases.push(database);
    await runMigrations(database.url, "drizzle");
    await verifyMigrationIntegrity(database.client, "drizzle");

    await database.client.unsafe('UPDATE "drizzle"."__drizzle_migrations" SET "hash" = $1 WHERE "id" = 1', ["f".repeat(64)]);
    await expect(verifyMigrationIntegrity(database.client, "drizzle")).rejects.toBeInstanceOf(MigrationIntegrityError);
  });

  it("lets only one invitation per household and address stay open, and bounds send_error to its classes (#481)", async () => {
    const database = await createMigrationTestDatabase("invitations");
    databases.push(database);
    await runMigrations(database.url, "drizzle");

    const householdId = randomUUID();
    await insertFixtureHousehold(database.client, householdId);
    const insert = (digest: string) => database.client.unsafe(
      `INSERT INTO "household_invitations" ("household_id", "email_enc", "email_index", "token_digest", "expires_at")
       VALUES ($1, 'mdv1.a.b.c', $2, $3, now() + interval '14 days')`,
      [householdId, "invited-address-blind-index", digest],
    );

    await expect(insert("a".repeat(64))).resolves.toBeDefined();
    /* The partial unique index is the "resend replaces" rule in the database:
       a second OPEN invitation to the same address cannot exist at all. */
    await expect(insert("b".repeat(64))).rejects.toThrow(/household_invitation_open_once_index/u);
    /* Withdrawn, and the address is free again — the audit row survives. */
    await database.client.unsafe(`UPDATE "household_invitations" SET "revoked_at" = now()`);
    await expect(insert("c".repeat(64))).resolves.toBeDefined();

    /* send_error carries a bounded class, never a provider message. */
    await expect(
      database.client.unsafe(`UPDATE "household_invitations" SET "send_error" = 'smtp_rejected'`),
    ).resolves.toBeDefined();
    await expect(
      database.client.unsafe(`UPDATE "household_invitations" SET "send_error" = '550 no such user someone@example.invalid'`),
    ).rejects.toThrow(/household_invitation_send_error_valid/u);
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

  it("keeps the metadata key scopes honest: one per household, exactly one instance row (0040, ADR-0024)", async () => {
    const database = await createMigrationTestDatabase("tier1-metadata-key-scopes");
    databases.push(database);
    await runMigrations(database.url, "drizzle");

    const householdId = randomUUID();
    await insertFixtureHousehold(database.client, householdId);
    const insertKey = (scope: string, household: string | null, keyId: string) => database.client.unsafe(
      `INSERT INTO "metadata_keys" ("scope", "household_id", "envelope_version", "wrapped_dek", "wrap_iv", "wrap_auth_tag", "key_id")
       VALUES ($1, $2, 1, 'dek', 'iv', 'tag', $3)`,
      [scope, household, keyId],
    );

    await expect(insertKey("household", householdId, "key-one")).resolves.toBeDefined();
    /* One DEK per household: a second row for the same household would leave
       half its values on a key nothing reads. */
    await expect(insertKey("household", householdId, "key-two")).rejects.toThrow(/metadata_keys_household_unique/u);
    /* The check constraint pairs scope with household_id in both directions. */
    await expect(insertKey("household", null, "key-three")).rejects.toThrow(/metadata_keys_scope_household_valid/u);
    await expect(insertKey("instance", householdId, "key-four")).rejects.toThrow(/metadata_keys_scope_household_valid/u);

    await expect(insertKey("instance", null, "key-five")).resolves.toBeDefined();
    /* PostgreSQL treats every NULL as distinct, so the plain unique index
       above does not constrain this one; the partial index is what does. */
    await expect(insertKey("instance", null, "key-six")).rejects.toThrow(/metadata_keys_instance_unique/u);

    /* Dropping a household drops its key, which crypto-shreds any stray copy
       of that household's ciphertext. */
    await database.client.unsafe(`DELETE FROM "households" WHERE "id" = $1`, [householdId]);
    expect(await database.client.unsafe(`SELECT count(*)::int AS count FROM "metadata_keys" WHERE "scope" = 'household'`))
      .toEqual([{ count: 0 }]);
    expect(await database.client.unsafe(`SELECT count(*)::int AS count FROM "metadata_keys" WHERE "scope" = 'instance'`))
      .toEqual([{ count: 1 }]);
  });

  it("carries 'one account per address' onto the blind index (0044, ADR-0024 decision 2)", async () => {
    const database = await createMigrationTestDatabase("account-address-blind-index");
    databases.push(database);
    await runMigrations(database.url, "drizzle");

    const [first] = await database.client.unsafe(
      `INSERT INTO "users" ("email_enc", "email_index", "display_name")
       VALUES ('mdv1.a.b.c', 'shared-index-value', 'First') RETURNING "id"`,
    );
    expect(first.id).toBeDefined();

    /* The rule the plaintext unique index used to enforce. Without this index
       it would have gone quietly when the plaintext was cleared, because
       PostgreSQL counts every NULL as distinct. */
    await expect(database.client.unsafe(
      `INSERT INTO "users" ("email_enc", "email_index", "display_name")
       VALUES ('mdv1.a.b.c', 'shared-index-value', 'Second')`,
    )).rejects.toMatchObject({ constraint_name: "user_email_unique_index" });
    await expect(database.client.unsafe(
      `INSERT INTO "users" ("email_enc", "email_index", "display_name")
       VALUES ('mdv1.a.b.c', 'another-index-value', 'Third')`,
    )).resolves.toBeDefined();
  });

  it("carries 'one open invitation per address' onto the blind index (0041, ADR-0024 decision 2)", async () => {
    const database = await createMigrationTestDatabase("tier2-invitation-blind-index");
    databases.push(database);
    await runMigrations(database.url, "drizzle");

    const householdId = randomUUID();
    await insertFixtureHousehold(database.client, householdId);
    let digestSeed = 0;
    const insertInvitation = (emailIndex: string | null) => database.client.unsafe(
      `INSERT INTO "household_invitations" ("household_id", "email_enc", "email_index", "token_digest", "expires_at")
       VALUES ($1, 'mdv1.a.b.c', $2, $3, now() + interval '7 days')`,
      [householdId, emailIndex, String(digestSeed += 1).padStart(64, "0")],
    );

    await expect(insertInvitation("digest-one")).resolves.toBeDefined();
    /* The rule the plaintext index used to enforce, now enforced on the
       digest: without this, clearing the plaintext would have retired it
       silently, because PostgreSQL treats every NULL as distinct. */
    await expect(insertInvitation("digest-one")).rejects.toThrow(/household_invitation_open_once_index/u);
    await expect(insertInvitation("digest-two")).resolves.toBeDefined();

    /* A withdrawn invitation is not open, so the address may be invited again. */
    await database.client.unsafe(
      `UPDATE "household_invitations" SET "revoked_at" = now() WHERE "email_index" = 'digest-one'`,
    );
    await expect(insertInvitation("digest-one")).resolves.toBeDefined();
  });

  it("bounds a credential setup token to its two purposes and cascades with its user (0038, ADR-0023 §2)", async () => {
    const database = await createMigrationTestDatabase("credential-setup-tokens");
    databases.push(database);
    await runMigrations(database.url, "drizzle");

    const userId = await insertFixtureUser(database.client, "setup-token-owner@example.invalid");
    const insertToken = (purpose: string, tokenHash: string) => database.client.unsafe(
      `INSERT INTO "credential_setup_tokens" ("user_id", "token_hash", "purpose", "expires_at")
       VALUES ($1, $2, $3, now() + interval '1 day')`,
      [userId, tokenHash, purpose],
    );

    await expect(insertToken("setup", "a".repeat(64))).resolves.toBeDefined();
    await expect(insertToken("recovery", "b".repeat(64))).resolves.toBeDefined();
    await expect(insertToken("bogus", "c".repeat(64))).rejects.toThrow(/credential_setup_tokens_purpose/u);

    /* The setup token is a child of the user it was issued for: deleting the
       user must not leave an orphaned token behind. */
    await database.client.unsafe(`DELETE FROM "users" WHERE "id" = $1`, [userId]);
    expect(await database.client.unsafe(
      `SELECT count(*)::int AS count FROM "credential_setup_tokens" WHERE "user_id" = $1`,
      [userId],
    )).toEqual([{ count: 0 }]);
  });
});
