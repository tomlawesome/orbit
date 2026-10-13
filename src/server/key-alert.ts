/**
 * The operator alert for a locked instance (#1405 section 5, owner answers on
 * #1405): deduplicated alerting with a repeat interval.
 *
 * Administrators' own addresses are encrypted under the very key that is
 * missing, so the alert goes to `OPERATOR_ALERT_ADDRESS`, a server setting,
 * and nowhere else: never the public contact address. Unset, or with outbound
 * mail unconfigured, the container log is the only record.
 *
 * "Already sent" is an `audit_log` row (`encryption_key_alert_sent`), which is
 * unencrypted and readable without the key: the way this codebase already
 * records once-per-fault facts (`mail_in_credential_locked`,
 * `document_kek_rotation_started`). A fault already alerted inside 24 hours
 * is not repeated; a different fault (another wrong key) alerts at once. The
 * row is written only after a successful send, so a failed send is tried again
 * an hour later in this process and on the next restart.
 *
 * On the first clean start after an alert, one "working again" mail closes the
 * loop, recorded as `encryption_key_restored`.
 *
 * No key material, no host path, no private address goes into a mail: key ids
 * only, and APP_URL, which is the operator's own public address.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog } from "@/db/schema";
import { log, operationalDetail } from "@/lib/logger";
import { sendBoundedMail } from "@/server/invitations/send";
import type { KeyFaultReason, KeyState } from "@/server/key-state";

const ALERT_SENT = "encryption_key_alert_sent";
const KEY_RESTORED = "encryption_key_restored";
const REPEAT_INTERVAL_MS = 24 * 3_600_000;
const RETRY_INTERVAL_MS = 3_600_000;

/** The configured alert address, or null when unset or not an address. */
function operatorAlertAddress(): string | null {
  const configured = process.env.OPERATOR_ALERT_ADDRESS?.trim();
  if (!configured) return null;
  return z.email().safeParse(configured).success ? configured : null;
}

/** The operator's own public address for the instance, as the mail names it. */
function instanceAddress(): string {
  try {
    return new URL(process.env.APP_URL ?? "").href.replace(/\/$/u, "");
  } catch {
    return "this server";
  }
}

function sentAt(now: Date): string {
  return `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

type Fault = { reason: KeyFaultReason; heldKeyId?: string; storedKeyId?: string };

function faultOf(state: Extract<KeyState, { verdict: "unusable" }>): Fault {
  return {
    reason: state.reason,
    ...(state.heldKeyId ? { heldKeyId: state.heldKeyId } : {}),
    ...(state.storedKeyId ? { storedKeyId: state.storedKeyId } : {}),
  };
}

function sameFault(changes: unknown, fault: Fault): boolean {
  const recorded = (changes ?? {}) as Partial<Fault>;
  return recorded.reason === fault.reason
    && (recorded.heldKeyId ?? null) === (fault.heldKeyId ?? null)
    && (recorded.storedKeyId ?? null) === (fault.storedKeyId ?? null);
}

const FAULT_WORDS: Record<KeyFaultReason, string> = {
  missing: "missing",
  unreadable: "unreadable",
  malformed: "malformed",
  both_forms: "set twice",
  mismatch: "not the key this database was written under",
  key_row_damaged: "not able to open the key this database was written under",
};

function renderAlert(fault: Fault, now: Date): { subject: string; text: string } {
  const ids = fault.reason === "mismatch" || fault.reason === "key_row_damaged"
    ? ` Orbit is holding key ${fault.heldKeyId}; the database was written under ${fault.storedKeyId}. Use that id to pick the right backup or recovery bundle.`
    : "";
  return {
    subject: "Orbit is locked: its encryption key needs attention",
    text: [
      `Orbit at ${instanceAddress()} cannot open anyone's records or sign anyone in, because its encryption key is ${FAULT_WORDS[fault.reason]}.`,
      "",
      "Nothing is lost. Everything stays encrypted and intact; Orbit has closed itself to everyone, administrators included, until the key is fixed on the host and the container restarted.",
      "",
      `What to do: docs/administrator-operations.md, "Restoring the document key-encryption key".${ids}`,
      "",
      `Orbit will send this again in 24 hours if it is still locked, and once when the key is back. Sent ${sentAt(now)}.`,
      "",
    ].join("\n"),
  };
}

function renderRestored(now: Date): { subject: string; text: string } {
  return {
    subject: "Orbit's encryption key is working again",
    text: [
      `Orbit at ${instanceAddress()} has started with its encryption key and is open again: records can be read and people can sign in.`,
      "",
      "Nothing was lost. This is the one message that follows the earlier alert.",
      "",
      `Sent ${sentAt(now)}.`,
      "",
    ].join("\n"),
  };
}

async function record(action: string, changes: Record<string, unknown>): Promise<void> {
  await getDb().insert(auditLog).values({
    householdId: null,
    actorUserId: null,
    entityType: "instance_authority",
    entityId: randomUUID(),
    action,
    changes,
  });
}

async function alertedRecently(fault: Fault, now: Date): Promise<boolean> {
  const rows = await getDb()
    .select({ changes: auditLog.changes })
    .from(auditLog)
    .where(and(eq(auditLog.action, ALERT_SENT), gt(auditLog.createdAt, new Date(now.getTime() - REPEAT_INTERVAL_MS))));
  return rows.some((row) => sameFault(row.changes, fault));
}

/**
 * Sends the alert for an unusable verdict, unless the same fault was alerted
 * within 24 hours. Never throws for a mail failure: it logs, and for a
 * transient one tries again in an hour, on a timer that does not hold the
 * process open.
 */
export async function sendKeyAlert(state: KeyState): Promise<void> {
  if (state.verdict !== "unusable") return;
  const fault = faultOf(state);
  const address = operatorAlertAddress();
  if (!address) {
    log.info({
      event: "encryption.key",
      state: "degraded",
      reason: "not_configured",
      action: "repair_configuration",
      impact: "none",
      detail: operationalDetail`no OPERATOR_ALERT_ADDRESS; the fault is in this log only`,
    });
    return;
  }

  const now = new Date();
  if (await alertedRecently(fault, now)) {
    log.info({
      event: "encryption.key",
      state: "blocked",
      reason: "key_unavailable",
      action: "check_configuration",
      impact: "none",
      detail: operationalDetail`alert already sent within 24 hours; not repeated`,
    });
    return;
  }

  const outcome = await sendBoundedMail(address, renderAlert(fault, now), undefined, now);
  if (outcome.sendError === null) {
    await record(ALERT_SENT, fault);
    log.info({
      event: "delivery.smtp",
      state: "completed",
      action: "none",
      detail: operationalDetail`encryption key alert sent to the operator address`,
    });
    return;
  }
  if (outcome.sendError === "smtp_unconfigured") {
    log.info({
      event: "encryption.key",
      state: "degraded",
      reason: "smtp_unconfigured",
      action: "repair_configuration",
      impact: "none",
      detail: operationalDetail`outbound mail is not configured; the fault is in this log only`,
    });
    return;
  }
  log.warn({
    event: "delivery.smtp",
    state: "retrying",
    reason: outcome.sendError,
    action: "check_configuration",
    impact: "none",
    detail: operationalDetail`encryption key alert not sent; retrying in 60 minutes`,
  });
  setTimeout(() => {
    void sendKeyAlert(state).catch(() => undefined);
  }, RETRY_INTERVAL_MS).unref();
}

/**
 * On a start with a usable key: one "working again" mail if an alert was sent
 * since the last such notice, recorded so a second clean start sends nothing.
 * Says nothing to anyone when there is no alert address.
 */
export async function sendKeyRestoredNotice(): Promise<void> {
  const [lastAlert] = await getDb()
    .select({ createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(eq(auditLog.action, ALERT_SENT))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  if (!lastAlert) return;
  const [lastRestored] = await getDb()
    .select({ createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(eq(auditLog.action, KEY_RESTORED))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  if (lastRestored && lastRestored.createdAt >= lastAlert.createdAt) return;

  const address = operatorAlertAddress();
  if (!address) return;
  const now = new Date();
  const outcome = await sendBoundedMail(address, renderRestored(now), undefined, now);
  if (outcome.sendError !== null) {
    log.warn({
      event: "delivery.smtp",
      state: "degraded",
      reason: outcome.sendError,
      action: "check_configuration",
      impact: "none",
      detail: operationalDetail`encryption key working-again notice not sent; tried again on the next start`,
    });
    return;
  }
  await record(KEY_RESTORED, {});
  log.info({
    event: "delivery.smtp",
    state: "completed",
    action: "none",
    detail: operationalDetail`encryption key working-again notice sent to the operator address`,
  });
}
