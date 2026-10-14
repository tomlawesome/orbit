import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MigrationIntegrityError,
  readExpectedMigrationHashes,
  verifyMigrationIntegrity,
  verifyMigrationJournalComplete,
} from "./migration-integrity";

const folder = "drizzle";

function clientWith(journal: string[] | Error, productTables = false) {
  return {
    unsafe: async (query: string) => {
      if (query.includes("__drizzle_migrations")) {
        if (journal instanceof Error) throw journal;
        return journal.map((hash) => ({ hash }));
      }
      return [{ present: productTables }];
    },
  };
}

describe("migration integrity", () => {
  it("accepts a genuinely fresh database with no journal or product tables", async () => {
    await expect(verifyMigrationIntegrity(clientWith(Object.assign(new Error("missing"), { code: "42P01" })), folder)).resolves.toBeUndefined();
  });

  // #822: a connection/authentication failure reaching readAppliedMigrationHashes
  // (e.g. a drifted database credential) must never be reclassified as a
  // migration/schema problem -- boot.ts's own mapping (src/server/boot.ts)
  // relies on receiving the RAW, non-MigrationIntegrityError here so it can
  // report the generic "migration_integrity" reason instead of the precise
  // (and here, wrong) "database_mismatch" one. Wrapping it, as the code did,
  // is exactly what made repair_journeys' credential-drift check intermittently
  // see "database-schema-mismatch" instead of "database-credential-mismatch".
  it("propagates a connection or authentication failure unwrapped, rather than mislabeling it a schema mismatch (#822)", async () => {
    const authFailure = Object.assign(
      new Error('password authentication failed for user "orbit"'),
      { code: "28P01" },
    );
    await expect(verifyMigrationIntegrity(clientWith(authFailure), folder)).rejects.toBe(authFailure);
  });

  it("rejects missing or empty journals when product tables already exist", async () => {
    const missing = Object.assign(new Error("missing"), { code: "42P01" });
    await expect(verifyMigrationIntegrity(clientWith(missing, true), folder)).rejects.toMatchObject({ code: "migration_integrity" });
    await expect(verifyMigrationIntegrity(clientWith([], true), folder)).rejects.toMatchObject({ code: "migration_integrity" });
  });

  it("accepts every exact prefix", async () => {
    const expected = await readExpectedMigrationHashes(folder);
    for (let length = 1; length <= expected.length; length += 1) {
      await expect(verifyMigrationIntegrity(clientWith(expected.slice(0, length).map(({ hash }) => hash)), folder)).resolves.toBeUndefined();
    }
  });

  it.each([
    ["checksum drift", (hashes: string[]) => hashes.map((hash, index) => index === 4 ? "f".repeat(64) : hash), "migration_integrity"],
    ["reordered", (hashes: string[]) => [...hashes].reverse(), "migration_integrity"],
    ["extra", (hashes: string[]) => [...hashes, "e".repeat(64)], "migration_integrity"],
  ])("rejects %s journal state", async (_label, mutate, code) => {
    const expected = await readExpectedMigrationHashes(folder);
    await expect(verifyMigrationIntegrity(clientWith(mutate(expected.map(({ hash }) => hash))), folder))
      .rejects.toMatchObject({ code });
  });

  it("requires post-migration equality with the complete expected sequence", async () => {
    const expected = await readExpectedMigrationHashes(folder);
    await expect(verifyMigrationJournalComplete(clientWith(expected.map(({ hash }) => hash)), folder)).resolves.toBeUndefined();
    await expect(verifyMigrationJournalComplete(clientWith(expected.slice(0, -1).map(({ hash }) => hash)), folder))
      .rejects.toBeInstanceOf(MigrationIntegrityError);
  });

  // #1403 slice E: the history is one baseline migration. The hash recorded
  // when it was applied is the control, so a hand-edit of the file afterwards
  // must be refused, with no database needed to show it.
  it("refuses a database whose baseline migration file was hand-edited after it was applied", async () => {
    const expected = await readExpectedMigrationHashes(folder);
    expect(expected.map(({ tag }) => tag)).toEqual(["0000_baseline"]);
    const applied = expected.map(({ hash }) => hash);

    const copy = await mkdtemp(join(tmpdir(), "orbit-integrity-copy-"));
    try {
      await cp(folder, copy, { recursive: true });
      await expect(verifyMigrationIntegrity(clientWith(applied), copy)).resolves.toBeUndefined();
      const baselinePath = join(copy, "0000_baseline.sql");
      await writeFile(baselinePath, `${await readFile(baselinePath, "utf8")}\n-- hand edit\n`);
      await expect(verifyMigrationIntegrity(clientWith(applied), copy)).rejects.toMatchObject({ code: "migration_integrity" });
      await expect(verifyMigrationJournalComplete(clientWith(applied), copy)).rejects.toBeInstanceOf(MigrationIntegrityError);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });
});
