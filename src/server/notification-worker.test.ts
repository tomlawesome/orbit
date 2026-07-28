import { describe, expect, it } from "vitest";
import {
  categorizeProviderError,
  deliveryFailureState,
  enabledDeliveryChannels,
  getNotificationWorkerConfig,
  getNotificationWorkerHealth,
  householdReminderTime,
  notificationRetryDelayMs,
  reminderIsSnoozed,
} from "./notification-worker";

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
