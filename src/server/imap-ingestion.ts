/**
 * Re-exports `@/server/mail-in/imap-ingestion` under its pre-#298 import
 * path. Not inert legacy glue: `boot.ts` and `admin-operations.ts` still
 * import through here, so this stays live, not merely kept for an external
 * caller nobody has anymore (A2-Q5). Update those importers to the new path
 * before calling this safe to remove.
 */
export * from "@/server/mail-in/imap-ingestion";
