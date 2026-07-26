import nodemailer from "nodemailer";
import webPush from "web-push";
import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  dueEvents,
  households,
  items,
  memberships,
  notificationDeliveries,
  pushSubscriptions,
  reminderRules,
  users,
} from "@/db/schema";
import { readRuntimeSecret } from "@/lib/runtime-secret";

const notificationEnvironmentSchema = z.object({
  SMTP_URL: z.string().optional().default(""),
  SMTP_FROM: z.string().min(1).default("Orbit <orbit@localhost>"),
  VAPID_SUBJECT: z.string().optional().default(""),
  VAPID_PUBLIC_KEY: z.string().optional().default(""),
  VAPID_PRIVATE_KEY: z.string().optional().default(""),
  WORKER_POLL_SECONDS: z.coerce.number().int().min(10).max(3_600).default(60),
  NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
});

export interface NotificationWorkerConfig {
  smtpUrl: string;
  smtpFrom: string;
  vapidSubject: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  pollMilliseconds: number;
  maxAttempts: number;
}

export function getNotificationWorkerConfig(environment: NodeJS.ProcessEnv = process.env): NotificationWorkerConfig {
  const parsed = notificationEnvironmentSchema.parse({
    ...environment,
    SMTP_URL: readRuntimeSecret(environment, "SMTP_URL"),
    VAPID_PRIVATE_KEY: readRuntimeSecret(environment, "VAPID_PRIVATE_KEY"),
  });
  return {
    smtpUrl: parsed.SMTP_URL,
    smtpFrom: parsed.SMTP_FROM,
    vapidSubject: parsed.VAPID_SUBJECT,
    vapidPublicKey: parsed.VAPID_PUBLIC_KEY,
    vapidPrivateKey: parsed.VAPID_PRIVATE_KEY,
    pollMilliseconds: parsed.WORKER_POLL_SECONDS * 1_000,
    maxAttempts: parsed.NOTIFICATION_MAX_ATTEMPTS,
  };
}

/**
 * Converts a household-local 09:00 calendar date to UTC without allowing the
 * host machine's timezone to influence reminder delivery.
 */
export function householdReminderTime(dueDate: string, daysBefore: number, timeZone: string): Date {
  const [year, month, day] = dueDate.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1, day - daysBefore, 9));
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(target);
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  const representedAsUtc = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
  return new Date(target.getTime() - (representedAsUtc - target.getTime()));
}

/** Returns true when a scheduled reminder falls before the household-local resume date. */
export function reminderIsSnoozed(
  scheduledFor: Date,
  snoozedUntil: string | null,
  timeZone: string,
): boolean {
  return Boolean(
    snoozedUntil
    && scheduledFor < householdReminderTime(snoozedUntil, 0, timeZone),
  );
}

async function materializeDueDeliveries(now: Date): Promise<void> {
  const candidates = await getDb()
    .select({
      eventId: dueEvents.id,
      householdId: dueEvents.householdId,
      dueDate: dueEvents.dueDate,
      timezone: households.timezone,
      userId: memberships.userId,
      daysBefore: reminderRules.daysBefore,
      emailEnabled: reminderRules.emailEnabled,
      pushEnabled: reminderRules.pushEnabled,
      snoozedUntil: items.snoozedUntil,
    })
    .from(dueEvents)
    .innerJoin(items, eq(items.id, dueEvents.itemId))
    .innerJoin(households, eq(households.id, dueEvents.householdId))
    .innerJoin(reminderRules, eq(reminderRules.itemId, dueEvents.itemId))
    .innerJoin(memberships, eq(memberships.householdId, dueEvents.householdId))
    .where(and(
      isNull(dueEvents.completedAt),
      eq(items.status, "active"),
    ));

  const catchUpBoundary = new Date(now.getTime() - 86_400_000);
  const deliveries = candidates.flatMap((candidate) => {
    const scheduledFor = householdReminderTime(candidate.dueDate, candidate.daysBefore, candidate.timezone);
    if (scheduledFor > now || scheduledFor < catchUpBoundary) return [];
    if (reminderIsSnoozed(scheduledFor, candidate.snoozedUntil, candidate.timezone)) return [];
    const channels: Array<"email" | "web_push"> = [];
    if (candidate.emailEnabled) channels.push("email");
    if (candidate.pushEnabled) channels.push("web_push");
    return channels.map((channel) => ({
      householdId: candidate.householdId,
      eventId: candidate.eventId,
      userId: candidate.userId,
      channel,
      scheduledFor,
    }));
  });

  if (deliveries.length) {
    await getDb().insert(notificationDeliveries).values(deliveries).onConflictDoNothing();
  }
}

async function claimDeliveries(limit = 25): Promise<string[]> {
  const rows = await getDb().execute(sql<{ id: string }>`
    with claimable as (
      select id
      from notification_deliveries
      where status in ('pending', 'retry')
        and scheduled_for <= now()
        and (locked_at is null or locked_at < now() - interval '10 minutes')
      order by scheduled_for
      for update skip locked
      limit ${limit}
    )
    update notification_deliveries as delivery
    set status = 'processing',
        locked_at = now(),
        attempts = delivery.attempts + 1,
        updated_at = now()
    from claimable
    where delivery.id = claimable.id
    returning delivery.id
  `);
  return (rows as unknown as Array<{ id: string }>).map((row) => row.id);
}

async function deliverClaimed(ids: string[], config: NotificationWorkerConfig): Promise<void> {
  if (!ids.length) return;
  const deliveries = await getDb()
    .select({
      id: notificationDeliveries.id,
      channel: notificationDeliveries.channel,
      attempts: notificationDeliveries.attempts,
      userId: notificationDeliveries.userId,
      email: users.email,
      displayName: users.displayName,
      title: items.title,
      dueDate: dueEvents.dueDate,
      kind: dueEvents.kind,
      householdName: households.name,
    })
    .from(notificationDeliveries)
    .innerJoin(users, eq(users.id, notificationDeliveries.userId))
    .innerJoin(dueEvents, eq(dueEvents.id, notificationDeliveries.eventId))
    .innerJoin(items, eq(items.id, dueEvents.itemId))
    .innerJoin(households, eq(households.id, notificationDeliveries.householdId))
    .where(inArray(notificationDeliveries.id, ids));

  const transporter = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : undefined;
  if (config.vapidSubject && config.vapidPublicKey && config.vapidPrivateKey) {
    webPush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  }

  for (const delivery of deliveries) {
    try {
      const message = `${delivery.title} is due on ${delivery.dueDate}.`;
      if (delivery.channel === "email") {
        if (!transporter) throw new Error("SMTP is not configured");
        await transporter.sendMail({
          from: config.smtpFrom,
          to: delivery.email,
          subject: `${delivery.title} is coming up`,
          text: `Hello ${delivery.displayName},\n\n${message}\n\nOpen Orbit to review ${delivery.householdName}.`,
        });
      } else {
        if (!config.vapidSubject || !config.vapidPublicKey || !config.vapidPrivateKey) {
          throw new Error("Web Push is not configured");
        }
        const subscriptions = await getDb().select().from(pushSubscriptions).where(and(
          eq(pushSubscriptions.userId, delivery.userId),
          isNull(pushSubscriptions.revokedAt),
          or(isNull(pushSubscriptions.expiresAt), gte(pushSubscriptions.expiresAt, new Date())),
        ));
        if (!subscriptions.length) throw new Error("No active push subscription");
        await Promise.all(subscriptions.map(async (subscription) => {
          try {
            await webPush.sendNotification({
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            }, JSON.stringify({
              title: `${delivery.title} is coming up`,
              body: message,
              url: "/",
            }));
          } catch (error) {
            const statusCode = (error as { statusCode?: number }).statusCode;
            if (statusCode === 404 || statusCode === 410) {
              await getDb().update(pushSubscriptions).set({ revokedAt: new Date() })
                .where(eq(pushSubscriptions.id, subscription.id));
              return;
            }
            throw error;
          }
        }));
      }
      await getDb().update(notificationDeliveries).set({
        status: "sent",
        sentAt: new Date(),
        lockedAt: null,
        lastError: null,
        updatedAt: new Date(),
      }).where(eq(notificationDeliveries.id, delivery.id));
    } catch (error) {
      const lastError = error instanceof Error ? error.message.slice(0, 500) : "Unknown delivery error";
      const providerUnavailable = /not configured|No active push subscription/.test(lastError);
      await getDb().update(notificationDeliveries).set({
        status: providerUnavailable ? "cancelled" : delivery.attempts >= config.maxAttempts ? "failed" : "retry",
        lockedAt: null,
        lastError,
        updatedAt: new Date(),
      }).where(eq(notificationDeliveries.id, delivery.id));
    }
  }
}

export async function runNotificationCycle(config = getNotificationWorkerConfig()): Promise<void> {
  const now = new Date();
  await materializeDueDeliveries(now);
  const claimed = await claimDeliveries();
  await deliverClaimed(claimed, config);
}

const workerState = globalThis as typeof globalThis & { __orbitWorkerStarted?: boolean };

/** Starts one resilient scheduler per application process. PostgreSQL locking prevents duplicate sends. */
export function startNotificationWorker(config = getNotificationWorkerConfig()): void {
  if (workerState.__orbitWorkerStarted) return;
  workerState.__orbitWorkerStarted = true;

  const poll = async () => {
    try {
      await runNotificationCycle(config);
    } catch (error) {
      console.error("Orbit notification cycle failed", error);
    } finally {
      setTimeout(poll, config.pollMilliseconds).unref();
    }
  };
  void poll();
}
