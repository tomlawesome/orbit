import { imapAliasBaseFromAccount } from "@/server/mail-in/core/imap-recipient";
import type { ImapIngestionConfig } from "@/server/mail-in/core/config";

/**
 * A complete, enabled `ImapIngestionConfig` for tests, built field by field.
 * The runtime config comes from the database (ADR-0017), so a test that needs
 * one states the fields it cares about and takes harmless defaults for the
 * rest. The alias fields that are derived from others (`aliasBase`,
 * `aliasCurrent`, `aliasSecret`) follow `user`, `recipientDomain` and the
 * current generation and secret unless overridden outright.
 */
export function testImapConfig(overrides: Partial<ImapIngestionConfig> = {}): ImapIngestionConfig {
  const user = overrides.user ?? "orbit";
  const recipientDomain = overrides.recipientDomain ?? "ingest.example.test";
  const currentAliasGeneration = overrides.currentAliasGeneration ?? 1;
  const currentAliasSecret = overrides.currentAliasSecret ?? "test-current-alias-secret-that-is-long-enough";
  return {
    configured: true,
    enabled: true,
    host: "imap.example.test",
    port: 993,
    user,
    password: "test-password",
    mailbox: "INBOX",
    tlsServerName: "",
    recipientDomain,
    aliasBase: { localPart: imapAliasBaseFromAccount(user).localPart, domain: recipientDomain },
    currentAliasGeneration,
    currentAliasSecret,
    aliasCurrent: { generation: currentAliasGeneration, secret: currentAliasSecret },
    aliasSecret: currentAliasSecret,
    trustedRecipientHeader: "X-Original-To",
    pollMilliseconds: 300_000,
    ...overrides,
  };
}
