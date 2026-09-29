/**
 * "Sent to you lately" (#1003, owner-decisions §20; ratified round 1:
 * `design/v19/notification-history/round-1/a-sent-to-you-lately.html`).
 *
 * Nothing read a member's own `notification_deliveries` back before this: the
 * table is write-only from the recipient's point of view, filled by the
 * dispatch worker (`src/server/notification-worker.ts`) and never answered to
 * a browser. This is that one read -- the signed-in user's own last five
 * attempted deliveries, newest first, no id accepted from the caller so there
 * is no way to read anyone else's.
 *
 * "Attempted" is the filter: `pending` rows have not gone yet (there is
 * nothing to report) and `cancelled` rows never will (the item was completed,
 * the household is closing, the recipient turned the channel off) -- neither
 * is "what Orbit has actually sent this person", the round-1 README's own
 * phrase. `sent`, `retry` and `failed` are.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { dueEvents, households, items, notificationDeliveries, reminderRules, userPreferences } from "@/db/schema";
import {
  effectiveReminderOffsets,
  householdReminderTime,
  type NotificationFailureCategory,
  type ReminderOffset,
} from "@/server/notification-worker";
import { openMetadataReaders } from "@/server/metadata/fields";

export const SENT_NOTIFICATION_LIMIT = 5;

export type SentNotificationChannel = "email" | "push";
export type SentNotificationWarning = "first" | "final";
export type SentNotificationStatus = "sent" | "retry" | "failed";

export interface SentNotification {
  id: string;
  itemId: string;
  itemName: string;
  warning: SentNotificationWarning;
  daysBefore: number;
  channel: SentNotificationChannel;
  status: SentNotificationStatus;
  /** A short, plain sentence -- never the raw `lastError` category. `null` for a send that went, or a category this map does not name. */
  reason: string | null;
  /** ISO timestamp: when it went (`sentAt`), else when it was due (`scheduledFor`). */
  at: string;
}

/**
 * `lastError` on a `failed`/`retry` row is always one of
 * `NotificationFailureCategory` (`failDelivery` in notification-worker.ts is
 * the only writer for those two statuses) -- never the raw provider error, so
 * this is a closed, reviewable vocabulary rather than pattern-matching on
 * free text. A category this map does not name, or a delivery whose
 * `lastError` is somehow absent, says nothing rather than guessing: the row
 * still reads "couldn't send" / "still trying" on its own.
 */
const REASON_WORDS: Partial<Record<NotificationFailureCategory, string>> = {
  smtp_unconfigured: "mail not set up",
  smtp_unavailable: "the mail server couldn’t be reached",
  smtp_rejected: "the mail server turned it down",
  push_unconfigured: "browser alerts aren’t set up on this Orbit",
  push_unsubscribed: "this device stopped listening",
  push_unavailable: "device was offline",
};

export function reasonFor(lastError: string | null): string | null {
  if (!lastError) return null;
  return REASON_WORDS[lastError as NotificationFailureCategory] ?? null;
}

export function channelWord(channel: "email" | "web_push"): SentNotificationChannel {
  return channel === "web_push" ? "push" : "email";
}

/**
 * Which of the recipient's two current warnings (§20: "first" is the one
 * further out, "final" the one closer to the date) this delivery was. There
 * is no stored offset on the row itself, so it is recovered the same way
 * `deliverClaimed`'s own re-check does (notification-worker.ts): rebuild the
 * offsets currently in force for this item and recipient and find the one
 * whose scheduled time matches. `effectiveReminderOffsets` returns them
 * sorted furthest-out first, so a match at index 0 is "first" and any other
 * match is "final".
 *
 * A preference or item rule changed since the row was scheduled can leave no
 * exact match (the same gap the worker's own re-check accepts) -- picked here
 * by nearest scheduled time instead of left unlabelled, so a past send still
 * reads as one or the other rather than never rendering.
 */
export function warningFor(
  dueDate: string,
  scheduledFor: Date,
  timeZone: string,
  offsets: readonly ReminderOffset[],
): { warning: SentNotificationWarning; daysBefore: number } {
  const scheduledTimes = offsets.map((offset) => householdReminderTime(dueDate, offset.daysBefore, timeZone).getTime());
  let index = scheduledTimes.findIndex((time) => time === scheduledFor.getTime());
  if (index === -1) {
    let closest = 0;
    let smallestGap = Infinity;
    scheduledTimes.forEach((time, candidate) => {
      const gap = Math.abs(time - scheduledFor.getTime());
      if (gap < smallestGap) {
        smallestGap = gap;
        closest = candidate;
      }
    });
    index = closest;
  }
  return { warning: index === 0 ? "first" : "final", daysBefore: offsets[index]?.daysBefore ?? 0 };
}

/** The signed-in user's own last five attempted deliveries. Never takes an id from the request. */
export async function readSentNotifications(userId: string): Promise<SentNotification[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: notificationDeliveries.id,
      channel: notificationDeliveries.channel,
      scheduledFor: notificationDeliveries.scheduledFor,
      sentAt: notificationDeliveries.sentAt,
      status: notificationDeliveries.status,
      lastError: notificationDeliveries.lastError,
      householdId: notificationDeliveries.householdId,
      itemId: items.id,
      itemTitle: items.title,
      itemTitleEnc: items.titleEnc,
      dueDate: dueEvents.dueDate,
      timezone: households.timezone,
      firstWarningDays: userPreferences.firstWarningDays,
      finalWarningDays: userPreferences.finalWarningDays,
    })
    .from(notificationDeliveries)
    .innerJoin(dueEvents, eq(dueEvents.id, notificationDeliveries.eventId))
    .innerJoin(items, eq(items.id, dueEvents.itemId))
    .innerJoin(households, eq(households.id, notificationDeliveries.householdId))
    .leftJoin(userPreferences, eq(userPreferences.userId, notificationDeliveries.userId))
    .where(and(
      eq(notificationDeliveries.userId, userId),
      inArray(notificationDeliveries.status, ["sent", "retry", "failed"]),
    ))
    .orderBy(desc(notificationDeliveries.scheduledFor))
    .limit(SENT_NOTIFICATION_LIMIT);

  if (!rows.length) return [];

  const itemIds = [...new Set(rows.map((row) => row.itemId))];
  const rules = await db.select({
    itemId: reminderRules.itemId,
    daysBefore: reminderRules.daysBefore,
    emailEnabled: reminderRules.emailEnabled,
    pushEnabled: reminderRules.pushEnabled,
  }).from(reminderRules).where(inArray(reminderRules.itemId, itemIds));
  const rulesByItem = new Map<string, ReminderOffset[]>();
  for (const rule of rules) {
    rulesByItem.set(rule.itemId, [...(rulesByItem.get(rule.itemId) ?? []), rule]);
  }

  const titleReaders = await openMetadataReaders(rows.map((row) => row.householdId), db);

  return rows.map((row) => {
    const offsets = effectiveReminderOffsets(rulesByItem.get(row.itemId) ?? [], {
      firstWarningDays: row.firstWarningDays,
      finalWarningDays: row.finalWarningDays,
    });
    const { warning, daysBefore } = warningFor(row.dueDate, row.scheduledFor, row.timezone, offsets);
    const decryptedTitle = titleReaders.get(row.householdId)!
      .text("items.title", row.itemId, { encrypted: row.itemTitleEnc, plaintext: row.itemTitle });
    return {
      id: row.id,
      itemId: row.itemId,
      // Unreadable (locked instance, damaged value): the row still lists,
      // named plainly rather than left blank, the same fallback #963 chose
      // for the reminder's own subject line.
      itemName: decryptedTitle.value?.trim() || "an item",
      warning,
      daysBefore,
      channel: channelWord(row.channel),
      status: row.status as SentNotificationStatus,
      reason: row.status === "sent" ? null : reasonFor(row.lastError),
      at: (row.sentAt ?? row.scheduledFor).toISOString(),
    };
  });
}
