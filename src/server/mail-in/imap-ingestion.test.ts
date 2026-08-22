import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getImapIngestionConfig, imapAttachmentRetryDelayMs, imapProviderConfigCommitment, imapProviderConnectionOptions, imapRecipientAlias, matchesImapRecipientAlias, verifyImapIngestionProviders } from "./imap-ingestion";
import { getNotificationWorkerConfig } from "../notification-worker";
import { deriveImapRecipientAlias } from "./core/imap-recipient";

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

describe("receipt retention", () => {
  it("holds a suggestion for 45 days (#434, owner decision 2026-08-15)", async () => {
    const { RECEIPT_RETENTION_MS } = await import("./imap-ingestion");
    expect(RECEIPT_RETENTION_MS).toBe(45 * 86_400_000);
  });
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

  it("accepts a non-standard implicit TLS port while enforcing verified TLS in provider construction", () => {
    const config = getImapIngestionConfig(environment({
      IMAP_HOST: "imap.example.test", IMAP_PORT: "143", IMAP_USER: "orbit", IMAP_PASSWORD: "test-password",
      IMAP_RECIPIENT_DOMAIN: "ingest.example.test", IMAP_ALIAS_CURRENT_GENERATION: "1", IMAP_ALIAS_CURRENT_SECRET: "test-current-alias-secret-that-is-long-enough",
      IMAP_TRUSTED_RECIPIENT_HEADER: "X-Original-To", SMTP_HOST: "smtp.example.test",
    }));
    expect(config.port).toBe(143);
    expect(imapProviderConnectionOptions(config)).toMatchObject({
      port: 143,
      secure: true,
      tls: { rejectUnauthorized: true, servername: "imap.example.test" },
    });
  });

  it("preserves a configured mailbox while explicitly disabling polling", () => {
    expect(getImapIngestionConfig(environment({
      IMAP_ENABLED: "false",
      IMAP_HOST: "imap.example.test", IMAP_USER: "orbit", IMAP_PASSWORD: "test-password",
      IMAP_RECIPIENT_DOMAIN: "ingest.example.test", IMAP_ALIAS_CURRENT_GENERATION: "1", IMAP_ALIAS_CURRENT_SECRET: "test-current-alias-secret-that-is-long-enough",
      IMAP_TRUSTED_RECIPIENT_HEADER: "X-Original-To", SMTP_HOST: "smtp.example.test",
    }))).toMatchObject({ configured: true, enabled: false });
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

  it("uses bounded exponential attachment backoff and rejects invalid attempts", () => {
    expect(imapAttachmentRetryDelayMs(1)).toBe(1_000);
    expect(imapAttachmentRetryDelayMs(5)).toBe(16_000);
    expect(imapAttachmentRetryDelayMs(50)).toBe(900_000);
    expect(() => imapAttachmentRetryDelayMs(0)).toThrow("attempt is invalid");
  });

  it("requires both current provider preflights and invalidates readiness on safe provider configuration changes", async () => {
    const environmentValues = {
      IMAP_HOST: "imap.example.test", IMAP_USER: "orbit", IMAP_PASSWORD: "provider-password",
      IMAP_RECIPIENT_DOMAIN: "ingest.example.test", IMAP_ALIAS_CURRENT_GENERATION: "1", IMAP_ALIAS_CURRENT_SECRET: "test-current-alias-secret-that-is-long-enough",
      IMAP_TRUSTED_RECIPIENT_HEADER: "X-Original-To", SMTP_HOST: "smtp.example.test", SMTP_USER: "orbit", SMTP_PASSWORD: "smtp-password",
    };
    const config = getImapIngestionConfig(environment(environmentValues));
    const smtp = getNotificationWorkerConfig(environment(environmentValues));
    await expect(verifyImapIngestionProviders(config, smtp, {
      verifySmtp: async () => "ready",
      verifyImap: async () => "ready",
    })).resolves.toMatchObject({ status: "available", smtp: "available", imap: "available" });
    const changed = getImapIngestionConfig(environment({ ...environmentValues, IMAP_HOST: "replacement-imap.example.test" }));
    await expect(verifyImapIngestionProviders(changed, smtp, {
      verifySmtp: async () => "smtp_unavailable",
      verifyImap: async () => "imap_unavailable",
    })).resolves.toMatchObject({ status: "provider_unavailable" });
  });

  it("keeps the provider commitment stable, non-secret, and sensitive to safe configuration", () => {
    const environmentValues = {
      IMAP_HOST: "imap.example.test", IMAP_USER: "orbit", IMAP_PASSWORD: "provider-password",
      IMAP_RECIPIENT_DOMAIN: "ingest.example.test", IMAP_ALIAS_CURRENT_GENERATION: "1", IMAP_ALIAS_CURRENT_SECRET: "test-current-alias-secret-that-is-long-enough",
      IMAP_TRUSTED_RECIPIENT_HEADER: "X-Original-To", SMTP_HOST: "smtp.example.test", SMTP_USER: "orbit", SMTP_PASSWORD: "smtp-password",
    };
    const config = getImapIngestionConfig(environment(environmentValues));
    const smtp = getNotificationWorkerConfig(environment(environmentValues));
    const commitment = imapProviderConfigCommitment(config, smtp);

    expect(commitment).toMatch(/^[0-9a-f]{64}$/u);
    expect(imapProviderConfigCommitment(config, smtp)).toBe(commitment);
    expect(imapProviderConfigCommitment(
      getImapIngestionConfig(environment({ ...environmentValues, IMAP_PASSWORD: "rotated-password" })),
      smtp,
    )).toBe(commitment);
    expect(imapProviderConfigCommitment(
      getImapIngestionConfig(environment({ ...environmentValues, IMAP_HOST: "replacement-imap.example.test" })),
      smtp,
    )).not.toBe(commitment);
    expect(commitment).not.toContain(environmentValues.IMAP_PASSWORD);
    expect(commitment).not.toContain(environmentValues.SMTP_PASSWORD);
  });

  it("reduces exceptional provider verification to a safe result and recovers on a later attempt", async () => {
    const environmentValues = {
      IMAP_HOST: "imap.example.test", IMAP_USER: "orbit", IMAP_PASSWORD: "exception-password",
      IMAP_RECIPIENT_DOMAIN: "ingest.example.test", IMAP_ALIAS_CURRENT_GENERATION: "1", IMAP_ALIAS_CURRENT_SECRET: "test-current-alias-secret-that-is-long-enough",
      IMAP_TRUSTED_RECIPIENT_HEADER: "X-Original-To", SMTP_HOST: "smtp.example.test", SMTP_USER: "orbit", SMTP_PASSWORD: "smtp-password",
    };
    const config = getImapIngestionConfig(environment(environmentValues));
    const smtp = getNotificationWorkerConfig(environment(environmentValues));
    let attempts = 0;
    let failFirstAttempt = true;
    const verifyImap = async () => {
      attempts += 1;
      if (failFirstAttempt) {
        failFirstAttempt = false;
        throw new Error("provider response contained a secret");
      }
      return "ready" as const;
    };
    await expect(verifyImapIngestionProviders(config, smtp, {
      verifySmtp: async () => "ready",
      verifyImap,
    })).resolves.toEqual(expect.objectContaining({ status: "provider_unavailable" }));
    await expect(verifyImapIngestionProviders(config, smtp, {
      verifySmtp: async () => "ready",
      verifyImap,
    })).resolves.toEqual(expect.objectContaining({ status: "available" }));
    expect(attempts).toBe(2);
  });
});
