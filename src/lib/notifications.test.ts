import { describe, expect, it } from "vitest";
import type { HomeItem } from "./domain";
import { householdNotifications, type NotificationReader } from "./notifications";
import { createTestWorkspace } from "./test-workspace";
import { activeHousehold, createEmptyWorkspace, reduceWorkspace } from "./workspace";

/** Every demo item already carries its own reminder rules, so these existing
 * cases are indifferent to the reader's pair — a reader with no stored
 * preferences row at all (#487's "reader" parameter is exercised for real in
 * the "recipient's own pair" describe block below). */
const NO_PREFERENCE_READER: NotificationReader = { id: "reader", firstWarningDays: null, finalWarningDays: null };

/** A single-item household on top of the same base workspace `createTestWorkspace`
 * uses, for cases that need full control over one item's rules and due date. */
function householdWithItem(item: HomeItem) {
  const workspace = createEmptyWorkspace();
  const household = activeHousehold(workspace);
  return { ...household, items: [item] };
}

describe("household notifications", () => {
  it("derives overdue and reminder-window notifications from active schedules", () => {
    const household = activeHousehold(createTestWorkspace());
    const notifications = householdNotifications(household, "2026-07-25", NO_PREFERENCE_READER);

    expect(notifications.map((notification) => notification.itemId)).toEqual(["car-insurance", "boiler-service"]);
    expect(notifications.map((notification) => notification.kind)).toEqual(["overdue", "upcoming"]);
  });

  it("persists read and dismissed notification state independently", () => {
    const initial = createTestWorkspace();
    const notification = householdNotifications(activeHousehold(initial), "2026-07-25", NO_PREFERENCE_READER)[0];
    const read = reduceWorkspace(initial, {
      type: "notification.read",
      householdId: "our-home",
      notificationId: notification.id,
    });
    const dismissed = reduceWorkspace(read, {
      type: "notification.dismiss",
      householdId: "our-home",
      notificationId: notification.id,
    });

    expect(householdNotifications(activeHousehold(read), "2026-07-25", NO_PREFERENCE_READER)[0].read).toBe(true);
    expect(householdNotifications(activeHousehold(dismissed), "2026-07-25", NO_PREFERENCE_READER).some((entry) => entry.id === notification.id)).toBe(false);
  });

  // Regression coverage for the #383 deep-review finding at notifications.ts:34/49:
  // dismissed/read lookups moved from `Array.prototype.includes` (an O(n) scan
  // per item, repeated per item) to a `Set` built once per call. This pins the
  // read/dismissed semantics at the schema's array-size cap (workspace.ts:
  // 2000 entries) so a future change can't silently swap back to a lookup
  // that only happens to work for small fixtures.
  it("keeps read/dismissed semantics correct against large id lists", () => {
    const initial = createTestWorkspace();
    const household = activeHousehold(initial);
    const [firstNotification, secondNotification] = householdNotifications(household, "2026-07-25", NO_PREFERENCE_READER);
    expect(firstNotification).toBeDefined();
    expect(secondNotification).toBeDefined();

    const padding = Array.from({ length: 2000 }, (_, index) => `padding-${index}`);
    const padded = {
      ...initial,
      households: initial.households.map((entry) => entry.id === household.id
        ? {
          ...entry,
          // The target notification's id sits at the very end of a
          // schema-capped read list and is absent from an equally large
          // dismissed list — a linear scan and a Set-based lookup only agree
          // here if the whole list is actually checked correctly.
          readNotificationIds: [...padding, firstNotification.id],
          dismissedNotificationIds: padding,
        }
        : entry),
    };

    const results = householdNotifications(activeHousehold(padded), "2026-07-25", NO_PREFERENCE_READER);
    expect(results.map((entry) => entry.itemId)).toEqual([firstNotification.itemId, secondNotification.itemId]);
    expect(results.find((entry) => entry.id === firstNotification.id)?.read).toBe(true);
    expect(results.find((entry) => entry.id === secondNotification.id)?.read).toBe(false);
  });

  it("drops a notification whose id is anywhere in a large dismissed list, not just at the edges", () => {
    const initial = createTestWorkspace();
    const household = activeHousehold(initial);
    const [firstNotification] = householdNotifications(household, "2026-07-25", NO_PREFERENCE_READER);
    expect(firstNotification).toBeDefined();

    const padding = Array.from({ length: 2000 }, (_, index) => `padding-${index}`);
    const dismissedInTheMiddle = [...padding.slice(0, 1000), firstNotification.id, ...padding.slice(1000)];
    const padded = {
      ...initial,
      households: initial.households.map((entry) => entry.id === household.id
        ? { ...entry, dismissedNotificationIds: dismissedInTheMiddle }
        : entry),
    };

    const results = householdNotifications(activeHousehold(padded), "2026-07-25", NO_PREFERENCE_READER);
    expect(results.some((entry) => entry.id === firstNotification.id)).toBe(false);
  });

  it("suppresses notifications until a snooze date is reached", () => {
    const initial = createTestWorkspace();
    const activity = {
      id: "activity-snooze",
      itemId: "car-insurance",
      kind: "snoozed" as const,
      occurredAt: "2026-07-25T10:00:00.000Z",
      nextDate: "2026-08-01",
    };
    const snoozed = reduceWorkspace(initial, {
      type: "item.snooze",
      householdId: "our-home",
      itemId: "car-insurance",
      expectedVersion: 1,
      snoozedUntil: "2026-08-01",
      activity,
    });

    expect(householdNotifications(activeHousehold(snoozed), "2026-07-25", NO_PREFERENCE_READER).some((entry) => entry.itemId === "car-insurance")).toBe(false);
    expect(householdNotifications(activeHousehold(snoozed), "2026-08-01", NO_PREFERENCE_READER).some((entry) => entry.itemId === "car-insurance")).toBe(true);
  });

  /**
   * #487's matrix, mirroring #479's own (src/server/notification-worker.test.ts):
   * rules-win, defaults, custom, boundary. Before this fix the in-app list
   * always used Math.max(0, ...item.reminderDays), so an item with no rules
   * of its own had a window of 0 no matter what the reader had asked for —
   * disagreeing with the emails/pushes #479 already sends that same reader.
   */
  describe("reads the reminder window from the reader's own pair (#487)", () => {
    it("rules-win: an item's own reminder rules stand even against a wider reader pair", () => {
      const household = householdWithItem({
        id: "rules-item", sectionId: "home", title: "Rules item", currency: "GBP",
        dueDate: "2026-08-09", scheduleKind: "renewal", reminderDays: [10], status: "active", version: 1,
      });
      const wideReader: NotificationReader = { id: "reader", firstWarningDays: 20, finalWarningDays: 1 };
      // 15 days out: past the item's own 10-day rule, even though the
      // reader's pair (20) would have shown it. The rule wins outright.
      expect(householdNotifications(household, "2026-07-25", wideReader).some((entry) => entry.itemId === "rules-item")).toBe(false);
      // 10 days out: right at the item's own rule.
      expect(householdNotifications(household, "2026-07-30", wideReader).some((entry) => entry.itemId === "rules-item")).toBe(true);
    });

    it("defaults: an item with no rules falls back to the documented defaults when the reader has no stored pair", () => {
      const household = householdWithItem({
        id: "default-item", sectionId: "home", title: "Default item", currency: "GBP",
        dueDate: "2026-08-08", scheduleKind: "renewal", status: "active", version: 1,
      });
      // 14 days out: exactly the documented first-warning default.
      expect(householdNotifications(household, "2026-07-25", NO_PREFERENCE_READER).some((entry) => entry.itemId === "default-item")).toBe(true);
      // 15 days out: one day past the default window.
      expect(householdNotifications(household, "2026-07-24", NO_PREFERENCE_READER).some((entry) => entry.itemId === "default-item")).toBe(false);
    });

    it("custom: an item with no rules uses the reader's own stored pair, not the documented defaults", () => {
      const household = householdWithItem({
        id: "custom-item", sectionId: "home", title: "Custom item", currency: "GBP",
        dueDate: "2026-08-08", scheduleKind: "renewal", status: "active", version: 1,
      });
      const customReader: NotificationReader = { id: "reader", firstWarningDays: 30, finalWarningDays: 5 };
      // 30 days out: past the 14-day default, but exactly this reader's own
      // first warning — proving their pair, not the default, is in effect.
      expect(householdNotifications(household, "2026-07-09", customReader).some((entry) => entry.itemId === "custom-item")).toBe(true);
      // 31 days out: past even this reader's own pair.
      expect(householdNotifications(household, "2026-07-08", customReader).some((entry) => entry.itemId === "custom-item")).toBe(false);
    });

    it("boundary: a crossed pair still raises on the larger offset, and a final warning of zero is honoured", () => {
      const household = householdWithItem({
        id: "boundary-item", sectionId: "home", title: "Boundary item", currency: "GBP",
        dueDate: "2026-08-08", scheduleKind: "renewal", status: "active", version: 1,
      });
      // The route, schema and CHECK constraints all refuse a crossed pair
      // today, but effectiveReminderOffsets treats it as a set of offsets
      // rather than silently dropping to the smaller one.
      const crossedReader: NotificationReader = { id: "reader", firstWarningDays: 2, finalWarningDays: 9 };
      expect(householdNotifications(household, "2026-07-30", crossedReader).some((entry) => entry.itemId === "boundary-item")).toBe(true);
      expect(householdNotifications(household, "2026-07-29", crossedReader).some((entry) => entry.itemId === "boundary-item")).toBe(false);

      // "on the day" is a final warning of zero, which the settings screen
      // offers and the CHECK constraint allows.
      const onTheDayReader: NotificationReader = { id: "reader", firstWarningDays: 5, finalWarningDays: 0 };
      expect(householdNotifications(household, "2026-08-03", onTheDayReader).some((entry) => entry.itemId === "boundary-item")).toBe(true);
      expect(householdNotifications(household, "2026-08-02", onTheDayReader).some((entry) => entry.itemId === "boundary-item")).toBe(false);
    });
  });
});
