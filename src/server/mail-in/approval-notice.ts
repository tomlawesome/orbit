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
 * Since the rework (note 56230) the words no longer name the title; the row
 * still holds it so a damaged or locked notice is caught before anything goes.
 * A file the scanner flagged queues no notice: the review card says so.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, imapIngestionMessages, memberships, pushSubscriptions, userPreferences, users } from "@/db/schema";
import { asOperationalReason, log } from "@/lib/logger";
import { appHost, householdLine, renderMail } from "@/server/invitations/mail";
import { metadataCryptoAvailable } from "@/server/metadata/keys";
import { openInstanceMetadataReader, openMetadataReader, type MetadataCipher, type MetadataExecutor } from "@/server/metadata/fields";
import { isAllowedPushEndpoint, type NotificationProviders, type NotificationWorkerConfig } from "@/server/notification-worker";

export const APPROVAL_NOTICE_ENTITY = "reviewed_intake_notice";
const TITLE_COLUMN = "audit_log.approval_notice" as const;
/** A claim older than this was cut off mid-send; it is never sent again (told once, not twice). */
const SENDING_LEASE_MS = 10 * 60_000;

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
  /** When the worker may next look at it: set while it waits, is in flight, or retries. */
  nextAttemptAt?: string | null;
  /** How many times it has waited on something outside it (a receipt mid-approval, a locked key); sets the delay. */
  deferrals?: number;
  /** Set while it waits on its receipt mid-approval: due again as soon as the receipt is back in review. */
  waitingOn?: "receipt";
}

/** The notice row's id: one per operation id, never the id itself (the item and its activity use that). */
export function approvalNoticeId(operationId: string): string {
  const hex = createHash("sha256").update(`orbit:reviewed-intake-notice:${operationId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The owner's headline, which is the subject too (#1398 note 56230): one wording for every failure, no title. */
export const APPROVAL_NOTICE_HEADLINE = "Orbit couldn't add your email — please login and try again";
/** The owner's body, which is the preheader and the push text too. */
export const APPROVAL_NOTICE_BODY = "A server error occurred and your mail couldn't be added. The email and attachments are waiting for review in your inbox";

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

const unfinishedSql = (channel: "email" | "push") => sql`${auditLog.changes}->>${sql.raw(`'${channel}'`)} in ('pending', 'sending')`;

/**
 * Ends a receipt's notices in the caller's transaction, for the paths that take
 * the receipt out of review for good (added, discarded, expired, moved to
 * another household): the worker only looks at receipts still in review, so
 * these paths end each pending channel themselves. A channel already `sending`
 * is left to the send in flight, whose result is recorded as it happened, and
 * that record ends whatever is left; the title goes once nothing is in flight.
 */
export async function endApprovalNotices(executor: MetadataExecutor, receipt: { id: string; householdId: string | null }): Promise<void> {
  if (!receipt.householdId) return;
  const ending = (channel: "email" | "push") =>
    sql`case when ${auditLog.changes}->>${sql.raw(`'${channel}'`)} = 'pending' then 'skipped' else ${auditLog.changes}->>${sql.raw(`'${channel}'`)} end`;
  await executor.update(auditLog).set({
    changes: sql`(${auditLog.changes} || jsonb_build_object('email', ${ending("email")}, 'push', ${ending("push")}))
      || case when (${ending("email")}) = 'sending' or (${ending("push")}) = 'sending' then '{}'::jsonb else jsonb_build_object('titleEnc', null) end`,
  }).where(and(
    eq(auditLog.householdId, receipt.householdId),
    eq(auditLog.entityType, APPROVAL_NOTICE_ENTITY),
    eq(auditLog.entityId, receipt.id),
    sql`(${auditLog.changes}->>'titleEnc' is not null or ${unfinishedSql("email")} or ${unfinishedSql("push")})`,
  ));
}

/**
 * Ends every notice of a household being purged, in the purge's transaction
 * and before the household row goes (which nulls `audit_log.household_id` and
 * would leave them out of reach). Nothing of the household survives, so a
 * channel in flight ends too: its late result finds it no longer `sending`
 * and is ignored.
 */
export async function endHouseholdApprovalNotices(executor: MetadataExecutor, householdId: string): Promise<void> {
  const ending = (channel: "email" | "push") =>
    sql`case when ${unfinishedSql(channel)} then 'skipped' else ${auditLog.changes}->>${sql.raw(`'${channel}'`)} end`;
  await executor.update(auditLog).set({
    changes: sql`${auditLog.changes} || jsonb_build_object('email', ${ending("email")}, 'push', ${ending("push")}, 'titleEnc', null)`,
  }).where(and(
    eq(auditLog.householdId, householdId),
    eq(auditLog.entityType, APPROVAL_NOTICE_ENTITY),
    sql`(${auditLog.changes}->>'titleEnc' is not null or ${unfinishedSql("email")} or ${unfinishedSql("push")})`,
  ));
}

function inboxLink(environment: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const url = new URL(environment.APP_URL ?? "");
    if (["http:", "https:"].includes(url.protocol) && url.hostname) return new URL("/?open=inbox", url.origin).href;
  } catch { /* no link rather than an invented one */ }
  return null;
}

/** The mail: the card with the owner's words and the inbox button; the footer is the household line alone. */
export function approvalNoticeMail(environment: NodeJS.ProcessEnv = process.env) {
  const href = inboxLink(environment);
  return renderMail({
    subject: APPROVAL_NOTICE_HEADLINE,
    preheader: APPROVAL_NOTICE_BODY,
    headline: APPROVAL_NOTICE_HEADLINE,
    body: [APPROVAL_NOTICE_BODY],
    ...(href ? { button: { label: "Open your inbox", href } } : {}),
    footer: [householdLine(appHost(environment))],
    text: `${APPROVAL_NOTICE_HEADLINE}\n\n${APPROVAL_NOTICE_BODY}${href ? `\n\nOpen your inbox: ${href}` : ""}`,
  });
}

/** The push: the headline and the body, as the mail. */
export function approvalNoticePush(): { title: string; body: string; url: "/" } {
  return { title: APPROVAL_NOTICE_HEADLINE, body: APPROVAL_NOTICE_BODY, url: "/" };
}


const unfinished = (state: ChannelState) => state === "pending" || state === "sending";

/**
 * Sends queued notices, oldest due first, once per channel. Each row goes
 * through three short steps, so no row lock or transaction is held while mail
 * or push is on the wire: a claim (the row locked, skip locked, its receipt
 * re-checked and each channel to send marked `sending`), the sends, and the
 * record of what happened.
 *
 * A notice that cannot be sent yet (its receipt mid-approval or mid-cleanup,
 * its key locked or missing, a damaged title or address, a claim that threw)
 * is deferred, as the reminders are (#963/#969): it gets a next-attempt time
 * with a growing delay and is not looked at again until then. The ones
 * deferred in a cycle do not count against its limit, so blocked notices
 * never hold the slots of a deliverable one behind them. One waiting on its
 * receipt mid-approval is due again as soon as the receipt is back in review,
 * whatever its delay. A damaged value
 * spends an attempt each time and ends failed after the maximum. A notice
 * whose receipt left review, whose member left, or whose channel cannot send
 * at all (switched off, no sending set up) ends unsent. Once every channel
 * has ended, the title's ciphertext is cleared.
 */
export async function deliverApprovalNotices(
  db: ReturnType<typeof getDb>,
  config: NotificationWorkerConfig,
  now: Date,
  providers: NotificationProviders,
  retryDelay: (attempts: number) => number,
  limit = 25,
): Promise<void> {
  const seen: string[] = [];
  let delivered = 0;
  // A bound on the rows one cycle looks at, however many are blocked.
  while (delivered < limit && seen.length < limit * 4) {
    const candidates = await dueNoticesQuery(db, now, seen, Math.min(limit, limit * 4 - seen.length));
    if (!candidates.length) break;
    for (const { id } of candidates) {
      seen.push(id);
      try {
        if (await deliverOne(db, id, config, now, providers, retryDelay)) delivered += 1;
      } catch {
        log.warn({ event: "delivery.smtp", state: "retrying", reason: asOperationalReason("approval_notice_failed"), action: "retry", impact: "notification_delivery_delayed" });
        await deferNotice(db, id, now, retryDelay).catch(() => undefined);
      }
    }
  }
}

/**
 * The notices due now, oldest due first. Driven from the receipts still in
 * review (a bounded set) into audit_log through audit_household_entity_idx,
 * never a scan of audit_log by type. Exported, un-awaited, so its query plan
 * can be checked on a large audit log (#1787).
 */
export function dueNoticesQuery(db: ReturnType<typeof getDb>, now: Date, seen: string[], limit: number) {
  const dueAt = sql`coalesce((${auditLog.changes}->>'nextAttemptAt')::timestamptz, ${auditLog.createdAt})`;
  return db.select({ id: auditLog.id }).from(imapIngestionMessages)
    .innerJoin(auditLog, and(
      eq(auditLog.householdId, imapIngestionMessages.householdId),
      eq(auditLog.entityType, APPROVAL_NOTICE_ENTITY),
      eq(auditLog.entityId, imapIngestionMessages.id),
    ))
    .where(and(
      inArray(imapIngestionMessages.status, ["pending_review", "approving"]),
      or(sql`${auditLog.changes}->>'email' in ('pending', 'sending')`, sql`${auditLog.changes}->>'push' in ('pending', 'sending')`),
      sql`(${auditLog.changes}->>'nextAttemptAt' is null
        or (${auditLog.changes}->>'nextAttemptAt')::timestamptz <= ${now.toISOString()}::timestamptz
        or (${auditLog.changes}->>'waitingOn' = 'receipt' and ${imapIngestionMessages.status} = 'pending_review'))`,
      ...(seen.length ? [notInArray(auditLog.id, seen)] : []),
    ))
    .orderBy(asc(dueAt), asc(auditLog.id))
    .limit(limit);
}

type PushTarget = { id: string; endpoint: string; p256dh: string; auth: string };
interface NoticeClaim {
  title: string;
  claimedAt: string;
  email?: { address: string };
  push?: { subscriptions: PushTarget[] };
}

function finalise(changes: NoticeChanges): NoticeChanges {
  return unfinished(changes.email) || unfinished(changes.push) ? changes : { ...changes, titleEnc: null, nextAttemptAt: null };
}

function changed(before: NoticeChanges, after: NoticeChanges): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

const at = (now: Date, delayMs: number) => new Date(now.getTime() + delayMs).toISOString();

/** Waits on something outside the notice: no attempt spent, a growing delay. */
function defer(next: NoticeChanges, now: Date, retryDelay: (attempts: number) => number): void {
  next.deferrals = (next.deferrals ?? 0) + 1;
  next.nextAttemptAt = at(now, retryDelay(next.deferrals));
}

/** A claim that threw (a key that would not load, a database fault): deferred like any other wait. */
async function deferNotice(db: ReturnType<typeof getDb>, id: string, now: Date, retryDelay: (attempts: number) => number): Promise<void> {
  await db.transaction(async (transaction) => {
    const [row] = await transaction.select({ changes: auditLog.changes }).from(auditLog).where(eq(auditLog.id, id)).for("update").limit(1);
    if (!row) return;
    const next: NoticeChanges = { ...(row.changes as NoticeChanges) };
    // Its wait on the receipt is over or moot: the delay governs, not the receipt's return.
    delete next.waitingOn;
    defer(next, now, retryDelay);
    await transaction.update(auditLog).set({ changes: next }).where(eq(auditLog.id, id));
  });
}

/** Whether anything went on the wire. */
async function deliverOne(
  db: ReturnType<typeof getDb>,
  id: string,
  config: NotificationWorkerConfig,
  now: Date,
  providers: NotificationProviders,
  retryDelay: (attempts: number) => number,
): Promise<boolean> {
  const claim = await claimNotice(db, id, config, now, retryDelay);
  if (!claim) return false;
  const outcome: { email?: ChannelState; push?: { delivered: boolean; transient: boolean; revoked: string[] } } = {};
  if (claim.email) outcome.email = await sendMail(claim.email.address, config, providers);
  if (claim.push) outcome.push = await sendPush(claim.push.subscriptions, providers);
  await recordNotice(db, id, claim, outcome, config, now, retryDelay);
  return true;
}

/** Statuses a receipt can be in without its review having ended. */
const IN_REVIEW = new Set(["pending_review", "approving", "recoverable"]);

/** Step one: lock the row briefly, re-check its receipt, and mark what will be sent. */
async function claimNotice(
  db: ReturnType<typeof getDb>,
  id: string,
  config: NotificationWorkerConfig,
  now: Date,
  retryDelay: (attempts: number) => number,
): Promise<NoticeClaim | undefined> {
  return db.transaction(async (transaction) => {
    const rows = await transaction.execute(sql`select id from audit_log where id = ${id} for update skip locked`) as unknown as Array<{ id: string }>;
    if (!rows.length) return undefined;
    const [row] = await transaction.select({
      householdId: auditLog.householdId,
      userId: auditLog.actorUserId,
      changes: auditLog.changes,
      receiptStatus: imapIngestionMessages.status,
      receiptHouseholdId: imapIngestionMessages.householdId,
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
      const claimed = changes[`${channel}ClaimedAt`];
      if (next[channel] === "sending" && (!claimed || Date.parse(claimed) + SENDING_LEASE_MS <= now.getTime())) next[channel] = "failed";
    }
    const endPending = (state: ChannelState) => {
      if (next.email === "pending") next.email = state;
      if (next.push === "pending") next.push = state;
    };
    /* A damaged value spends an attempt on each channel it stops, and ends that channel after the maximum. */
    const damaged = (channels: Array<"email" | "push">) => {
      let waits = false;
      for (const channel of channels) {
        if (next[channel] !== "pending") continue;
        const attempts = `${channel}Attempts` as const;
        next[attempts] += 1;
        if (next[attempts] >= config.maxAttempts) next[channel] = "failed";
        else waits = true;
      }
      if (waits) next.nextAttemptAt = at(now, retryDelay(Math.max(next.emailAttempts, next.pushAttempts)));
    };
    let deferred = false;
    /* A receipt mid-approval (a same-key replay) or mid-cleanup has not left
       review for good: the notice waits for it to come back, and the path that
       ends the review ends the notice itself. */
    const waiting = row.receiptStatus === "approving" || row.receiptStatus === "recoverable";
    /* A receipt moved to another household has left this notice's review: the
       notice is filed and keyed under the household it was queued in. */
    const ended = !row.householdId || !row.userId || !IN_REVIEW.has(row.receiptStatus ?? "") || row.receiptHouseholdId !== row.householdId
      || Boolean(row.disabledAt) || !row.isMember;
    if (ended) {
      endPending("skipped");
    } else if (next.email === "pending" || next.push === "pending") {
      if (waiting) {
        deferred = true;
        next.waitingOn = "receipt";
      } else {
        /* Back in review (a failed replay released it): the wait on the receipt is over, and so is its backoff. */
        if (next.waitingOn) {
          delete next.waitingOn;
          next.deferrals = 0;
        }
        /* #963/#969, as the reminders: a locked or missing key is a transient
           fault (title kept, no attempt spent). One household's key missing or
           unopenable is deferred with a growing delay, so it never holds the
           slots of other households' notices; the whole instance locked (no
           KEK) blocks every notice alike, so it simply stays pending and goes
           on the first cycle after the key is back. A value unreadable with
           the key present is deferred too, spending an attempt each time, and
           ends failed after the maximum. */
        const instanceKeyed = metadataCryptoAvailable();
        const read = (await openMetadataReader(row.householdId!, transaction)).text(TITLE_COLUMN, id, { encrypted: changes.titleEnc });
        const title = read.value?.trim() || undefined;
        if (read.state === "metadata_locked") {
          deferred = instanceKeyed;
        } else if (!title) {
          damaged(["email", "push"]);
        } else {
          claim.title = title;
          if (next.email === "pending") {
            if (!row.userEmailEnabled) next.email = "off";
            else if (!config.smtpUrl) next.email = "skipped";
            else {
              const address = (await openInstanceMetadataReader(transaction)).text("users.email", row.userId!, { encrypted: row.emailEnc });
              if (address.state === "metadata_locked") deferred = instanceKeyed;
              else if (!address.value) damaged(["email"]);
              else {
                next.email = "sending";
                next.emailClaimedAt = claimedAt;
                claim.email = { address: address.value };
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
    }
    if (deferred) defer(next, now, retryDelay);
    /* In flight: not due again until the claim's lease runs out. */
    if (claim.email || claim.push) next.nextAttemptAt = at(now, SENDING_LEASE_MS);
    const final = finalise(next);
    if (changed(changes, final)) await transaction.update(auditLog).set({ changes: final }).where(eq(auditLog.id, id));
    return claim.email || claim.push ? claim : undefined;
  });
}

/**
 * Step three: record each claimed channel's result, only while the claim is
 * still this one. A receipt that left this notice's review while the send was
 * in flight (its review ended, or it moved to another household) had its
 * pending channels ended then; anything this result leaves pending ends now,
 * so the title is cleared rather than waiting under a receipt the worker no
 * longer finds for this notice.
 */
async function recordNotice(
  db: ReturnType<typeof getDb>,
  id: string,
  claim: NoticeClaim,
  outcome: { email?: ChannelState; push?: { delivered: boolean; transient: boolean; revoked: string[] } },
  config: NotificationWorkerConfig,
  now: Date,
  retryDelay: (attempts: number) => number,
): Promise<void> {
  await db.transaction(async (transaction) => {
    if (outcome.push?.revoked.length) {
      await transaction.update(pushSubscriptions).set({ revokedAt: now })
        .where(and(inArray(pushSubscriptions.id, outcome.push.revoked), isNull(pushSubscriptions.revokedAt)));
    }
    const [row] = await transaction.select({
      changes: auditLog.changes, householdId: auditLog.householdId,
      receiptStatus: imapIngestionMessages.status, receiptHouseholdId: imapIngestionMessages.householdId,
    }).from(auditLog)
      .leftJoin(imapIngestionMessages, eq(imapIngestionMessages.id, auditLog.entityId))
      .where(eq(auditLog.id, id)).for("update", { of: auditLog }).limit(1);
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
    if (!IN_REVIEW.has(row.receiptStatus ?? "") || row.receiptHouseholdId !== row.householdId) {
      if (next.email === "pending") next.email = "skipped";
      if (next.push === "pending") next.push = "skipped";
    }
    /* A failed send retries after a delay, as the reminders do. */
    const retrying = (["email", "push"] as const).filter((channel) => next[channel] === "pending");
    if (retrying.length) next.nextAttemptAt = at(now, retryDelay(Math.max(...retrying.map((channel) => next[`${channel}Attempts`]))));
    else if (next.email !== "sending" && next.push !== "sending") next.nextAttemptAt = null;
    const final = finalise(next);
    if (changed(changes, final)) await transaction.update(auditLog).set({ changes: final }).where(eq(auditLog.id, id));
  });
}

async function sendMail(address: string, config: NotificationWorkerConfig, providers: NotificationProviders): Promise<ChannelState> {
  const mail = approvalNoticeMail();
  try {
    await providers.sendEmail({ from: config.smtpFrom, to: address, subject: mail.subject, text: mail.text, html: mail.html, tlsMode: config.smtpSecurity });
    return "sent";
  } catch {
    return "failed";
  }
}

async function sendPush(subscriptions: PushTarget[], providers: NotificationProviders) {
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
        payload: approvalNoticePush(),
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
