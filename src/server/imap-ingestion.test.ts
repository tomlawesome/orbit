import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getImapIngestionConfig, imapRecipientAlias, matchesImapRecipientAlias } from "./imap-ingestion";
import { deriveImapRecipientAlias } from "./imap-recipient";

const temporaryDirectories: string[] = [];

function secretFile(value: string): string {
  const directory = mkdtempSync(join(tmpdir(), "orbit-imap-alias-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "secret");
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  return path;
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("IMAP ingestion configuration", () => {
  const environment = (values: Record<string, string | undefined>): NodeJS.ProcessEnv => ({ ...values, NODE_ENV: "test" } as NodeJS.ProcessEnv);

  it("is disabled until a complete dedicated mailbox and SMTP are configured", () => {
    expect(getImapIngestionConfig(environment({})).enabled).toBe(false);
    expect(() => getImapIngestionConfig(environment({ IMAP_HOST: "imap.example.test" })))
      .toThrow("must be configured together");
    expect(() => getImapIngestionConfig(environment({ IMAP_HOST: "imap.example.test", IMAP_USER: "orbit", IMAP_PASSWORD: "test-password" })))
      .toThrow("SMTP must be configured");
  });

  it("uses verified implicit TLS, file-backed alias generations, and a bounded poll interval", () => {
    expect(getImapIngestionConfig(environment({
      IMAP_HOST: "imap.example.test",
      IMAP_PORT: "993",
      IMAP_USER: "orbit",
      IMAP_PASSWORD: "test-password",
      IMAP_POLL_SECONDS: "30",
      IMAP_RECIPIENT_DOMAIN: "ingest.example.test",
      IMAP_ALIAS_CURRENT_GENERATION: "2",
      IMAP_ALIAS_CURRENT_SECRET: "test-current-alias-secret-that-is-long-enough",
      IMAP_TRUSTED_RECIPIENT_HEADER: "X-Original-To",
      SMTP_URL: "smtps://smtp.example.test",
    }))).toMatchObject({
      enabled: true,
      port: 993,
      pollMilliseconds: 30_000,
      mailbox: "INBOX",
      currentAliasGeneration: 2,
      previousAliasGeneration: undefined,
    });
  });

  it("accepts individual SMTP configuration", () => {
    expect(getImapIngestionConfig(environment({
      IMAP_HOST: "imap.example.test", IMAP_USER: "orbit", IMAP_PASSWORD: "test-password",
      IMAP_RECIPIENT_DOMAIN: "ingest.example.test", IMAP_ALIAS_CURRENT_GENERATION: "1", IMAP_ALIAS_CURRENT_SECRET: "test-current-alias-secret-that-is-long-enough",
      IMAP_TRUSTED_RECIPIENT_HEADER: "X-Original-To", SMTP_HOST: "smtp.example.test",
    }))).toMatchObject({ enabled: true });
  });

  it("loads distinct current and previous alias keys through runtime secret files", () => {
    const currentPath = secretFile("test-current-alias-secret-that-is-long-enough");
    const previousPath = secretFile("test-previous-alias-secret-that-is-long-enough");
    const previousExpiry = new Date(Date.now() + 86_400_000).toISOString();
    const configured = getImapIngestionConfig(environment({
      IMAP_HOST: "imap.example.test", IMAP_USER: "orbit", IMAP_PASSWORD: "test-password",
      IMAP_RECIPIENT_DOMAIN: "ingest.example.test", IMAP_ALIAS_CURRENT_GENERATION: "2", IMAP_ALIAS_CURRENT_SECRET_FILE: currentPath,
      IMAP_ALIAS_PREVIOUS_GENERATION: "1", IMAP_ALIAS_PREVIOUS_SECRET_FILE: previousPath, IMAP_ALIAS_PREVIOUS_EXPIRES_AT: previousExpiry,
      IMAP_TRUSTED_RECIPIENT_HEADER: "X-Original-To", SMTP_HOST: "smtp.example.test",
    }));
    expect(configured.currentAliasSecret).toBe("test-current-alias-secret-that-is-long-enough");
    expect(configured.previousAliasSecret).toBe("test-previous-alias-secret-that-is-long-enough");
  });

  it("rejects partial current and previous generation configuration", () => {
    const base = {
      IMAP_HOST: "imap.example.test", IMAP_USER: "orbit", IMAP_PASSWORD: "test-password",
      IMAP_RECIPIENT_DOMAIN: "ingest.example.test", IMAP_TRUSTED_RECIPIENT_HEADER: "X-Original-To",
      SMTP_URL: "smtps://smtp.example.test",
    };
    expect(() => getImapIngestionConfig(environment({ ...base, IMAP_ALIAS_CURRENT_GENERATION: "1" })))
      .toThrow("alias current generation and secret");
    expect(() => getImapIngestionConfig(environment({ ...base, IMAP_ALIAS_CURRENT_SECRET: "test-current-alias-secret-that-is-long-enough" })))
      .toThrow("alias current generation and secret");
    expect(() => getImapIngestionConfig(environment({
      ...base,
      IMAP_ALIAS_CURRENT_GENERATION: "2",
      IMAP_ALIAS_CURRENT_SECRET: "test-current-alias-secret-that-is-long-enough",
      IMAP_ALIAS_PREVIOUS_GENERATION: "1",
    }))).toThrow("alias previous generation, secret, and expiry");
  });

  it("accepts a bounded previous generation and invalidates it after expiry", () => {
    const previousExpiry = new Date(Date.now() + 86_400_000).toISOString();
    const config = getImapIngestionConfig(environment({
      IMAP_HOST: "imap.example.test", IMAP_USER: "orbit", IMAP_PASSWORD: "test-password",
      IMAP_RECIPIENT_DOMAIN: "ingest.example.test",
      IMAP_ALIAS_CURRENT_GENERATION: "2", IMAP_ALIAS_CURRENT_SECRET: "test-current-alias-secret-that-is-long-enough",
      IMAP_ALIAS_PREVIOUS_GENERATION: "1", IMAP_ALIAS_PREVIOUS_SECRET: "test-previous-alias-secret-that-is-long-enough",
      IMAP_ALIAS_PREVIOUS_EXPIRES_AT: previousExpiry,
      IMAP_TRUSTED_RECIPIENT_HEADER: "X-Original-To", SMTP_URL: "smtps://smtp.example.test",
    }));
    expect(config).toMatchObject({ currentAliasGeneration: 2, previousAliasGeneration: 1 });
    expect(config.previousAliasExpiresAt?.toISOString()).toBe(previousExpiry);
    const userId = "6f7aa3dc-347d-4ff4-bf50-bc4f4ffc054a";
    expect(matchesImapRecipientAlias(deriveImapRecipientAlias(userId, config.recipientDomain, config.aliasPrevious!), userId, config)).toBe(true);
    expect(imapRecipientAlias(userId, config)).toBe(deriveImapRecipientAlias(userId, config.recipientDomain, config.aliasCurrent));
  });
});
