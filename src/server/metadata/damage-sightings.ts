/**
 * Counting damaged Tier 1 values (#941, ADR-0024 decision 5).
 *
 * Damage is only discoverable by decrypting, so there is nothing to count
 * unless the instance remembers what it has already seen fail. A sighting is
 * written the first time a value refuses to authenticate, keyed exactly like
 * that value's own content AAD — table, column, row — and deleted when the
 * value is written over, which is the repair. There is no sweep job: the
 * administrator card says in so many words that the number is a count of what
 * has been encountered, not of what exists.
 *
 * Recording must never fail a read. A member opening an item is not asking to
 * have their page 500 because the count could not be written, so the work is
 * queued off the read path and its failures are logged, not thrown.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { imapIngestionMessages, items, metadataDamageSightings } from "@/db/schema";
import { log, operationalDetail } from "@/lib/logger";
import type { MetadataColumn } from "@/server/metadata/crypto";
import type { MetadataExecutor } from "@/server/metadata/keys";

/** The two tables Tier 1 covers, as `row_id` addresses them. */
export type MetadataDamageTable = "items" | "imap_ingestion_messages";

interface Sighting {
  tableName: string;
  columnName: string;
  rowId: string;
}

function sightingOf(column: MetadataColumn, rowId: string): Sighting {
  const separator = column.indexOf(".");
  return { tableName: column.slice(0, separator), columnName: column.slice(separator + 1), rowId };
}

const keyOf = (sighting: Sighting) => `${sighting.tableName}.${sighting.columnName} ${sighting.rowId}`;

/**
 * Values this process has recorded as damaged and not yet seen repaired. It is
 * the gate on the clear-on-read path below: without it every successful
 * decrypt would queue a DELETE, and the overwhelmingly common case — an
 * instance with nothing damaged at all — would pay a statement per field read.
 * Being process-local only ever costs a redundant delete that a later write
 * would have done anyway; it is never the thing that decides a count.
 */
const recorded = new Set<string>();
const pendingSeen = new Map<string, Sighting>();
const pendingCleared = new Map<string, Sighting>();

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();

function schedule(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushMetadataDamageSightings();
  }, 0);
  // Never a reason for the process to stay alive: this is bookkeeping.
  flushTimer.unref?.();
}

/**
 * Records that a value failed its integrity check. Synchronous and cheap by
 * design — the caller is inside a decrypt, on a read path.
 */
export function noteMetadataDamage(column: MetadataColumn, rowId: string): void {
  const sighting = sightingOf(column, rowId);
  const key = keyOf(sighting);
  pendingCleared.delete(key);
  pendingSeen.set(key, sighting);
  recorded.add(key);
  schedule();
}

/**
 * Records that a value this process had seen damaged now decrypts. Does
 * nothing — no queue entry, no statement — for a value that was never seen
 * damaged here, which is every value on a healthy instance.
 */
export function noteMetadataReadable(column: MetadataColumn, rowId: string): void {
  const sighting = sightingOf(column, rowId);
  const key = keyOf(sighting);
  if (!recorded.has(key)) return;
  pendingSeen.delete(key);
  pendingCleared.set(key, sighting);
  schedule();
}

/**
 * Drops every sighting against one row, in the caller's own transaction. This
 * is the exact repair path: `item.upsert` rewrites both Tier 1 columns of the
 * row in one statement, so whatever was damaged there is gone with it.
 */
export async function clearMetadataDamageForRow(
  table: MetadataDamageTable,
  rowId: string,
  executor: MetadataExecutor = getDb(),
): Promise<void> {
  await executor.delete(metadataDamageSightings).where(and(
    eq(metadataDamageSightings.tableName, table),
    eq(metadataDamageSightings.rowId, rowId),
  ));
  // A sighting queued by the read that opened the panel must not outlive the
  // write that repaired it, or the flush would re-insert what was just deleted.
  for (const [key, sighting] of [...pendingSeen]) {
    if (sighting.tableName === table && sighting.rowId === rowId) pendingSeen.delete(key);
  }
  for (const key of [...recorded]) {
    if (key.startsWith(`${table}.`) && key.endsWith(` ${rowId}`)) recorded.delete(key);
  }
}

async function runFlush(): Promise<void> {
  const seen = [...pendingSeen.values()];
  const cleared = [...pendingCleared.values()];
  pendingSeen.clear();
  pendingCleared.clear();
  if (!seen.length && !cleared.length) return;
  try {
    if (seen.length) {
      await getDb().insert(metadataDamageSightings).values(seen).onConflictDoNothing();
    }
    for (const sighting of cleared) {
      await getDb().delete(metadataDamageSightings).where(and(
        eq(metadataDamageSightings.tableName, sighting.tableName),
        eq(metadataDamageSightings.columnName, sighting.columnName),
        eq(metadataDamageSightings.rowId, sighting.rowId),
      ));
      recorded.delete(keyOf(sighting));
    }
  } catch (error) {
    // The count is worth less than the read that produced it. Nothing a member
    // sees is affected — the read already answered, and the field's own damaged
    // marker went with it — so the impact is none and only the administrator
    // count is short.
    log.warn({
      event: "metadata.integrity",
      state: "degraded",
      reason: "unexpected_failure",
      impact: "none",
      action: "inspect_admin_diagnostics",
      detail: operationalDetail`${error instanceof Error ? error.name : "unknown error"} while recording damaged Tier 1 values`,
    });
  }
}

/** Runs the queued work now. Awaited by tests and by the health read. */
export function flushMetadataDamageSightings(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  chain = chain.then(runFlush, runFlush);
  return chain;
}

export interface MetadataDamageCounts {
  values: number;
  items: number;
  receipts: number;
}

/**
 * How many damaged values are known, and how many rows they sit on.
 *
 * Each half joins the table its sightings address, so a row that has since
 * been deleted — a receipt that burned up, an item that went with its
 * household — stops counting the moment it goes, with no sweep job to run and
 * nothing left claiming damage to data that no longer exists.
 *
 * `count(*)::int` rather than a bare `count(*)`: the driver hands a PostgreSQL
 * bigint back as a string, and a string reaching the response would render as
 * a plausible-looking number that arithmetic silently mangles.
 */
export async function countMetadataDamage(): Promise<MetadataDamageCounts> {
  const [itemRows, receiptRows] = await Promise.all([
    getDb().select({
      values: sql<number>`count(*)::int`,
      rows: sql<number>`count(distinct ${metadataDamageSightings.rowId})::int`,
    })
      .from(metadataDamageSightings)
      .innerJoin(items, eq(items.id, metadataDamageSightings.rowId))
      .where(eq(metadataDamageSightings.tableName, "items")),
    getDb().select({
      values: sql<number>`count(*)::int`,
      rows: sql<number>`count(distinct ${metadataDamageSightings.rowId})::int`,
    })
      .from(metadataDamageSightings)
      .innerJoin(imapIngestionMessages, eq(imapIngestionMessages.id, metadataDamageSightings.rowId))
      .where(eq(metadataDamageSightings.tableName, "imap_ingestion_messages")),
  ]);
  const itemValues = Number(itemRows[0]?.values ?? 0);
  const receiptValues = Number(receiptRows[0]?.values ?? 0);
  return {
    values: itemValues + receiptValues,
    items: Number(itemRows[0]?.rows ?? 0),
    receipts: Number(receiptRows[0]?.rows ?? 0),
  };
}

/** Test-only: the queue and the seen-damaged set outlive a fixture otherwise. */
export function resetMetadataDamageSightingsForTests(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pendingSeen.clear();
  pendingCleared.clear();
  recorded.clear();
}
