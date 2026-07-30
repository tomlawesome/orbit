import { describe, expect, it } from "vitest";
import { authenticatedReviewUrl, buildImapNotification, imapNotificationRetryDelayMs } from "./imap-receipt-worker";

describe("mailbox notification privacy contract", () => {
  it.each(["receipt", "review_ready"] as const)("renders a generic authenticated %s notification", (kind) => {
    const notification = buildImapNotification(kind, "https://orbit.example.test/?open=inbox");
    expect(notification.subject).not.toMatch(/subject|sender|filename|household|item/i);
    expect(notification.text).toContain("https://orbit.example.test/?open=inbox");
    expect(notification.text).not.toMatch(/document attachment|message|recipient|alias|provider|hash|error|secret/i);
    expect(notification.text).toMatch(/sign in|authenticate/i);
  });

  it("never puts an approval or user token in the review link", () => {
    const notification = buildImapNotification("review_ready", "https://orbit.example.test/?open=inbox");
    expect(notification.text).not.toMatch(/receipt|draft|approve|token|user|household|id=/i);
  });

  it("normalizes the authenticated application link to the origin", () => {
    expect(authenticatedReviewUrl({ NODE_ENV: "test", APP_URL: "https://user:example.invalid@orbit.example.test/private/path#token" } as NodeJS.ProcessEnv))
      .toBe("https://orbit.example.test/?open=inbox");
    expect(imapNotificationRetryDelayMs(1)).toBe(60_000);
    expect(imapNotificationRetryDelayMs(20)).toBe(3_600_000);
  });
});
