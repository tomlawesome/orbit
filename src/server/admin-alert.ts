/**
 * The administrator alert (#1421): when Orbit needs a person to act, every
 * instance administrator is mailed once, through the shared card (#1648).
 *
 * Standard pattern: deduplicated alerting with a repeat interval, made
 * race-free by claim-before-send (#1419). Per administrator, under a
 * transaction-scoped advisory lock on (kind, fault, administrator), an
 * `audit_log` row is inserted only if none exists inside 24 hours, and the
 * mail is sent only when that row is new; concurrent callers wait on the lock
 * and then see the row. A failed send deletes its row, so the next occurrence
 * tries again. The row holds the kind, a short hash of the fault key, the
 * recipient's user id and when the fault began: no address, household name
 * or secret.
 *
 * It never throws into its caller. Every failure is a bounded log line
 * without the error text, which could carry a connection string.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
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
}

function importUndoCopy(alert: AdminAlert, at: string): AlertCopy {
  const into = alert.householdName ? `into the ${alert.householdName} household` : "into a household";
  return {
    subject: "Orbit needs you: an import could not be undone",
    preheader: "An import failed and undoing it failed too.",
    lede: `Importing an archive ${into} failed at ${at}, and undoing it failed too. Orbit will finish undoing it when it is next restarted. The household’s owner has been told an administrator has been notified.`,
    facts: [
      { label: "what", value: "import undo failed" },
      // No household line when the household is not known (#1419 review).
      ...(alert.householdName ? [{ label: "household", value: alert.householdName }] : []),
      { label: "when", value: at, keep: [at] },
      { label: "Orbit did", value: "kept the household read-only until the restart" },
    ],
  };
}

/**
 * Wording from design/v19/mail/round-4/l-admin-alert-scanner.html, and only
 * that. The "Orbit did" fact appears only when there are held documents to
 * count. The line telling the administrator that members were told is left
 * out until the member view of a held document is built (#1419, parked).
 */
function scannerCopy(alert: AdminAlert, at: string): AlertCopy {
  const held = alert.heldDocuments ?? 0;
  return {
    subject: "Orbit needs you: the virus scanner is down",
    preheader: "The virus scanner stopped answering. New documents are being held.",
    lede: `The virus scanner stopped answering at ${at}. New documents are being held, not refused, until it is back.`,
    facts: [
      { label: "what", value: "virus scanner down" },
      { label: "since", value: at, keep: [at] },
      { label: "where", value: "the whole instance" },
      ...(held > 0 ? [{ label: "Orbit did", value: `held ${held} new ${held === 1 ? "document" : "documents"}` }] : []),
    ],
  };
}

function render(alert: AdminAlert) {
  const at = when(alert.occurredAt);
  const host = appHost();
  const base = (process.env.APP_URL ?? "").replace(/\/+$/u, "");
  const link = `${base}/admin`;
  const { subject, preheader, lede, facts } = alert.kind === "scanner_unavailable" ? scannerCopy(alert, at) : importUndoCopy(alert, at);
  const repeat = "Sent to every administrator. Orbit won’t repeat this for the same fault within 24 hours.";
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

/**
 * Two records of one fault at most this far apart are one continuing fault:
 * a continuing fault is re-mailed every 24 hours plus at most one check
 * interval, so two hours of slack keeps a repeat on the original start time.
 */
const CONTINUING_MS = REPEAT_MS + 2 * 3_600_000;

/**
 * Claims this administrator's mail for this fault: answers when the fault
 * began if the claim is new, or null when it was already mailed inside the
 * repeat window. The claim is the audit row itself, written before the send.
 */
async function claimMail(userId: string, alert: AdminAlert, faultHash: string, now: Date): Promise<{ id: string; since: Date } | null> {
  return getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:admin-alert:${alert.kind}:${faultHash}:${userId}`}, 0))`);
    const sameFault = and(
      eq(auditLog.action, ACTION),
      sql`${auditLog.changes}->>'kind' = ${alert.kind}`,
      sql`${auditLog.changes}->>'faultHash' = ${faultHash}`,
    );
    const [recent] = await transaction.select({ id: auditLog.id }).from(auditLog)
      .where(and(sameFault, gt(auditLog.createdAt, new Date(now.getTime() - REPEAT_MS)), sql`${auditLog.changes}->>'userId' = ${userId}`))
      .limit(1);
    if (recent) return null;
    // A repeat of a continuing fault gives the time it began, not the repeat's.
    const [previous] = await transaction.select({ createdAt: auditLog.createdAt, changes: auditLog.changes }).from(auditLog)
      .where(sameFault).orderBy(desc(auditLog.createdAt)).limit(1);
    let since = alert.occurredAt;
    if (previous && alert.occurredAt.getTime() - previous.createdAt.getTime() <= CONTINUING_MS) {
      const recorded = (previous.changes as { since?: string } | null)?.since;
      const parsed = recorded ? new Date(recorded) : previous.createdAt;
      since = Number.isFinite(parsed.getTime()) && parsed < since ? parsed : since;
    }
    const id = randomUUID();
    await transaction.insert(auditLog).values({
      id,
      householdId: null,
      actorUserId: null,
      entityType: "instance_authority",
      entityId: randomUUID(),
      action: ACTION,
      changes: { kind: alert.kind, faultHash, userId, since: since.toISOString() },
    });
    return { id, since };
  });
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
