import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  categorizeProviderError,
  deliveryFailureState,
  effectiveReminderOffsets,
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

  it("#479: lets an item's own reminder rules stand, pair or no pair", () => {
    const rules = [
      { daysBefore: 30, emailEnabled: true, pushEnabled: false },
      { daysBefore: 1, emailEnabled: false, pushEnabled: true },
    ];
    // The settings screen never claimed to overrule a per-item choice, so the
    // stored pair is not consulted at all — not merged, not appended.
    expect(effectiveReminderOffsets(rules, { firstWarningDays: 21, finalWarningDays: 2 })).toEqual(rules);
    expect(effectiveReminderOffsets(rules, { firstWarningDays: null, finalWarningDays: null })).toEqual(rules);
  });

  it("#479: falls back to the recipient's own pair for an item with no rules, and to the documented defaults when it is unset", () => {
    // No preferences row at all: the column defaults are the answer, and they
    // are the same numbers the settings screen shows a user who never chose.
    expect(effectiveReminderOffsets([], { firstWarningDays: null, finalWarningDays: null })).toEqual([
      { daysBefore: 14, emailEnabled: true, pushEnabled: true },
      { daysBefore: 3, emailEnabled: true, pushEnabled: true },
    ]);
    expect(effectiveReminderOffsets([], { firstWarningDays: 30, finalWarningDays: 7 })).toEqual([
      { daysBefore: 30, emailEnabled: true, pushEnabled: true },
      { daysBefore: 7, emailEnabled: true, pushEnabled: true },
    ]);
    // Half a stored pair is still half an answer: the missing slot defaults
    // on its own rather than dragging its partner back to the default too.
    expect(effectiveReminderOffsets([], { firstWarningDays: 30, finalWarningDays: null })).toEqual([
      { daysBefore: 30, emailEnabled: true, pushEnabled: true },
      { daysBefore: 3, emailEnabled: true, pushEnabled: true },
    ]);
  });

  it("#479: honours the pair's boundary values and never emits the same warning twice", () => {
    // "on the day" is a final warning of zero, which the settings screen
    // offers and the CHECK constraint allows.
    expect(effectiveReminderOffsets([], { firstWarningDays: 365, finalWarningDays: 0 }).map((offset) => offset.daysBefore))
      .toEqual([365, 0]);
    expect(effectiveReminderOffsets([], { firstWarningDays: 1, finalWarningDays: 0 }).map((offset) => offset.daysBefore))
      .toEqual([1, 0]);
    // A pair whose halves coincide is one warning, not a duplicate delivery.
    expect(effectiveReminderOffsets([], { firstWarningDays: 5, finalWarningDays: 5 }).map((offset) => offset.daysBefore))
      .toEqual([5]);
  });

  it("#479: treats the pair as a set of offsets, so a crossed pair still raises both warnings", () => {
    // The route, the schema and two CHECK constraints all refuse a crossed
    // pair, so this is unreachable today; the first/final ordering is a
    // promise the labels make, and each offset is scheduled independently, so
    // a row arriving by some other path must not silence the item entirely.
    expect(effectiveReminderOffsets([], { firstWarningDays: 2, finalWarningDays: 9 }).map((offset) => offset.daysBefore))
      .toEqual([9, 2]);
  });

  it("#479: refuses an out-of-range or fractional stored offset in favour of that slot's default", () => {
    expect(effectiveReminderOffsets([], { firstWarningDays: 0, finalWarningDays: 3 }).map((offset) => offset.daysBefore))
      .toEqual([14, 3]);
    expect(effectiveReminderOffsets([], { firstWarningDays: 400, finalWarningDays: 3 }).map((offset) => offset.daysBefore))
      .toEqual([14, 3]);
    expect(effectiveReminderOffsets([], { firstWarningDays: 30, finalWarningDays: -1 }).map((offset) => offset.daysBefore))
      .toEqual([30, 3]);
    expect(effectiveReminderOffsets([], { firstWarningDays: 14.5, finalWarningDays: 3 }).map((offset) => offset.daysBefore))
      .toEqual([14, 3]);
  });

  it("#479: turns the recipient's pair into the household-local instants the settings screen describes", () => {
    const dueDate = "2026-08-31";
    const [first, final] = effectiveReminderOffsets([], { firstWarningDays: 14, finalWarningDays: 3 })
      .map((offset) => householdReminderTime(dueDate, offset.daysBefore, "Europe/London").toISOString());
    // "14 days before closest approach", then "3 days before", each at 09:00
    // household-local (BST here, so 08:00Z).
    expect(first).toBe("2026-08-17T08:00:00.000Z");
    expect(final).toBe("2026-08-28T08:00:00.000Z");
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
