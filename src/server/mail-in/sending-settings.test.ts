import { describe, expect, it } from "vitest";
import { mailboxSubmissionServer } from "./sending-settings";

describe("the mailbox account's submission server (#1780)", () => {
  it("keeps Gmail's default submission server", () => {
    expect(mailboxSubmissionServer({ host: "imap.gmail.com", providerProfile: "gmail" })).toEqual({ host: "smtp.gmail.com", port: 587, security: "starttls" });
  });

  it("submits through the mailbox's own host for other and a stored outlook profile", () => {
    expect(mailboxSubmissionServer({ host: "mail.example.test", providerProfile: "other" }).host).toBe("mail.example.test");
    expect(mailboxSubmissionServer({ host: "outlook.office365.com", providerProfile: "outlook" }).host).toBe("outlook.office365.com");
  });
});
