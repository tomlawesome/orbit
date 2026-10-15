/**
 * mail-in/core boundary: pure parsing/config logic only. No `getDb`/`db`/
 * schema imports and no `imapflow` import — see src/server/mail-in/README.md.
 * Extracted from imap-ingestion.ts as part of the #298 module split.
 */
import { createHash } from "node:crypto";
import type { NotificationWorkerConfig } from "@/server/notification-worker";
import type { ImapAliasBase, ImapAliasGeneration } from "./imap-recipient";

export interface ImapIngestionConfig {
  configured: boolean;
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
  tlsServerName: string;
  recipientDomain: string;
  /**
   * The plus-address base every relay address is built on, derived from
   * `user` (ADR-0017 decision 1). `recipientDomain` is the same domain, kept
   * as its own field because the receipt path reports a wrong-domain failure
   * distinctly from a malformed local part.
   */
  aliasBase: ImapAliasBase;
  currentAliasGeneration: number;
  currentAliasSecret: string;
  previousAliasGeneration?: number;
  previousAliasSecret?: string;
  previousAliasExpiresAt?: Date;
  aliasCurrent: ImapAliasGeneration;
  aliasPrevious?: ImapAliasGeneration;
  /**
   * The `mail_in_secrets` row of kind `alias_key` the mailbox currently points
   * at, recorded on every alias row this key derives (ADR-0017 slice 3). Absent
   * when the config is built without a stored key row.
   */
  aliasKeySecretId?: string;
  /**
   * Every alias key by row id, so an address minted under a key the
   * administrator has since replaced still verifies for as long as the grace
   * they set runs. The current key is in here too.
   */
  aliasKeys?: Record<string, string>;
  /** Deprecated in-memory compatibility name; never persist or log it. */
  aliasSecret: string;
  trustedRecipientHeader: string;
  /**
   * Whose `Authentication-Results` verdict this instance believes (ADR-0017
   * decision 3). Absent or empty means it has not said, so no sender is ever
   * authenticated and nothing is attributed — the fail-closed default.
   */
  trustedAuthservId?: string;
  pollMilliseconds: number;
}

/** Non-secret configuration commitment used only to invalidate stale preflight results. */
export function imapProviderConfigCommitment(config: ImapIngestionConfig, smtp: NotificationWorkerConfig): string {
  return createHash("sha256").update(JSON.stringify([
    "orbit:mail-provider-preflight:v2",
    config.host, config.port, config.user, config.mailbox, config.tlsServerName,
    config.recipientDomain, config.aliasBase.localPart,
    config.trustedRecipientHeader, config.currentAliasGeneration,
    config.previousAliasGeneration ?? null, config.previousAliasExpiresAt?.toISOString() ?? null,
    smtp.smtpSecurity, smtp.smtpFrom,
  ])).digest("hex");
}

/** Bounded retry schedule shared by claim tests and the attachment worker. */
export function imapAttachmentRetryDelayMs(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("IMAP attachment attempt is invalid");
  return Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attempts - 1, 10));
}
