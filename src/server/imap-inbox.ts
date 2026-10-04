/**
 * Re-exports `@/server/mail-in/imap-inbox` under its pre-#298 import path.
 * Not inert legacy glue: `imap-characterization.test.ts` still imports
 * through here, so this stays live, not merely kept for an external caller
 * nobody has anymore (A2-Q5). Update that importer to the new path before
 * calling this safe to remove.
 */
export * from "@/server/mail-in/imap-inbox";
