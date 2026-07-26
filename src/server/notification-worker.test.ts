import { describe, expect, it } from "vitest";
import { getNotificationWorkerConfig, householdReminderTime, reminderIsSnoozed } from "./notification-worker";

describe("notification worker scheduling", () => {
  it("schedules at 09:00 in the household timezone across daylight saving time", () => {
    expect(householdReminderTime("2026-01-15", 0, "Europe/London").toISOString()).toBe("2026-01-15T09:00:00.000Z");
    expect(householdReminderTime("2026-07-15", 0, "Europe/London").toISOString()).toBe("2026-07-15T08:00:00.000Z");
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
});
