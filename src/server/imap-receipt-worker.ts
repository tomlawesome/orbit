import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { imapIngestionMessages, imapNotificationDeliveries, users } from "@/db/schema";
import { categorizeProviderError, createSmtpTransport, getNotificationWorkerConfig, type NotificationWorkerConfig } from "@/server/notification-worker";
import { purgeExpiredImapStaging } from "@/server/imap-inbox";

type ImapNotificationKind = "receipt" | "review_ready";
type ImapNotificationFailure = "smtp_unconfigured" | "smtp_unavailable" | "smtp_rejected" | "unknown";
interface ClaimedNotification { id: string; leaseToken: string }

const notificationLeaseDurationMs = 10 * 60_000;
const notificationBackoffCapMs = 60 * 60_000;

/** Bounded retry schedule shared by mailbox notification contract tests. */
export function imapNotificationRetryDelayMs(attempts: number): number {
  const boundedAttempts = Math.max(1, Math.min(Math.floor(attempts), 7));
  return Math.min(notificationBackoffCapMs, 60_000 * (2 ** (boundedAttempts - 1)));
}

export interface ImapNotification {
  subject: string;
  text: string;
}

/** Produces content-free mail with a non-mutating link into the authenticated inbox. */
export function buildImapNotification(_kind: ImapNotificationKind, reviewUrl: string): ImapNotification {
  return {
    subject: "Orbit review available",
    text: `Orbit has an update waiting in your private inbox.\n\nSign in to Orbit to review it: ${reviewUrl}\n\nThis link only opens your authenticated inbox; it does not change any data.`,
  };
}

export function authenticatedReviewUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.APP_URL;
  if (!configured) return "/?open=inbox";
  try {
    const url = new URL(configured);
    url.username = "";
    url.password = "";
    url.pathname = "/";
    url.search = "?open=inbox";
    url.hash = "";
    return url.href;
  } catch {
    return "/?open=inbox";
  }
}

/** Inserts one durable operation per receipt kind; duplicates are harmless. */
async function materializeNotifications(now = new Date()): Promise<void> {
  const db = getDb();
  const rows = await db.select({
    id: imapIngestionMessages.id,
    userId: imapIngestionMessages.userId,
    status: imapIngestionMessages.status,
    receiptStatus: imapIngestionMessages.receiptStatus,
  }).from(imapIngestionMessages).innerJoin(users, eq(users.id, imapIngestionMessages.userId)).where(and(isNotNull(imapIngestionMessages.userId), isNull(users.disabledAt)));
  const values = rows.flatMap((row) => {
    if (!row.userId) return [];
    const kinds: ImapNotificationKind[] = [];
    if (["pending", "retry", "processing"].includes(row.receiptStatus)) kinds.push("receipt");
    if (row.status === "pending_review") kinds.push("review_ready");
    return kinds.map((kind) => ({ messageId: row.id, userId: row.userId!, kind, nextAttemptAt: now }));
  });
  if (values.length) await db.insert(imapNotificationDeliveries).values(values).onConflictDoNothing();
}

/** Atomically leases mailbox notifications with stale-token protection. */
async function claimNotifications(now = new Date(), limit = 25): Promise<ClaimedNotification[]> {
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - notificationLeaseDurationMs).toISOString();
  const rows = await getDb().execute(sql<ClaimedNotification>`
    with claimable as (
      select id
      from imap_notification_deliveries
      where (status in ('pending', 'retry') and next_attempt_at <= ${nowIso})
         or (status = 'processing' and locked_at < ${staleIso})
      order by next_attempt_at, id
      for update skip locked
      limit ${limit}
    )
    update imap_notification_deliveries as delivery
    set status = 'processing', locked_at = ${nowIso}, lease_token = gen_random_uuid(),
        attempts = delivery.attempts + 1, updated_at = ${nowIso}
    from claimable
    where delivery.id = claimable.id
    returning delivery.id, delivery.lease_token as "leaseToken"
  `);
  return rows as unknown as ClaimedNotification[];
}

function failureState(category: ImapNotificationFailure, attempts: number, maxAttempts: number): "retry" | "failed" | "cancelled" {
  if (category === "smtp_unconfigured" || category === "smtp_rejected") return "cancelled";
  return attempts >= maxAttempts ? "failed" : "retry";
}

async function markNotificationFailure(
  id: string,
  leaseToken: string,
  attempts: number,
  config: NotificationWorkerConfig,
  category: ImapNotificationFailure,
  now: Date,
): Promise<void> {
  const status = failureState(category, attempts, config.maxAttempts);
  const nextAttemptAt = status === "retry" ? new Date(now.getTime() + imapNotificationRetryDelayMs(attempts)) : now;
  const [updated] = await getDb().update(imapNotificationDeliveries).set({
    status,
    nextAttemptAt,
    lockedAt: null,
    leaseToken: null,
    failureCode: category,
    updatedAt: now,
  }).where(and(
    eq(imapNotificationDeliveries.id, id),
    eq(imapNotificationDeliveries.status, "processing"),
    eq(imapNotificationDeliveries.leaseToken, leaseToken),
  )).returning({ id: imapNotificationDeliveries.id, kind: imapNotificationDeliveries.kind, messageId: imapNotificationDeliveries.messageId });
  if (updated?.kind === "receipt") {
    await getDb().update(imapIngestionMessages).set({
      receiptStatus: status,
      receiptFailureCode: category,
      updatedAt: now,
    }).where(eq(imapIngestionMessages.id, updated.messageId));
  }
}

async function markNotificationSent(
  id: string,
  leaseToken: string,
  now: Date,
): Promise<void> {
  const [updated] = await getDb().update(imapNotificationDeliveries).set({
    status: "sent",
    sentAt: now,
    lockedAt: null,
    leaseToken: null,
    failureCode: null,
    updatedAt: now,
  }).where(and(
    eq(imapNotificationDeliveries.id, id),
    eq(imapNotificationDeliveries.status, "processing"),
    eq(imapNotificationDeliveries.leaseToken, leaseToken),
  )).returning({ id: imapNotificationDeliveries.id, kind: imapNotificationDeliveries.kind, messageId: imapNotificationDeliveries.messageId });
  if (updated?.kind === "receipt") {
    await getDb().update(imapIngestionMessages).set({
      receiptStatus: "sent",
      receiptSentAt: now,
      receiptLockedAt: null,
      receiptLeaseToken: null,
      receiptFailureCode: null,
      updatedAt: now,
    }).where(eq(imapIngestionMessages.id, updated.messageId));
  }
}

/** Sends only leased, content-free receipt/review-ready operations. */
export async function runImapReceiptCycle(): Promise<void> {
  const config = getNotificationWorkerConfig();
  const now = new Date();
  await purgeExpiredImapStaging();
  await materializeNotifications(now);
  const claimed = await claimNotifications(now);
  if (!claimed.length) return;
  const tokens = new Map(claimed.map((notification) => [notification.id, notification.leaseToken]));
  const deliveries = await getDb().select({
    id: imapNotificationDeliveries.id,
    messageId: imapNotificationDeliveries.messageId,
    kind: imapNotificationDeliveries.kind,
    leaseToken: imapNotificationDeliveries.leaseToken,
    attempts: imapNotificationDeliveries.attempts,
    email: users.email,
    disabledAt: users.disabledAt,
  }).from(imapNotificationDeliveries)
    .innerJoin(users, eq(users.id, imapNotificationDeliveries.userId))
    .where(and(inArray(imapNotificationDeliveries.id, claimed.map((notification) => notification.id)), eq(imapNotificationDeliveries.status, "processing")));
  const transporter = config.smtpUrl ? createSmtpTransport(config) : undefined;
  const reviewUrl = authenticatedReviewUrl();
  try {
    for (const delivery of deliveries) {
      const leaseToken = tokens.get(delivery.id);
      if (!leaseToken || delivery.leaseToken !== leaseToken) continue;
      try {
        if (delivery.disabledAt) {
          await getDb().update(imapNotificationDeliveries).set({ status: "cancelled", lockedAt: null, leaseToken: null, failureCode: null, updatedAt: now }).where(and(eq(imapNotificationDeliveries.id, delivery.id), eq(imapNotificationDeliveries.status, "processing"), eq(imapNotificationDeliveries.leaseToken, leaseToken)));
          continue;
        }
        if (!transporter) throw Object.assign(new Error("SMTP unavailable"), { code: "smtp_unconfigured" });
        const notification = buildImapNotification(delivery.kind, reviewUrl);
        await transporter.sendMail({ from: config.smtpFrom, to: delivery.email, ...notification });
        await markNotificationSent(delivery.id, leaseToken, now);
      } catch (error) {
        const category: ImapNotificationFailure = (error as { code?: string }).code === "smtp_unconfigured"
          ? "smtp_unconfigured"
          : categorizeProviderError("email", error) === "smtp_rejected"
            ? "smtp_rejected"
            : categorizeProviderError("email", error) === "smtp_unavailable"
              ? "smtp_unavailable"
              : "unknown";
        await markNotificationFailure(delivery.id, leaseToken, delivery.attempts, config, category, now);
      }
    }
  } finally {
    transporter?.close();
  }
}

const workerState = globalThis as typeof globalThis & { __orbitImapReceiptWorkerStarted?: boolean };
export function startImapReceiptWorker(): void {
  if (workerState.__orbitImapReceiptWorkerStarted) return;
  workerState.__orbitImapReceiptWorkerStarted = true;
  const poll = async () => {
    try { await runImapReceiptCycle(); } catch { console.error("Orbit IMAP receipt cycle failed"); }
    finally {
      let pollMilliseconds = 60_000;
      try { pollMilliseconds = getNotificationWorkerConfig().pollMilliseconds; } catch { /* Unsafe configuration remains paused. */ }
      setTimeout(poll, pollMilliseconds).unref();
    }
  };
  void poll();
}
