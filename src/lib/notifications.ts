import { daysUntil } from "@/lib/domain";
import type { HouseholdWorkspace } from "@/lib/workspace";

export type NotificationKind = "overdue" | "due-today" | "upcoming";

export interface HouseholdNotification {
  id: string;
  itemId: string;
  kind: NotificationKind;
  title: string;
  message: string;
  dueDate: string;
  days: number;
  read: boolean;
}

function scheduleLabel(kind: "renewal" | "service" | undefined): string {
  return kind === "service" ? "service" : "renewal";
}

/**
 * Derives actionable notifications from schedules while retaining read/dismiss
 * state separately.
 *
 * The id arrays are schema-capped at 2000 entries each (see workspace.ts) and
 * are checked once per surviving item below, so this builds a Set for each up
 * front (issue #383) instead of doing an `.includes` linear scan per item.
 */
export function householdNotifications(household: HouseholdWorkspace, today: string): HouseholdNotification[] {
  const dismissedIds = new Set(household.dismissedNotificationIds);
  const readIds = new Set(household.readNotificationIds);
  return household.items
    .filter((item) => item.status === "active" && item.dueDate)
    .flatMap((item): HouseholdNotification[] => {
      const dueDate = item.dueDate as string;
      const days = daysUntil(dueDate, today);
      if (item.snoozedUntil && daysUntil(item.snoozedUntil, today) > 0) return [];
      const reminderWindow = Math.max(0, ...(item.reminderDays ?? []));
      if (days > reminderWindow) return [];

      const kind: NotificationKind = days < 0 ? "overdue" : days === 0 ? "due-today" : "upcoming";
      const id = `${item.id}:${dueDate}:${kind}`;
      if (dismissedIds.has(id)) return [];

      const event = scheduleLabel(item.scheduleKind);
      const message = days < 0
        ? `${event[0].toUpperCase() + event.slice(1)} was due ${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ago.`
        : days === 0
          ? `${event[0].toUpperCase() + event.slice(1)} is due today.`
          : `${event[0].toUpperCase() + event.slice(1)} is due in ${days} ${days === 1 ? "day" : "days"}.`;
      return [{
        id,
        itemId: item.id,
        kind,
        title: item.title,
        message,
        dueDate,
        days,
        read: readIds.has(id),
      }];
    })
    .sort((left, right) => left.days - right.days || left.title.localeCompare(right.title));
}
