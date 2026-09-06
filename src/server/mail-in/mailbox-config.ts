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
  pollMilliseconds: 300_000,
};

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
  },
  password: string,
  aliasSecret: string,
): ImapIngestionConfig {
  const configured = Boolean(mailbox.host && mailbox.accountUser && password);
  const aliasCurrent = { generation: 1, secret: aliasSecret };
  const aliasBase = imapAliasBaseFromAccount(mailbox.accountUser);
  return {
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

  if (mailboxRow.aliasKeySecretId) {
    const [secretRow] = await getDb().select().from(mailInSecrets)
      .where(eq(mailInSecrets.id, mailboxRow.aliasKeySecretId)).limit(1);
    if (secretRow) {
      try {
        aliasSecret = decryptSecretRow(secretRow, account, documentConfig.keyEncryptionKey).toString("utf8");
      } catch {
        await reportCredentialLocked(mailboxRow.id, secretRow.keyId);
        throw new MailInCredentialLockedError(secretRow.keyId);
      }
    }
  }

  return imapConfigFromMailbox(mailboxRow, password, aliasSecret);
}

/** Test-only reset for the per-process locked-audit dedupe guard. */
export function resetMailInCredentialLockAuditForTests(): void {
  lastAuditedLockKeyId = undefined;
}
