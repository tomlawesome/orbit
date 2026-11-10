/**
 * How long Orbit keeps what it has been asked to let go, in a module of its
 * own so the session payload can state them (#1336) without loading the
 * mail ingester or the household lifecycle (and the database) with it.
 */

const DAY_MS = 86_400_000;

/**
 * How long a mail-in receipt (and its held suggestion) waits for review
 * before expiring. Owner decision, 2026-08-15 (#434): 45 days, up from 30 —
 * a forwarded document should survive a long holiday.
 */
export const RECEIPT_RETENTION_MS = 45 * DAY_MS;

/**
 * How long a refused upload's `rejected` row is kept before the document
 * worker deletes it (#1786): 45 days, as for a mail-in receipt, so a member
 * back from a long holiday still sees what was refused. Measured from the
 * row's `updated_at`, which nothing writes after the rejection. The
 * `document_rejected_*` audit rows are kept.
 */
export const REJECTED_DOCUMENT_RETENTION_MS = 45 * DAY_MS;

/** How long a household whose deletion was requested can still be restored. */
export const RECOVERY_WINDOW_MS = 30 * DAY_MS;

/** Whole days, for the words the screens print. */
export function wholeDays(ms: number): number {
  return Math.round(ms / DAY_MS);
}
