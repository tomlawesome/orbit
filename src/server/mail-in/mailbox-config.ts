/**
 * The database-backed replacement for the environment-driven mail-in
 * configuration (ADR-0017 decision 1 and 6, slice 1, orbit#742).
 *
 * `getImapIngestionConfig` here is what every runtime caller in this module
 * uses; the environment-parsing function of the same old name lives on in
 * `core/config.ts` under `parseImapIngestionConfigFromEnvironment`, kept only
 * so its characterization tests stay exercised — nothing wires it up any
 * more. There is no environment fallback and no one-shot import: the owner's
 * rescoping of orbit#742 removed both, because there are no existing
 * installs to carry forward (mail-in ships its admin-settings surface next,
 * in #743).
 *
 * This lives outside `core/` because it needs `getDb`/schema access, which
 * `core/` is not allowed (src/server/mail-in/README.md).
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, mailInMailbox, mailInSecrets } from "@/db/schema";
import { log } from "@/lib/logger";
import { getDocumentConfig } from "@/server/documents/config";
import {
  decryptMailInSecret,
  type MailInSecretContext,
  type MailInSecretEnvelope,
} from "./core/secret-crypto";
import { imapAliasBaseFromAccount } from "./core/imap-recipient";
import type { ImapIngestionConfig } from "./core/config";

/**
 * Thrown when a `mail_in_secrets` row cannot be decrypted under the current
 * document KEK — a KEK swap with no rewrap, a tampered row, or corruption.
 * The message and every field on this error are fixed and non-secret: no
 * plaintext, provider error, or stack detail from the underlying crypto
 * failure is ever attached (ADR-0017 decision 1, decision 5).
 */
export class MailInCredentialLockedError extends Error {
  readonly keyId: string;

  constructor(keyId: string) {
    super("The mail-in credential could not be decrypted under the current key");
    this.name = "MailInCredentialLockedError";
    this.keyId = keyId;
  }
}

const NOT_CONFIGURED: ImapIngestionConfig = {
  configured: false,
  enabled: false,
  host: "",
  port: 993,
  user: "",
  password: "",
  mailbox: "INBOX",
  tlsServerName: "",
  recipientDomain: "",
  aliasBase: { localPart: "orbit", domain: "" },
  currentAliasGeneration: 1,
  currentAliasSecret: "",
  aliasCurrent: { generation: 1, secret: "" },
  aliasSecret: "",
  trustedRecipientHeader: "",
  trustedAuthservId: "",
  pollMilliseconds: 300_000,
};

/**
 * Whose `Authentication-Results` verdict this instance believes (ADR-0017
 * decision 3, slice 4).
 *
 * The administrator's explicit value always wins. Gmail and Outlook write a
 * known, fixed identity, so those two profiles work without one being typed.
 * Mailcow and `other` are the operator's own host, which only they can supply,
 * and until they do this answers empty — which means nothing is believed, no
 * mail is attributed by sender and no reply is ever sent. Guessing the host
 * would be inventing a rule ADR-0017 did not make, and the guess would be the
 * one an attacker gets to exploit.
 */
const PROFILE_AUTHSERV_IDS: Record<string, string> = {
  gmail: "mx.google.com",
  outlook: "protection.outlook.com",
};

export function resolveTrustedAuthservId(providerProfile: string | undefined, configured: string | undefined): string {
  const explicit = configured?.trim().toLowerCase();
  if (explicit) return explicit;
  return PROFILE_AUTHSERV_IDS[providerProfile ?? ""] ?? "";
}

type MailInSecretRow = typeof mailInSecrets.$inferSelect;

/** Authenticates and decrypts one secret row, bound to the mailbox's own host/account. */
function decryptSecretRow(row: MailInSecretRow, account: { host: string; user: string }, keyEncryptionKey: Buffer): Buffer {
  const context: MailInSecretContext = {
    secretId: row.id,
    kind: row.kind,
    host: account.host,
    user: account.user,
  };
  const envelope: MailInSecretEnvelope = {
    envelopeVersion: row.envelopeVersion as 1,
    algorithm: "aes-256-gcm",
    keyId: row.keyId,
    contentIv: row.contentIv,
    contentAuthTag: row.contentAuthTag,
    wrappedDek: row.wrappedDek,
    wrapIv: row.wrapIv,
    wrapAuthTag: row.wrapAuthTag,
  };
  return decryptMailInSecret(row.ciphertext, context, envelope, keyEncryptionKey);
}

// Per-process guard so a stuck lock logs and audits once rather than once per
// poll cycle; a fresh lock (a different keyId) is still reported.
let lastAuditedLockKeyId: string | undefined;

/** Records `mail_in_credential_locked` once per distinct lock, and logs with no secret or stack trace. */
async function reportCredentialLocked(mailboxId: string, keyId: string): Promise<void> {
  log.error({
    event: "imap.ingestion",
    state: "blocked",
    reason: "key_unavailable",
    action: "inspect_admin_diagnostics",
    impact: "mail_receipt_delayed",
  });
  if (lastAuditedLockKeyId === keyId) return;
  lastAuditedLockKeyId = keyId;
  await getDb().insert(auditLog).values({
    householdId: null,
    actorUserId: null,
    entityType: "mail_in_mailbox",
    entityId: mailboxId,
    action: "mail_in_credential_locked",
    changes: { keyId },
  });
}

/**
 * Turns one mailbox row into the shape the ingestion worker and the relay
 * page already read. Exported so the administrator settings module can build
 * the same configuration for a candidate that has not been committed yet —
 * rotation and first setup both have to verify against the provider before
 * anything is written (ADR-0017 decision 1).
 */
export function imapConfigFromMailbox(
  mailbox: {
    host: string; port: number; accountUser: string; mailbox: string; tlsServerName: string;
    trustedRecipientHeader: string; pollSeconds: number; enabled: boolean;
    providerProfile?: string; trustedAuthservId?: string;
  },
  password: string,
  aliasSecret: string,
  aliasKeys: { currentId?: string | null; byId?: Record<string, string> } = {},
): ImapIngestionConfig {
  const configured = Boolean(mailbox.host && mailbox.accountUser && password);
  /* Generation 1 is the shape a not-yet-enrolled member starts at; since
     ADR-0017 slice 3 the live number is the user's own, read from
     `mail_in_relays`, and this field carries only the instance's key bytes. */
  const aliasCurrent = { generation: 1, secret: aliasSecret };
  const aliasBase = imapAliasBaseFromAccount(mailbox.accountUser);
  return {
    ...(aliasKeys.currentId ? { aliasKeySecretId: aliasKeys.currentId } : {}),
    ...(aliasKeys.byId ? { aliasKeys: aliasKeys.byId } : {}),
    configured,
    enabled: configured && mailbox.enabled,
    host: mailbox.host,
    port: mailbox.port,
    user: mailbox.accountUser,
    password,
    mailbox: mailbox.mailbox,
    tlsServerName: mailbox.tlsServerName,
    recipientDomain: aliasBase.domain,
    aliasBase,
    currentAliasGeneration: aliasCurrent.generation,
    currentAliasSecret: aliasCurrent.secret,
    aliasCurrent,
    aliasSecret: aliasCurrent.secret,
    trustedRecipientHeader: mailbox.trustedRecipientHeader,
    trustedAuthservId: resolveTrustedAuthservId(mailbox.providerProfile, mailbox.trustedAuthservId),
    pollMilliseconds: mailbox.pollSeconds * 1_000,
  };
}

/**
 * Resolves the mail-in configuration from `mail_in_mailbox`/`mail_in_secrets`.
 * No row means mail-in has never been set up: this resolves to the same
 * `configured: false` shape the environment parser used to return, never an
 * error. A row whose secret cannot be decrypted throws
 * `MailInCredentialLockedError` instead of silently disabling ingestion,
 * because that failure needs an administrator's attention (decision 1).
 */
export async function getImapIngestionConfig(): Promise<ImapIngestionConfig> {
  const [mailboxRow] = await getDb().select().from(mailInMailbox).limit(1);
  if (!mailboxRow) return NOT_CONFIGURED;

  const documentConfig = getDocumentConfig();
  const account = { host: mailboxRow.host, user: mailboxRow.accountUser };

  let password = "";
  let aliasSecret = "";

  if (mailboxRow.passwordSecretId) {
    const [secretRow] = await getDb().select().from(mailInSecrets)
      .where(eq(mailInSecrets.id, mailboxRow.passwordSecretId)).limit(1);
    if (secretRow) {
      try {
        password = decryptSecretRow(secretRow, account, documentConfig.keyEncryptionKey).toString("utf8");
      } catch {
        await reportCredentialLocked(mailboxRow.id, secretRow.keyId);
        throw new MailInCredentialLockedError(secretRow.keyId);
      }
    }
  }

  /* Every alias key, not just the mailbox's current one. An emergency
     instance-wide rotation (ADR-0017 slice 3) mints a new key and keeps the
     superseded one until the grace the administrator set has lapsed, because
     the outgoing addresses are spelt in the old key's bytes and
     `imap_recipient_aliases.alias_key_secret_id` names which. */
  const aliasKeysById: Record<string, string> = {};
  if (mailboxRow.aliasKeySecretId) {
    const secretRows = await getDb().select().from(mailInSecrets).where(eq(mailInSecrets.kind, "alias_key"));
    for (const secretRow of secretRows) {
      try {
        aliasKeysById[secretRow.id] = decryptSecretRow(secretRow, account, documentConfig.keyEncryptionKey).toString("utf8");
      } catch {
        // A superseded key that no longer decrypts only costs its own grace
        // period; the CURRENT key failing is what locks mail-in, because
        // nothing can be derived or verified without it.
        if (secretRow.id !== mailboxRow.aliasKeySecretId) continue;
        await reportCredentialLocked(mailboxRow.id, secretRow.keyId);
        throw new MailInCredentialLockedError(secretRow.keyId);
      }
    }
    aliasSecret = aliasKeysById[mailboxRow.aliasKeySecretId] ?? "";
  }

  return imapConfigFromMailbox(mailboxRow, password, aliasSecret, {
    currentId: mailboxRow.aliasKeySecretId,
    byId: aliasKeysById,
  });
}

/** Test-only reset for the per-process locked-audit dedupe guard. */
export function resetMailInCredentialLockAuditForTests(): void {
  lastAuditedLockKeyId = undefined;
}
