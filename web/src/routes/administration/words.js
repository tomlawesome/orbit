/*
 * What administration says, held once so the desk's cards and the pocket's
 * rows say the same thing (#1123). Moved verbatim from +page.svelte.
 */

/** @param {string} name */
export const initialsOf = (name) =>
  name.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase();

/** The lapse date as a reader reads it, in UTC so the gate photographs one date. @param {string} iso */
export const lapses = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * The lapse date on the pocket, day and month only (round 3 §3.9): the
 * setup-link line is `setup link sent · lapses 3 Oct`. @param {string} iso
 */
export const lapsesShort = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * The instance line on the pocket (round 3 §3.9, owner answer 10b): one line
 * of caps, `ORBIT 1.3.0 · PREVIEW · FD6A7E6`, read off the desk's own line
 * (workspace.js's instanceLineOf, or the fixture's) with its labels and the
 * self-hosted promise dropped. @param {string} line
 */
export const versionLine = (line) =>
  line.split(" · ")
    .filter((part) => !/^self-hosted/i.test(part))
    .map((part) => part.replace(/^(CHANNEL|REVISION) /, "").replace(/^ORBIT v/, "ORBIT ").toUpperCase())
    .join(" · ");

/** The mailer's bounded word, said plainly. @param {string} reason */
export const sendWords = (reason) =>
  reason === "smtp_unconfigured"
    ? "this instance has no outgoing mail configured, so nothing was sent"
    : reason === "smtp_unavailable"
      ? "the mail server could not be reached, so nothing was sent"
      : reason === "smtp_rejected"
        ? "the mail server refused the message, so nothing was sent"
        : "the message could not be sent";

/** What a refused action means here, from the bounded code. @param {unknown} error */
export function setupWords(error) {
  const code = /** @type {{ code?: string, message?: string }} */ (error)?.code;
  if (code === "recent_authentication_required") return "that isn't your current password — nothing was created";
  if (code === "too_many_attempts") return "too many attempts at once; try again shortly";
  if (code === "provider_handover_unreadable") {
    return "not started — Orbit could not hand you to your identity provider";
  }
  return /** @type {{ message?: string }} */ (error)?.message ?? String(error);
}

/** @param {string} word */
export const plainly = (word) => word.replaceAll("_", " ");

/** @param {?string} iso */
export const stamp = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "UTC" }) : "never");

/**
 * How long the rotation card's subject has been open (#956), in the
 * sentence register — "open 3 days" — where format.js's ago() speaks in
 * chrome shorthand and appends "ago".
 * @param {string} iso
 */
export const openFor = (iso) => {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
};

/** The setup link's lifetime, in days, as the server bounds it (ADR-0023 §3). */
export const SETUP_LINK_DAYS = { min: 1, max: 14, fallback: 7 };

/* ── document jobs and the two mail tests (#1071, #1055 round 2) ───────── */

/** A job's kind as its row's title. Kind only, never the document (owner, 2026-09-19). */
export const JOB_KINDS = /** @type {Record<string, string>} */ ({
  scan: "Virus scan", encrypt: "Encryption", purge: "Purge", reconcile: "Reconcile", rewrap: "Re-key",
});

/** The server's bounded failure codes, in plain words. */
export const JOB_REASONS = /** @type {Record<string, string>} */ ({
  key_unavailable: "the encryption key wasn’t available",
  purge_failed: "the stored file couldn’t be removed",
  processing_interrupted: "processing was interrupted",
  storage_object_missing: "the stored file is missing",
  scanner_unavailable: "couldn’t reach the scanner",
  scanner_timeout: "the scanner took too long",
  scanner_protocol: "the scanner’s answer couldn’t be read",
  scanner_failed: "the scanner failed",
  stage_purge_failed: "the upload’s staging copy couldn’t be removed",
  scan_recovery_expired: "the scan couldn’t be recovered in time",
  staging_object_invalid: "the uploaded file couldn’t be read",
  unknown: "failed for a reason Orbit doesn’t name",
});

/** A job's state as its pill says it, and the order the card reads them in. */
export const JOB_STATES = /** @type {Record<string, { word: string, tone: string, rank: number }>} */ ({
  failed: { word: "failed", tone: "over", rank: 0 },
  retry: { word: "retrying", tone: "soon", rank: 1 },
  processing: { word: "running", tone: "up", rank: 2 },
  pending: { word: "queued", tone: "up", rank: 3 },
  completed: { word: "done", tone: "", rank: 4 },
  cancelled: { word: "cancelled", tone: "", rank: 5 },
});

/** The test's bounded answer: passed, still running, or failed and why. */
const PASSED = new Set(["available", "ready"]);
const BUSY = new Set(["verification_pending", "retrying"]);
const TEST_REASONS = /** @type {Record<string, string>} */ ({
  provider_unavailable: "the mail provider couldn’t be reached",
  unsafe_input: "the settings Orbit holds can’t be used as they are",
  credential_locked: "the stored password is locked · the encryption key isn’t available",
  not_configured: "no mailbox is set up",
  disabled: "ingest is paused",
  exhausted: "it gave up after repeated failures",
  retention_backlog: "old mail is waiting to be cleared",
  smtp_rejected: "the relay refused the sign-in details",
  smtp_unavailable: "the relay couldn’t be reached",
  smtp_unconfigured: "no outgoing mail is configured",
});

/** @param {string} result */
export const testVerdict = (result) => PASSED.has(result)
  ? { word: "passed", tone: "ok", reason: "" }
  : BUSY.has(result)
    ? { word: "checking", tone: "up", reason: "a test is already running · try again in a moment" }
    : { word: "failed", tone: "over", reason: TEST_REASONS[result] ?? plainly(result) };
