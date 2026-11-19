/**
 * The two settings that fix how fast the content backfill runs (#1874 A-F4),
 * kept here, free of database imports, so the update preflight can derive its
 * "documents a minute" text from them. Both are fixed: no environment setting
 * overrides either.
 */
/** Rows one maintenance cycle looks at. */
export const CONTENT_INDEX_BACKFILL_BATCH_SIZE = 200;
/** Milliseconds between maintenance cycles. */
export const DOCUMENT_WORKER_POLL_MS = 60_000;
