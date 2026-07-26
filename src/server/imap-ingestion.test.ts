import { describe, expect, it } from "vitest";
import { getImapIngestionConfig, imapRecipientAlias, matchesImapRecipientAlias } from "./imap-ingestion";

describe("IMAP ingestion configuration", () => {
  const environment = (values: Record<string, string | undefined>): NodeJS.ProcessEnv => ({ ...values, NODE_ENV: "test" } as NodeJS.ProcessEnv);

  it("is disabled until a complete dedicated mailbox and SMTP are configured", () => {
    expect(getImapIngestionConfig(environment({})).enabled).toBe(false);
    expect(() => getImapIngestionConfig(environment({ IMAP_HOST: "imap.example.test" })))
      .toThrow("must be configured together");
    expect(() => getImapIngestionConfig(environment({ IMAP_HOST: "imap.example.test", IMAP_USER: "orbit", IMAP_PASSWORD: "test-password" })))
      .toThrow("SMTP_URL must be configured");
  });

  it("uses verified implicit TLS and a bounded poll interval", () => {
    expect(getImapIngestionConfig(environment({
      IMAP_HOST: "imap.example.test",
      IMAP_PORT: "993",
      IMAP_USER: "orbit",
      IMAP_PASSWORD: "test-password",
      IMAP_POLL_SECONDS: "30",
      IMAP_RECIPIENT_DOMAIN: "ingest.example.test",
      IMAP_ALIAS_SECRET: "test-alias-secret-that-is-long-enough",
      IMAP_TRUSTED_RECIPIENT_HEADER: "X-Original-To",
      SMTP_URL: "smtps://smtp.example.test",
    }))).toMatchObject({ enabled: true, port: 993, pollMilliseconds: 30_000, mailbox: "INBOX" });
  });

  it("derives opaque aliases and rejects non-matching provider recipients", () => {
    const config = getImapIngestionConfig(environment({
      IMAP_HOST: "imap.example.test", IMAP_USER: "orbit", IMAP_PASSWORD: "test-password",
      IMAP_RECIPIENT_DOMAIN: "ingest.example.test", IMAP_ALIAS_SECRET: "test-alias-secret-that-is-long-enough",
      IMAP_TRUSTED_RECIPIENT_HEADER: "X-Original-To", SMTP_URL: "smtps://smtp.example.test",
    }));
    const alias = imapRecipientAlias("6f7aa3dc-347d-4ff4-bf50-bc4f4ffc054a", config);
    expect(alias).toMatch(/^orbit\+[A-Za-z0-9_-]+@ingest\.example\.test$/);
    expect(matchesImapRecipientAlias(alias.toUpperCase(), "6f7aa3dc-347d-4ff4-bf50-bc4f4ffc054a", config)).toBe(true);
    expect(matchesImapRecipientAlias("orbit+other@ingest.example.test", "6f7aa3dc-347d-4ff4-bf50-bc4f4ffc054a", config)).toBe(false);
  });
});
