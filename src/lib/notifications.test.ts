import { describe, expect, it } from "vitest";
import { householdNotifications } from "./notifications";
import { createTestWorkspace } from "./test-workspace";
import { activeHousehold, reduceWorkspace } from "./workspace";

describe("household notifications", () => {
  it("derives overdue and reminder-window notifications from active schedules", () => {
    const household = activeHousehold(createTestWorkspace());
    const notifications = householdNotifications(household, "2026-07-25");

    expect(notifications.map((notification) => notification.itemId)).toEqual(["car-insurance", "boiler-service"]);
    expect(notifications.map((notification) => notification.kind)).toEqual(["overdue", "upcoming"]);
  });

  it("persists read and dismissed notification state independently", () => {
    const initial = createTestWorkspace();
    const notification = householdNotifications(activeHousehold(initial), "2026-07-25")[0];
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

    expect(householdNotifications(activeHousehold(read), "2026-07-25")[0].read).toBe(true);
    expect(householdNotifications(activeHousehold(dismissed), "2026-07-25").some((entry) => entry.id === notification.id)).toBe(false);
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
    const [firstNotification, secondNotification] = householdNotifications(household, "2026-07-25");
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

    const results = householdNotifications(activeHousehold(padded), "2026-07-25");
    expect(results.map((entry) => entry.itemId)).toEqual([firstNotification.itemId, secondNotification.itemId]);
    expect(results.find((entry) => entry.id === firstNotification.id)?.read).toBe(true);
    expect(results.find((entry) => entry.id === secondNotification.id)?.read).toBe(false);
  });

  it("drops a notification whose id is anywhere in a large dismissed list, not just at the edges", () => {
    const initial = createTestWorkspace();
    const household = activeHousehold(initial);
    const [firstNotification] = householdNotifications(household, "2026-07-25");
    expect(firstNotification).toBeDefined();

    const padding = Array.from({ length: 2000 }, (_, index) => `padding-${index}`);
    const dismissedInTheMiddle = [...padding.slice(0, 1000), firstNotification.id, ...padding.slice(1000)];
    const padded = {
      ...initial,
      households: initial.households.map((entry) => entry.id === household.id
        ? { ...entry, dismissedNotificationIds: dismissedInTheMiddle }
        : entry),
    };

    const results = householdNotifications(activeHousehold(padded), "2026-07-25");
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

    expect(householdNotifications(activeHousehold(snoozed), "2026-07-25").some((entry) => entry.itemId === "car-insurance")).toBe(false);
    expect(householdNotifications(activeHousehold(snoozed), "2026-08-01").some((entry) => entry.itemId === "car-insurance")).toBe(true);
  });
});
