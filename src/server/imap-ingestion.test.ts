import { describe, expect, it } from "vitest";
import { getImapIngestionConfig } from "./imap-ingestion";

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
      SMTP_URL: "smtps://smtp.example.test",
    }))).toMatchObject({ enabled: true, port: 993, pollMilliseconds: 30_000, mailbox: "INBOX" });
  });
});
