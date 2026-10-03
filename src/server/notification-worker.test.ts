import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const webPushMock = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(async () => ({ statusCode: 201, body: "", headers: {} })),
}));
vi.mock("web-push", () => ({ default: webPushMock }));

import {
  categorizeProviderError,
  createDefaultNotificationProviders,
  deliveryFailureState,
  effectiveReminderOffsets,
  enabledDeliveryChannels,
  getNotificationWorkerConfig,
  getNotificationWorkerHealth,
  householdReminderTime,
  isAllowedPushEndpoint,
  materializeDeliveriesForCandidate,
  NOTIFICATION_PROVIDER_TIMEOUT_MS,
  notificationRetryDelayMs,
  reminderIsSnoozed,
  type MaterializationCandidate,
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

  it("treats SMTP_SECURITY=\"\" as not set, the same as every other unset field (#1151 SF2-F2)", () => {
    const config = getNotificationWorkerConfig({
      NODE_ENV: "test",
      SMTP_SECURITY: "",
    } as NodeJS.ProcessEnv);
    expect(config.smtpSecurity).toBe("starttls");
  });

  it("still rejects a genuinely invalid SMTP_SECURITY rather than silently defaulting it", () => {
    expect(() => getNotificationWorkerConfig({
      NODE_ENV: "test",
      SMTP_SECURITY: "tls1.2",
    } as NodeJS.ProcessEnv)).toThrow();
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
    /* #963/#969: a name or an address this run could not decrypt is deferred,
       not cancelled — a locked key and a damaged value are both repairable,
       and neither is a reason to throw somebody's reminder away. */
    expect(deliveryFailureState("item_title_unreadable", 1, 5)).toBe("retry");
    expect(deliveryFailureState("recipient_address_unreadable", 1, 5)).toBe("retry");
    expect(deliveryFailureState("recipient_address_unreadable", 5, 5)).toBe("failed");
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

  describe("materializeDeliveriesForCandidate (#1151 A4-S3)", () => {
    const NOW = new Date("2026-09-20T09:00:00.000Z");
    const CATCH_UP_BOUNDARY = new Date(NOW.getTime() - 24 * 60 * 60_000);

    function candidate(overrides: Partial<MaterializationCandidate> = {}): MaterializationCandidate {
      return {
        householdId: "household-1",
        eventId: "event-1",
        dueDate: "2026-09-20",
        timezone: "UTC",
        userId: "user-1",
        daysBefore: null,
        emailEnabled: null,
        pushEnabled: null,
        userEmailEnabled: true,
        userPushEnabled: true,
        firstWarningDays: 14,
        finalWarningDays: 3,
        snoozedUntil: null,
        ...overrides,
      };
    }

    it("still sends a reminder due inside the catch-up window, exactly as before", () => {
      // 09:00 UTC on the due date itself (daysBefore 0 via a single rule) is
      // the due instant -- in the window, due right now.
      const deliveries = materializeDeliveriesForCandidate(
        candidate({ daysBefore: 0, emailEnabled: true, pushEnabled: true }),
        NOW,
        CATCH_UP_BOUNDARY,
      );
      expect(deliveries.map((d) => d.scheduledFor.toISOString())).toEqual([NOW.toISOString(), NOW.toISOString()]);
    });

    it("never sends a reminder not yet due", () => {
      const deliveries = materializeDeliveriesForCandidate(
        candidate({ dueDate: "2026-09-25", daysBefore: 3 }),
        NOW,
        CATCH_UP_BOUNDARY,
      );
      expect(deliveries).toEqual([]);
    });

    it("sends a single reminder more than a day overdue, rather than dropping it (the finding itself)", () => {
      // 3 days before the due date is 2026-09-17T09:00Z -- two days before
      // the catch-up boundary of 2026-09-19T09:00Z.
      const deliveries = materializeDeliveriesForCandidate(
        candidate({ dueDate: "2026-09-20", daysBefore: 3, emailEnabled: true, pushEnabled: false }),
        NOW,
        CATCH_UP_BOUNDARY,
      );
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].channel).toBe("email");
      expect(deliveries[0].scheduledFor.toISOString()).toBe("2026-09-17T09:00:00.000Z");
    });

    it("collapses two missed offsets (the default first/final pair) into one, per channel", () => {
      // No item rule of its own (daysBefore: null), so the recipient's
      // first/final pair applies -- 14 and 3 days before the due date. An
      // outage spanning both leaves both overdue; the recipient gets one
      // delivery, timestamped at the more recent (final) of the two.
      const deliveries = materializeDeliveriesForCandidate(
        candidate({ dueDate: "2026-09-20", firstWarningDays: 14, finalWarningDays: 3 }),
        NOW,
        CATCH_UP_BOUNDARY,
      );
      const emailDeliveries = deliveries.filter((d) => d.channel === "email");
      expect(emailDeliveries).toHaveLength(1);
      expect(emailDeliveries[0].scheduledFor.toISOString()).toBe("2026-09-17T09:00:00.000Z");
      const pushDeliveries = deliveries.filter((d) => d.channel === "web_push");
      expect(pushDeliveries).toHaveLength(1);
      expect(pushDeliveries[0].scheduledFor.toISOString()).toBe("2026-09-17T09:00:00.000Z");
    });

    it("never sends a reminder the household snoozed, overdue or not", () => {
      const deliveries = materializeDeliveriesForCandidate(
        candidate({ dueDate: "2026-09-20", daysBefore: 3, snoozedUntil: "2026-09-30" }),
        NOW,
        CATCH_UP_BOUNDARY,
      );
      expect(deliveries).toEqual([]);
    });
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

  it("bounds a push send to the same outbound timeout the email transport uses (#1151 SR2-R4, A4-R3)", async () => {
    webPushMock.sendNotification.mockClear();
    const providers = createDefaultNotificationProviders(getNotificationWorkerConfig({
      NODE_ENV: "test",
      VAPID_SUBJECT: "mailto:ops@example.test",
      VAPID_PUBLIC_KEY: "public-key",
      VAPID_PRIVATE_KEY: "private-key",
    } as NodeJS.ProcessEnv));

    await providers.sendPush({
      target: { endpoint: "https://push.services.example.test/sub/abc123", keys: { p256dh: "p", auth: "a" } },
      payload: { title: "Due today", body: "An item", url: "/" },
    });

    expect(webPushMock.sendNotification).toHaveBeenCalledTimes(1);
    const [, , options] = webPushMock.sendNotification.mock.calls[0] as unknown as [unknown, unknown, { timeout?: number }];
    // Before the fix, no third argument was passed at all: a blackholed
    // endpoint held the household's DB advisory lock for as long as the
    // provider never answered, one subscription at a time.
    expect(options?.timeout).toBe(NOTIFICATION_PROVIDER_TIMEOUT_MS);
  });

  it("gives a push send's timeout the same bound the email transport's connect/greeting/socket timeouts use", () => {
    expect(NOTIFICATION_PROVIDER_TIMEOUT_MS).toBe(5_000);
  });
});
