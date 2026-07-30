import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { imapIngestionMessages, imapNotificationDeliveries, users } from "@/db/schema";
import { categorizeProviderError, createSmtpTransport, getNotificationWorkerConfig } from "@/server/notification-worker";
import { purgeExpiredImapStaging } from "@/server/imap-inbox";
import { AppError } from "@/lib/app-error";

type ImapNotificationKind = "receipt" | "review_ready";
export type ImapNotificationFailure = "smtp_unconfigured" | "smtp_unavailable" | "smtp_rejected" | "unknown";
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
  if (!configured) throw new AppError("unsafe_input", "The mailbox notification application URL is unavailable", 503);
  try {
    const url = new URL(configured);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)) throw new Error("unsafe application origin");
    return new URL("/?open=inbox", url.origin).href;
  } catch {
    throw new AppError("unsafe_input", "The mailbox notification application URL is unavailable", 503);
  }
}

const notificationMaterializationBatchSize = 25;

/** Inserts only bounded, eligible durable operations at the database boundary. */
async function materializeNotifications(now = new Date(), requestedLimit = notificationMaterializationBatchSize, onlyUserId?: string): Promise<number> {
  const limit = Math.max(1, Math.min(Math.floor(requestedLimit), notificationMaterializationBatchSize));
  const nowIso = now.toISOString();
  const db = getDb();
  const userScope = onlyUserId ? sql`AND m.user_id = ${onlyUserId}` : sql``;
  const [receiptRows, reviewRows] = await Promise.all([
    db.execute(sql`
      WITH eligible AS (
        SELECT m.id AS message_id, m.user_id
        FROM imap_ingestion_messages AS m
        INNER JOIN users AS u ON u.id = m.user_id
        WHERE m.user_id IS NOT NULL
          AND u.disabled_at IS NULL
          ${userScope}
          AND m.receipt_status IN ('pending', 'retry', 'processing')
          AND NOT EXISTS (
            SELECT 1
            FROM imap_notification_deliveries AS d
            WHERE d.message_id = m.id AND d.kind = 'receipt'
          )
        ORDER BY m.id
        LIMIT ${limit}
      )
      INSERT INTO imap_notification_deliveries (message_id, user_id, kind, next_attempt_at)
      SELECT message_id, user_id, 'receipt'::imap_notification_kind, ${nowIso}
      FROM eligible
      ON CONFLICT (message_id, kind) DO NOTHING
      RETURNING id
    `),
    db.execute(sql`
      WITH eligible AS (
        SELECT m.id AS message_id, m.user_id
        FROM imap_ingestion_messages AS m
        INNER JOIN users AS u ON u.id = m.user_id
        WHERE m.user_id IS NOT NULL
          AND u.disabled_at IS NULL
          ${userScope}
          AND m.status = 'pending_review'
          AND NOT EXISTS (
            SELECT 1
            FROM imap_notification_deliveries AS d
            WHERE d.message_id = m.id AND d.kind = 'review_ready'
          )
        ORDER BY m.id
        LIMIT ${limit}
      )
      INSERT INTO imap_notification_deliveries (message_id, user_id, kind, next_attempt_at)
      SELECT message_id, user_id, 'review_ready'::imap_notification_kind, ${nowIso}
      FROM eligible
      ON CONFLICT (message_id, kind) DO NOTHING
      RETURNING id
    `),
  ]);
  return receiptRows.length + reviewRows.length;
}

/** PostgreSQL contract seam for bounded materialization tests. */
export function materializeImapNotificationsForTests(now = new Date(), limit = notificationMaterializationBatchSize, userId?: string): Promise<number> {
  return materializeNotifications(now, limit, userId);
}

/** Atomically leases mailbox notifications with stale-token protection. */
async function claimNotifications(now = new Date(), limit = 25, onlyDeliveryIds?: string[]): Promise<ClaimedNotification[]> {
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), notificationMaterializationBatchSize));
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - notificationLeaseDurationMs).toISOString();
  const idScope = onlyDeliveryIds?.length ? sql`AND id IN (${sql.join(onlyDeliveryIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
  const rows = await getDb().execute(sql<ClaimedNotification>`
    with claimable as (
      select id
      from imap_notification_deliveries
      where ((status in ('pending', 'retry') and next_attempt_at <= ${nowIso})
         or (status = 'processing' and locked_at < ${staleIso}))
        ${idScope}
      order by next_attempt_at, id
      for update skip locked
      limit ${boundedLimit}
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

/** PostgreSQL contract seam for concurrent lease tests. */
export function claimImapNotificationsForTests(now = new Date(), limit = notificationMaterializationBatchSize, deliveryIds?: string[]): Promise<ClaimedNotification[]> {
  return claimNotifications(now, limit, deliveryIds);
}

function failureState(category: ImapNotificationFailure, attempts: number, maxAttempts: number): "retry" | "failed" | "cancelled" {
  if (category === "smtp_unconfigured" || category === "smtp_rejected") return "cancelled";
  return attempts >= maxAttempts ? "failed" : "retry";
}

async function markNotificationFailure(
  id: string,
  leaseToken: string,
  attempts: number,
  maxAttempts: number,
  category: ImapNotificationFailure,
  now: Date,
): Promise<void> {
  const status = failureState(category, attempts, maxAttempts);
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

/** PostgreSQL contract seam for retry, exhaustion, and lease-fencing tests. */
export function markImapNotificationFailureForTests(input: {
  id: string;
  leaseToken: string;
  attempts: number;
  maxAttempts: number;
  category: ImapNotificationFailure;
  now: Date;
}): Promise<void> {
  return markNotificationFailure(input.id, input.leaseToken, input.attempts, input.maxAttempts, input.category, input.now);
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

async function cancelDisabledNotification(id: string, leaseToken: string, disabledAt: Date | null | undefined, now: Date): Promise<boolean> {
  if (!disabledAt) return false;
  const [cancelled] = await getDb().update(imapNotificationDeliveries).set({
    status: "cancelled", lockedAt: null, leaseToken: null, failureCode: null, updatedAt: now,
  }).where(and(
    eq(imapNotificationDeliveries.id, id),
    eq(imapNotificationDeliveries.status, "processing"),
    eq(imapNotificationDeliveries.leaseToken, leaseToken),
  )).returning({ id: imapNotificationDeliveries.id });
  return Boolean(cancelled);
}

/** PostgreSQL contract seam for disabled-user cancellation tests. */
export async function cancelDisabledImapNotificationForTests(id: string, leaseToken: string, now = new Date()): Promise<boolean> {
  const [delivery] = await getDb().select({ disabledAt: users.disabledAt }).from(imapNotificationDeliveries)
    .innerJoin(users, eq(users.id, imapNotificationDeliveries.userId))
    .where(and(eq(imapNotificationDeliveries.id, id), eq(imapNotificationDeliveries.status, "processing"), eq(imapNotificationDeliveries.leaseToken, leaseToken)));
  return cancelDisabledNotification(id, leaseToken, delivery?.disabledAt, now);
}

/** Sends only leased, content-free receipt/review-ready operations. */
export async function runImapReceiptCycle(): Promise<void> {
  const config = getNotificationWorkerConfig();
  const now = new Date();
  await purgeExpiredImapStaging();
  await materializeNotifications(now);
  const reviewUrl = authenticatedReviewUrl();
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
  try {
    for (const delivery of deliveries) {
      const leaseToken = tokens.get(delivery.id);
      if (!leaseToken || delivery.leaseToken !== leaseToken) continue;
      try {
        if (await cancelDisabledNotification(delivery.id, leaseToken, delivery.disabledAt, now)) continue;
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
        await markNotificationFailure(delivery.id, leaseToken, delivery.attempts, config.maxAttempts, category, now);
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
