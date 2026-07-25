import { describe, expect, it } from "vitest";
import { householdNotifications } from "./notifications";
import { activeHousehold, createDemoWorkspace, reduceWorkspace } from "./workspace";

describe("household notifications", () => {
  it("derives overdue and reminder-window notifications from active schedules", () => {
    const household = activeHousehold(createDemoWorkspace());
    const notifications = householdNotifications(household, "2026-07-25");

    expect(notifications.map((notification) => notification.itemId)).toEqual(["car-insurance", "boiler-service"]);
    expect(notifications.map((notification) => notification.kind)).toEqual(["overdue", "upcoming"]);
  });

  it("persists read and dismissed notification state independently", () => {
    const initial = createDemoWorkspace();
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

  it("suppresses notifications until a snooze date is reached", () => {
    const initial = createDemoWorkspace();
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
      snoozedUntil: "2026-08-01",
      activity,
    });

    expect(householdNotifications(activeHousehold(snoozed), "2026-07-25").some((entry) => entry.itemId === "car-insurance")).toBe(false);
    expect(householdNotifications(activeHousehold(snoozed), "2026-08-01").some((entry) => entry.itemId === "car-insurance")).toBe(true);
  });
});
