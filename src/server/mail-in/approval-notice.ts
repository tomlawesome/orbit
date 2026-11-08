/**
 * #1398: telling a member, once per approval attempt, that Orbit could not add
 * their mail and kept it. The notice is a transactional outbox row: written in
 * the same transaction that puts the receipt back in review, and sent by the
 * notification worker's cycle under the member's own mail and push switches.
 *
 * The row lives in `audit_log` (no new table, no migration): its id is derived
 * from the approval's operation id, so a retry of the same request finds the
 * row already there and queues nothing. Its `changes` hold only the title's
 * ciphertext (Tier 1, the household's key) and each channel's state; the
 * worker finds it through the receipt it names, which must still be in review.
 */
import { createHash } from "node:crypto";
import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, imapIngestionMessages, memberships, pushSubscriptions, userPreferences, users } from "@/db/schema";
import { asOperationalReason, log } from "@/lib/logger";
import { appHost, householdLine, renderMail } from "@/server/invitations/mail";
import { openInstanceMetadataReader, openMetadataReader, type MetadataCipher, type MetadataExecutor } from "@/server/metadata/fields";
import { isAllowedPushEndpoint, type NotificationProviders, type NotificationWorkerConfig } from "@/server/notification-worker";

export const APPROVAL_NOTICE_ENTITY = "reviewed_intake_notice";
const TITLE_COLUMN = "audit_log.approval_notice" as const;

type ChannelState = "pending" | "sent" | "off" | "skipped" | "failed";
interface NoticeChanges {
  operationId: string;
  titleEnc: string | null;
  email: ChannelState;
  push: ChannelState;
  emailAttempts: number;
  pushAttempts: number;
}

/** The notice row's id: one per operation id, never the id itself (the item and its activity use that). */
export function approvalNoticeId(operationId: string): string {
  const hex = createHash("sha256").update(`orbit:reviewed-intake-notice:${operationId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The ratified headline, which is the subject too. */
export function approvalNoticeHeadline(title: string): string {
  return `Orbit could not add ${title} — your mail is kept, try again`;
}

/** Queues the notice in the caller's transaction; a second call for the same operation adds nothing. */
export async function queueApprovalNotice(
  executor: MetadataExecutor,
  cipher: MetadataCipher,
  notice: { operationId: string; userId: string; householdId: string; receiptId: string; title: string; reason: string },
): Promise<void> {
  const id = approvalNoticeId(notice.operationId);
  const changes: NoticeChanges & { reason: string } = {
    operationId: notice.operationId,
    titleEnc: cipher.encryptText(TITLE_COLUMN, id, notice.title.trim().slice(0, 160)),
    email: "pending",
    push: "pending",
    emailAttempts: 0,
    pushAttempts: 0,
    reason: notice.reason,
  };
  await executor.insert(auditLog).values({
    id,
    householdId: notice.householdId,
    actorUserId: notice.userId,
    entityType: APPROVAL_NOTICE_ENTITY,
    entityId: notice.receiptId,
    action: "reviewed_intake_not_added",
    changes,
  }).onConflictDoNothing({ target: auditLog.id });
}

function inboxLink(environment: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const url = new URL(environment.APP_URL ?? "");
    if (["http:", "https:"].includes(url.protocol) && url.hostname) return new URL("/?open=inbox", url.origin).href;
  } catch { /* no link rather than an invented one */ }
  return null;
}

const KEPT = "Nothing was added and nothing was lost: the mail is still in your Orbit inbox, with its attachments.";
const AGAIN = "Open it and add it again.";

/** The mail: the ratified card, its footer ending with the household line. */
export function approvalNoticeMail(title: string, environment: NodeJS.ProcessEnv = process.env) {
  const headline = approvalNoticeHeadline(title);
  const href = inboxLink(environment);
  return renderMail({
    subject: headline,
    preheader: KEPT,
    headline,
    body: [KEPT, AGAIN],
    ...(href ? { button: { label: "open your inbox", href } } : {}),
    footer: ["You asked Orbit to add this mail; Orbit tells you once for each try.", householdLine(appHost(environment))],
    text: `${headline}\n\n${KEPT}\n${AGAIN}${href ? `\n\n${href}` : ""}`,
  });
}

/** The push: the headline and one line. */
export function approvalNoticePush(title: string): { title: string; body: string; url: "/" } {
  return { title: approvalNoticeHeadline(title), body: `${KEPT} ${AGAIN}`.slice(0, 320), url: "/" };
}

/**
 * Sends every queued notice whose receipt is still in review, once per
 * channel. Each row is locked while it is sent (skip locked, so two workers
 * never send one twice) and its channel states are written in the same
 * transaction. A switch that is off, a disabled account or a member who left
 * ends that channel unsent; an unreadable title or address, or no sending
 * set up yet, leaves it for a later cycle.
 */
export async function deliverApprovalNotices(
  db: ReturnType<typeof getDb>,
  config: NotificationWorkerConfig,
  now: Date,
  providers: NotificationProviders,
  limit = 25,
): Promise<void> {
  const candidates = await db.select({ id: auditLog.id }).from(imapIngestionMessages)
    .innerJoin(auditLog, and(
      eq(auditLog.householdId, imapIngestionMessages.householdId),
      eq(auditLog.entityType, APPROVAL_NOTICE_ENTITY),
      eq(auditLog.entityId, imapIngestionMessages.id),
    ))
    .where(and(
      eq(imapIngestionMessages.status, "pending_review"),
      or(sql`${auditLog.changes}->>'email' = 'pending'`, sql`${auditLog.changes}->>'push' = 'pending'`),
    ))
    .limit(limit);
  for (const { id } of candidates) {
    try {
      await deliverOne(db, id, config, now, providers);
    } catch {
      log.warn({ event: "delivery.smtp", state: "retrying", reason: asOperationalReason("approval_notice_failed"), action: "retry", impact: "notification_delivery_delayed" });
    }
  }
}

async function deliverOne(
  db: ReturnType<typeof getDb>,
  id: string,
  config: NotificationWorkerConfig,
  now: Date,
  providers: NotificationProviders,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const rows = await transaction.execute(sql`select id from audit_log where id = ${id} for update skip locked`) as unknown as Array<{ id: string }>;
    if (!rows.length) return;
    const [row] = await transaction.select({
      householdId: auditLog.householdId,
      userId: auditLog.actorUserId,
      changes: auditLog.changes,
      emailEnc: users.emailEnc,
      disabledAt: users.disabledAt,
      isMember: sql<boolean>`${memberships.userId} is not null`,
      userEmailEnabled: sql<boolean>`coalesce(${userPreferences.emailNotifications}, true)`,
      userPushEnabled: sql<boolean>`coalesce(${userPreferences.pushNotifications}, true)`,
    }).from(auditLog)
      .innerJoin(users, eq(users.id, auditLog.actorUserId))
      .leftJoin(userPreferences, eq(userPreferences.userId, auditLog.actorUserId))
      .leftJoin(memberships, and(eq(memberships.householdId, auditLog.householdId), eq(memberships.userId, auditLog.actorUserId)))
      .where(eq(auditLog.id, id)).limit(1);
    if (!row?.householdId || !row.userId) return;
    const changes = row.changes as NoticeChanges;
    const next: NoticeChanges = { ...changes };
    const gone = Boolean(row.disabledAt) || !row.isMember;
    if (gone) {
      if (next.email === "pending") next.email = "skipped";
      if (next.push === "pending") next.push = "skipped";
    } else {
      const title = (await openMetadataReader(row.householdId, transaction)).text(TITLE_COLUMN, id, { encrypted: changes.titleEnc }).value?.trim();
      if (title) {
        if (next.email === "pending") next.email = await sendMail(transaction, row, title, next, config, providers);
        if (next.push === "pending") next.push = await sendPush(transaction, row.userId, row.userPushEnabled, title, next, config, providers, now);
      }
    }
    if (next.email === changes.email && next.push === changes.push && next.emailAttempts === changes.emailAttempts && next.pushAttempts === changes.pushAttempts) return;
    await transaction.update(auditLog).set({ changes: next }).where(eq(auditLog.id, id));
  });
}

async function sendMail(
  executor: MetadataExecutor,
  row: { userId: string | null; emailEnc: string | null; userEmailEnabled: boolean },
  title: string,
  next: NoticeChanges,
  config: NotificationWorkerConfig,
  providers: NotificationProviders,
): Promise<ChannelState> {
  if (!row.userEmailEnabled) return "off";
  /* No sending set up yet (#1629): it waits, as a reminder does. */
  if (!config.smtpUrl) return "pending";
  const address = (await openInstanceMetadataReader(executor)).text("users.email", row.userId!, { encrypted: row.emailEnc }).value;
  if (!address) return "pending";
  const mail = approvalNoticeMail(title);
  try {
    await providers.sendEmail({ from: config.smtpFrom, to: address, subject: mail.subject, text: mail.text, html: mail.html, tlsMode: config.smtpSecurity });
    return "sent";
  } catch {
    next.emailAttempts += 1;
    return next.emailAttempts >= config.maxAttempts ? "failed" : "pending";
  }
}

async function sendPush(
  executor: MetadataExecutor,
  userId: string,
  enabled: boolean,
  title: string,
  next: NoticeChanges,
  config: NotificationWorkerConfig,
  providers: NotificationProviders,
  now: Date,
): Promise<ChannelState> {
  if (!enabled) return "off";
  if (!config.vapidSubject || !config.vapidPublicKey || !config.vapidPrivateKey) return "skipped";
  const subscriptions = await executor.select().from(pushSubscriptions).where(and(
    eq(pushSubscriptions.userId, userId),
    isNull(pushSubscriptions.revokedAt),
    or(isNull(pushSubscriptions.expiresAt), gte(pushSubscriptions.expiresAt, now)),
  ));
  /* A web push where they have one: none is not a failure. */
  if (!subscriptions.length) return "skipped";
  let delivered = false;
  let transient = false;
  const revoked: string[] = [];
  for (const subscription of subscriptions) {
    if (!isAllowedPushEndpoint(subscription.endpoint)) {
      revoked.push(subscription.id);
      continue;
    }
    try {
      await providers.sendPush({
        target: { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        payload: approvalNoticePush(title),
      });
      delivered = true;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) revoked.push(subscription.id);
      else transient = true;
    }
  }
  if (revoked.length) {
    await executor.update(pushSubscriptions).set({ revokedAt: now })
      .where(and(inArray(pushSubscriptions.id, revoked), isNull(pushSubscriptions.revokedAt)));
  }
  /* Once one device has it, it is sent: a retry would repeat it on that device. */
  if (delivered) return "sent";
  if (!transient) return "skipped";
  next.pushAttempts += 1;
  return next.pushAttempts >= config.maxAttempts ? "failed" : "pending";
}
