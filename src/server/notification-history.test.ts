import { describe, expect, it } from "vitest";
import { householdReminderTime } from "./notification-worker";
import { channelWord, reasonFor, warningFor } from "./notification-history";

describe("channelWord", () => {
  it("renders the DB's web_push as the screen's own push", () => {
    expect(channelWord("web_push")).toBe("push");
  });
  it("leaves email as email", () => {
    expect(channelWord("email")).toBe("email");
  });
});

describe("reasonFor", () => {
  it("maps a known failure category to a plain sentence", () => {
    expect(reasonFor("smtp_unconfigured")).toBe("mail not set up");
    expect(reasonFor("push_unavailable")).toBe("device was offline");
  });
  it("never returns the raw category or error text for an unmapped or absent value", () => {
    expect(reasonFor(null)).toBeNull();
    expect(reasonFor("unknown")).toBeNull();
    expect(reasonFor("item_title_unreadable")).toBeNull();
  });
});

describe("warningFor", () => {
  const timeZone = "Europe/London";
  const dueDate = "2026-10-01";
  const offsets = [
    { daysBefore: 14, emailEnabled: true, pushEnabled: true },
    { daysBefore: 3, emailEnabled: true, pushEnabled: true },
  ];

  it("labels the offset furthest from the date as first", () => {
    const scheduledFor = householdReminderTime(dueDate, 14, timeZone);
    const result = warningFor(dueDate, scheduledFor, timeZone, offsets);
    expect(result).toEqual({ warning: "first", daysBefore: 14 });
  });

  it("labels the offset closest to the date as final", () => {
    const scheduledFor = householdReminderTime(dueDate, 3, timeZone);
    const result = warningFor(dueDate, scheduledFor, timeZone, offsets);
    expect(result).toEqual({ warning: "final", daysBefore: 3 });
  });

  it("falls back to the nearest offset when the preference has since moved, rather than leaving the row unlabelled", () => {
    // Scheduled at what was once the 14-day mark; the recipient's own pair is
    // now 21/5, so neither offset matches exactly, and 21 is nearer.
    const scheduledFor = householdReminderTime(dueDate, 14, timeZone);
    const moved = [
      { daysBefore: 21, emailEnabled: true, pushEnabled: true },
      { daysBefore: 5, emailEnabled: true, pushEnabled: true },
    ];
    const result = warningFor(dueDate, scheduledFor, timeZone, moved);
    expect(result).toEqual({ warning: "first", daysBefore: 21 });
  });

  it("labels the single offset a collapsed pair leaves as first", () => {
    const single = [{ daysBefore: 7, emailEnabled: true, pushEnabled: true }];
    const scheduledFor = householdReminderTime(dueDate, 7, timeZone);
    const result = warningFor(dueDate, scheduledFor, timeZone, single);
    expect(result).toEqual({ warning: "first", daysBefore: 7 });
  });
});
