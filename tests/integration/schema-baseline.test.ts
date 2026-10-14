/*
 * #1403 slice E: the approved schema drops and the baseline squash.
 *
 * Specification: .agents/reviews/v0.3.0-final/plan.md, section 1 "Migrations:
 * what goes where and why", section 2 "Slice E (schema), last", and owner
 * answers Q1, Q2, Q3 and Q7. These tests describe the finished state: one
 * `0000_baseline` migration whose result is the catalogue oracle in
 * support/migration-fixture.ts, with the dead schema gone. They run against
 * the checked-in `drizzle/` folder, so they hold for whatever history produced
 * it. The one-time proof that the baseline equals the old history minus the
 * drops (pg_dump --schema-only of each) is a builder step, not a test.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXPECTED_CONSTRAINTS,
  EXPECTED_ENUMS,
  EXPECTED_INDEXES,
  EXPECTED_TABLE_COLUMNS,
  createMigrationTestDatabase,
  readAppliedMigrationHashes,
  readExpectedMigrationHashes,
  readSchemaContract,
  runMigrations,
} from "./support/migration-fixture";
import {
  MigrationIntegrityError,
  canonicalMigrationChecksum,
  verifyMigrationIntegrity,
  verifyMigrationJournalComplete,
} from "../../src/db/migration-integrity";
import { DEFAULT_THEME_PACK, themePacks } from "../../src/lib/preferences";

const MIGRATIONS = "drizzle";
const BASELINE_TAG = "0000_baseline";

const databases: Array<Awaited<ReturnType<typeof createMigrationTestDatabase>>> = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.cleanup()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function freshDatabase(label: string) {
  const database = await createMigrationTestDatabase(label);
  databases.push(database);
  await runMigrations(database.url, MIGRATIONS);
  return database;
}

async function copyOfMigrations(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "orbit-baseline-copy-"));
  directories.push(directory);
  await cp(resolve(process.cwd(), MIGRATIONS), directory, { recursive: true });
  return directory;
}

describe("the migration history is one baseline (#1403 slice E)", () => {
  it("is a single 0000_baseline migration with its snapshot and nothing else", async () => {
    const journal = JSON.parse(await readFile(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.map(({ idx, tag }) => ({ idx, tag }))).toEqual([{ idx: 0, tag: BASELINE_TAG }]);
    expect((await readdir(MIGRATIONS)).sort()).toEqual([`${BASELINE_TAG}.sql`, "meta"]);
    expect((await readdir(join(MIGRATIONS, "meta"))).sort()).toEqual(["0000_snapshot.json", "_journal.json"]);
  });

  it("migrates a fresh database to exactly the catalogue oracle, recording one migration", async () => {
    const database = await freshDatabase("baseline-oracle");

    const hashes = await readAppliedMigrationHashes(database.client);
    expect(hashes).toEqual([canonicalMigrationChecksum(await readFile(join(MIGRATIONS, `${BASELINE_TAG}.sql`)))]);
    expect(hashes).toEqual(await readExpectedMigrationHashes(MIGRATIONS));

    const contract = await readSchemaContract(database.client);
    expect(contract.enums).toEqual(EXPECTED_ENUMS);
    expect(contract.tables).toEqual(EXPECTED_TABLE_COLUMNS);
    expect(contract.constraints).toEqual(EXPECTED_CONSTRAINTS);
    expect(contract.indexes).toEqual(EXPECTED_INDEXES);
  });

  it("seeds exactly the four singleton rows the old history seeded, and no other data", async () => {
    const database = await freshDatabase("baseline-seeds");
    const tables = await database.client.unsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    const populated: string[] = [];
    for (const { table_name } of tables) {
      const [row] = await database.client.unsafe(`SELECT count(*)::int AS count FROM "${String(table_name)}"`);
      if (Number(row.count) > 0) populated.push(`${String(table_name)}=${String(row.count)}`);
    }
    expect(populated).toEqual([
      "instance_contact=1",
      "instance_maintenance=1",
      "instance_upload_limit=1",
      "mail_probe_results=1",
    ]);
  });

  it("fails the drift check when the baseline SQL is hand-edited after it was applied", async () => {
    const copy = await copyOfMigrations();
    const database = await createMigrationTestDatabase("baseline-drift");
    databases.push(database);
    await runMigrations(database.url, copy);
    await verifyMigrationIntegrity(database.client, copy);
    await verifyMigrationJournalComplete(database.client, copy);

    const baselinePath = join(copy, `${BASELINE_TAG}.sql`);
    await writeFile(baselinePath, `${await readFile(baselinePath, "utf8")}\n-- hand edit\n`);

    await expect(verifyMigrationIntegrity(database.client, copy)).rejects.toMatchObject({ code: "migration_integrity" });
    await expect(verifyMigrationJournalComplete(database.client, copy)).rejects.toBeInstanceOf(MigrationIntegrityError);
  });

  it("has a snapshot drizzle-kit can diff against: generate on the unchanged schema writes nothing", async () => {
    const copy = await copyOfMigrations();
    const before = (await readdir(copy)).sort();
    const journalBefore = await readFile(join(copy, "meta", "_journal.json"), "utf8");

    /* drizzle-kit joins --out onto the working directory, so hand it a path
       relative to it. It needs no database to generate. */
    const result = spawnSync(
      resolve(process.cwd(), "node_modules/.bin/drizzle-kit"),
      ["generate", "--dialect", "postgresql", "--schema", "./src/db/schema.ts", "--out", relative(process.cwd(), copy)],
      { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 },
    );

    expect(result.status).toBe(0);
    expect((await readdir(copy)).sort()).toEqual(before);
    expect(await readFile(join(copy, "meta", "_journal.json"), "utf8")).toBe(journalBefore);
    expect((await readdir(join(copy, "meta"))).sort()).toEqual(["0000_snapshot.json", "_journal.json"]);
  });
});

describe("dead schema the owner approved dropping (#1403 slice E)", () => {
  it("has no document_drafts table and no document_draft_status enum (Q1)", async () => {
    const database = await freshDatabase("drop-document-drafts");
    expect(await database.client.unsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'document_drafts'`,
    )).toEqual([]);
    expect(await database.client.unsafe(
      `SELECT typname FROM pg_type WHERE typname = 'document_draft_status'`,
    )).toEqual([]);
    /* Nothing left pointing at it, by name, in the catalogue. */
    expect(await database.client.unsafe(
      `SELECT conname FROM pg_constraint WHERE conname LIKE 'document_draft%'`,
    )).toEqual([]);
    expect(await database.client.unsafe(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'document_draft%'`,
    )).toEqual([]);
  });

  it("has no theme_mode enum or column and no urgency_palette column (Q2)", async () => {
    const database = await freshDatabase("drop-theme-mode");
    expect(await database.client.unsafe(`SELECT typname FROM pg_type WHERE typname = 'theme_mode'`)).toEqual([]);
    expect(await database.client.unsafe(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('theme_mode', 'urgency_palette')`,
    )).toEqual([]);
    /* The columns that stay: the rest of a user's preferences. */
    const columns = await database.client.unsafe(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_preferences' ORDER BY column_name`,
    );
    expect(columns.map((row) => row.column_name)).toEqual(expect.arrayContaining(["theme_id", "text_size"]));
  });

  /* ADR-0024's contract release (owner answer Q3 = 3b, in slice E). Each
     plaintext column goes; its encrypted sibling and blind index stay. */
  it.each([
    ["items", ["title", "notes", "reference", "provider", "cost_minor"], ["title_enc", "notes_enc", "reference_enc", "reference_index", "provider_enc", "cost_minor_enc"]],
    ["users", ["email"], ["email_enc", "email_index"]],
    ["household_invitations", ["email"], ["email_enc", "email_index"]],
    ["mail_in_sender_addresses", ["address"], ["address_enc", "address_index"]],
    ["imap_ingestion_messages", ["proposal", "field_evidence"], ["proposal_enc", "field_evidence_enc"]],
  ])("drops the plaintext metadata columns of %s and keeps the encrypted ones (Q3)", async (table, dropped, kept) => {
    const database = await freshDatabase(`drop-plaintext-${table}`);
    const rows = await database.client.unsafe(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    const present = rows.map((row) => String(row.column_name));
    for (const column of dropped) expect(present, `${table}.${column}`).not.toContain(column);
    for (const column of kept) expect(present, `${table}.${column}`).toContain(column);
  });

  it("keeps every uniqueness rule on the blind index once the plaintext indexes are gone (Q3)", async () => {
    const database = await freshDatabase("plaintext-indexes");
    const indexes = (await database.client.unsafe(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    )).map((row) => String(row.indexname));
    for (const gone of ["user_email_lookup_idx", "user_email_unique_ci", "household_invitation_open_once", "mail_in_sender_address_unique"]) {
      expect(indexes, gone).not.toContain(gone);
    }
    for (const kept of ["user_email_unique_index", "household_invitation_open_once_index", "mail_in_sender_address_unique_index", "item_household_reference_index_idx"]) {
      expect(indexes, kept).toContain(kept);
    }
  });

  it("still rejects a second account, sender or open invitation with the same blind index (Q3)", async () => {
    const database = await freshDatabase("blind-index-rules");
    const householdId = randomUUID();
    await database.client.unsafe(`INSERT INTO "households" (id, name) VALUES ($1, 'Blind index household')`, [householdId]);
    const insertUser = (index: string) => database.client.unsafe(
      `INSERT INTO "users" ("email_enc", "email_index", "display_name") VALUES ('mdv1.a.b.c', $1, 'Person') RETURNING "id"`,
      [index],
    );
    const [user] = await insertUser("account-index");
    await expect(insertUser("account-index")).rejects.toMatchObject({ constraint_name: "user_email_unique_index" });

    const insertSender = (index: string) => database.client.unsafe(
      `INSERT INTO "mail_in_sender_addresses" ("user_id", "address_enc", "address_index") VALUES ($1, 'mdv1.a.b.c', $2)`,
      [user.id, index],
    );
    await insertSender("sender-index");
    await expect(insertSender("sender-index")).rejects.toMatchObject({ constraint_name: "mail_in_sender_address_unique_index" });

    let digest = 0;
    const insertInvitation = (index: string) => database.client.unsafe(
      `INSERT INTO "household_invitations" ("household_id", "email_enc", "email_index", "token_digest", "expires_at")
       VALUES ($1, 'mdv1.a.b.c', $2, $3, now() + interval '7 days')`,
      [householdId, index, String((digest += 1)).padStart(64, "0")],
    );
    await insertInvitation("invitee-index");
    await expect(insertInvitation("invitee-index")).rejects.toMatchObject({ constraint_name: "household_invitation_open_once_index" });
  });
});

describe("the default theme is a real pack (#1403 slice E, Q7)", () => {
  it("gives a new preferences row a theme_id that is one of the shipped theme packs", async () => {
    const database = await freshDatabase("theme-default");
    const [user] = await database.client.unsafe(
      `INSERT INTO "users" ("email_enc", "email_index", "display_name") VALUES ('mdv1.a.b.c', 'theme-user', 'Theme user') RETURNING "id"`,
    );
    const [preferences] = await database.client.unsafe(
      `INSERT INTO "user_preferences" ("user_id") VALUES ($1) RETURNING "theme_id"`,
      [user.id],
    );
    /* Not the pre-#325 "after-dark" spelling, which was never a pack id. */
    expect(preferences.theme_id).toBe(DEFAULT_THEME_PACK);
    expect(themePacks as readonly string[]).toContain(String(preferences.theme_id));

    const [column] = await database.client.unsafe(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_preferences' AND column_name = 'theme_id'`,
    );
    expect(String(column.column_default)).toBe(`'${DEFAULT_THEME_PACK}'::text`);
  });
});
