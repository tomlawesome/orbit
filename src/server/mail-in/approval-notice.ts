/**
 * #1398: telling a member, once per approval attempt, that Orbit could not add
 * their mail and kept it. The notice is a transactional outbox row: written in
 * the same transaction that puts the receipt back in review, and sent by the
 * notification worker's cycle under the member's own mail and push switches.
 *
 * The row lives in `audit_log` (no new table, no migration): its id is derived
 * from the approval's operation id, so a retry of the same request finds the
 * row already there and queues nothing. Its `changes` hold only the title's
 * ciphertext (Tier 1, the household's key) and each channel's state, which
 * the worker updates as delivery state; it sends only while the receipt it
 * names is still in review, and clears the title once every channel has ended.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, imapIngestionMessages, memberships, pushSubscriptions, userPreferences, users } from "@/db/schema";
import { asOperationalReason, log } from "@/lib/logger";
import { appHost, householdLine, renderMail } from "@/server/invitations/mail";
import { openInstanceMetadataReader, openMetadataReader, type MetadataCipher, type MetadataExecutor } from "@/server/metadata/fields";
import { isAllowedPushEndpoint, type NotificationProviders, type NotificationWorkerConfig } from "@/server/notification-worker";

export const APPROVAL_NOTICE_ENTITY = "reviewed_intake_notice";
const TITLE_COLUMN = "audit_log.approval_notice" as const;

type ChannelState = "pending" | "sending" | "sent" | "off" | "skipped" | "failed";
interface NoticeChanges {
  operationId: string;
  titleEnc: string | null;
  email: ChannelState;
  push: ChannelState;
  emailAttempts: number;
  pushAttempts: number;
  /** When a channel was marked `sending`, which the result step must still find. */
  emailClaimedAt?: string | null;
  pushClaimedAt?: string | null;
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

/**
 * Ends a receipt's notices in the caller's transaction, for the paths that take
 * the receipt out of review for good (added, discarded, expired, moved to
 * another household): the worker only looks at receipts still in review, so
 * these paths end each unfinished channel and clear the title themselves.
 */
export async function endApprovalNotices(executor: MetadataExecutor, receipt: { id: string; householdId: string | null }): Promise<void> {
  if (!receipt.householdId) return;
  const ending = (channel: "email" | "push") =>
    sql`case when ${auditLog.changes}->>${sql.raw(`'${channel}'`)} in ('pending', 'sending') then 'skipped' else ${auditLog.changes}->>${sql.raw(`'${channel}'`)} end`;
  await executor.update(auditLog).set({
    changes: sql`${auditLog.changes} || jsonb_build_object('email', ${ending("email")}, 'push', ${ending("push")}, 'titleEnc', null)`,
  }).where(and(
    eq(auditLog.householdId, receipt.householdId),
    eq(auditLog.entityType, APPROVAL_NOTICE_ENTITY),
    eq(auditLog.entityId, receipt.id),
    sql`(${auditLog.changes}->>'titleEnc' is not null or ${auditLog.changes}->>'email' in ('pending', 'sending') or ${auditLog.changes}->>'push' in ('pending', 'sending'))`,
  ));
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


/** A claim older than this was cut off mid-send; it is never sent again (told once, not twice). */
const SENDING_LEASE_MS = 10 * 60_000;

const unfinished = (state: ChannelState) => state === "pending" || state === "sending";

/**
 * Sends queued notices, oldest first, once per channel. Each row goes through
 * three short steps, so no row lock or transaction is held while mail or push
 * is on the wire: a claim (the row locked, skip locked, its receipt re-checked
 * and each channel to send marked `sending`), the sends, and the record of
 * what happened. A notice whose receipt left review (added, discarded,
 * expired), whose member left, or that can never be sent (no sending set up,
 * an unreadable address or title) ends unsent rather than waiting, so it
 * never holds a slot ahead of a newer one; once every channel has ended, the
 * title's ciphertext is cleared.
 */
export async function deliverApprovalNotices(
  db: ReturnType<typeof getDb>,
  config: NotificationWorkerConfig,
  now: Date,
  providers: NotificationProviders,
  limit = 25,
): Promise<void> {
  // Driven from the receipts still in review (a bounded set) into audit_log
  // through audit_household_entity_idx, never a scan of audit_log by type.
  const candidates = await db.select({ id: auditLog.id }).from(imapIngestionMessages)
    .innerJoin(auditLog, and(
      eq(auditLog.householdId, imapIngestionMessages.householdId),
      eq(auditLog.entityType, APPROVAL_NOTICE_ENTITY),
      eq(auditLog.entityId, imapIngestionMessages.id),
    ))
    .where(and(
      inArray(imapIngestionMessages.status, ["pending_review", "approving"]),
      or(sql`${auditLog.changes}->>'email' in ('pending', 'sending')`, sql`${auditLog.changes}->>'push' in ('pending', 'sending')`),
    ))
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id))
    .limit(limit);
  for (const { id } of candidates) {
    try {
      await deliverOne(db, id, config, now, providers);
    } catch {
      log.warn({ event: "delivery.smtp", state: "retrying", reason: asOperationalReason("approval_notice_failed"), action: "retry", impact: "notification_delivery_delayed" });
    }
  }
}

type PushTarget = { id: string; endpoint: string; p256dh: string; auth: string };
interface NoticeClaim {
  title: string;
  claimedAt: string;
  email?: { address: string };
  push?: { subscriptions: PushTarget[] };
}

function finalise(changes: NoticeChanges): NoticeChanges {
  return unfinished(changes.email) || unfinished(changes.push) ? changes : { ...changes, titleEnc: null };
}

function changed(before: NoticeChanges, after: NoticeChanges): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

async function deliverOne(
  db: ReturnType<typeof getDb>,
  id: string,
  config: NotificationWorkerConfig,
  now: Date,
  providers: NotificationProviders,
): Promise<void> {
  const claim = await claimNotice(db, id, config, now);
  if (!claim) return;
  const outcome: { email?: ChannelState; push?: { delivered: boolean; transient: boolean; revoked: string[] } } = {};
  if (claim.email) outcome.email = await sendMail(claim.email.address, claim.title, config, providers);
  if (claim.push) outcome.push = await sendPush(claim.push.subscriptions, claim.title, providers);
  await recordNotice(db, id, claim, outcome, config, now);
}

/** Step one: lock the row briefly, re-check its receipt, and mark what will be sent. */
async function claimNotice(
  db: ReturnType<typeof getDb>,
  id: string,
  config: NotificationWorkerConfig,
  now: Date,
): Promise<NoticeClaim | undefined> {
  return db.transaction(async (transaction) => {
    const rows = await transaction.execute(sql`select id from audit_log where id = ${id} for update skip locked`) as unknown as Array<{ id: string }>;
    if (!rows.length) return undefined;
    const [row] = await transaction.select({
      householdId: auditLog.householdId,
      userId: auditLog.actorUserId,
      changes: auditLog.changes,
      receiptStatus: imapIngestionMessages.status,
      emailEnc: users.emailEnc,
      disabledAt: users.disabledAt,
      isMember: sql<boolean>`${memberships.userId} is not null`,
      userEmailEnabled: sql<boolean>`coalesce(${userPreferences.emailNotifications}, true)`,
      userPushEnabled: sql<boolean>`coalesce(${userPreferences.pushNotifications}, true)`,
    }).from(auditLog)
      .leftJoin(imapIngestionMessages, eq(imapIngestionMessages.id, auditLog.entityId))
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .leftJoin(userPreferences, eq(userPreferences.userId, auditLog.actorUserId))
      .leftJoin(memberships, and(eq(memberships.householdId, auditLog.householdId), eq(memberships.userId, auditLog.actorUserId)))
      .where(eq(auditLog.id, id)).limit(1);
    if (!row) return undefined;
    const changes = row.changes as NoticeChanges;
    const next: NoticeChanges = { ...changes };
    const claimedAt = now.toISOString();
    const claim: NoticeClaim = { title: "", claimedAt };
    // A claim cut off mid-send may have gone out: it ends rather than sending twice.
    for (const channel of ["email", "push"] as const) {
      const at = changes[`${channel}ClaimedAt`];
      if (next[channel] === "sending" && (!at || Date.parse(at) + SENDING_LEASE_MS <= now.getTime())) next[channel] = "failed";
    }
    const endPending = (state: ChannelState) => {
      if (next.email === "pending") next.email = state;
      if (next.push === "pending") next.push = state;
    };
    /* A receipt mid-approval (a same-key replay) or mid-cleanup has not left
       review for good: the notice waits for it to come back or to end, and the
       path that ends it finalises the notice itself. */
    const waiting = row.receiptStatus === "approving" || row.receiptStatus === "recoverable";
    const ended = !row.householdId || !row.userId || (!waiting && row.receiptStatus !== "pending_review") || Boolean(row.disabledAt) || !row.isMember;
    if (ended) {
      endPending("skipped");
    } else if (!waiting && (next.email === "pending" || next.push === "pending")) {
      /* #963/#969, as the reminders: a locked key is a transient fault (the
         notice stays pending, title kept, no attempt spent); only a value
         unreadable with the key present can never be sent. */
      const read = (await openMetadataReader(row.householdId!, transaction)).text(TITLE_COLUMN, id, { encrypted: changes.titleEnc });
      const title = read.value?.trim() || undefined;
      if (read.state === "metadata_locked") {
        /* left pending for a later cycle */
      } else if (!title) {
        endPending("failed");
      } else {
        claim.title = title;
        if (next.email === "pending") {
          if (!row.userEmailEnabled) next.email = "off";
          else if (!config.smtpUrl) next.email = "skipped";
          else {
            const read = (await openInstanceMetadataReader(transaction)).text("users.email", row.userId!, { encrypted: row.emailEnc });
            const address = read.value;
            if (read.state === "metadata_locked") { /* left pending for a later cycle */ }
            else if (!address) next.email = "failed";
            else {
              next.email = "sending";
              next.emailClaimedAt = claimedAt;
              claim.email = { address };
            }
          }
        }
        if (next.push === "pending") {
          if (!row.userPushEnabled) next.push = "off";
          else if (!config.vapidSubject || !config.vapidPublicKey || !config.vapidPrivateKey) next.push = "skipped";
          else {
            const subscriptions = await transaction.select({
              id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth,
            }).from(pushSubscriptions).where(and(
              eq(pushSubscriptions.userId, row.userId!),
              isNull(pushSubscriptions.revokedAt),
              or(isNull(pushSubscriptions.expiresAt), gte(pushSubscriptions.expiresAt, now)),
            ));
            /* A web push where they have one: none is not a failure. */
            if (!subscriptions.length) next.push = "skipped";
            else {
              next.push = "sending";
              next.pushClaimedAt = claimedAt;
              claim.push = { subscriptions };
            }
          }
        }
      }
    }
    const final = finalise(next);
    if (changed(changes, final)) await transaction.update(auditLog).set({ changes: final }).where(eq(auditLog.id, id));
    return claim.email || claim.push ? claim : undefined;
  });
}

/** Step three: record each claimed channel's result, only while the claim is still this one. */
async function recordNotice(
  db: ReturnType<typeof getDb>,
  id: string,
  claim: NoticeClaim,
  outcome: { email?: ChannelState; push?: { delivered: boolean; transient: boolean; revoked: string[] } },
  config: NotificationWorkerConfig,
  now: Date,
): Promise<void> {
  await db.transaction(async (transaction) => {
    if (outcome.push?.revoked.length) {
      await transaction.update(pushSubscriptions).set({ revokedAt: now })
        .where(and(inArray(pushSubscriptions.id, outcome.push.revoked), isNull(pushSubscriptions.revokedAt)));
    }
    const [row] = await transaction.select({ changes: auditLog.changes }).from(auditLog).where(eq(auditLog.id, id)).for("update").limit(1);
    if (!row) return;
    const changes = row.changes as NoticeChanges;
    const next: NoticeChanges = { ...changes };
    if (outcome.email && next.email === "sending" && next.emailClaimedAt === claim.claimedAt) {
      if (outcome.email === "sent") next.email = "sent";
      else {
        next.emailAttempts += 1;
        next.email = next.emailAttempts >= config.maxAttempts ? "failed" : "pending";
      }
      next.emailClaimedAt = null;
    }
    if (outcome.push && next.push === "sending" && next.pushClaimedAt === claim.claimedAt) {
      /* Once one device has it, it is sent: a retry would repeat it on that device. */
      if (outcome.push.delivered) next.push = "sent";
      else if (!outcome.push.transient) next.push = "skipped";
      else {
        next.pushAttempts += 1;
        next.push = next.pushAttempts >= config.maxAttempts ? "failed" : "pending";
      }
      next.pushClaimedAt = null;
    }
    const final = finalise(next);
    if (changed(changes, final)) await transaction.update(auditLog).set({ changes: final }).where(eq(auditLog.id, id));
  });
}

async function sendMail(address: string, title: string, config: NotificationWorkerConfig, providers: NotificationProviders): Promise<ChannelState> {
  const mail = approvalNoticeMail(title);
  try {
    await providers.sendEmail({ from: config.smtpFrom, to: address, subject: mail.subject, text: mail.text, html: mail.html, tlsMode: config.smtpSecurity });
    return "sent";
  } catch {
    return "failed";
  }
}

async function sendPush(subscriptions: PushTarget[], title: string, providers: NotificationProviders) {
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
  return { delivered, transient, revoked };
}
