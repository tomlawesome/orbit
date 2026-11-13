/**
 * How Orbit sends mail (#1629, ADR-0017 amendment "outgoing mail is
 * app-managed too"): set on the Administration Mail card, beside the mailbox,
 * and stored the way the mailbox credential is.
 *
 * Standard pattern: application-owned integration settings, secrets
 * encrypted at rest under the document KEK, environment imported once then
 * retired (the shape ADR-0017 decision 6 gave `IMAP_*`).
 *
 * - The non-secret values live in the `mail_sending` singleton; the password
 *   of "another account" is a `mail_in_secrets` row of kind `smtp_password`,
 *   bound by its AAD to that account's host and user. It is WRITE-ONLY:
 *   nothing this module returns, logs, audits or throws carries it.
 * - A save is VERIFIED BEFORE IT IS COMMITTED: a live SMTP sign-in with
 *   exactly what was typed (`verifySmtpProviderConnection`, which sends
 *   nothing) runs before any row is written; a refusal writes nothing.
 * - "The mailbox account" stores no second password. At send time it reads
 *   the mailbox credential and works the submission server out from the
 *   mailbox's provider profile.
 * - `importSendingFromEnvironment` copies a complete `SMTP_*` set once, on
 *   first start, under an advisory lock and only when the KEK is readable,
 *   and never over a row set from the screen. After that `SMTP_*` is ignored:
 *   nothing in Orbit reads those lines to send mail any more.
 *
 * Every sender of mail (`sendBoundedMail`, the reminder worker, the receipt
 * worker, the address check, the mailbox probe) asks `outgoingMailConfig()`.
 * No row, or a password the key cannot open, is an empty `smtpUrl`: mail
 * stays queued and goes out once sending is set.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import addressparser from "nodemailer/lib/addressparser";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, mailInMailbox, mailInSecrets, mailSending, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { log, operationalDetail } from "@/lib/logger";
import { readRuntimeSecret } from "@/lib/runtime-secret";
import { envelopeOf } from "@/server/documents/crypto";
import { getDocumentConfig, keyEncryptionKeyFor, wrappingKey } from "@/server/documents/config";
import { requireInstanceAdministrator } from "@/server/authorization";
import {
  getNotificationWorkerConfig,
  getNotificationWorkerSettings,
  verifySmtpProviderConnection,
  type NotificationWorkerConfig,
} from "@/server/notification-worker";
import { decryptMailInSecret, encryptMailInSecret } from "./core/secret-crypto";
import { getImapIngestionConfig, MailInCredentialLockedError } from "./mailbox-config";

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type SendingRow = typeof mailSending.$inferSelect;

export const sendingVias = ["mailbox", "account"] as const;
export const sendingSecurities = ["starttls", "implicit_tls"] as const;
export type SendingSecurity = typeof sendingSecurities[number];

/** Every bounded word a save answers with; a provider's own text never reaches one. */
export const sendingVerificationOutcomes = ["verified", "smtp_rejected", "smtp_unavailable"] as const;
export type SendingVerificationOutcome = typeof sendingVerificationOutcomes[number];

/* A bare server name or IPv4 literal: the host goes into a transport URL, so
   nothing that could carry a scheme, credentials, a path or a port. `_` is
   allowed: internal relay names use it, and the SMTP_* lines accepted it. */
const hostSchema = z.string().trim().min(1).max(253)
  .regex(/^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,251}[A-Za-z0-9_])?$/u, { message: "The host must be a server name" });
const noControl = (value: string) => ![...value].some((character) => {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
});
/* As the mailbox password: refused rather than trimmed, because an altered
   credential would never sign in. */
const passwordSchema = z.string().min(1).max(1024)
  .refine(noControl, { message: "The password must not contain control characters" });
const userSchema = z.string().trim().min(1).max(320)
  .refine(noControl, { message: "The user must not contain control characters" });
/* The display name goes into the From header, quoted when it holds a
   character that would otherwise start another address (`sendsAsOf`). Angle
   brackets, quotes and backslashes are refused outright. */
const senderNameSchema = z.string().trim().min(1).max(80)
  .refine((value) => noControl(value) && !/[<>"\\]/u.test(value), {
    message: "The sender name must not contain < > \" or \\",
  });
const senderAddressSchema = z.email().max(320);

export const sendingSettingsInputSchema = z.discriminatedUnion("via", [
  z.object({
    via: z.literal("mailbox"),
    senderName: senderNameSchema,
    senderAddress: senderAddressSchema,
  }),
  z.object({
    via: z.literal("account"),
    host: hostSchema,
    port: z.number().int().min(1).max(65_535),
    security: z.enum(sendingSecurities),
    user: userSchema,
    password: passwordSchema,
    senderName: senderNameSchema,
    senderAddress: senderAddressSchema,
  }),
]);
export type SendingSettingsInput = z.infer<typeof sendingSettingsInputSchema>;

/**
 * What the Sending half of the Mail card shows. Never the password: `password`
 * is only whose it is (`"mailbox"`) or that one is stored (`"set"`).
 */
export interface SendingSettingsView {
  configured: boolean;
  via: "mailbox" | "account" | null;
  host: string | null;
  port: number | null;
  security: SendingSecurity | null;
  user: string | null;
  senderName: string | null;
  senderAddress: string | null;
  sendsAs: string | null;
  password: "set" | "mailbox" | null;
  credentialSetBy: string | null;
  credentialSetAt: string | null;
  source: "ui" | "imported" | null;
  setBy: string | null;
  setAt: string | null;
  lastSent: { what: string; at: string } | null;
  version: number | null;
}

const NOT_SET_UP: SendingSettingsView = {
  configured: false, via: null, host: null, port: null, security: null, user: null,
  senderName: null, senderAddress: null, sendsAs: null, password: null,
  credentialSetBy: null, credentialSetAt: null, source: null, setBy: null, setAt: null,
  lastSent: null, version: null,
};

const conflict = () => new AppError("sending_version_conflict", "The sending settings changed; reload and try again", 409);

/**
 * The From header Orbit writes: `Name <address>`, the name quoted when it
 * holds a character with a meaning in an address list (RFC 5322 "specials",
 * a comma above all), or the bare address when there is no name.
 */
export function sendsAsOf(senderName: string, senderAddress: string): string {
  if (!senderName) return senderAddress;
  const name = /[()<>[\]:;@\\,."]/u.test(senderName)
    ? `"${senderName.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`
    : senderName;
  return `${name} <${senderAddress}>`;
}

/**
 * Where "the mailbox account" submits, from the mailbox's provider profile:
 * Gmail's own submission server for Gmail, the mailbox's own host otherwise,
 * an old `outlook` row included (#1780); mailcow and most self-run servers
 * take submission on the IMAP host. Always port 587 with STARTTLS, signed in as the mailbox.
 */
export function mailboxSubmissionServer(mailbox: { host: string; providerProfile: string }): { host: string; port: number; security: SendingSecurity } {
  const host = mailbox.providerProfile === "gmail" ? "smtp.gmail.com"
    : mailbox.host;
  return { host, port: 587, security: "starttls" };
}

function transportUrl(account: { host: string; port: number; security: SendingSecurity; user: string; password: string }): string {
  const scheme = account.security === "implicit_tls" ? "smtps" : "smtp";
  return `${scheme}://${encodeURIComponent(account.user)}:${encodeURIComponent(account.password)}@${account.host}:${account.port}`;
}

/** A full worker config that signs in as this account and sends as `from`. */
export function configFor(
  account: { host: string; port: number; security: SendingSecurity; user: string; password: string },
  from: string,
): NotificationWorkerConfig {
  return {
    ...getNotificationWorkerSettings(),
    smtpUrl: transportUrl(account),
    smtpSecurity: account.security,
    smtpFrom: from,
  };
}

async function readRow(): Promise<SendingRow | undefined> {
  const [row] = await getDb().select().from(mailSending).limit(1);
  return row;
}

function decryptSendingPassword(secret: typeof mailInSecrets.$inferSelect, account: { host: string; user: string }): string {
  const keyEncryptionKey = keyEncryptionKeyFor(getDocumentConfig(), secret.keyId);
  if (!keyEncryptionKey) throw new MailInCredentialLockedError(secret.keyId);
  try {
    return decryptMailInSecret(
      secret.ciphertext,
      { secretId: secret.id, kind: "smtp_password", host: account.host, user: account.user },
      envelopeOf(secret),
      keyEncryptionKey,
    ).toString("utf8");
  } catch {
    throw new MailInCredentialLockedError(secret.keyId);
  }
}

/**
 * The account a send signs in with, or why there is none: `unconfigured`
 * (no row, or "the mailbox account" with no mailbox) or `locked` (the key
 * cannot open the password). Never falls back to `SMTP_*`.
 */
export async function resolveSendingAccount(): Promise<
  | { state: "ready"; host: string; port: number; security: SendingSecurity; user: string; password: string; from: string }
  | { state: "unconfigured" }
  | { state: "locked" }
> {
  const row = await readRow();
  if (!row) return { state: "unconfigured" };
  const from = sendsAsOf(row.senderName, row.senderAddress);
  if (row.via === "mailbox") {
    let mailbox: Awaited<ReturnType<typeof getImapIngestionConfig>>;
    try {
      mailbox = await getImapIngestionConfig();
    } catch {
      return { state: "locked" };
    }
    if (!mailbox.configured) return { state: "unconfigured" };
    const [profile] = await getDb().select({ providerProfile: mailInMailbox.providerProfile }).from(mailInMailbox).limit(1);
    const server = mailboxSubmissionServer({ host: mailbox.host, providerProfile: profile?.providerProfile ?? "other" });
    return { state: "ready", ...server, user: mailbox.user, password: mailbox.password, from };
  }
  if (!row.passwordSecretId) return { state: "unconfigured" };
  const [secret] = await getDb().select().from(mailInSecrets).where(eq(mailInSecrets.id, row.passwordSecretId)).limit(1);
  if (!secret) return { state: "unconfigured" };
  try {
    const password = decryptSendingPassword(secret, { host: row.host, user: row.accountUser });
    return { state: "ready", host: row.host, port: row.port, security: row.security, user: row.accountUser, password, from };
  } catch {
    return { state: "locked" };
  }
}

/**
 * The worker's settings with outgoing mail from the sending row: what every
 * sender of mail uses. `smtpUrl` is empty when sending is not set up or the
 * key cannot open its password, and the `SMTP_*` lines are never consulted.
 */
export async function outgoingMailConfig(): Promise<NotificationWorkerConfig> {
  const base = getNotificationWorkerSettings();
  let account: Awaited<ReturnType<typeof resolveSendingAccount>>;
  try {
    account = await resolveSendingAccount();
  } catch {
    return base;
  }
  if (account.state !== "ready") return base;
  return configFor(account, account.from);
}

/** Whether a sending row exists that could send (no decryption: "configured", not "reachable"). */
export async function sendingConfigured(): Promise<boolean> {
  const row = await readRow();
  if (!row) return false;
  if (row.via === "account") return Boolean(row.passwordSecretId);
  const [mailbox] = await getDb().select({ host: mailInMailbox.host, accountUser: mailInMailbox.accountUser, passwordSecretId: mailInMailbox.passwordSecretId })
    .from(mailInMailbox).limit(1);
  return Boolean(mailbox?.host && mailbox.accountUser && mailbox.passwordSecretId);
}

/**
 * Where the operations snapshot reads `mailSending.source` (the launcher's
 * signal to retire `SMTP_*`): the row's source. With `usable`, as `orbit
 * mail-sending-status` asks it (#1817), null too unless Orbit can open the
 * stored password: a row whose key is missing or whose decrypt fails is not a
 * usable copy, and retiring the lines then would destroy the last one.
 */
export async function sendingSource(options: { usable?: boolean } = {}): Promise<"ui" | "imported" | null> {
  const row = await readRow();
  if (!row) return null;
  if (!options.usable) return row.source;
  const account = await resolveSendingAccount();
  return account.state === "ready" ? row.source : null;
}

/**
 * Whether the sending row ever came from the `SMTP_*` lines: true for good
 * once they were imported, even after an administrator changes sending on the
 * screen (`source` then reads `ui`). Read from the import's audit record,
 * which nothing edits.
 */
export async function sendingImportedFromEnvironment(): Promise<boolean> {
  const [record] = await getDb().select({ id: auditLog.id }).from(auditLog)
    .where(and(eq(auditLog.entityType, "mail_sending"), eq(auditLog.action, "mail_sending_imported")))
    .limit(1);
  return Boolean(record);
}

export type SendingImportSkipReason = "key_unavailable" | "lines_unusable";

/* What this process's last import attempt could not do. Every start runs the
   import, so the value is always the current start's. */
let importSkippedReason: SendingImportSkipReason | null = null;

/** Why the `SMTP_*` lines were not copied on this start, or null (copied, set already, or none there). */
export function sendingImportSkipped(): { reason: SendingImportSkipReason } | null {
  return importSkippedReason ? { reason: importSkippedReason } : null;
}

/**
 * "last sent" on the card: what went and when. Best effort and outside the
 * version, so a send never invalidates an editor someone has open.
 */
export async function noteMailSent(what: string, at: Date = new Date()): Promise<void> {
  try {
    await getDb().update(mailSending)
      .set({ lastSentAt: at, lastSentWhat: what.slice(0, 80) })
      .where(eq(mailSending.singleton, true));
  } catch { /* the mail went; only the card is behind */ }
}

async function displayNameOf(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [user] = await getDb().select({ displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1);
  return user?.displayName ?? null;
}

async function viewOf(row: SendingRow | undefined): Promise<SendingSettingsView> {
  if (!row) return NOT_SET_UP;
  const common = {
    senderName: row.senderName,
    senderAddress: row.senderAddress,
    sendsAs: sendsAsOf(row.senderName, row.senderAddress),
    source: row.source,
    setBy: await displayNameOf(row.setByUserId),
    setAt: row.setAt.toISOString(),
    lastSent: row.lastSentAt && row.lastSentWhat ? { what: row.lastSentWhat, at: row.lastSentAt.toISOString() } : null,
    version: row.version,
  };
  if (row.via === "mailbox") {
    const [mailbox] = await getDb().select().from(mailInMailbox).limit(1);
    const configured = Boolean(mailbox?.host && mailbox.accountUser && mailbox.passwordSecretId);
    const server = mailbox ? mailboxSubmissionServer(mailbox) : null;
    return {
      ...common,
      configured,
      via: "mailbox",
      host: server?.host ?? null,
      port: server?.port ?? null,
      security: server?.security ?? null,
      user: mailbox?.accountUser ?? null,
      password: "mailbox",
      credentialSetBy: null,
      credentialSetAt: null,
    };
  }
  let credentialSetBy: string | null = null;
  let credentialSetAt: string | null = null;
  if (row.passwordSecretId) {
    const [secret] = await getDb().select({ createdAt: mailInSecrets.createdAt, createdByUserId: mailInSecrets.createdByUserId })
      .from(mailInSecrets).where(eq(mailInSecrets.id, row.passwordSecretId)).limit(1);
    credentialSetAt = secret?.createdAt.toISOString() ?? null;
    credentialSetBy = await displayNameOf(secret?.createdByUserId ?? null);
  }
  return {
    ...common,
    configured: Boolean(row.passwordSecretId),
    via: "account",
    host: row.host,
    port: row.port,
    security: row.security,
    user: row.accountUser,
    password: row.passwordSecretId ? "set" : null,
    credentialSetBy,
    credentialSetAt,
  };
}

/** The administrator's read of the Sending half. Never returns the password. */
export async function readSendingSettings(actorUserId: string): Promise<SendingSettingsView> {
  await requireInstanceAdministrator(actorUserId);
  return viewOf(await readRow());
}

/** Signs in to the candidate server and answers in one bounded word; sends nothing, stores nothing. */
async function verifyCandidate(config: NotificationWorkerConfig): Promise<SendingVerificationOutcome> {
  const result = await verifySmtpProviderConnection(config);
  if (result === "ready") return "verified";
  if (result === "smtp_rejected") return "smtp_rejected";
  return "smtp_unavailable";
}

async function insertSendingSecret(
  transaction: Transaction,
  password: string,
  account: { host: string; user: string },
  actorUserId: string | null,
): Promise<{ id: string; keyId: string }> {
  // The next key while a rotation is in progress, the current key otherwise (#955).
  const { keyEncryptionKey, keyId } = wrappingKey(getDocumentConfig());
  const id = randomUUID();
  const plaintext = Buffer.from(password, "utf8");
  try {
    const encrypted = encryptMailInSecret(plaintext, { secretId: id, kind: "smtp_password", host: account.host, user: account.user }, keyEncryptionKey, keyId);
    await transaction.insert(mailInSecrets).values({
      id,
      kind: "smtp_password",
      ciphertext: encrypted.ciphertext,
      envelopeVersion: encrypted.envelope.envelopeVersion,
      contentIv: encrypted.envelope.contentIv,
      contentAuthTag: encrypted.envelope.contentAuthTag,
      wrappedDek: encrypted.envelope.wrappedDek,
      wrapIv: encrypted.envelope.wrapIv,
      wrapAuthTag: encrypted.envelope.wrapAuthTag,
      keyId: encrypted.envelope.keyId,
      createdByUserId: actorUserId,
    });
  } finally {
    plaintext.fill(0);
  }
  return { id, keyId };
}

async function recordAudit(transaction: Transaction, entityId: string, actorUserId: string | null, action: string, changes: Record<string, unknown>) {
  await transaction.insert(auditLog).values({
    householdId: null,
    actorUserId,
    entityType: "mail_sending",
    entityId,
    action,
    changes,
  });
}

/** True for a Postgres unique-constraint violation (SQLSTATE 23505), bare or wrapped by the driver layer. */
function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 3; depth += 1) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Sets how Orbit sends, signing in to the server first.
 *
 * `expectedVersion` is null only for the first setup; otherwise it must be
 * the version the caller read, so two administrators cannot overwrite each
 * other. A refused or unreachable server answers with its bounded word and
 * writes nothing at all. On success the superseded password, if any, is
 * deleted in the same transaction that stops referencing it.
 */
export async function setSendingSettings(
  actorUserId: string,
  expectedVersion: number | null,
  input: SendingSettingsInput,
): Promise<{ outcome: SendingVerificationOutcome; settings: SendingSettingsView }> {
  await requireInstanceAdministrator(actorUserId);
  const parsed = sendingSettingsInputSchema.parse(input);
  const existing = await readRow();
  if (existing ? existing.version !== expectedVersion : expectedVersion !== null) throw conflict();

  const from = sendsAsOf(parsed.senderName, parsed.senderAddress);
  let candidate: NotificationWorkerConfig;
  if (parsed.via === "mailbox") {
    let mailbox: Awaited<ReturnType<typeof getImapIngestionConfig>>;
    try {
      mailbox = await getImapIngestionConfig();
    } catch (error) {
      if (error instanceof MailInCredentialLockedError) {
        throw new AppError("credential_locked", "The mailbox password cannot be read right now", 503);
      }
      throw error;
    }
    if (!mailbox.configured) {
      throw new AppError("mailbox_not_configured", "Set up the mailbox first, or send through another account", 409);
    }
    const [profile] = await getDb().select({ providerProfile: mailInMailbox.providerProfile }).from(mailInMailbox).limit(1);
    const server = mailboxSubmissionServer({ host: mailbox.host, providerProfile: profile?.providerProfile ?? "other" });
    candidate = configFor({ ...server, user: mailbox.user, password: mailbox.password }, from);
  } else {
    candidate = configFor(parsed, from);
  }

  const outcome = await verifyCandidate(candidate);
  if (outcome !== "verified") return { outcome, settings: await viewOf(existing) };

  const now = new Date();
  await getDb().transaction(async (transaction) => {
    const [row] = await transaction.select().from(mailSending).for("update").limit(1);
    if (row ? row.version !== expectedVersion : expectedVersion !== null) throw conflict();
    const secret = parsed.via === "account"
      ? await insertSendingSecret(transaction, parsed.password, { host: parsed.host, user: parsed.user }, actorUserId)
      : null;
    const values = {
      via: parsed.via,
      host: parsed.via === "account" ? parsed.host : "",
      port: parsed.via === "account" ? parsed.port : 587,
      security: parsed.via === "account" ? parsed.security : "starttls" as const,
      accountUser: parsed.via === "account" ? parsed.user : "",
      senderName: parsed.senderName,
      senderAddress: parsed.senderAddress,
      passwordSecretId: secret?.id ?? null,
      source: "ui" as const,
      setByUserId: actorUserId,
      setAt: now,
      updatedAt: now,
    };
    let entityId: string;
    if (row) {
      const [updated] = await transaction.update(mailSending)
        .set({ ...values, version: row.version + 1 })
        .where(eq(mailSending.version, row.version))
        .returning({ id: mailSending.id });
      if (!updated) throw conflict();
      entityId = updated.id;
    } else {
      /* Two first saves at once both saw no row; the loser's insert waits for
         the winner and hits the singleton key. Throwing rolls back its secret. */
      let inserted: { id: string } | undefined;
      try {
        [inserted] = await transaction.insert(mailSending).values(values).returning({ id: mailSending.id });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
      if (!inserted) throw conflict();
      entityId = inserted.id;
    }
    if (row?.passwordSecretId) await transaction.delete(mailInSecrets).where(eq(mailInSecrets.id, row.passwordSecretId));
    await recordAudit(transaction, entityId, actorUserId, "mail_sending_set", {
      via: parsed.via,
      ...(secret ? { keyId: secret.keyId } : {}),
    });
  });
  return { outcome, settings: await viewOf(await readRow()) };
}

/** The sender the old code used when `SMTP_FROM` was not set. */
const LEGACY_DEFAULT_SENDER = { senderName: "Orbit", senderAddress: "orbit@localhost" };

/**
 * `SMTP_FROM` as the old code sent it, parsed as an address list (a quoted
 * display name may hold a comma). A value with no address in it falls back to
 * the user when that is an address, else to the old default sender.
 */
function senderOf(from: string, user: string): { senderName: string; senderAddress: string } {
  const [first] = addressparser(from, { flatten: true });
  const address = first?.address?.trim() ?? "";
  if (address && noControl(address) && !/[<>\s]/u.test(address)) {
    const name = (first?.name ?? "").trim();
    return { senderName: noControl(name) ? name.slice(0, 200) : "", senderAddress: address };
  }
  if (senderAddressSchema.safeParse(user).success) return { senderName: "Orbit", senderAddress: user };
  return LEGACY_DEFAULT_SENDER;
}

/**
 * The `SMTP_*` lines as the old code read them: `absent` when none is set,
 * `unusable` when the old code could not have sent with them either (half
 * written, a port out of range, an unreadable password file), else the
 * account. No stricter than before: whatever `getNotificationWorkerConfig`
 * took, this takes.
 */
function smtpEnvironment(environment: NodeJS.ProcessEnv):
  | { state: "absent" }
  | { state: "unusable" }
  | { state: "present"; host: string; port: number; security: SendingSecurity; user: string; password: string; senderName: string; senderAddress: string } {
  const present = ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_PASSWORD_FILE"].some((name) => Boolean(environment[name]?.trim()));
  if (!present) return { state: "absent" };
  let config: NotificationWorkerConfig;
  try {
    config = getNotificationWorkerConfig({
      ...environment,
      VAPID_SUBJECT: undefined, VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined, VAPID_PRIVATE_KEY_FILE: undefined,
    });
  } catch {
    return { state: "unusable" };
  }
  if (!config.smtpUrl) return { state: "unusable" };
  let password: string | undefined;
  try {
    password = readRuntimeSecret(environment, "SMTP_PASSWORD");
  } catch {
    return { state: "unusable" };
  }
  const host = environment.SMTP_HOST?.trim() ?? "";
  const user = environment.SMTP_USER?.trim() ?? "";
  const security: SendingSecurity = config.smtpSecurity === "implicit_tls" ? "implicit_tls" : "starttls";
  const port = environment.SMTP_PORT?.trim() ? Number(environment.SMTP_PORT) : security === "implicit_tls" ? 465 : 587;
  if (!password || !hostSchema.safeParse(host).success || !Number.isInteger(port) || port < 1 || port > 65_535) return { state: "unusable" };
  if (!userSchema.safeParse(user).success || !passwordSchema.safeParse(password).success) return { state: "unusable" };
  return { state: "present", host, port, security, user, password, ...senderOf(config.smtpFrom, user) };
}

const IMPORT_LOCK_KEY = "orbit:mail-sending-import";

export type SendingImportResult = "imported" | "already_set" | "absent" | "key_unavailable" | "lines_unusable";

/**
 * The one-time import of the old `SMTP_*` lines (ADR-0017 amendment), run on
 * start before the workers. Copies a complete set into the sending row,
 * marked `imported`, with the password encrypted. Does nothing when there is
 * already a row (from the screen or an earlier import) or no lines; answers
 * `lines_unusable` for a set the old code could not have sent with either,
 * and `key_unavailable` when the key cannot be read, so a later start can
 * still import. Those two are what `sendingImportSkipped` reports. Two starts at once serialise on an advisory lock and import
 * once. No live sign-in: the lines were already sending, and a start must not
 * depend on the server answering.
 */
export async function importSendingFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<SendingImportResult> {
  const result = await importOnce(environment);
  importSkippedReason = result === "key_unavailable" || result === "lines_unusable" ? result : null;
  return result;
}

async function importOnce(environment: NodeJS.ProcessEnv): Promise<SendingImportResult> {
  const lines = smtpEnvironment(environment);
  if (lines.state === "absent") return "absent";
  if (await readRow()) return "already_set";
  if (lines.state === "unusable") return "lines_unusable";
  try {
    wrappingKey(getDocumentConfig());
  } catch {
    return "key_unavailable";
  }

  const result = await getDb().transaction(async (transaction): Promise<SendingImportResult> => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${IMPORT_LOCK_KEY}, 0))`);
    const [row] = await transaction.select({ id: mailSending.id }).from(mailSending).for("update").limit(1);
    if (row) return "already_set";
    const secret = await insertSendingSecret(transaction, lines.password, { host: lines.host, user: lines.user }, null);
    const [inserted] = await transaction.insert(mailSending).values({
      via: "account",
      host: lines.host,
      port: lines.port,
      security: lines.security,
      accountUser: lines.user,
      senderName: lines.senderName,
      senderAddress: lines.senderAddress,
      passwordSecretId: secret.id,
      source: "imported",
      setByUserId: null,
    }).onConflictDoNothing().returning({ id: mailSending.id });
    if (!inserted) {
      await transaction.delete(mailInSecrets).where(eq(mailInSecrets.id, secret.id));
      return "already_set";
    }
    await recordAudit(transaction, inserted.id, null, "mail_sending_imported", { keyId: secret.keyId });
    return "imported";
  });
  if (result === "imported") {
    log.info({
      event: "delivery.smtp",
      state: "completed",
      action: "none",
      detail: operationalDetail`outgoing mail copied from the SMTP lines into the Mail settings; the lines are ignored from now on`,
    });
  }
  return result;
}
