/**
 * The administrator alert (#1421): when Orbit needs a person to act, every
 * instance administrator is mailed once, through the shared card (#1648).
 *
 * Standard pattern: deduplicated alerting with a repeat interval, made
 * race-free by claim-before-send (#1419). Per administrator, under a
 * transaction-scoped advisory lock on (kind, fault), an
 * `audit_log` row is inserted only if none exists inside 24 hours, and the
 * mail is sent only when that row is new; concurrent callers wait on the lock
 * and then see the row. A failed send deletes its row, so the next occurrence
 * tries again. The row holds the kind, a short hash of the fault key, the
 * recipient's user id, when the fault began, a `pending` flag and, once a
 * recovery ends it, when it ended: no address, household name or secret.
 *
 * The claim is an expiring lease (#1810 A-R2): written `pending: true`, and
 * set false once the mail is sent. A process killed between the two leaves a
 * pending row; once it is older than `CLAIM_LEASE_MS` the next occurrence
 * takes it over (deletes it under the lock, keeping the fault's start if it
 * was still open) and mails again. At least once: a lost "sent" write can
 * mail an administrator twice, never not at all. Rows from before the flag
 * have none and count as sent.
 *
 * It never throws into its caller. Every failure is a bounded log line
 * without the error text, which could carry a connection string.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, users } from "@/db/schema";
import { log, operationalDetail } from "@/lib/logger";
import { appHost, householdLine, renderMail } from "@/server/invitations/mail";
import { sendBoundedMail } from "@/server/invitations/send";
import { openInstanceMetadataReader } from "@/server/metadata/fields";

export type AdminAlertKind = "import_undo_failed" | "scanner_unavailable";

export interface AdminAlert {
  kind: AdminAlertKind;
  /** What makes two faults "the same": the import id for an import, one fixed key for the scanner. */
  faultKey: string;
  /** The household the fault is in; absent for an instance-wide fault such as a scanner outage (#1419). */
  householdName?: string;
  occurredAt: Date;
  /** Scanner outage only: how many new documents are held for a scan right now. */
  heldDocuments?: number;
}

const ACTION = "admin_alert_sent";
const REPEAT_MS = 24 * 3_600_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function when(date: Date): string {
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} at ${hours}:${minutes} UTC`;
}

function faultHashOf(faultKey: string): string {
  return createHash("sha256").update(faultKey).digest("hex").slice(0, 16);
}

interface AlertCopy {
  subject: string;
  preheader: string;
  lede: string;
  facts: Array<{ label: string; value: string; keep?: string[] }>;
  /** The footer's repeat line: the rule claimMail enforces for this kind (#1810 A-F8). */
  repeat: string;
}

function importUndoCopy(alert: AdminAlert, at: string): AlertCopy {
  const into = alert.householdName ? `into the ${alert.householdName} household` : "into a household";
  return {
    subject: "Orbit needs you: an import could not be undone",
    preheader: "An import failed and undoing it failed too.",
    lede: `Importing an archive ${into} failed at ${at}, and undoing it failed too. Orbit tries the undo again every fifteen minutes; until it succeeds, meanwhile the household is still closed to other members.`,
    facts: [
      { label: "what", value: "import undo failed" },
      // No household line when the household is not known (#1419 review).
      ...(alert.householdName ? [{ label: "household", value: alert.householdName }] : []),
      { label: "when", value: at, keep: [at] },
      { label: "Orbit did", value: "kept the household closed to other members until the undo finishes" },
    ],
    repeat: "Sent to every administrator. Orbit won’t repeat this for the same fault within 24 hours.",
  };
}

/**
 * Wording from design/v19/mail/round-4/l-admin-alert-scanner.html, and only
 * that. The "Orbit did" fact appears only when there are held documents to
 * count. The lede's last sentence, that members were told, is said now that
 * the member's held view is built (#1419).
 */
function scannerCopy(alert: AdminAlert, at: string): AlertCopy {
  const held = alert.heldDocuments ?? 0;
  return {
    subject: "Orbit needs you: the virus scanner is down",
    preheader: "The virus scanner stopped answering. New documents are being held.",
    lede: `The virus scanner stopped answering at ${at}. New documents are being held, not refused, until it is back. Members have been told an administrator has been notified.`,
    facts: [
      { label: "what", value: "virus scanner down" },
      { label: "since", value: at, keep: [at] },
      { label: "where", value: "the whole instance" },
      ...(held > 0 ? [{ label: "Orbit did", value: `held ${held} new ${held === 1 ? "document" : "documents"}` }] : []),
    ],
    // 24 hours inside one open outage; the hourly cap across recoveries (#1419).
    repeat:
      "Sent to every administrator. Orbit won’t repeat this within 24 hours while the scanner stays down, and never more than once an hour if it keeps dropping out.",
  };
}

function render(alert: AdminAlert) {
  const at = when(alert.occurredAt);
  const host = appHost();
  const base = (process.env.APP_URL ?? "").replace(/\/+$/u, "");
  const link = `${base}/admin`;
  const { subject, preheader, lede, facts, repeat } =
    alert.kind === "scanner_unavailable" ? scannerCopy(alert, at) : importUndoCopy(alert, at);
  return renderMail({
    subject,
    preheader,
    headline: "Orbit needs an administrator",
    body: [lede],
    button: { label: "open Administration", href: link },
    facts,
    footer: [repeat, householdLine(host)],
    text: [
      "Orbit needs an administrator",
      "",
      lede,
      "",
      ...facts.map((fact) => `${fact.label}: ${fact.value}`),
      "",
      `Open Administration: ${link}`,
      "",
      repeat,
      householdLine(host),
      "",
    ].join("\n"),
  });
}

function logFailure(detail: ReturnType<typeof operationalDetail>): void {
  log.warn({
    event: "delivery.smtp",
    state: "degraded",
    reason: "unexpected_failure",
    action: "check_configuration",
    impact: "none",
    detail,
  });
}

/** A flapping scanner is mailed about at most this often, outage or not (#1419). */
const SCANNER_MAIL_MIN_GAP_MS = 3_600_000;

/**
 * How long a claim whose send has not been confirmed holds (#1810 A-R2). A
 * claim is an expiring lease: written pending before the send and marked sent
 * after it, so a process killed in between leaves a pending claim that stops
 * counting once this has passed, and the next occurrence mails again. Longer
 * than any bounded send.
 */
const CLAIM_LEASE_MS = 10 * 60_000;

/** Rows of one kind and fault; `open` adds "not yet ended by a recovery". */
function sameFault(kind: AdminAlertKind, faultHash: string, open = false) {
  return and(
    eq(auditLog.action, ACTION),
    sql`${auditLog.changes}->>'kind' = ${kind}`,
    sql`${auditLog.changes}->>'faultHash' = ${faultHash}`,
    ...(open ? [sql`${auditLog.changes}->>'endedAt' is null`] : []),
  );
}

/** A claim marked pending and older than the lease: its send never confirmed. */
function expiredClaim(now: Date) {
  return and(
    sql`(${auditLog.changes}->>'pending')::boolean is true`,
    lt(auditLog.createdAt, new Date(now.getTime() - CLAIM_LEASE_MS)),
  );
}

/** Serialises every claim and recovery of one fault, across replicas. */
function lockFault(transaction: { execute: ReturnType<typeof getDb>["execute"] }, kind: AdminAlertKind, faultHash: string) {
  return transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:admin-alert:${kind}:${faultHash}`}, 0))`);
}

/**
 * Claims this administrator's mail for this fault: answers when the fault
 * began if the claim is new, or null when it must not be sent. The claim is
 * the audit row itself, written before the send under the fault's lock.
 *
 * A fault is open from its first record until a recovery ends it
 * (`endAdminAlertFault`). Inside one open fault an administrator is mailed
 * at most once in 24 hours, and a repeat gives the time the fault began. A
 * fault after a recovery is a new one, mailed again with its own start time,
 * but a scanner is mailed about at most once an hour so a flapping one
 * cannot flood the inbox.
 */
async function claimMail(userId: string, alert: AdminAlert, faultHash: string, now: Date): Promise<{ id: string; since: Date } | null> {
  return getDb().transaction(async (transaction) => {
    await lockFault(transaction, alert.kind, faultHash);
    const mine = sql`${auditLog.changes}->>'userId' = ${userId}`;
    // An expired claim is taken over: its mail was never confirmed sent. One
    // that was still open keeps the fault's start for the claim replacing it.
    const taken = await transaction.delete(auditLog).where(and(sameFault(alert.kind, faultHash), mine, expiredClaim(now)))
      .returning({ createdAt: auditLog.createdAt, changes: auditLog.changes });
    const [recent] = await transaction.select({ id: auditLog.id }).from(auditLog)
      .where(and(sameFault(alert.kind, faultHash, true), mine, gt(auditLog.createdAt, new Date(now.getTime() - REPEAT_MS))))
      .limit(1);
    if (recent) return null;
    if (alert.kind === "scanner_unavailable") {
      const [lastHour] = await transaction.select({ id: auditLog.id }).from(auditLog)
        .where(and(sameFault(alert.kind, faultHash), mine, gt(auditLog.createdAt, new Date(now.getTime() - SCANNER_MAIL_MIN_GAP_MS))))
        .limit(1);
      if (lastHour) return null;
    }
    const [open] = await transaction.select({ createdAt: auditLog.createdAt, changes: auditLog.changes }).from(auditLog)
      .where(sameFault(alert.kind, faultHash, true)).orderBy(desc(auditLog.createdAt)).limit(1);
    let since = alert.occurredAt;
    const stillOpen = taken.filter((row) => !(row.changes as { endedAt?: string } | null)?.endedAt);
    for (const row of [...(open ? [open] : []), ...stillOpen]) {
      const recorded = (row.changes as { since?: string } | null)?.since;
      const parsed = recorded ? new Date(recorded) : row.createdAt;
      if (Number.isFinite(parsed.getTime()) && parsed < since) since = parsed;
    }
    const id = randomUUID();
    await transaction.insert(auditLog).values({
      id,
      householdId: null,
      actorUserId: null,
      entityType: "instance_authority",
      entityId: randomUUID(),
      action: ACTION,
      changes: { kind: alert.kind, faultHash, userId, since: since.toISOString(), pending: true },
    });
    return { id, since };
  });
}

/**
 * Ends an open fault (#1419): its alert records are marked with when it
 * ended, so a later occurrence is a new fault. Writes no new row, and nothing
 * when no fault is open. Never throws: answers whether the end was recorded
 * (none open counts), so a caller can retry one that was not.
 */
export async function endAdminAlertFault(kind: AdminAlertKind, faultKey: string, endedAt: Date): Promise<boolean> {
  try {
    const faultHash = faultHashOf(faultKey);
    await getDb().transaction(async (transaction) => {
      await lockFault(transaction, kind, faultHash);
      await transaction.update(auditLog)
        .set({ changes: sql`${auditLog.changes} || ${JSON.stringify({ endedAt: endedAt.toISOString() })}::jsonb` })
        .where(sameFault(kind, faultHash, true));
    });
    return true;
  } catch {
    logFailure(operationalDetail`administrator alert recovery not recorded; the next alert continues the same fault`);
    return false;
  }
}

/** Mails every enabled administrator with a readable address. Never throws. */
export async function raiseAdminAlert(alert: AdminAlert): Promise<void> {
  try {
    const admins = await getDb()
      .select({ id: users.id, emailEnc: users.emailEnc })
      .from(users)
      .where(and(eq(users.isInstanceAdmin, true), isNull(users.disabledAt)));
    const cipher = await openInstanceMetadataReader();
    if (cipher.locked) {
      logFailure(operationalDetail`administrator alert not mailed: the metadata key is unavailable`);
      return;
    }
    const faultHash = faultHashOf(alert.faultKey);
    for (const admin of admins) {
      try {
        const address = cipher.text("users.email", admin.id, { encrypted: admin.emailEnc }).value;
        if (!address) {
          logFailure(operationalDetail`administrator alert skipped for one administrator: the address cannot be read`);
          continue;
        }
        const now = new Date();
        const claim = await claimMail(admin.id, alert, faultHash, now);
        if (!claim) continue;
        let sent = false;
        try {
          const mail = { ...render({ ...alert, occurredAt: claim.since }), what: "an administrator alert" };
          const outcome = await sendBoundedMail(address, mail, undefined, now);
          sent = outcome.sendError === null;
          if (!sent) logFailure(operationalDetail`administrator alert not sent (${outcome.sendError}); tried again on the next occurrence`);
          // Sent: the lease becomes a lasting claim. If this write is lost the
          // claim expires and the administrator may be mailed twice, never not at all.
          else await getDb().update(auditLog)
            .set({ changes: sql`${auditLog.changes} || '{"pending":false}'::jsonb` })
            .where(eq(auditLog.id, claim.id))
            .catch(() => logFailure(operationalDetail`administrator alert sent but not confirmed; it may be sent again once its claim expires`));
        } finally {
          // Unsent: the claim is given back so the next occurrence mails this administrator.
          if (!sent) await getDb().delete(auditLog).where(eq(auditLog.id, claim.id));
        }
      } catch {
        logFailure(operationalDetail`administrator alert failed for one administrator; tried again on the next occurrence`);
      }
    }
  } catch {
    logFailure(operationalDetail`administrator alert not mailed: it could not be prepared`);
  }
}
