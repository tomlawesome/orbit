import { daysUntil } from "@/lib/domain";
import { effectiveReminderOffsets, type RecipientWarningDays, type ReminderOffset } from "@/lib/preferences";
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

/**
 * The signed-in reader the list is being built for (#487): whoever is
 * looking at the bell sees warnings on THEIR OWN first/final pair, not a
 * one-size-fits-all window, for every item that carries no reminder rule of
 * its own — the same precedence `effectiveReminderOffsets` already applies
 * to dispatch (#479). `firstWarningDays`/`finalWarningDays` are the raw
 * stored values (nullable: a reader with no preferences row at all), never
 * pre-defaulted here, so both surfaces run the exact same fallback logic.
 */
export type NotificationReader = RecipientWarningDays & { id: string };

function scheduleLabel(kind: "renewal" | "service" | undefined): string {
  return kind === "service" ? "service" : "renewal";
}

/** An item's own explicit reminder rules, shaped for `effectiveReminderOffsets`.
 * The in-app list has no channel distinction of its own — an item's rules win
 * outright regardless of channel — so every day carries both channels open. */
function itemReminderRules(reminderDays: readonly number[] | undefined): ReminderOffset[] {
  return (reminderDays ?? []).map((daysBefore) => ({ daysBefore, emailEnabled: true, pushEnabled: true }));
}

/**
 * Derives actionable notifications from schedules while retaining read/dismiss
 * state separately.
 *
 * The id arrays are schema-capped at 2000 entries each (see workspace.ts) and
 * are checked once per surviving item below, so this builds a Set for each up
 * front (issue #383) instead of doing an `.includes` linear scan per item.
 */
export function householdNotifications(household: HouseholdWorkspace, today: string, reader: NotificationReader): HouseholdNotification[] {
  const dismissedIds = new Set(household.dismissedNotificationIds);
  const readIds = new Set(household.readNotificationIds);
  return household.items
    .filter((item) => item.status === "active" && item.dueDate)
    .flatMap((item): HouseholdNotification[] => {
      const dueDate = item.dueDate as string;
      const days = daysUntil(dueDate, today);
      if (item.snoozedUntil && daysUntil(item.snoozedUntil, today) > 0) return [];
      // #487: an item with no rules of its own used to show nothing beyond
      // "overdue"/"due today" (the old Math.max(0, ...[]) === 0 window) even
      // though dispatch (#479) already warns this reader on their own pair
      // for that very item. effectiveReminderOffsets is the one truth both
      // surfaces read the window from now.
      const offsets = effectiveReminderOffsets(itemReminderRules(item.reminderDays), reader);
      const reminderWindow = Math.max(0, ...offsets.map((offset) => offset.daysBefore));
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
