/**
 * The administrator alert (#1421): when Orbit needs a person to act, every
 * instance administrator is mailed once, through the shared card (#1648).
 *
 * Standard pattern: deduplicated alerting with a repeat interval, the shape
 * `key-alert.ts` uses. An `audit_log` row is written per administrator only
 * after that administrator's send succeeded, so a failed send is tried again
 * on the next occurrence, and the same kind and fault inside 24 hours is not
 * mailed again. The row holds the kind, a short hash of the fault key and the
 * recipient's user id: no address, household name or secret.
 *
 * It never throws into its caller. Every failure is a bounded log line
 * without the error text, which could carry a connection string.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
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
      { label: "household", value: alert.householdName ?? "unknown" },
      { label: "when", value: at, keep: [at] },
      { label: "Orbit did", value: "kept the household read-only until the restart" },
    ],
  };
}

function heldLine(count: number | undefined): string {
  if (count === undefined || count <= 0) return "holds new documents until it is back";
  return `held ${count} new ${count === 1 ? "document" : "documents"}`;
}

/**
 * Wording from design/v19/mail/round-4/l-admin-alert-scanner.html. The line
 * telling the administrator that members were told is left out until the
 * member view of a held document is built (#1419, parked design round).
 */
function scannerCopy(alert: AdminAlert, at: string): AlertCopy {
  return {
    subject: "Orbit needs you: the virus scanner is down",
    preheader: "The virus scanner stopped answering. New documents are being held.",
    lede: `The virus scanner stopped answering at ${at}. New documents are being held, not refused, until it is back.`,
    facts: [
      { label: "what", value: "virus scanner down" },
      { label: "since", value: at, keep: [at] },
      { label: "where", value: "the whole instance" },
      { label: "Orbit did", value: heldLine(alert.heldDocuments) },
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

/** Whether this administrator was already mailed this fault inside the repeat window. */
async function alreadySent(userId: string, kind: string, faultHash: string, now: Date): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(
      eq(auditLog.action, ACTION),
      gt(auditLog.createdAt, new Date(now.getTime() - REPEAT_MS)),
      sql`${auditLog.changes}->>'userId' = ${userId}`,
      sql`${auditLog.changes}->>'kind' = ${kind}`,
      sql`${auditLog.changes}->>'faultHash' = ${faultHash}`,
    ))
    .limit(1);
  return row !== undefined;
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
    const mail = { ...render(alert), what: "an administrator alert" };
    for (const admin of admins) {
      try {
        const address = cipher.text("users.email", admin.id, { encrypted: admin.emailEnc }).value;
        if (!address) {
          logFailure(operationalDetail`administrator alert skipped for one administrator: the address cannot be read`);
          continue;
        }
        const now = new Date();
        if (await alreadySent(admin.id, alert.kind, faultHash, now)) continue;
        const outcome = await sendBoundedMail(address, mail, undefined, now);
        if (outcome.sendError !== null) {
          logFailure(operationalDetail`administrator alert not sent (${outcome.sendError}); tried again on the next occurrence`);
          continue;
        }
        await getDb().insert(auditLog).values({
          householdId: null,
          actorUserId: null,
          entityType: "instance_authority",
          entityId: randomUUID(),
          action: ACTION,
          changes: { kind: alert.kind, faultHash, userId: admin.id },
        });
      } catch {
        logFailure(operationalDetail`administrator alert failed for one administrator; tried again on the next occurrence`);
      }
    }
  } catch {
    logFailure(operationalDetail`administrator alert not mailed: it could not be prepared`);
  }
}
