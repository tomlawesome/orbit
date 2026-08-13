import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  categorizeProviderError,
  deliveryFailureState,
  enabledDeliveryChannels,
  getNotificationWorkerConfig,
  getNotificationWorkerHealth,
  householdReminderTime,
  isAllowedPushEndpoint,
  notificationRetryDelayMs,
  reminderIsSnoozed,
} from "./notification-worker";

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function secretFile(value: string): string {
  const directory = mkdtempSync(join(tmpdir(), "orbit-smtp-secret-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "password");
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  return path;
}

describe("notification worker scheduling", () => {
  it("honours both reminder rules and the recipient's selected channels", () => {
    expect(enabledDeliveryChannels({
      emailEnabled: true,
      pushEnabled: true,
      userEmailEnabled: false,
      userPushEnabled: true,
    })).toEqual(["web_push"]);
    expect(enabledDeliveryChannels({
      emailEnabled: true,
      pushEnabled: false,
      userEmailEnabled: true,
      userPushEnabled: true,
    })).toEqual(["email"]);
  });

  it("schedules at 09:00 in the household timezone across DST, calendar, and host timezone boundaries", () => {
    expect(householdReminderTime("2026-01-15", 0, "Europe/London").toISOString()).toBe("2026-01-15T09:00:00.000Z");
    expect(householdReminderTime("2026-07-15", 0, "Europe/London").toISOString()).toBe("2026-07-15T08:00:00.000Z");
    expect(householdReminderTime("2026-03-29", 0, "Europe/London").toISOString()).toBe("2026-03-29T08:00:00.000Z");
    expect(householdReminderTime("2026-10-25", 0, "Europe/London").toISOString()).toBe("2026-10-25T09:00:00.000Z");
    expect(householdReminderTime("2026-01-01", 1, "Europe/London").toISOString()).toBe("2025-12-31T09:00:00.000Z");
    expect(householdReminderTime("2026-03-08", 0, "America/New_York").toISOString()).toBe("2026-03-08T13:00:00.000Z");
    expect(householdReminderTime("2026-11-01", 0, "America/New_York").toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });

  it("uses bounded retry backoff without depending on the host clock", () => {
    expect(notificationRetryDelayMs(1)).toBe(60_000);
    expect(notificationRetryDelayMs(2)).toBe(120_000);
    expect(notificationRetryDelayMs(5)).toBe(960_000);
    expect(notificationRetryDelayMs(20)).toBe(3_600_000);
  });

  it("validates and defaults worker configuration", () => {
    const config = getNotificationWorkerConfig({
      NODE_ENV: "test",
      WORKER_POLL_SECONDS: "30",
    } as NodeJS.ProcessEnv);
    expect(config.pollMilliseconds).toBe(30_000);
    expect(config.maxAttempts).toBe(5);
  });

  it("keeps SMTP providers independent and prefers a file-backed password", () => {
    const config = getNotificationWorkerConfig({
      NODE_ENV: "test",
      SMTP_HOST: "smtp.example.test",
      SMTP_PORT: "587",
      SMTP_SECURITY: "starttls",
      SMTP_USER: "orbit",
      SMTP_PASSWORD_FILE: secretFile("file-password"),
      IMAP_HOST: "imap.example.test",
    } as NodeJS.ProcessEnv);
    expect(config.smtpUrl).toContain("file-password");
    expect(config.smtpUrl).not.toContain("IMAP");
  });

  it("rejects an SMTP plaintext downgrade or mismatched security URL", () => {
    expect(() => getNotificationWorkerConfig({
      NODE_ENV: "test", SMTP_URL: "smtp://smtp.example.test:25", SMTP_SECURITY: "implicit_tls",
    } as NodeJS.ProcessEnv)).toThrow("implicit TLS");
    expect(() => getNotificationWorkerConfig({
      NODE_ENV: "test", SMTP_URL: "smtps://smtp.example.test:465", SMTP_SECURITY: "starttls",
    } as NodeJS.ProcessEnv)).toThrow("STARTTLS");
  });

  it("suppresses only reminders scheduled before the household snooze resume date", () => {
    const earlyReminder = householdReminderTime("2026-08-31", 30, "Europe/London");
    const laterReminder = householdReminderTime("2026-08-31", 7, "Europe/London");

    expect(reminderIsSnoozed(earlyReminder, "2026-08-15", "Europe/London")).toBe(true);
    expect(reminderIsSnoozed(laterReminder, "2026-08-15", "Europe/London")).toBe(false);
  });

  it("maps provider failures to safe, bounded categories without inspecting messages", () => {
    expect(categorizeProviderError("email", { responseCode: 550, message: "recipient@example.com rejected" }))
      .toBe("smtp_rejected");
    expect(categorizeProviderError("email", { code: "ETIMEDOUT", message: "smtp.internal timed out" }))
      .toBe("smtp_unavailable");
    expect(categorizeProviderError("web_push", { statusCode: 410, message: "https://push.example/subscription" }))
      .toBe("push_unsubscribed");
    expect(categorizeProviderError("web_push", { statusCode: 503 }))
      .toBe("push_unavailable");
    expect(categorizeProviderError("email", { message: "password=secret" })).toBe("unknown");
  });

  it("retries only transient delivery categories and cancels corrective failures", () => {
    expect(deliveryFailureState("smtp_unconfigured", 1, 5)).toBe("cancelled");
    expect(deliveryFailureState("smtp_rejected", 1, 5)).toBe("cancelled");
    expect(deliveryFailureState("recipient_preferences_disabled", 1, 5)).toBe("cancelled");
    expect(deliveryFailureState("smtp_unavailable", 1, 5)).toBe("retry");
    expect(deliveryFailureState("push_unavailable", 5, 5)).toBe("failed");
    expect(deliveryFailureState("unknown", 5, 5)).toBe("failed");
  });

  it("#383 finding 2: only allows push endpoints that are https on the default port and not a private or reserved address", () => {
    expect(isAllowedPushEndpoint("https://push.services.example.test/sub/abc123")).toBe(true);
    expect(isAllowedPushEndpoint("https://push.services.example.test:443/sub/abc123")).toBe(true);
    // Plaintext HTTP is never a real push service, and it strips the VAPID auth header's confidentiality.
    expect(isAllowedPushEndpoint("http://push.services.example.test/sub")).toBe(false);
    // A non-default port on an otherwise-plausible host is exactly the shape
    // the review's concrete probe used against the database container.
    expect(isAllowedPushEndpoint("https://orbit-db:5432/probe")).toBe(false);
    expect(isAllowedPushEndpoint("https://orbit-tika:9998/probe")).toBe(false);
    // IPv4 and IPv6 loopback, link-local, and private ranges.
    expect(isAllowedPushEndpoint("https://127.0.0.1/probe")).toBe(false);
    expect(isAllowedPushEndpoint("https://10.0.0.5/probe")).toBe(false);
    expect(isAllowedPushEndpoint("https://172.20.3.4/probe")).toBe(false);
    expect(isAllowedPushEndpoint("https://192.168.1.10/probe")).toBe(false);
    expect(isAllowedPushEndpoint("https://169.254.1.1/probe")).toBe(false);
    expect(isAllowedPushEndpoint("https://[::1]/probe")).toBe(false);
    expect(isAllowedPushEndpoint("https://[fe80::1]/probe")).toBe(false);
    expect(isAllowedPushEndpoint("https://[fd00::1]/probe")).toBe(false);
    expect(isAllowedPushEndpoint("https://localhost/probe")).toBe(false);
    // Malformed input must fail closed rather than throw.
    expect(isAllowedPushEndpoint("not a url")).toBe(false);
  });

  it("exposes only bounded initial worker health", () => {
    expect(getNotificationWorkerHealth()).toEqual({
      started: false,
      running: false,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorCategory: null,
    });
  });
});
