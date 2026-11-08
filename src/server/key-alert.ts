/**
 * The operator alert for a locked instance (#1405 section 5, owner answers on
 * #1405), as #1629 left it.
 *
 * Outgoing mail is app-managed since #1629: the sending password (or the
 * mailbox's, for "the mailbox account") is encrypted under the document KEK.
 * So the one fault this module reports is the one fault under which Orbit
 * cannot mail at all (ADR-0017 amendment, "One alert cannot mail"). While
 * the key is unusable the alert is NOT mailed, by the sending row or by any
 * stale `SMTP_*` line: it shows on Administration and in the launcher's
 * health check, and the container log says so. Nothing is retried or
 * repeated, because waiting does not make the password readable.
 *
 * What is kept is the fact: an `audit_log` row (`encryption_key_alert_held`),
 * unencrypted and readable without the key, written once per fault since the
 * last "working again" record. On the first clean start after it (or after
 * an `encryption_key_alert_sent` row from before #1629), one "working again"
 * mail goes to `OPERATOR_ALERT_ADDRESS` through the sending row, saying what
 * was wrong, recorded as `encryption_key_restored` so a second clean start
 * sends nothing.
 *
 * The alert address is a server setting and nowhere else: never the public
 * contact address. Unset, the container log is the only record. No key
 * material, no host path, no private address goes into a mail: the fault's
 * words only, and APP_URL, which is the operator's own public address.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog } from "@/db/schema";
import { log, operationalDetail, type OperationalDetail } from "@/lib/logger";
import { hostOf, householdLine, renderMail } from "@/server/invitations/mail";
import { sendBoundedMail } from "@/server/invitations/send";
import type { KeyFaultReason, KeyState } from "@/server/key-state";

/* Written before #1629, when the alert itself was mailed; still read, so an
   instance upgraded mid-fault sends its working-again notice. */
const ALERT_SENT = "encryption_key_alert_sent";
const ALERT_HELD = "encryption_key_alert_held";
const KEY_RESTORED = "encryption_key_restored";

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

/** The operator's own public address for the instance, as the mail names it. */
function instanceAddress(): string {
  try {
    return new URL(process.env.APP_URL ?? "").href.replace(/\/$/u, "");
  } catch {
    return "this server";
  }
}

/** The host alone, as in every other mail's footer; "" when `APP_URL` is unreadable. */
function instanceHost(): string {
  return hostOf(process.env.APP_URL ?? "");
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

const FAULT_FACTS: Record<KeyFaultReason, string> = {
  missing: "key missing",
  unreadable: "key unreadable",
  malformed: "key malformed",
  both_forms: "key set twice",
  mismatch: "key does not match the database",
  key_row_damaged: "key row damaged",
};

type KeyMail = { subject: string; text: string; html: string };

/* Both mails are the ratified card (#1648 mails 9 and 10): no button and no
   link, since there is nothing to press and the fix is made on the host. The
   html names the host where the text names the full address. */
function renderAlert(fault: Fault, now: Date): KeyMail {
  const withIds = fault.reason === "mismatch" || fault.reason === "key_row_damaged";
  const ids = withIds
    ? ` Orbit is holding key ${fault.heldKeyId}; the database was written under ${fault.storedKeyId}. Use that id to pick the right backup or recovery bundle.`
    : "";
  const host = instanceHost();
  const named = host || "this server";
  return renderMail({
    subject: "Orbit is locked: its encryption key needs attention",
    preheader: `Its encryption key is ${FAULT_WORDS[fault.reason]}. Nothing is lost.`,
    headline: "Orbit is locked",
    body: [
      `Orbit at ${named} cannot open anyone’s records or sign anyone in, because its encryption key is ${FAULT_WORDS[fault.reason]}.`,
      "Nothing is lost. Everything stays encrypted and intact; Orbit has closed itself to everyone, administrators included, until the key is fixed on the host and the container restarted.",
    ],
    facts: [
      { label: "instance", value: named },
      { label: "the fault", value: FAULT_FACTS[fault.reason] },
      ...(withIds
        ? [
          { label: "key held", value: String(fault.heldKeyId) },
          { label: "database written under", value: String(fault.storedKeyId) },
        ]
        : []),
      { label: "what to do", value: "administrator-operations.md, “Restoring the document key-encryption key”", keep: ["administrator-operations.md,", "key-encryption"] },
    ],
    footer: [
      "Orbit will send this again in 24 hours if it is still locked, and once when the key is back.",
      `Sent ${sentAt(now)}.`,
      householdLine(host),
    ],
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
  });
}

function renderRestored(now: Date, held: Fault | null): KeyMail {
  const host = instanceHost();
  const named = host || "this server";
  const whatHappened = held
    ? `While it was locked its encryption key was ${FAULT_WORDS[held.reason]}, and Orbit could not mail you about it: the password it sends mail with is encrypted under that same key.`
    : null;
  const closing = held
    ? "Nothing was lost. Everything stayed encrypted and intact while it was closed."
    : "Nothing was lost. This is the one message that follows the earlier alert.";
  return renderMail({
    subject: "Orbit's encryption key is working again",
    preheader: "Records can be read and people can sign in.",
    headline: "Orbit is open again",
    body: [
      `Orbit at ${named} has started with its encryption key and is open again: records can be read and people can sign in.`,
      ...(whatHappened ? [whatHappened] : []),
      closing,
    ],
    footer: [`Sent ${sentAt(now)}.`, householdLine(host)],
    text: [
      `Orbit at ${instanceAddress()} has started with its encryption key and is open again: records can be read and people can sign in.`,
      "",
      ...(whatHappened ? [whatHappened, ""] : []),
      closing,
      "",
      `Sent ${sentAt(now)}.`,
      "",
    ].join("\n"),
  });
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

/** The newest "working again" record, or null. */
async function lastRestoredAt(): Promise<Date | null> {
  const [row] = await getDb()
    .select({ createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(eq(auditLog.action, KEY_RESTORED))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row?.createdAt ?? null;
}

/** Whether this fault is already held since the last "working again" record. */
async function alreadyHeld(fault: Fault): Promise<boolean> {
  const since = await lastRestoredAt();
  const rows = await getDb()
    .select({ changes: auditLog.changes })
    .from(auditLog)
    .where(since ? and(eq(auditLog.action, ALERT_HELD), gt(auditLog.createdAt, since)) : eq(auditLog.action, ALERT_HELD));
  return rows.some((row) => sameFault(row.changes, fault));
}

/**
 * For an unusable verdict: records the fault once (since the last "working
 * again" record) so the first clean start can tell the operator, and logs
 * that it was not mailed. Never mails, never arms a timer, never throws for a
 * bookkeeping failure: it logs one bounded line instead.
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
  const fault = faultOf(state, configured.address);
  try {
    if (!(await alreadyHeld(fault))) await record(ALERT_HELD, fault);
  } catch {
    logAlertStoreFailure(operationalDetail`encryption key fault not recorded; the working-again notice may not follow`);
    return;
  }
  log.info({
    event: "encryption.key",
    state: "blocked",
    reason: "key_unavailable",
    action: "check_configuration",
    impact: "none",
    detail: operationalDetail`alert not mailed: the sending password is encrypted under the missing key; shown on Administration and in the health check, and mailed once the key is back`,
  });
}

/**
 * On a start with a usable key: one "working again" mail if a fault was held
 * (or, before #1629, an alert sent) since the last such notice, recorded so a second clean start sends nothing.
 * Says nothing to anyone when there is no alert address.
 */
export async function sendKeyRestoredNotice(): Promise<void> {
  const [lastFault] = await getDb()
    .select({ action: auditLog.action, changes: auditLog.changes, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(inArray(auditLog.action, [ALERT_SENT, ALERT_HELD]))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  if (!lastFault) return;
  const lastRestored = await lastRestoredAt();
  if (lastRestored && lastRestored >= lastFault.createdAt) return;
  const held = lastFault.action === ALERT_HELD ? lastFault.changes as Fault : null;

  const configured = operatorAlertAddress();
  if (!configured || "invalid" in configured) return;
  const { address } = configured;
  const now = new Date();
  const outcome = await sendBoundedMail(address, { ...renderRestored(now, held), what: "the key-restored notice" }, undefined, now);
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
