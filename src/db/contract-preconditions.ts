import { readExpectedMigrationHashes } from "./migration-integrity";

// Contract migrations and what must be true before each may run (#1779,
// design note 58520, build note A). Pattern: expand -> backfill -> contract,
// with a check-before-switch preflight gate. A contract migration drops what
// the previous version still empties in the background; `orbit update
// --preflight` asks the live database, before the installer replaces
// anything, whether any pending contract would refuse. The migration's own
// refusal stays the backstop for a stack that was down when the installer
// ran.
//
// A precondition is checked only while its migration tag is not in the
// journal: once the drop is applied the column is gone and its SELECT would
// itself fail. Every statement sent is a read (SELECT only).

export interface ContractPrecondition {
  /** The contract migration's drizzle tag, e.g. `0017_drop_document_content_sha256`. */
  migrationTag: string;
  /** `<table>.<column>`, as printed on the blocked line. */
  column: string;
  /** What the pending rows are, for readers of this list. Never printed. */
  description: string;
  /** A read returning one row with one cell: how many rows still block the migration. Never printed. */
  pendingSql: string;
  /** The lines printed after the blocked line: what the operator does next. */
  remedy: string[];
}

export const CONTRACT_PRECONDITIONS: readonly ContractPrecondition[] = [
  {
    // The drop ships later (note 58520 decision 3, build note C). Until then
    // its tag is in no journal, so this runs against today's column and
    // passes once the backfill has sealed every row. The drop migration must
    // be generated under exactly this tag.
    migrationTag: "0017_drop_document_content_sha256",
    column: "documents.content_sha256",
    description: "documents whose content hash is still stored in plain form, not yet sealed under the household key",
    pendingSql: "SELECT count(*) FROM documents WHERE content_sha256 IS NOT NULL",
    remedy: [
      "Orbit is still moving documents under the household key. The running version finishes this in the background, about 200 documents a minute.",
      "Leave Orbit running and run the update again later.",
      "If Orbit is locked because its household key is missing, restore the key and let Orbit run before updating.",
    ],
  },
];

export type PreflightQuery = (sql: string) => Promise<string[][]>;

export interface UpdatePreflightResult {
  ready: boolean;
  exitCode: 0 | 1;
  lines: string[];
}

export const MIGRATION_JOURNAL_SQL = 'SELECT "hash" FROM "drizzle"."__drizzle_migrations"';

function pendingCount(rows: string[][]): number {
  const cell = rows[0]?.[0];
  if (rows.length !== 1 || cell === undefined || !/^[0-9]+$/u.test(cell.trim())) {
    throw new Error("A contract precondition did not return one count.");
  }
  return Number(cell.trim());
}

/**
 * The preflight `orbit update --preflight` prints. Rejects when the journal
 * or a count cannot be read: an unanswered question is never "ready".
 */
export async function runUpdatePreflight(options: {
  query: PreflightQuery;
  migrationsFolder: string;
  preconditions?: readonly ContractPrecondition[];
}): Promise<UpdatePreflightResult> {
  const preconditions = options.preconditions ?? CONTRACT_PRECONDITIONS;
  const expected = new Map((await readExpectedMigrationHashes(options.migrationsFolder)).map((entry) => [entry.tag, entry.hash]));
  const applied = new Set((await options.query(MIGRATION_JOURNAL_SQL)).map((row) => row[0]));
  const lines: string[] = [];
  for (const precondition of preconditions) {
    // A precondition gates only the release that ships its contract migration
    // (expand/contract): when this image carries no such migration, an older
    // install's pending rows cannot block it (#1854 A-R1).
    const hash = expected.get(precondition.migrationTag);
    if (hash === undefined || applied.has(hash)) continue;
    const rows = pendingCount(await options.query(precondition.pendingSql));
    if (rows > 0) lines.push(`update-preflight: blocked ${precondition.column} rows=${rows}`, ...precondition.remedy);
  }
  if (lines.length === 0) return { ready: true, exitCode: 0, lines: ["update-preflight: ready"] };
  return { ready: false, exitCode: 1, lines };
}
