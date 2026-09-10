/**
 * The administrator's mailbox settings: set, verify, probe, rotate, remove,
 * enable and disable (ADR-0017 decision 1, slice 2, orbit#743).
 *
 * Three rules shape everything here.
 *
 * The password and the alias key are WRITE-ONLY. They arrive in a request
 * body, are encrypted into `mail_in_secrets` and are never read back out:
 * nothing this module returns, logs, audits or throws carries either of them,
 * and there is no read path that could. The precedent is
 * `RelayConflictError` in `relays.ts`, which deliberately names no secret,
 * digest or address in its message.
 *
 * A credential is VERIFIED BEFORE IT IS COMMITTED. Setting and rotating both
 * build a candidate configuration in memory, run the same bounded TLS connect
 * the poll loop's preflight uses (`verifyImapProvider`), and only then open a
 * transaction. A failed verification writes no secret row and leaves whatever
 * was active exactly where it was.
 *
 * A superseded secret is DELETED, not kept. Rotation inserts the new row,
 * re-points `mail_in_mailbox` at it and deletes the old row in one
 * transaction, so there is never a moment where two password rows exist and
 * never a spent credential left behind.
 *
 * This lives outside `core/` because it needs `getDb`/schema access and an
 * `imapflow` client, which `core/` is not allowed (see this directory's
 * README).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, mailInMailbox, mailInSecrets, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { getDocumentConfig, wrappingKey } from "@/server/documents/config";
import { requireInstanceAdministrator } from "@/server/authorization";
import {
  createSmtpTransport,
  getNotificationWorkerConfig,
  type NotificationWorkerConfig,
} from "@/server/notification-worker";
import {
  createImapClient,
  getImapProviderPreflightState,
  verifyImapProvider,
} from "./imap-ingestion";
import { deriveImapRecipientAlias, imapAliasBaseFromAccount, normalizeImapRecipientAlias } from "./core/imap-recipient";
import { encryptMailInSecret, type MailInSecretKind } from "./core/secret-crypto";
import { getImapIngestionConfig, imapConfigFromMailbox, MailInCredentialLockedError, resolveTrustedAuthservId } from "./mailbox-config";
import { resetAllRelaysForMovedAccount, rotateAllRelaysForNewAliasKey } from "./relays";
import { RELAY_MAX_GRACE_MS } from "./core/relay-generations";
import type { ImapIngestionConfig } from "./core/config";

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** The four provider profiles ADR-0017 decision 1 names; `other` is the default. */
export const mailboxProviderProfiles = ["mailcow", "gmail", "outlook", "other"] as const;
export type MailboxProviderProfile = typeof mailboxProviderProfiles[number];

/**
 * Every bounded word a verification or probe can answer with. Nothing outside
 * this list ever reaches a response or an audit row, so a provider's own
 * error text can never leak through the outcome.
 */
export const mailboxVerificationOutcomes = [
  "verified",
  "not_configured",
  "provider_unavailable",
  "credential_locked",
] as const;
export type MailboxVerificationOutcome = typeof mailboxVerificationOutcomes[number];

export const mailboxProbeOutcomes = [
  "delivered",
  "delivered_without_recipient_header",
  "not_delivered",
  "not_configured",
  "smtp_not_configured",
  "smtp_unavailable",
  "provider_unavailable",
  "credential_locked",
] as const;
export type MailboxProbeOutcome = typeof mailboxProbeOutcomes[number];

/**
 * How long the setup probe waits for its own message to come back, and how
 * often it looks. Bounded so an administrator's click cannot hold a request
 * open indefinitely against a provider that silently drops the message.
 */
const PROBE_DEADLINE_MS = 30_000;
const PROBE_POLL_INTERVAL_MS = 3_000;

/** Alias keys are 32 random bytes; the legacy shape check required at least 32 characters. */
const ALIAS_KEY_BYTES = 32;

/**
 * How long the outgoing addresses keep working after an emergency alias-key
 * rotation. The administrator chooses; the ceiling is the product's, not
 * theirs (ADR-0017 decision 2, `RELAY_MAX_GRACE_MS`).
 */
const graceDaysSchema = z.number().int().min(0).max(RELAY_MAX_GRACE_MS / 86_400_000);

const hostSchema = z.string().trim().min(1).max(253);
const accountSchema = z.string().trim().min(3).max(512)
  .refine((value) => value.includes("@") && !value.startsWith("@") && !value.endsWith("@"), {
    message: "The account must be a full mailbox address",
  });
/* Rejected rather than trimmed: a password with a control character in it
   cannot be sent over IMAP unchanged, and silently altering a credential
   before storing it produces a row that will never authenticate. */
const passwordSchema = z.string().min(1).max(1024)
  .refine((value) => ![...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  }), { message: "The password must not contain control characters" });

export const mailboxSettingsInputSchema = z.object({
  host: hostSchema,
  port: z.number().int().min(1).max(65_535),
  accountUser: accountSchema,
  mailbox: z.string().trim().min(1).max(255),
  tlsServerName: z.string().trim().max(253).default(""),
  providerProfile: z.enum(mailboxProviderProfiles),
  trustedRecipientHeader: z.string().trim().regex(/^[A-Za-z0-9-]{1,80}$/u),
  /* Whose Authentication-Results verdict this instance believes (ADR-0017
     decision 3, slice 4). Optional: Gmail and Outlook have a known identity,
     and leaving it blank for any other provider means nothing is believed —
     which fails closed rather than guessing at a hostname. */
  trustedAuthservId: z.string().trim().max(253).regex(/^[A-Za-z0-9.:-]*$/u).default(""),
  pollSeconds: z.number().int().min(30).max(3_600),
  password: passwordSchema,
});
export type MailboxSettingsInput = z.infer<typeof mailboxSettingsInputSchema>;

/**
 * What an administrator is shown (ADR-0017 decision 1, "What an administrator
 * sees"). Non-secret provider configuration, verification state, who set the
 * credential and when, and the bounded health classes. Deliberately absent:
 * the password, the alias key, and any user's alias address — the last of
 * which is why `aliasPattern` prints a placeholder token rather than a real
 * derived address.
 */
export interface MailboxSettingsView {
  configured: boolean;
  enabled: boolean;
  host: string;
  port: number;
  accountUser: string;
  mailbox: string;
  tlsServerName: string;
  providerProfile: MailboxProviderProfile;
  authMethod: "password" | "xoauth2";
  trustedRecipientHeader: string;
  /** As configured; blank means "the provider profile's own", or none at all. */
  trustedAuthservId: string;
  /** What attribution will actually use, after the profile default is applied. */
  effectiveAuthservId: string;
  pollSeconds: number;
  verificationState: "unverified" | "verified" | "failed";
  verifiedAt: string | null;
  /** The plus-address shape every relay address takes, derived from the account. */
  aliasPattern: string | null;
  credentialSetAt: string | null;
  credentialSetBy: string | null;
  hasPassword: boolean;
  hasAliasKey: boolean;
  version: number | null;
  health: {
    status: string;
    smtp: string;
    imap: string;
    checkedAt: string | null;
    credentialLocked: boolean;
  };
}

/** Explicit seams so tests never open a socket; the defaults are the real providers. */
export interface MailboxSettingsDependencies {
  verifyImap?: (config: ImapIngestionConfig) => Promise<"ready" | "imap_unconfigured" | "imap_unavailable">;
  sendProbeMail?: (message: { from: string; to: string; subject: string; text: string }) => Promise<void>;
  findProbeMessage?: (config: ImapIngestionConfig, token: string) => Promise<ProbeSighting | undefined>;
  smtpConfig?: () => NotificationWorkerConfig;
  now?: () => Date;
}

/** What the probe found: the trusted recipient header, if the provider preserved one. */
export interface ProbeSighting {
  trustedRecipient?: string;
}

type MailboxRow = typeof mailInMailbox.$inferSelect;

function providerProfileOf(value: string): MailboxProviderProfile {
  return (mailboxProviderProfiles as readonly string[]).includes(value)
    ? value as MailboxProviderProfile
    : "other";
}

function verificationStateOf(value: string): MailboxSettingsView["verificationState"] {
  return value === "verified" || value === "failed" ? value : "unverified";
}

async function readMailboxRow(): Promise<MailboxRow | undefined> {
  const [row] = await getDb().select().from(mailInMailbox).limit(1);
  return row;
}

/**
 * Takes the singleton for update and checks the caller's expected version.
 *
 * Absent (`null`) means "there is no row yet" and is only valid for the first
 * setup; anything else must match exactly, so two administrators editing the
 * same screen cannot silently overwrite each other.
 */
async function lockMailbox(transaction: Transaction, expectedVersion: number | null): Promise<MailboxRow | undefined> {
  const [row] = await transaction.select().from(mailInMailbox).for("update").limit(1);
  if (!row) {
    if (expectedVersion !== null) {
      throw new AppError("mailbox_version_conflict", "The mailbox settings changed; reload and try again", 409);
    }
    return undefined;
  }
  if (expectedVersion === null || row.version !== expectedVersion) {
    throw new AppError("mailbox_version_conflict", "The mailbox settings changed; reload and try again", 409);
  }
  return row;
}

/** Requires a configured mailbox for an operation that only makes sense against one. */
function requireMailbox(row: MailboxRow | undefined): MailboxRow {
  if (!row) throw new AppError("mailbox_not_configured", "Mail-in has not been set up", 409);
  return row;
}

async function insertSecret(
  transaction: Transaction,
  kind: MailInSecretKind,
  plaintext: Buffer,
  account: { host: string; user: string },
  actorUserId: string,
): Promise<{ id: string; keyId: string }> {
  // The next key while a rotation is in progress, the current key otherwise (#955).
  const { keyEncryptionKey, keyId } = wrappingKey(getDocumentConfig());
  const id = randomUUID();
  const encrypted = encryptMailInSecret(plaintext, { secretId: id, kind, host: account.host, user: account.user }, keyEncryptionKey, keyId);
  await transaction.insert(mailInSecrets).values({
    id,
    kind,
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
  return { id, keyId };
}

async function recordMailboxAudit(
  transaction: Transaction,
  mailboxId: string,
  actorUserId: string | null,
  action: string,
  changes: Record<string, unknown>,
): Promise<void> {
  await transaction.insert(auditLog).values({
    householdId: null,
    actorUserId,
    entityType: "mail_in_mailbox",
    entityId: mailboxId,
    action,
    changes,
  });
}

/** The alias shape an administrator is shown: the base is real, the token is not. */
function aliasPatternOf(accountUser: string): string | null {
  const base = imapAliasBaseFromAccount(accountUser);
  if (!base.domain) return null;
  return `${base.localPart}+<code>@${base.domain}`;
}

async function credentialProvenance(row: MailboxRow): Promise<{ at: string | null; by: string | null }> {
  if (!row.passwordSecretId) return { at: null, by: null };
  const [secret] = await getDb().select({
    createdAt: mailInSecrets.createdAt,
    displayName: users.displayName,
  }).from(mailInSecrets)
    .leftJoin(users, eq(users.id, mailInSecrets.createdByUserId))
    .where(eq(mailInSecrets.id, row.passwordSecretId))
    .limit(1);
  return {
    at: secret?.createdAt ? secret.createdAt.toISOString() : null,
    by: secret?.displayName ?? null,
  };
}

/**
 * The administrator's read of the mailbox. Never returns a secret, and never
 * a user's alias address — only the pattern addresses are built from.
 */
export async function readMailboxSettings(actorUserId: string): Promise<MailboxSettingsView> {
  await requireInstanceAdministrator(actorUserId);
  const row = await readMailboxRow();
  let credentialLocked = false;
  let config: ImapIngestionConfig | undefined;
  try {
    config = await getImapIngestionConfig();
  } catch (error) {
    if (!(error instanceof MailInCredentialLockedError)) throw error;
    credentialLocked = true;
  }
  const preflight = getImapProviderPreflightState(config);
  const health = {
    status: credentialLocked ? "credential_locked" : preflight.status,
    smtp: preflight.smtp,
    imap: credentialLocked ? "unsafe_input" : preflight.imap,
    checkedAt: preflight.checkedAt,
    credentialLocked,
  };
  if (!row) {
    return {
      configured: false, enabled: false, host: "", port: 993, accountUser: "", mailbox: "INBOX",
      tlsServerName: "", providerProfile: "other", authMethod: "password", trustedRecipientHeader: "",
      trustedAuthservId: "", effectiveAuthservId: "", pollSeconds: 300, verificationState: "unverified", verifiedAt: null, aliasPattern: null,
      credentialSetAt: null, credentialSetBy: null, hasPassword: false, hasAliasKey: false,
      version: null, health,
    };
  }
  const provenance = await credentialProvenance(row);
  return {
    configured: Boolean(row.host && row.accountUser && row.passwordSecretId),
    enabled: row.enabled,
    host: row.host,
    port: row.port,
    accountUser: row.accountUser,
    mailbox: row.mailbox,
    tlsServerName: row.tlsServerName,
    providerProfile: providerProfileOf(row.providerProfile),
    authMethod: row.authMethod === "xoauth2" ? "xoauth2" : "password",
    trustedRecipientHeader: row.trustedRecipientHeader,
    trustedAuthservId: row.trustedAuthservId,
    effectiveAuthservId: resolveTrustedAuthservId(row.providerProfile, row.trustedAuthservId),
    pollSeconds: row.pollSeconds,
    verificationState: verificationStateOf(row.verificationState),
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    aliasPattern: aliasPatternOf(row.accountUser),
    credentialSetAt: provenance.at,
    credentialSetBy: provenance.by,
    hasPassword: Boolean(row.passwordSecretId),
    hasAliasKey: Boolean(row.aliasKeySecretId),
    version: row.version,
    health,
  };
}

/**
 * Sets the mailbox and its password, verifying against the provider first.
 *
 * On a first setup the instance's alias-derivation key is generated here and
 * never leaves the database: users never hold it, and no read path returns
 * it. On a re-set of an already-configured mailbox the alias key is preserved
 * — replacing it would change every member's address, which is the
 * administrator's separate emergency rotation (slice 3), not a side effect of
 * correcting a host name.
 */
export async function setMailboxSettings(
  actorUserId: string,
  expectedVersion: number | null,
  input: MailboxSettingsInput,
  dependencies: MailboxSettingsDependencies = {},
): Promise<{ outcome: MailboxVerificationOutcome; settings: MailboxSettingsView }> {
  await requireInstanceAdministrator(actorUserId);
  const now = dependencies.now?.() ?? new Date();
  const existing = await readMailboxRow();
  if (existing && expectedVersion !== existing.version) {
    throw new AppError("mailbox_version_conflict", "The mailbox settings changed; reload and try again", 409);
  }

  /* Verified as a candidate, before anything is written. The alias key is
     irrelevant to a provider connect, so a placeholder stands in rather than
     decrypting or generating one for a credential that may not survive the
     check. */
  const candidate = imapConfigFromMailbox({ ...input, enabled: true }, input.password, "");
  const outcome = await verifyCandidate(candidate, dependencies);
  if (outcome !== "verified") {
    await recordVerificationOutcome(existing, actorUserId, outcome);
    return { outcome, settings: await readMailboxSettings(actorUserId) };
  }

  await getDb().transaction(async (transaction) => {
    const row = await lockMailbox(transaction, expectedVersion);
    const account = { host: input.host, user: input.accountUser };
    const password = await insertSecret(transaction, "imap_password", Buffer.from(input.password, "utf8"), account, actorUserId);
    const supersededPasswordId = row?.passwordSecretId ?? null;
    /* An alias key row is bound to host and account by its own AAD, so a
       re-set that moves the mailbox to a different account cannot keep it —
       it would never decrypt again. Every address is derived from the
       account anyway, so moving account already changes them all; a fresh
       key costs nothing extra. A correction that leaves the account alone
       keeps the key, and therefore every member's address, untouched. */
    let aliasKeySecretId = row?.aliasKeySecretId ?? null;
    let supersededAliasKeyId: string | null = null;
    const accountMoved = row !== undefined && (row.host !== input.host || row.accountUser !== input.accountUser);
    if (!aliasKeySecretId || accountMoved) {
      const aliasSecret = randomBytes(ALIAS_KEY_BYTES).toString("base64url");
      const created = await insertSecret(transaction, "alias_key", Buffer.from(aliasSecret, "utf8"), account, actorUserId);
      supersededAliasKeyId = aliasKeySecretId;
      aliasKeySecretId = created.id;
      /* A new alias key means every derived address changes, and the account
         it was a sub-address of has moved, so there is nothing to keep alive:
         every relay moves to its next generation with no previous at all and
         every old alias row goes inactive. The next poll cycle materialises
         each member's new row under the new key (ADR-0017 slice 3). */
      await resetAllRelaysForMovedAccount(transaction, now);
    }
    const values = {
      host: input.host,
      port: input.port,
      accountUser: input.accountUser,
      mailbox: input.mailbox,
      tlsServerName: input.tlsServerName,
      providerProfile: input.providerProfile,
      authMethod: "password" as const,
      trustedRecipientHeader: input.trustedRecipientHeader,
      trustedAuthservId: input.trustedAuthservId,
      pollSeconds: input.pollSeconds,
      passwordSecretId: password.id,
      aliasKeySecretId,
      verificationState: "verified",
      verifiedAt: now,
      updatedAt: now,
    };
    let mailboxId: string;
    if (row) {
      const [updated] = await transaction.update(mailInMailbox)
        .set({ ...values, version: row.version + 1 })
        .where(eq(mailInMailbox.version, row.version))
        .returning({ id: mailInMailbox.id });
      if (!updated) throw new AppError("mailbox_version_conflict", "The mailbox settings changed; reload and try again", 409);
      mailboxId = updated.id;
    } else {
      const [inserted] = await transaction.insert(mailInMailbox)
        .values({ ...values, enabled: true })
        .returning({ id: mailInMailbox.id });
      mailboxId = inserted.id;
    }
    /* Deleted only after the row stops referencing them, so the foreign key
       never has to be relaxed and no spent secret survives the transaction. */
    if (supersededPasswordId) await transaction.delete(mailInSecrets).where(eq(mailInSecrets.id, supersededPasswordId));
    if (supersededAliasKeyId) await transaction.delete(mailInSecrets).where(eq(mailInSecrets.id, supersededAliasKeyId));
    await recordMailboxAudit(transaction, mailboxId, actorUserId, "mail_in_credential_created", {
      kind: "imap_password",
      keyId: password.keyId,
    });
  });
  return { outcome, settings: await readMailboxSettings(actorUserId) };
}

/**
 * Rotates the password against the live mailbox settings.
 *
 * The new credential is proven against the provider before anything is
 * written; on success the new row becomes active and the old row is deleted
 * in the same transaction (ADR-0017 decision 1). A failure leaves the
 * previous credential exactly as it was and records only a bounded outcome.
 */
export async function rotateMailboxPassword(
  actorUserId: string,
  expectedVersion: number,
  password: string,
  dependencies: MailboxSettingsDependencies = {},
): Promise<{ outcome: MailboxVerificationOutcome; settings: MailboxSettingsView }> {
  await requireInstanceAdministrator(actorUserId);
  const parsed = passwordSchema.parse(password);
  const now = dependencies.now?.() ?? new Date();
  const existing = requireMailbox(await readMailboxRow());
  if (existing.version !== expectedVersion) {
    throw new AppError("mailbox_version_conflict", "The mailbox settings changed; reload and try again", 409);
  }
  if (!existing.passwordSecretId) throw new AppError("mailbox_not_configured", "Mail-in has no credential to rotate", 409);

  const candidate = imapConfigFromMailbox({ ...existing, enabled: true }, parsed, "");
  const outcome = await verifyCandidate(candidate, dependencies);
  if (outcome !== "verified") {
    await recordVerificationOutcome(existing, actorUserId, outcome);
    return { outcome, settings: await readMailboxSettings(actorUserId) };
  }

  await getDb().transaction(async (transaction) => {
    const row = requireMailbox(await lockMailbox(transaction, expectedVersion));
    const superseded = row.passwordSecretId;
    const created = await insertSecret(
      transaction,
      "imap_password",
      Buffer.from(parsed, "utf8"),
      { host: row.host, user: row.accountUser },
      actorUserId,
    );
    const [updated] = await transaction.update(mailInMailbox).set({
      passwordSecretId: created.id,
      verificationState: "verified",
      verifiedAt: now,
      version: row.version + 1,
      updatedAt: now,
    }).where(eq(mailInMailbox.version, row.version)).returning({ id: mailInMailbox.id });
    if (!updated) throw new AppError("mailbox_version_conflict", "The mailbox settings changed; reload and try again", 409);
    if (superseded) await transaction.delete(mailInSecrets).where(eq(mailInSecrets.id, superseded));
    await recordMailboxAudit(transaction, updated.id, actorUserId, "mail_in_credential_rotated", {
      kind: "imap_password",
      keyId: created.keyId,
    });
  });
  return { outcome, settings: await readMailboxSettings(actorUserId) };
}

/**
 * Removes the credential. The reference is cleared, the secret row deleted and
 * ingest switched off; the cursor, receipts, private drafts and staging are
 * untouched, which is what `IMAP_ENABLED=false` preserved before this.
 */
export async function removeMailboxCredential(
  actorUserId: string,
  expectedVersion: number,
  dependencies: MailboxSettingsDependencies = {},
): Promise<MailboxSettingsView> {
  await requireInstanceAdministrator(actorUserId);
  const now = dependencies.now?.() ?? new Date();
  await getDb().transaction(async (transaction) => {
    const row = requireMailbox(await lockMailbox(transaction, expectedVersion));
    const superseded = row.passwordSecretId;
    if (!superseded) throw new AppError("mailbox_not_configured", "Mail-in has no credential to remove", 409);
    const [secret] = await transaction.select({ keyId: mailInSecrets.keyId })
      .from(mailInSecrets).where(eq(mailInSecrets.id, superseded)).limit(1);
    const [updated] = await transaction.update(mailInMailbox).set({
      passwordSecretId: null,
      enabled: false,
      verificationState: "unverified",
      verifiedAt: null,
      version: row.version + 1,
      updatedAt: now,
    }).where(eq(mailInMailbox.version, row.version)).returning({ id: mailInMailbox.id });
    if (!updated) throw new AppError("mailbox_version_conflict", "The mailbox settings changed; reload and try again", 409);
    await transaction.delete(mailInSecrets).where(eq(mailInSecrets.id, superseded));
    await recordMailboxAudit(transaction, updated.id, actorUserId, "mail_in_credential_removed", {
      kind: "imap_password",
      keyId: secret?.keyId ?? getDocumentConfig().keyId,
    });
  });
  return readMailboxSettings(actorUserId);
}

/** Switches polling on or off without touching the credential or any stored state. */
export async function setMailboxIngestEnabled(
  actorUserId: string,
  expectedVersion: number,
  enabled: boolean,
  dependencies: MailboxSettingsDependencies = {},
): Promise<MailboxSettingsView> {
  await requireInstanceAdministrator(actorUserId);
  const now = dependencies.now?.() ?? new Date();
  await getDb().transaction(async (transaction) => {
    const row = requireMailbox(await lockMailbox(transaction, expectedVersion));
    if (enabled && !row.passwordSecretId) {
      throw new AppError("mailbox_not_configured", "Set a mailbox credential before enabling ingest", 409);
    }
    const [updated] = await transaction.update(mailInMailbox)
      .set({ enabled, version: row.version + 1, updatedAt: now })
      .where(eq(mailInMailbox.version, row.version))
      .returning({ id: mailInMailbox.id });
    if (!updated) throw new AppError("mailbox_version_conflict", "The mailbox settings changed; reload and try again", 409);
    await recordMailboxAudit(transaction, updated.id, actorUserId, enabled ? "mail_in_ingest_enabled" : "mail_in_ingest_disabled", {});
  });
  return readMailboxSettings(actorUserId);
}

/**
 * The administrator's emergency instance-wide alias-key rotation (ADR-0017
 * decision 2, slice 3, orbit#744).
 *
 * This is the ONE operation that changes every member's address, and it is
 * deliberately not something a member can trigger: a new `alias_key` row is
 * minted, the mailbox is re-pointed at it, and every relay is rotated in the
 * same transaction with the grace the administrator chose — 0 to 90 days,
 * which is the same ceiling the environment-era configuration capped an alias
 * transition at.
 *
 * The superseded key row is KEPT, not deleted, unlike a password rotation:
 * every outgoing address is spelt in its bytes, and deleting it would cut the
 * grace period off at the moment it was granted. It goes when the last row
 * naming it lapses.
 */
export async function rotateMailboxAliasKey(
  actorUserId: string,
  expectedVersion: number,
  graceDays: number,
  dependencies: MailboxSettingsDependencies = {},
): Promise<MailboxSettingsView> {
  await requireInstanceAdministrator(actorUserId);
  const grace = graceDaysSchema.parse(graceDays);
  const now = dependencies.now?.() ?? new Date();
  await getDb().transaction(async (transaction) => {
    const row = requireMailbox(await lockMailbox(transaction, expectedVersion));
    if (!row.passwordSecretId) throw new AppError("mailbox_not_configured", "Mail-in has not been set up", 409);
    const account = { host: row.host, user: row.accountUser };
    const aliasSecret = randomBytes(ALIAS_KEY_BYTES).toString("base64url");
    const created = await insertSecret(transaction, "alias_key", Buffer.from(aliasSecret, "utf8"), account, actorUserId);
    const [updated] = await transaction.update(mailInMailbox)
      .set({ aliasKeySecretId: created.id, version: row.version + 1, updatedAt: now })
      .where(eq(mailInMailbox.version, row.version))
      .returning({ id: mailInMailbox.id });
    if (!updated) throw new AppError("mailbox_version_conflict", "The mailbox settings changed; reload and try again", 409);
    const config = imapConfigFromMailbox({ ...row, enabled: row.enabled }, "unused-for-derivation", aliasSecret, {
      currentId: created.id,
      byId: { [created.id]: aliasSecret },
    });
    await rotateAllRelaysForNewAliasKey(transaction, actorUserId, config, created.id, grace * 86_400_000, now);
  });
  return readMailboxSettings(actorUserId);
}

/** Runs the bounded connect against a candidate or committed configuration. */
async function verifyCandidate(
  config: ImapIngestionConfig,
  dependencies: MailboxSettingsDependencies,
): Promise<MailboxVerificationOutcome> {
  if (!config.configured) return "not_configured";
  const verify = dependencies.verifyImap ?? verifyImapProvider;
  let result: Awaited<ReturnType<typeof verifyImapProvider>>;
  try {
    result = await verify(config);
  } catch {
    return "provider_unavailable";
  }
  if (result === "ready") return "verified";
  return result === "imap_unconfigured" ? "not_configured" : "provider_unavailable";
}

/** Writes the bounded outcome and, for a committed mailbox, the state it implies. */
async function recordVerificationOutcome(
  row: MailboxRow | undefined,
  actorUserId: string,
  outcome: MailboxVerificationOutcome | MailboxProbeOutcome,
  markState = false,
): Promise<void> {
  if (!row) return;
  await getDb().transaction(async (transaction) => {
    if (markState) {
      await transaction.update(mailInMailbox).set({
        verificationState: outcome === "verified" ? "verified" : "failed",
        verifiedAt: outcome === "verified" ? new Date() : row.verifiedAt,
        updatedAt: new Date(),
      }).where(eq(mailInMailbox.singleton, true));
    }
    await recordMailboxAudit(transaction, row.id, actorUserId, "mail_in_credential_verified", { outcome });
  });
}

/**
 * Verifies the stored credential against the provider, without sending mail.
 *
 * This is the cheap check: a bounded TLS connect and authentication, the same
 * one the poll loop's preflight runs. The setup probe below is the expensive
 * one that proves sub-addressing end to end.
 */
export async function verifyMailboxCredential(
  actorUserId: string,
  dependencies: MailboxSettingsDependencies = {},
): Promise<{ outcome: MailboxVerificationOutcome; settings: MailboxSettingsView }> {
  await requireInstanceAdministrator(actorUserId);
  const row = await readMailboxRow();
  if (!row) return { outcome: "not_configured", settings: await readMailboxSettings(actorUserId) };
  let config: ImapIngestionConfig;
  try {
    config = await getImapIngestionConfig();
  } catch (error) {
    if (!(error instanceof MailInCredentialLockedError)) throw error;
    await recordVerificationOutcome(row, actorUserId, "credential_locked", true);
    return { outcome: "credential_locked", settings: await readMailboxSettings(actorUserId) };
  }
  const outcome = await verifyCandidate({ ...config, enabled: config.configured }, dependencies);
  await recordVerificationOutcome(row, actorUserId, outcome, true);
  return { outcome, settings: await readMailboxSettings(actorUserId) };
}

/**
 * Rung 1 of the ratified degradation ladder (owner, 2026-08-13, #336):
 * "setup probes the mailbox by round-tripping a self-addressed test message
 * to a derived alias".
 *
 * It sends one message from the instance's own SMTP sender to an alias
 * derived from the mailbox account, then watches the mailbox for it. Two
 * different things can fail, and the two outcomes are kept apart because the
 * remedies are different: the provider may not deliver sub-addressed mail at
 * all (`not_delivered`), or it may deliver it but strip the envelope
 * recipient, in which case mail arrives and can never be attributed
 * (`delivered_without_recipient_header`).
 *
 * The probe's alias is derived from an opaque token rather than any real
 * user, so it belongs to nobody, matches no `imap_recipient_aliases` row, and
 * cannot land in a member's queue. The probe deletes its own message from the
 * mailbox rather than leaving litter behind for the poll cycle to record.
 */
export async function runMailboxSetupProbe(
  actorUserId: string,
  dependencies: MailboxSettingsDependencies = {},
): Promise<{ outcome: MailboxProbeOutcome; settings: MailboxSettingsView }> {
  await requireInstanceAdministrator(actorUserId);
  const row = await readMailboxRow();
  const answer = async (outcome: MailboxProbeOutcome) => {
    await recordVerificationOutcome(row, actorUserId, outcome);
    return { outcome, settings: await readMailboxSettings(actorUserId) };
  };
  if (!row) return answer("not_configured");

  let config: ImapIngestionConfig;
  try {
    config = await getImapIngestionConfig();
  } catch (error) {
    if (!(error instanceof MailInCredentialLockedError)) throw error;
    return answer("credential_locked");
  }
  if (!config.configured) return answer("not_configured");

  let smtp: NotificationWorkerConfig;
  try {
    smtp = (dependencies.smtpConfig ?? getNotificationWorkerConfig)();
  } catch {
    return answer("smtp_not_configured");
  }
  if (!smtp.smtpUrl || !smtp.smtpFrom) return answer("smtp_not_configured");

  const token = randomUUID();
  const probeAlias = deriveImapRecipientAlias(`orbit:mail-in-setup-probe:${token}`, config.aliasBase, config.aliasCurrent);
  const send = dependencies.sendProbeMail ?? defaultProbeSender(smtp);
  try {
    await send({
      from: smtp.smtpFrom,
      to: probeAlias,
      subject: `Orbit setup probe ${token}`,
      text: "Orbit sent this to itself to check that this mailbox accepts plus-addressed mail. It is safe to ignore.",
    });
  } catch {
    return answer("smtp_unavailable");
  }

  let sighting: ProbeSighting | undefined;
  try {
    sighting = await (dependencies.findProbeMessage ?? findProbeMessage)(config, token);
  } catch {
    return answer("provider_unavailable");
  }
  if (!sighting) return answer("not_delivered");
  const preserved = sighting.trustedRecipient
    && normalizeImapRecipientAlias(sighting.trustedRecipient, config.aliasBase) === probeAlias.toLowerCase();
  return answer(preserved ? "delivered" : "delivered_without_recipient_header");
}

function defaultProbeSender(smtp: NotificationWorkerConfig) {
  return async (message: { from: string; to: string; subject: string; text: string }) => {
    const transporter = createSmtpTransport(smtp);
    try {
      await transporter.sendMail(message);
    } finally {
      transporter.close();
    }
  };
}

/**
 * Watches the mailbox for the probe's own message and takes it back out.
 *
 * The search is by the probe's random token in the subject, so it can never
 * match a member's mail. The message is flagged `\Deleted` and that one UID
 * expunged, which leaves the durable cursor (`max(uid)`) alone: the poll
 * cycle never has to decide what to do with a message Orbit sent itself.
 */
async function findProbeMessage(config: ImapIngestionConfig, token: string): Promise<ProbeSighting | undefined> {
  const deadline = Date.now() + PROBE_DEADLINE_MS;
  const subject = `Orbit setup probe ${token}`;
  const client = createImapClient(config);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.mailbox);
    try {
      while (Date.now() < deadline) {
        const uids = await client.search({ subject }, { uid: true });
        const uid = Array.isArray(uids) ? uids.at(-1) : undefined;
        if (uid !== undefined) {
          const message = await client.fetchOne(String(uid), { headers: true }, { uid: true });
          const headers = message && typeof message === "object" && "headers" in message
            ? (message as { headers?: Buffer }).headers
            : undefined;
          const trustedRecipient = trustedRecipientOf(headers, config.trustedRecipientHeader);
          /* Best effort: the answer is already known, and a provider that
             refuses the expunge must not turn a successful probe into a
             failed one. */
          try { await client.messageDelete(String(uid), { uid: true }); } catch { /* The message stays; the probe still answered. */ }
          return { trustedRecipient };
        }
        await new Promise((resolve) => { setTimeout(resolve, PROBE_POLL_INTERVAL_MS); });
      }
      return undefined;
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch { /* The connection may never have completed. */ }
  }
}

/* Re-parsed here rather than imported from the ingestion shell so the probe
   reads exactly the header the receipt path reads, with the same bounds. */
function trustedRecipientOf(headers: Buffer | undefined, headerName: string): string | undefined {
  if (!headers || !headerName) return undefined;
  const text = headers.toString("utf8");
  const expected = `${headerName.toLowerCase()}:`;
  for (const line of text.split(/\r?\n/u)) {
    if (line.toLowerCase().startsWith(expected)) return line.slice(expected.length).trim();
  }
  return undefined;
}
