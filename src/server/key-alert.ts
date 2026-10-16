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
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog } from "@/db/schema";
import { log, operationalDetail, type OperationalDetail } from "@/lib/logger";
import { sendBoundedMail } from "@/server/invitations/send";
import type { KeyFaultReason, KeyState } from "@/server/key-state";

const ALERT_SENT = "encryption_key_alert_sent";
const KEY_RESTORED = "encryption_key_restored";
const REPEAT_INTERVAL_MS = 24 * 3_600_000;
const RETRY_INTERVAL_MS = 3_600_000;

/* Told apart so a mistyped address is logged as invalid, not as unset: the
   boot-time warning for it only runs on a usable start. */
type AlertAddress = { address: string } | { invalid: true } | null;

/** The configured alert address; null when unset. */
function operatorAlertAddress(): AlertAddress {
  const configured = process.env.OPERATOR_ALERT_ADDRESS?.trim();
  if (!configured) return null;
  return z.email().safeParse(configured).success ? { address: configured } : { invalid: true };
}

/* The address is part of the fault, so a corrected address hears at once; only
   a short hash is recorded, never the address. */
function addressHashOf(address: string): string {
  return createHash("sha256").update(address).digest("hex").slice(0, 16);
}

/* One timer at a time, shared by the hourly retry and the daily repeat, so the
   two never both fire. */
let pendingAlert: ReturnType<typeof setTimeout> | null = null;

/* The bounded line for an alert-bookkeeping read or write that threw: no
   error text, which could carry a connection string. */
function logAlertStoreFailure(detail: OperationalDetail): void {
  log.warn({
    event: "encryption.key",
    state: "degraded",
    reason: "unexpected_failure",
    action: "check_database",
    impact: "none",
    detail,
  });
}

function armAlert(state: KeyState, delayMs: number): void {
  if (pendingAlert) clearTimeout(pendingAlert);
  pendingAlert = setTimeout(() => {
    pendingAlert = null;
    /* A database that cannot answer (a restart, a host update) must not end
       the daily promise: say so and try again in an hour (#1316). */
    return sendKeyAlert(state).catch(() => {
      logAlertStoreFailure(operationalDetail`encryption key alert not checked; retrying in 60 minutes`);
      armAlert(state, RETRY_INTERVAL_MS);
    });
  }, Math.max(delayMs, 0));
  pendingAlert.unref();
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

type Fault = { reason: KeyFaultReason; heldKeyId?: string; storedKeyId?: string; addressHash: string };

function faultOf(state: Extract<KeyState, { verdict: "unusable" }>, address: string): Fault {
  return {
    reason: state.reason,
    addressHash: addressHashOf(address),
    ...(state.heldKeyId ? { heldKeyId: state.heldKeyId } : {}),
    ...(state.storedKeyId ? { storedKeyId: state.storedKeyId } : {}),
  };
}

function sameFault(changes: unknown, fault: Fault): boolean {
  const recorded = (changes ?? {}) as Partial<Fault>;
  return recorded.reason === fault.reason
    && (recorded.heldKeyId ?? null) === (fault.heldKeyId ?? null)
    && (recorded.storedKeyId ?? null) === (fault.storedKeyId ?? null)
    && recorded.addressHash === fault.addressHash;
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

/**
 * When the same fault was last alerted within 24 hours, or null. An alert
 * before the newest "working again" record belongs to a fault already
 * resolved, so it does not hold back a new one.
 */
async function lastAlertedWithinDay(fault: Fault, now: Date): Promise<Date | null> {
  const [lastRestored] = await getDb()
    .select({ createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(eq(auditLog.action, KEY_RESTORED))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  const dayAgo = new Date(now.getTime() - REPEAT_INTERVAL_MS);
  const since = lastRestored && lastRestored.createdAt > dayAgo ? lastRestored.createdAt : dayAgo;
  const rows = await getDb()
    .select({ changes: auditLog.changes, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(eq(auditLog.action, ALERT_SENT), gt(auditLog.createdAt, since)))
    .orderBy(desc(auditLog.createdAt));
  return rows.find((row) => sameFault(row.changes, fault))?.createdAt ?? null;
}

/**
 * Sends the alert for an unusable verdict, unless the same fault was alerted
 * within 24 hours, and arms the next one: 24 hours after the newest alert
 * while the process stays locked (counted from the recorded row, so a restart
 * does not reset the clock). Never throws for a mail failure: it logs, and for
 * a transient one tries again in an hour. Timers do not hold the process open.
 */
export async function sendKeyAlert(state: KeyState): Promise<void> {
  if (state.verdict !== "unusable") return;
  const configured = operatorAlertAddress();
  if (configured && "invalid" in configured) {
    log.info({
      event: "encryption.key",
      state: "degraded",
      reason: "configuration_optional",
      setting: "alerts",
      action: "repair_configuration",
      impact: "none",
      detail: operationalDetail`OPERATOR_ALERT_ADDRESS is not a valid address; the fault is in this log only`,
    });
    return;
  }
  if (!configured) {
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
  const { address } = configured;
  const fault = faultOf(state, address);

  const now = new Date();
  const lastAlerted = await lastAlertedWithinDay(fault, now);
  if (lastAlerted) {
    log.info({
      event: "encryption.key",
      state: "blocked",
      reason: "key_unavailable",
      action: "check_configuration",
      impact: "none",
      detail: operationalDetail`alert already sent within 24 hours; not repeated`,
    });
    armAlert(state, lastAlerted.getTime() + REPEAT_INTERVAL_MS - now.getTime());
    return;
  }

  const outcome = await sendBoundedMail(address, renderAlert(fault, now), undefined, now);
  if (outcome.sendError === null) {
    /* The mail went: the repeat is armed whether or not the record lands. A
       lost record only means a restart may send this alert again. */
    await record(ALERT_SENT, fault).catch(() =>
      logAlertStoreFailure(operationalDetail`encryption key alert sent but not recorded; a restart may repeat it`));
    log.info({
      event: "delivery.smtp",
      state: "completed",
      action: "none",
      detail: operationalDetail`encryption key alert sent to the operator address`,
    });
    armAlert(state, REPEAT_INTERVAL_MS);
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
  armAlert(state, RETRY_INTERVAL_MS);
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

  const configured = operatorAlertAddress();
  if (!configured || "invalid" in configured) return;
  const { address } = configured;
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
