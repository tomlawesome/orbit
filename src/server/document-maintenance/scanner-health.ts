/**
 * The scanner health check and the scanner-outage alert (#1419).
 *
 * Standard pattern: a periodic health check that raises a rate-limited alert.
 * The document-maintenance cycle runs the check every five minutes while
 * scanning is enabled; a held upload raises the same alert. Both use one
 * fault key, so the 24-hour repeat limit in `admin-alert.ts` covers both and
 * an outage is mailed once a day, however it was noticed. A check that
 * finds the scanner answering ends an open outage, so a later failure is a
 * new outage with its own start time; held documents are scanned by the
 * existing retry.
 */
import { count, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { documentStagingObjects } from "@/db/schema";
import { log } from "@/lib/logger";
import { endAdminAlertFault, raiseAdminAlert } from "@/server/admin-alert";

/** The one fault key a scanner outage is mailed under, whoever noticed it. */
export const SCANNER_UNAVAILABLE_FAULT_KEY = "malware-scanner";

/** How often the maintenance cycle checks the scanner. */
export const SCANNER_HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1_000;

async function heldDocumentCount(): Promise<number | undefined> {
  try {
    const [row] = await getDb().select({ held: count() })
      .from(documentStagingObjects).where(eq(documentStagingObjects.status, "pending"));
    return row?.held;
  } catch {
    return undefined;
  }
}

/**
 * Whether an outage may still be open in the database (#1810 A-F1, A-R1).
 * Level-triggered reconciliation: a healthy ping ends whatever outage the
 * database holds open, not only one this process saw begin. It starts true,
 * because a fresh process cannot know what an earlier one left open, and is
 * cleared only once the end is written, so a failed write is retried by the
 * next healthy ping. Once cleared, a healthy scanner costs no write per check.
 */
let outageSeen = true;

/** Tells the administrators the scanner is down. Never throws. */
export async function alertScannerUnavailable(occurredAt: Date): Promise<void> {
  outageSeen = true;
  try {
    await raiseAdminAlert({
      kind: "scanner_unavailable",
      faultKey: SCANNER_UNAVAILABLE_FAULT_KEY,
      occurredAt,
      heldDocuments: await heldDocumentCount(),
    });
  } catch { /* raiseAdminAlert does not throw; nothing here may reach the caller */ }
}

/**
 * Pings the scanner once. A ping that answers false or throws is a failure,
 * and raises the alert. Answers whether the scanner answered.
 */
export async function runScannerHealthCheck(
  deps: { ping: () => Promise<boolean> },
  options: { now: Date },
): Promise<boolean> {
  let reachable = false;
  try {
    reachable = await deps.ping();
  } catch {
    reachable = false;
  }
  if (reachable) {
    if (outageSeen && await endAdminAlertFault("scanner_unavailable", SCANNER_UNAVAILABLE_FAULT_KEY, options.now)) {
      outageSeen = false;
    }
    return true;
  }
  log.warn({
    event: "document.scan",
    state: "degraded",
    reason: "scanner_unavailable",
    action: "check_scanner",
    impact: "document_upload_blocked",
  });
  await alertScannerUnavailable(options.now);
  return false;
}
