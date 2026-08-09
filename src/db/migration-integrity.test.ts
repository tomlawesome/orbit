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

  it("rejects missing or empty journals when product tables already exist", async () => {
    const missing = Object.assign(new Error("missing"), { code: "42P01" });
    await expect(verifyMigrationIntegrity(clientWith(missing, true), folder)).rejects.toMatchObject({ code: "database_floor" });
    await expect(verifyMigrationIntegrity(clientWith([], true), folder)).rejects.toMatchObject({ code: "database_floor" });
  });

  it("accepts the supported floor and every exact prefix", async () => {
    const expected = await readExpectedMigrationHashes(folder);
    await expect(verifyMigrationIntegrity(clientWith(expected.slice(0, 18).map(({ hash }) => hash)), folder)).resolves.toBeUndefined();
    for (let length = 18; length <= expected.length; length += 1) {
      await expect(verifyMigrationIntegrity(clientWith(expected.slice(0, length).map(({ hash }) => hash)), folder)).resolves.toBeUndefined();
    }
  });

  it.each([
    ["below floor", (hashes: string[]) => hashes.slice(0, 16), "database_floor"],
    ["checksum drift", (hashes: string[]) => hashes.slice(0, 18).map((hash, index) => index === 4 ? "f".repeat(64) : hash), "migration_integrity"],
    ["reordered", (hashes: string[]) => hashes.slice(0, 18).reverse(), "migration_integrity"],
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
});
