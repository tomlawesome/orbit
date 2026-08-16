/**
 * The signed-in user's own reminder timing (#468).
 *
 * The settings screen (§13, built in #464) states four things about
 * reminders: whether email reminders are on, how far ahead the first warning
 * is raised, how close in the final one lands, and whether the instance can
 * send mail at all. The first three are the reader's own stored preference;
 * the fourth is the operator's, reported read-only in bounded words — the
 * same rule the relay follows (#411/#432): a reader learns "configured" or
 * "not configured" and never a host, a port, a mailbox or a credential.
 *
 * There is no user parameter on the read: the caller passes the session's own
 * id, so there is nothing to name and therefore no way to read or write
 * someone else's timing.
 *
 * Since #479 the stored pair is dispatch truth, not only displayed truth: the
 * notification worker schedules an item's reminders from the recipient's own
 * pair whenever the item carries no reminder rule of its own
 * (`effectiveReminderOffsets` in server/notification-worker.ts). An item with
 * its own offsets still keeps them, so the two sentences this screen writes
 * describe what actually arrives for everything else.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { notificationDeliveries, userPreferences } from "@/db/schema";
import {
  DEFAULT_FINAL_WARNING_DAYS,
  DEFAULT_FIRST_WARNING_DAYS,
  type ReminderPreference,
} from "@/lib/preferences";
import { getNotificationWorkerConfig } from "@/server/notification-worker";

/** The instance has somewhere to send mail. */
export const OUTBOUND_CONFIGURED = "configured";
/** It does not — unset, half-set, or unresolvable. Which of those is the operator's business. */
export const OUTBOUND_NOT_CONFIGURED = "not configured";

export type OutboundMail = typeof OUTBOUND_CONFIGURED | typeof OUTBOUND_NOT_CONFIGURED;

export interface ReminderSettings {
  emailEnabled: boolean;
  /** Days before the date that the first warning is raised. */
  firstWarningDays: number;
  /** Days before the date that the final warning lands; always the smaller of the two. */
  finalWarningDays: number;
  /** The screen's own sentence for the pair, so the port needs no phrasing of its own. */
  firstWarning: string;
  finalWarning: string;
  /** The instance's outbound-mail state, read-only: this screen has no lever for it. */
  outboundMail: OutboundMail;
}

function days(count: number): string {
  return `${count} ${count === 1 ? "day" : "days"}`;
}

/** "14 days before closest approach" — the star-chart wording for the due date. */
export function firstWarningLabel(count: number): string {
  return `${days(count)} before closest approach`;
}

/** "3 days before", or "on the day" when the final warning is the date itself. */
export function finalWarningLabel(count: number): string {
  return count === 0 ? "on the day" : `${days(count)} before`;
}

/**
 * A configuration that cannot be resolved is "not configured", not a 500: the
 * thrown message names environment variables, which is the operator's surface
 * (#411), not this reader's. `smtpUrl` is the same emptiness test
 * `verifySmtpProviderConnection` treats as `smtp_unconfigured`, so the screen
 * and the worker cannot disagree about whether mail can leave.
 */
function outboundMailState(): OutboundMail {
  try {
    return getNotificationWorkerConfig().smtpUrl ? OUTBOUND_CONFIGURED : OUTBOUND_NOT_CONFIGURED;
  } catch {
    return OUTBOUND_NOT_CONFIGURED;
  }
}

function settingsFor(row: {
  emailNotifications: boolean;
  firstWarningDays: number;
  finalWarningDays: number;
} | undefined): ReminderSettings {
  // A user with no preferences row has never chosen: the column defaults are
  // the answer, and they are the same numbers the database would write.
  const emailEnabled = row?.emailNotifications ?? true;
  const firstWarningDays = row?.firstWarningDays ?? DEFAULT_FIRST_WARNING_DAYS;
  const finalWarningDays = row?.finalWarningDays ?? DEFAULT_FINAL_WARNING_DAYS;
  return {
    emailEnabled,
    firstWarningDays,
    finalWarningDays,
    firstWarning: firstWarningLabel(firstWarningDays),
    finalWarning: finalWarningLabel(finalWarningDays),
    outboundMail: outboundMailState(),
  };
}

/** The session's own reminder timing. Never takes an id from the request. */
export async function readReminderSettings(userId: string): Promise<ReminderSettings> {
  const [row] = await getDb()
    .select({
      emailNotifications: userPreferences.emailNotifications,
      firstWarningDays: userPreferences.firstWarningDays,
      finalWarningDays: userPreferences.finalWarningDays,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return settingsFor(row);
}

/**
 * Saves the session's own reminder timing and answers what is now stored.
 *
 * Switching email reminders off cancels the caller's own queued email
 * deliveries in the same transaction, exactly as `PUT /api/preferences` does
 * for the appearance surface: a preference that leaves a queue draining
 * behind it is not a preference the reader would recognise. Only this user's
 * rows are touched, and only ones not yet sent.
 */
export async function writeReminderSettings(
  userId: string,
  preference: ReminderPreference,
): Promise<ReminderSettings> {
  const now = new Date();
  await getDb().transaction(async (transaction) => {
    await transaction.insert(userPreferences).values({
      userId,
      emailNotifications: preference.emailEnabled,
      firstWarningDays: preference.firstWarningDays,
      finalWarningDays: preference.finalWarningDays,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: userPreferences.userId,
      set: {
        emailNotifications: preference.emailEnabled,
        firstWarningDays: preference.firstWarningDays,
        finalWarningDays: preference.finalWarningDays,
        updatedAt: now,
      },
    });

    if (!preference.emailEnabled) {
      await transaction.update(notificationDeliveries).set({
        status: "cancelled",
        lockedAt: null,
        lastError: "Disabled in recipient preferences",
        updatedAt: now,
      }).where(and(
        eq(notificationDeliveries.userId, userId),
        eq(notificationDeliveries.channel, "email"),
        inArray(notificationDeliveries.status, ["pending", "retry"]),
      ));
    }
  });
  return readReminderSettings(userId);
}
