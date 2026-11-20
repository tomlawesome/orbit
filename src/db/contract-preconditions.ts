import { CONTENT_INDEX_BACKFILL_BATCH_SIZE, DOCUMENT_WORKER_POLL_MS } from "../server/document-maintenance/backfill-rate";
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

/*
 * Worked out from the defaults: the batch and the tick are fixed settings, but
 * a cycle that has other work to do, or a restart, can make the real rate
 * lower, so the text says "about".
 */
const BACKFILL_DOCUMENTS_PER_MINUTE = Math.round(CONTENT_INDEX_BACKFILL_BATCH_SIZE * (60_000 / DOCUMENT_WORKER_POLL_MS));

export const CONTRACT_PRECONDITIONS: readonly ContractPrecondition[] = [
  {
    // The drop ships later (note 58520 decision 3, build note C). Until then
    // its tag is in no journal, so this runs against today's column and
    // passes once the backfill has sealed every row. The number 0017 is
    // already taken (0017_imap_attachment_hash_sealed), so this tag must be
    // changed to the next free number when the drop is written, and the drop
    // must be generated under whatever tag this entry holds at that time. A
    // gate whose tag matches no migration is skipped silently; the guard test
    // in contract-preconditions.test.ts enforces the match.
    migrationTag: "0017_drop_document_content_sha256",
    column: "documents.content_sha256",
    description: "documents whose content hash is still stored in plain form, not yet sealed under the household key",
    pendingSql: "SELECT count(*) FROM documents WHERE content_sha256 IS NOT NULL",
    remedy: [
      `Orbit is still moving documents under the household key. The running version finishes this in the background, about ${BACKFILL_DOCUMENTS_PER_MINUTE} documents a minute.`,
      "Leave Orbit running and run the update again later.",
      "If Orbit is locked because its household key is missing, restore the key and let Orbit run before updating.",
    ],
  },
  {
    // #1811 ruling (note 67362) item 3. The marker migration that retires the
    // pre-#1398 settle path ships later (item 6); until a migration carries
    // this tag the entry is skipped. Its number must be changed to the next
    // free one when that migration is written.
    migrationTag: "0023_retire_pre_1398_settle",
    column: "imap_ingestion_attachments.purge_pending",
    description: "mail attachments approved during a scanner outage before #1398 whose transfer is not yet settled: assigned and purge pending, with a document scanning, rejected or gone",
    pendingSql: "SELECT count(*) FROM imap_ingestion_attachments a WHERE a.status = 'assigned' AND a.purge_pending AND (NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = a.assigned_document_id) OR EXISTS (SELECT 1 FROM documents d WHERE d.id = a.assigned_document_id AND d.lifecycle IN ('scanning','rejected')))",
    remedy: [
      "Mail approved while the virus scanner was unreachable on an earlier Orbit is still being settled.",
      "Leave Orbit running with the scanner reachable and run the update again later.",
      "Such mail settles within the scan recovery window once the scanner answers, or sooner when the member retries or removes it from the inbox.",
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
