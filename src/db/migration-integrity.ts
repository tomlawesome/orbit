import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { operationalDetail, type OperationalDetail } from "@/lib/logger";

export type SqlClient = { unsafe(query: string): Promise<Array<Record<string, unknown>>> };

export type MigrationIntegrityCode = "database_floor" | "migration_integrity";

export class MigrationIntegrityError extends Error {
  readonly code: MigrationIntegrityCode;
  /**
   * A bounded description of what disagreed, for the operator's log (#437).
   * Refusing to start is correct; refusing without saying which migration
   * disagreed leaves nothing to act on. Its type is the log's own
   * `OperationalDetail` (#718), so it can only be written as a source literal
   * with tags and counts interpolated - never SQL, connection details or
   * credentials - and it reaches the rendered log line unchanged.
   */
  readonly detail?: OperationalDetail;

  constructor(code: MigrationIntegrityCode, detail?: OperationalDetail) {
    super("Orbit migration integrity check failed");
    this.name = "MigrationIntegrityError";
    this.code = code;
    this.detail = detail;
  }
}

const SUPPORTED_FLOOR_TAG = "0017_imap_recipient_alias_index";

export function canonicalMigrationChecksum(content: string | Buffer): string {
  return createHash("sha256").update(content.toString().replace(/\r\n/gu, "\n"), "utf8").digest("hex");
}

export async function readExpectedMigrationHashes(folder: string): Promise<Array<{ tag: string; hash: string }>> {
  try {
    const journal = JSON.parse(await readFile(join(folder, "meta", "_journal.json"), "utf8")) as {
      entries?: Array<{ tag?: string }>;
    };
    if (!Array.isArray(journal.entries)) throw new MigrationIntegrityError("migration_integrity");
    return await Promise.all(journal.entries.map(async (entry) => {
      if (typeof entry.tag !== "string" || !/^[0-9]{4}_[A-Za-z0-9_-]+$/u.test(entry.tag)) {
        throw new MigrationIntegrityError("migration_integrity");
      }
      return { tag: entry.tag, hash: canonicalMigrationChecksum(await readFile(join(folder, `${entry.tag}.sql`), "utf8")) };
    }));
  } catch (error) {
    if (error instanceof MigrationIntegrityError) throw error;
    throw new MigrationIntegrityError("migration_integrity");
  }
}

async function hasExistingProductTables(client: SqlClient): Promise<boolean> {
  const rows = await client.unsafe(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('users', 'households', 'memberships', 'sessions', 'documents')) AS present`,
  );
  return rows[0]?.present === true || rows[0]?.present === "true";
}

export async function readAppliedMigrationHashes(client: SqlClient): Promise<string[]> {
  const rows = await client.unsafe('SELECT "hash" FROM "drizzle"."__drizzle_migrations" ORDER BY "id"');
  return rows.map((row) => String(row.hash));
}

/** Confirms that the database journal is an exact expected prefix before migrate(). */
export async function verifyMigrationIntegrity(client: SqlClient, folder: string): Promise<void> {
  const expected = await readExpectedMigrationHashes(folder);
  let applied: string[];
  try {
    applied = await readAppliedMigrationHashes(client);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "42P01") {
      // A genuinely fresh database has neither the journal nor the product
      // schema. Existing product data without a journal cannot be safely
      // classified and therefore fails closed at the supported floor.
      if (await hasExistingProductTables(client)) {
        throw new MigrationIntegrityError("database_floor");
      }
      return;
    }
    throw new MigrationIntegrityError("migration_integrity");
  }
  const floorIndex = expected.findIndex((migration) => migration.tag === SUPPORTED_FLOOR_TAG);
  if (applied.length === 0 && await hasExistingProductTables(client)) {
    throw new MigrationIntegrityError(
      "database_floor",
      operationalDetail`database has product tables but no migration journal; supported floor is ${SUPPORTED_FLOOR_TAG}`,
    );
  }
  if (applied.length > 0 && (floorIndex < 0 || applied.length < floorIndex + 1)) {
    throw new MigrationIntegrityError(
      "database_floor",
      operationalDetail`database is older than the supported floor ${SUPPORTED_FLOOR_TAG}; applied ${applied.length} migrations`,
    );
  }
  const divergence = applied.findIndex((hash, index) => expected[index]?.hash !== hash);
  if (divergence >= 0) {
    /* A tag, not a sentence: the detail helper accepts bounded tokens only,
       so the "we do not know which" case has to be one too. */
    const divergentTag = expected[divergence]?.tag ?? "unknown_migration";
    throw new MigrationIntegrityError(
      "migration_integrity",
      operationalDetail`applied migration ${divergence + 1} of ${applied.length} does not match ${divergentTag}; this database was migrated by a different build`,
    );
  }
}

/** Confirms the post-migration journal is exactly the image's full sequence. */
export async function verifyMigrationJournalComplete(client: SqlClient, folder: string): Promise<void> {
  const expected = await readExpectedMigrationHashes(folder);
  let applied: string[];
  try {
    applied = await readAppliedMigrationHashes(client);
  } catch {
    throw new MigrationIntegrityError("migration_integrity");
  }
  if (applied.length !== expected.length || applied.some((hash, index) => hash !== expected[index]?.hash)) {
    throw new MigrationIntegrityError("migration_integrity");
  }
}
