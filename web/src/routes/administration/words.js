/*
 * What administration says, held once so the desk's cards and the pocket's
 * rows say the same thing (#1123). Moved verbatim from +page.svelte.
 */

import { constellationPlanetsOf, ringDotsOf } from "$lib/data/chart.js";
import { wordsOf } from "$lib/data/workspace.js";

import { ago, dayMonth, dayMonthYear, elapsed, plural } from "$lib/format.js";

/** The lapse date as a reader reads it, in UTC so the gate photographs one date. @param {string} iso */
export const lapses = (iso) => dayMonthYear(iso);

/**
 * A date on the pocket, day and month only (round 3 §3.9, §8): the
 * setup-link line is `setup link sent · lapses 3 Oct`, the mailbox rows
 * `verified · 12 Aug` and `1 Aug · Ned Harlow`. @param {?string} iso
 */
export const shortDay = (iso) => (iso ? dayMonth(iso) : "never");
export const lapsesShort = shortDay;

/**
 * The ingest row's meta on the pocket (round 3 §8): `every 30s` beside the
 * `on` trail, which already says enabled; the desk keeps `enabled · polling
 * every 30s`. @param {string} value
 */
export const ingestShort = (value) => value.replace(/^enabled · polling every /, "every ");

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
  return wordsOf(error);
}

/**
 * A document size limit as the upload limit card says it (#1285): whole MB
 * where it is whole, which every limit set here is. @param {number} bytes
 */
export const megabytes = (bytes) => {
  const mb = bytes / 1048576;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
};

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
export const openFor = (iso) => elapsed(iso, new Date().toISOString());

/** The setup link's lifetime, in days, as the server bounds it (ADR-0023 §3). */
export const SETUP_LINK_DAYS = { min: 1, max: 14, fallback: 7 };

/* ── document jobs and the two mail tests (#1071, #1055 round 2) ───────── */

/** A job's kind as its row's title. Kind only, never the document (owner, 2026-09-19). */
export const JOB_KINDS = /** @type {Record<string, string>} */ ({
  scan: "Virus scan", encrypt: "Encryption", purge: "Purge", reconcile: "Reconcile", rewrap: "Re-key",
});

/**
 * The server's bounded failure codes, in plain words. Each is at most 26
 * characters (round 3 §8): it is the row's whole meta at rest, in the body
 * face beside the `failed` or `retrying` pill, and must fit at 360.
 */
export const JOB_REASONS = /** @type {Record<string, string>} */ ({
  key_unavailable: "no encryption key",
  purge_failed: "stored file not removed",
  processing_interrupted: "processing was interrupted",
  storage_object_missing: "the stored file is missing",
  scanner_unavailable: "couldn’t reach the scanner",
  scanner_timeout: "the scanner took too long",
  scanner_protocol: "garbled scanner answer",
  scanner_failed: "the scanner failed",
  stage_purge_failed: "staging copy not removed",
  scan_recovery_expired: "scan not recovered in time",
  staging_object_invalid: "upload couldn’t be read",
  unknown: "reason not named",
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

/* ── what both layouts derive from the screen (#1353, web-8) ──────────── */

/** @typedef {NonNullable<Awaited<ReturnType<typeof import('$lib/data/workspace.js').readAdminScreen>>>} AdminView */
/** @typedef {NonNullable<AdminView["operations"]>["documentJobs"][number]} DocumentJob */
/** @typedef {Record<string, { status: string, at: string }>} Retried */

/** The invitation form as it opens, and as a sent link leaves it. */
export const freshInvite = () => ({ email: "", displayName: "", expiresInDays: SETUP_LINK_DAYS.fallback });

/**
 * The document jobs as the card reads them: a job retried here shows queued
 * at once, the same optimistic update on both layouts (the next re-read
 * settles it), and the list runs by what needs the reader, newest first.
 * @param {DocumentJob[]} documentJobs @param {Retried} retried
 */
export function jobsOf(documentJobs, retried) {
  const list = documentJobs.map((job) => retried[job.id]
    ? { ...job, status: /** @type {typeof job.status} */ (retried[job.id].status), attempts: 0, updatedAt: retried[job.id].at }
    : job);
  return list.sort((a, b) => (JOB_STATES[a.status]?.rank ?? 9) - (JOB_STATES[b.status]?.rank ?? 9)
    || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** The card's count line: `1 failed · 2 queued`. @param {DocumentJob[]} jobs */
export function jobCountsOf(jobs) {
  /** @type {Record<string, number>} */
  const by = {};
  for (const job of jobs) by[job.status] = (by[job.status] ?? 0) + 1;
  return ["failed", "retry", "processing", "pending", "completed"].filter((status) => by[status])
    .map((status) => `${by[status]} ${JOB_STATES[status].word}`).join(" · ");
}

/**
 * A job row's meta. A failed row says its reason; the desk adds the tries
 * and when it was last tried (`tries`), the issue's own example "couldn't
 * reach the virus scanner · 5 of 5 tries · last tried 6m ago" without the
 * "of N", since the client has no per-kind maximum. The phone keeps those
 * for the row's panel (round 3 §3.9, §8): its state pill takes the room.
 * @param {DocumentJob} job @param {string} clock @param {Retried} retried
 * @param {{ tries?: boolean }} [options]
 */
export function jobMetaOf(job, clock, retried, { tries = false } = {}) {
  if (job.status === "failed") {
    const reason = JOB_REASONS[job.lastErrorCode ?? "unknown"] ?? JOB_REASONS.unknown;
    return tries ? `${reason} · ${plural(job.attempts, "try", "tries")} · last tried ${ago(job.updatedAt, clock)}` : reason;
  }
  if (job.status === "retry") return job.lastErrorCode ? JOB_REASONS[job.lastErrorCode] ?? JOB_REASONS.unknown : `last tried ${ago(job.updatedAt, clock)}`;
  if (job.status === "pending") return retried[job.id] ? "attempt 1 · queued just now" : `queued ${ago(job.createdAt, clock)}`;
  if (job.status === "processing") return `started ${ago(job.updatedAt, clock)}`;
  return `${JOB_STATES[job.status]?.word ?? job.status} ${ago(job.updatedAt, clock)}`;
}

/** @param {?string | undefined} now */
const nowOf = (now) => Date.parse(now ?? new Date().toISOString());

/** Whole days left on a system's deletion clock, never below 0. @param {string} iso @param {?string} [now] the screen's clock */
export const daysLeft = (iso, now) => Math.max(0, Math.ceil((Date.parse(iso) - nowOf(now)) / 86_400_000));

/** Whether a system's window has run out. @param {{ deleteAfter: string }} row @param {?string} [now] the screen's clock */
export const expired = (row, now) => Date.parse(row.deleteAfter) <= nowOf(now);

/**
 * The tells: one per failure further down the page, said at the top
 * (#1071), each naming the card it belongs to. Failed jobs first, then
 * (the phone's, `services`) the first two failing services and how many
 * more, then the relay and the mailbox. With no probe yet, the mailbox's
 * own last verdict stands in (#1344). A service row's detail leads with
 * its state's own word (#1296), so the tell repeats it rather than
 * assuming every warm row is retrying.
 * @param {AdminView | null} view @param {DocumentJob[]} jobs
 * @param {{ services?: boolean }} [options]
 * @returns {{ card: "jobs" | "operations" | "mail", text: string }[]}
 */
export function tellsOf(view, jobs, { services = false } = {}) {
  /** @type {{ card: "jobs" | "operations" | "mail", text: string }[]} */
  const list = [];
  if (!view) return list;
  const failedJobs = jobs.filter((job) => job.status === "failed").length;
  if (failedJobs) list.push({ card: "jobs", text: `${plural(failedJobs, "job")} failed` });
  if (services) {
    const failing = (view.services ?? []).filter(([tone]) => tone === "overdue" || tone === "warm");
    for (const [tone, name, detail] of failing.slice(0, 2)) {
      list.push({ card: "operations", text: `${name} ${tone === "overdue" ? "down" : detail.split(" · ")[0]}` });
    }
    if (failing.length > 2) list.push({ card: "operations", text: `${failing.length - 2} more failing` });
  }
  const mailProbes = view.operations?.mailProbes ?? { mailbox: null, relay: null };
  if (mailProbes.relay && testVerdict(mailProbes.relay.result).tone === "over") list.push({ card: "mail", text: "relay failed" });
  const mailboxFailed = mailProbes.mailbox
    ? testVerdict(mailProbes.mailbox.result).tone === "over"
    : view.mailbox?.verificationState === "failed";
  if (mailboxFailed) list.push({ card: "mail", text: "mailbox failed" });
  return list;
}

/**
 * A mail test's line: checking, never tested, or the last answer's reason.
 * @param {"mailbox" | "relay"} which @param {"mailbox" | "relay" | null} testing the test running now
 * @param {NonNullable<AdminView["operations"]>["mailProbes"]} probes the server's last answers
 */
export function testMetaOf(which, testing, probes) {
  if (testing === which) return "checking now";
  const probe = probes[which];
  if (!probe) return "not tested yet";
  const verdict = testVerdict(probe.result);
  return verdict.reason || plainly(probe.result);
}

/* ── mail machinery's form (#743) ────────────────────────────────────── */

export const PROVIDER_PROFILES = ["mailcow", "gmail", "outlook", "other"];

/** The mailbox form before anything is set. */
export const blankMailDraft = () => ({
  host: "", port: 993, accountUser: "", mailbox: "INBOX", tlsServerName: "",
  providerProfile: "other", trustedRecipientHeader: "X-Original-To", pollSeconds: 300,
});

/** The mailbox form filled from what the server holds; the password is never among it. @param {NonNullable<AdminView["mailbox"]>} current */
export const mailDraftOf = (current) => ({
  host: current.host, port: current.port, accountUser: current.accountUser,
  mailbox: current.mailbox, tlsServerName: current.tlsServerName,
  providerProfile: current.providerProfile,
  trustedRecipientHeader: current.trustedRecipientHeader || "X-Original-To",
  pollSeconds: current.pollSeconds,
});

/**
 * Rotating every address keeps the old ones working this many days unless
 * the administrator chooses otherwise (0 to 90, mailbox-settings.ts): the
 * relay's own standard grace, RELAY_PREVIOUS_GRACE_MS
 * (src/server/mail-in/core/relay-generations.ts).
 */
export const ALIAS_GRACE_DAYS = 14;

/* ── a system's ring (#775) ──────────────────────────────────────────── */

/* The sheet's five hand-placed rings (design/v19/administration-iss.html,
   §Systems) turn out to be constellationPlanetsOf's own far-sky placement
   (CON-13), just re-centred on the roster's small r13 ring instead of the
   backdrop's distant one: the same orbit distance (18..30) and body size
   (2.0..2.8) divided by 6 and 4 respectively lands exactly on the sheet's
   hand-measured coordinates for all five fixture households (#775). */
const RING = { centre: 17, spread: 6, rMin: 1, rScale: 1 / 4 };

/** A system's ring wears its real due-state dots. @param {{ items?: import('$lib/data/chart.js').ChartItem[] }} system @param {string} today */
export const systemDotsOf = (system, today) => ringDotsOf(constellationPlanetsOf(system.items ?? [], today), RING);
