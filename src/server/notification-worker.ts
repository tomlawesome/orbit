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
  userPreferences,
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

export const notificationFailureCategories = [
  "smtp_unconfigured",
  "smtp_unavailable",
  "smtp_rejected",
  "push_unconfigured",
  "push_unsubscribed",
  "push_unavailable",
  "recipient_preferences_disabled",
  "unknown",
] as const;

export type NotificationFailureCategory = typeof notificationFailureCategories[number];

export interface NotificationWorkerHealth {
  started: boolean;
  running: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorCategory: NotificationFailureCategory | null;
}

type ProviderErrorDetails = {
  code?: unknown;
  responseCode?: unknown;
  statusCode?: unknown;
};

/**
 * Maps provider failures to the administrator-safe vocabulary before they are
 * persisted. Provider messages can contain addresses, hosts, or credentials.
 */
export function categorizeProviderError(channel: "email" | "web_push", error: unknown): NotificationFailureCategory {
  const details = error as ProviderErrorDetails | undefined;
  const code = typeof details?.code === "string" ? details.code : "";
  const responseCode = typeof details?.responseCode === "number" ? details.responseCode : undefined;
  const statusCode = typeof details?.statusCode === "number" ? details.statusCode : undefined;

  if (channel === "email") {
    if (["EAUTH", "EENVELOPE", "EMESSAGE"].includes(code)
      || (responseCode !== undefined && responseCode >= 500 && responseCode < 600)) return "smtp_rejected";
    if (["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH"].includes(code)) {
      return "smtp_unavailable";
    }
    if (responseCode !== undefined && responseCode >= 400 && responseCode < 500) return "smtp_unavailable";
    return "unknown";
  }

  if (statusCode === 404 || statusCode === 410) return "push_unsubscribed";
  if (["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH"].includes(code)
    || (statusCode !== undefined && statusCode >= 500)) {
    return "push_unavailable";
  }
  return "unknown";
}

/** Returns the terminal or retry state without exposing provider error details. */
export function deliveryFailureState(
  category: NotificationFailureCategory,
  attempts: number,
  maxAttempts: number,
): "cancelled" | "failed" | "retry" {
  if ([
    "smtp_unconfigured",
    "smtp_rejected",
    "push_unconfigured",
    "push_unsubscribed",
    "recipient_preferences_disabled",
  ].includes(category)) return "cancelled";
  return attempts >= maxAttempts ? "failed" : "retry";
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

/** Applies both the item reminder rule and the recipient's personal channels. */
export function enabledDeliveryChannels(input: {
  emailEnabled: boolean;
  pushEnabled: boolean;
  userEmailEnabled: boolean;
  userPushEnabled: boolean;
}): Array<"email" | "web_push"> {
  const channels: Array<"email" | "web_push"> = [];
  if (input.emailEnabled && input.userEmailEnabled) channels.push("email");
  if (input.pushEnabled && input.userPushEnabled) channels.push("web_push");
  return channels;
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
      userEmailEnabled: sql<boolean>`coalesce(${userPreferences.emailNotifications}, true)`,
      userPushEnabled: sql<boolean>`coalesce(${userPreferences.pushNotifications}, true)`,
      snoozedUntil: items.snoozedUntil,
    })
    .from(dueEvents)
    .innerJoin(items, eq(items.id, dueEvents.itemId))
    .innerJoin(households, eq(households.id, dueEvents.householdId))
    .innerJoin(reminderRules, eq(reminderRules.itemId, dueEvents.itemId))
    .innerJoin(memberships, eq(memberships.householdId, dueEvents.householdId))
    .leftJoin(userPreferences, eq(userPreferences.userId, memberships.userId))
    .where(and(
      isNull(dueEvents.completedAt),
      eq(items.status, "active"),
    ));

  const catchUpBoundary = new Date(now.getTime() - 86_400_000);
  const deliveries = candidates.flatMap((candidate) => {
    const scheduledFor = householdReminderTime(candidate.dueDate, candidate.daysBefore, candidate.timezone);
    if (scheduledFor > now || scheduledFor < catchUpBoundary) return [];
    if (reminderIsSnoozed(scheduledFor, candidate.snoozedUntil, candidate.timezone)) return [];
    const channels = enabledDeliveryChannels(candidate);
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

interface ClaimedDelivery {
  id: string;
  leaseToken: string;
}

async function claimDeliveries(limit = 25): Promise<ClaimedDelivery[]> {
  const rows = await getDb().execute(sql<ClaimedDelivery>`
    with claimable as (
      select id
      from notification_deliveries
      where (
          (status in ('pending', 'retry') and scheduled_for <= now())
          or (status = 'processing' and locked_at < now() - interval '10 minutes')
        )
      order by scheduled_for
      for update skip locked
      limit ${limit}
    )
    update notification_deliveries as delivery
        set status = 'processing',
        locked_at = now(),
        lease_token = gen_random_uuid(),
        attempts = delivery.attempts + 1,
        updated_at = now()
    from claimable
    where delivery.id = claimable.id
    returning delivery.id, delivery.lease_token as "leaseToken"
  `);
  return rows as unknown as ClaimedDelivery[];
}

async function deliverClaimed(claimed: ClaimedDelivery[], config: NotificationWorkerConfig): Promise<void> {
  if (!claimed.length) return;
  const leaseTokens = new Map(claimed.map((delivery) => [delivery.id, delivery.leaseToken]));
  const deliveries = await getDb()
    .select({
      id: notificationDeliveries.id,
      leaseToken: notificationDeliveries.leaseToken,
      channel: notificationDeliveries.channel,
      attempts: notificationDeliveries.attempts,
      userId: notificationDeliveries.userId,
      email: users.email,
      displayName: users.displayName,
      title: items.title,
      dueDate: dueEvents.dueDate,
      kind: dueEvents.kind,
      householdName: households.name,
      userEmailEnabled: sql<boolean>`coalesce(${userPreferences.emailNotifications}, true)`,
      userPushEnabled: sql<boolean>`coalesce(${userPreferences.pushNotifications}, true)`,
    })
    .from(notificationDeliveries)
    .innerJoin(users, eq(users.id, notificationDeliveries.userId))
    .innerJoin(dueEvents, eq(dueEvents.id, notificationDeliveries.eventId))
    .innerJoin(items, eq(items.id, dueEvents.itemId))
    .innerJoin(households, eq(households.id, notificationDeliveries.householdId))
    .leftJoin(userPreferences, eq(userPreferences.userId, notificationDeliveries.userId))
    .where(inArray(notificationDeliveries.id, claimed.map((delivery) => delivery.id)));

  const transporter = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : undefined;
  if (config.vapidSubject && config.vapidPublicKey && config.vapidPrivateKey) {
    webPush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  }

  for (const delivery of deliveries) {
    const leaseToken = leaseTokens.get(delivery.id);
    if (!leaseToken || delivery.leaseToken !== leaseToken) continue;
    try {
      const channelStillEnabled = delivery.channel === "email"
        ? delivery.userEmailEnabled
        : delivery.userPushEnabled;
      if (!channelStillEnabled) {
        await getDb().update(notificationDeliveries).set({
          status: "cancelled",
          lockedAt: null,
          leaseToken: null,
          lastError: "recipient_preferences_disabled",
          updatedAt: new Date(),
        }).where(and(
          eq(notificationDeliveries.id, delivery.id),
          eq(notificationDeliveries.status, "processing"),
          eq(notificationDeliveries.leaseToken, leaseToken),
        ));
        continue;
      }
      const message = `${delivery.title} is due on ${delivery.dueDate}.`;
      if (delivery.channel === "email") {
        if (!transporter) {
          await failDelivery(delivery.id, leaseToken, delivery.attempts, config.maxAttempts, "smtp_unconfigured");
          continue;
        }
        await transporter.sendMail({
          from: config.smtpFrom,
          to: delivery.email,
          subject: `${delivery.title} is coming up`,
          text: `Hello ${delivery.displayName},\n\n${message}\n\nOpen Orbit to review ${delivery.householdName}.`,
        });
      } else {
        if (!config.vapidSubject || !config.vapidPublicKey || !config.vapidPrivateKey) {
          await failDelivery(delivery.id, leaseToken, delivery.attempts, config.maxAttempts, "push_unconfigured");
          continue;
        }
        const subscriptions = await getDb().select().from(pushSubscriptions).where(and(
          eq(pushSubscriptions.userId, delivery.userId),
          isNull(pushSubscriptions.revokedAt),
          or(isNull(pushSubscriptions.expiresAt), gte(pushSubscriptions.expiresAt, new Date())),
        ));
        if (!subscriptions.length) {
          await failDelivery(delivery.id, leaseToken, delivery.attempts, config.maxAttempts, "push_unsubscribed");
          continue;
        }
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
        leaseToken: null,
        lastError: null,
        updatedAt: new Date(),
      }).where(and(
        eq(notificationDeliveries.id, delivery.id),
        eq(notificationDeliveries.status, "processing"),
        eq(notificationDeliveries.leaseToken, leaseToken),
      ));
    } catch (error) {
      await failDelivery(
        delivery.id,
        leaseToken,
        delivery.attempts,
        config.maxAttempts,
        categorizeProviderError(delivery.channel, error),
      );
    }
  }
}

/** Persists only a bounded failure code, never an untrusted provider message. */
async function failDelivery(
  id: string,
  leaseToken: string,
  attempts: number,
  maxAttempts: number,
  category: NotificationFailureCategory,
): Promise<void> {
  await getDb().update(notificationDeliveries).set({
    status: deliveryFailureState(category, attempts, maxAttempts),
    lockedAt: null,
    leaseToken: null,
    lastError: category,
    updatedAt: new Date(),
  }).where(and(
    eq(notificationDeliveries.id, id),
    eq(notificationDeliveries.status, "processing"),
    eq(notificationDeliveries.leaseToken, leaseToken),
  ));
}

export async function runNotificationCycle(config = getNotificationWorkerConfig()): Promise<void> {
  const now = new Date();
  await materializeDueDeliveries(now);
  const claimed = await claimDeliveries();
  await deliverClaimed(claimed, config);
}

const workerState = globalThis as typeof globalThis & {
  __orbitWorkerStarted?: boolean;
  __orbitWorkerRunning?: boolean;
  __orbitWorkerLastSuccessAt?: string;
  __orbitWorkerLastErrorAt?: string;
  __orbitWorkerLastErrorCategory?: NotificationFailureCategory;
};

/** Returns only bounded, process-local notification worker diagnostics. */
export function getNotificationWorkerHealth(): NotificationWorkerHealth {
  return {
    started: workerState.__orbitWorkerStarted ?? false,
    running: workerState.__orbitWorkerRunning ?? false,
    lastSuccessAt: workerState.__orbitWorkerLastSuccessAt ?? null,
    lastErrorAt: workerState.__orbitWorkerLastErrorAt ?? null,
    lastErrorCategory: workerState.__orbitWorkerLastErrorCategory ?? null,
  };
}

/** Starts one resilient scheduler per application process. PostgreSQL locking prevents duplicate sends. */
export function startNotificationWorker(config = getNotificationWorkerConfig()): void {
  if (workerState.__orbitWorkerStarted) return;
  workerState.__orbitWorkerStarted = true;

  const poll = async () => {
    workerState.__orbitWorkerRunning = true;
    try {
      await runNotificationCycle(config);
      workerState.__orbitWorkerLastSuccessAt = new Date().toISOString();
      workerState.__orbitWorkerLastErrorCategory = undefined;
    } catch {
      workerState.__orbitWorkerLastErrorAt = new Date().toISOString();
      workerState.__orbitWorkerLastErrorCategory = "unknown";
      console.error("Orbit notification cycle failed");
    } finally {
      workerState.__orbitWorkerRunning = false;
      setTimeout(poll, config.pollMilliseconds).unref();
    }
  };
  void poll();
}
