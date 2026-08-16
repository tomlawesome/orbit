import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
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
import { householdOwnerLockKey } from "@/lib/auth/authority-locks";
import { log, operationalReasons, type OperationalReason } from "@/lib/logger";
import { DEFAULT_FINAL_WARNING_DAYS, DEFAULT_FIRST_WARNING_DAYS } from "@/lib/preferences";
import { readRuntimeSecret } from "@/lib/runtime-secret";

const notificationEnvironmentSchema = z.object({
  SMTP_HOST: z.string().trim().max(253).optional().default(""),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SMTP_SECURITY: z.enum(["starttls", "implicit_tls"]).optional().default("starttls"),
  SMTP_USER: z.string().trim().max(320).optional().default(""),
  SMTP_PASSWORD: z.string().optional().default(""),
  // Deprecated compatibility input. New deployments should use the fields above.
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
  smtpSecurity: "starttls" | "implicit_tls";
  smtpFrom: string;
  vapidSubject: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  pollMilliseconds: number;
  maxAttempts: number;
}

export type SmtpProviderVerification = "ready" | "smtp_unconfigured" | "smtp_unavailable" | "smtp_rejected" | "unsafe_input";

export const notificationFailureCategories = [
  "smtp_unconfigured",
  "smtp_unavailable",
  "smtp_rejected",
  "push_unconfigured",
  "push_unsubscribed",
  "push_unavailable",
  "recipient_preferences_disabled",
  "household_pending_deletion",
  "membership_removed",
  "unknown",
] as const;

export type NotificationFailureCategory = typeof notificationFailureCategories[number];

function operationalNotificationReason(category: NotificationFailureCategory): OperationalReason {
  if (category === "unknown") return "provider_error";
  return (operationalReasons as readonly string[]).includes(category)
    ? category as OperationalReason
    : "unexpected_failure";
}

export interface NotificationWorkerHealth {
  started: boolean;
  running: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorCategory: NotificationFailureCategory | null;
}

export interface SmtpNotification {
  from: string;
  to: string;
  subject: string;
  text: string;
  tlsMode: NotificationWorkerConfig["smtpSecurity"];
}

export interface PushNotification {
  target: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  payload: {
    title: string;
    body: string;
    url: "/";
  };
}

export interface NotificationProviders {
  sendEmail(notification: SmtpNotification): Promise<void>;
  sendPush(notification: PushNotification): Promise<void>;
}

type NotificationDatabase = ReturnType<typeof getDb>;
type NotificationTransaction = Parameters<Parameters<NotificationDatabase["transaction"]>[0]>[0];

export interface NotificationWorkerDependencies {
  /** A separate Drizzle client may be supplied for concurrency tests. */
  db?: NotificationDatabase;
  /** Supplies one stable instant for a complete worker cycle. */
  now?: () => Date;
  /** Supplies a lease identity per claimed row. */
  nextLeaseToken?: () => string;
  /** Explicit provider fakes keep tests off the network. */
  providers?: NotificationProviders;
  /** Deterministic barrier used to model a lease handoff before dispatch. */
  beforeProviderDispatch?: (delivery: { id: string; channel: "email" | "web_push" }) => Promise<void>;
  leaseDurationMs?: number;
  retryDelayMs?: (attempts: number) => number;
  claimLimit?: number;
}

const notificationLeaseDurationMs = 10 * 60_000;
const notificationCatchUpWindowMs = 24 * 60 * 60_000;
const notificationRetryBackoffCapMs = 60 * 60_000;

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
    "household_pending_deletion",
    "membership_removed",
  ].includes(category)) return "cancelled";
  return attempts >= maxAttempts ? "failed" : "retry";
}

/** Returns a bounded exponential delay for a transient notification failure. */
export function notificationRetryDelayMs(attempts: number): number {
  const boundedAttempts = Math.max(1, Math.min(Math.floor(attempts), 7));
  return Math.min(notificationRetryBackoffCapMs, 60_000 * (2 ** (boundedAttempts - 1)));
}

export function getNotificationWorkerConfig(environment: NodeJS.ProcessEnv = process.env): NotificationWorkerConfig {
  const parsed = notificationEnvironmentSchema.parse({
    ...environment,
    SMTP_URL: readRuntimeSecret(environment, "SMTP_URL"),
    SMTP_PASSWORD: readRuntimeSecret(environment, "SMTP_PASSWORD"),
    VAPID_PRIVATE_KEY: readRuntimeSecret(environment, "VAPID_PRIVATE_KEY"),
  });
  const smtpRequested = Boolean(parsed.SMTP_HOST || parsed.SMTP_USER || parsed.SMTP_PASSWORD);
  if (smtpRequested && !(parsed.SMTP_HOST && parsed.SMTP_USER && parsed.SMTP_PASSWORD)) throw new Error("SMTP_HOST, SMTP_USER, and SMTP_PASSWORD must be configured together");
  if (parsed.SMTP_URL && smtpRequested) throw new Error("Use either SMTP_URL or individual SMTP settings, not both");
  const hasExplicitSmtpSecurity = typeof environment.SMTP_SECURITY === "string" && environment.SMTP_SECURITY.length > 0;
  let smtpSecurity = parsed.SMTP_SECURITY;
  if (parsed.SMTP_URL) {
    let smtpUrl: URL;
    try { smtpUrl = new URL(parsed.SMTP_URL); } catch { throw new Error("SMTP_URL must be a valid SMTP URL"); }
    if (!smtpUrl.hostname || !["smtp:", "smtps:"].includes(smtpUrl.protocol)) throw new Error("SMTP_URL must use smtp or smtps");
    const inferredSecurity = smtpUrl.protocol === "smtps:" ? "implicit_tls" : "starttls";
    if (hasExplicitSmtpSecurity && inferredSecurity !== parsed.SMTP_SECURITY) {
      throw new Error(parsed.SMTP_SECURITY === "implicit_tls" ? "SMTP_URL must use implicit TLS" : "SMTP_URL requires STARTTLS");
    }
    smtpSecurity = inferredSecurity;
  }
  const smtpPort = parsed.SMTP_PORT ?? (smtpSecurity === "implicit_tls" ? 465 : 587);
  const smtpUrl = smtpRequested
    ? `${smtpSecurity === "implicit_tls" ? "smtps" : "smtp"}://${encodeURIComponent(parsed.SMTP_USER)}:${encodeURIComponent(parsed.SMTP_PASSWORD)}@${parsed.SMTP_HOST}:${smtpPort}`
    : parsed.SMTP_URL;
  return {
    smtpUrl,
    smtpSecurity,
    smtpFrom: parsed.SMTP_FROM,
    vapidSubject: parsed.VAPID_SUBJECT,
    vapidPublicKey: parsed.VAPID_PUBLIC_KEY,
    vapidPrivateKey: parsed.VAPID_PRIVATE_KEY,
    pollMilliseconds: parsed.WORKER_POLL_SECONDS * 1_000,
    maxAttempts: parsed.NOTIFICATION_MAX_ATTEMPTS,
  };
}

/**
 * Builds a TLS-pinned Nodemailer transport without exposing provider details.
 *
 * nodemailer's `createTransport(urlString, secondArgument)` only ever reads
 * `secondArgument` as *mail* defaults (e.g. a default `from`) — never as
 * connection/transport options — whenever the first argument is a URL
 * string (see `nodemailer/lib/nodemailer.js` and `Mailer`'s constructor).
 * Passing `requireTLS`, `tls`, or the timeout bounds there is silently
 * discarded (#383 finding 1's fix depends on the timeouts actually taking
 * effect, which surfaced this). nodemailer's own URL parser does read
 * connection options from the URL's query string
 * (`shared.parseConnectionUrl`, including a `tls.<key>` nested form), so
 * that is the supported way to carry them through a URL-shaped transporter.
 */
export function createSmtpTransport(config: NotificationWorkerConfig, timeouts = true): ReturnType<typeof nodemailer.createTransport> {
  let url: URL;
  try { url = new URL(config.smtpUrl); } catch { return nodemailer.createTransport(config.smtpUrl); }
  url.searchParams.set("requireTLS", String(config.smtpSecurity === "starttls"));
  url.searchParams.set("tls.minVersion", "TLSv1.2");
  url.searchParams.set("tls.rejectUnauthorized", "true");
  if (url.hostname) url.searchParams.set("tls.servername", url.hostname);
  if (timeouts) {
    url.searchParams.set("connectionTimeout", "5000");
    url.searchParams.set("greetingTimeout", "5000");
    url.searchParams.set("socketTimeout", "5000");
  }
  return nodemailer.createTransport(url.toString());
}

/** Verifies SMTP TLS and authentication only; it never sends a message. */
export async function verifySmtpProviderConnection(config = getNotificationWorkerConfig()): Promise<SmtpProviderVerification> {
  if (!config.smtpUrl) return "smtp_unconfigured";
  let transporter: ReturnType<typeof nodemailer.createTransport> | undefined;
  try {
    transporter = createSmtpTransport(config);
    await transporter.verify();
    return "ready";
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("url") || message.includes("protocol")) return "unsafe_input";
    const category = categorizeProviderError("email", error);
    return category === "smtp_rejected" ? "smtp_rejected" : "smtp_unavailable";
  } finally {
    transporter?.close();
  }
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

/** One warning: how many days before the date it fires, and which channels it may use. */
export interface ReminderOffset {
  daysBefore: number;
  emailEnabled: boolean;
  pushEnabled: boolean;
}

/** The recipient's own stored pair, as read from `user_preferences` (#468). */
export interface RecipientWarningDays {
  firstWarningDays: number | null;
  finalWarningDays: number | null;
}

/**
 * A stored offset that is missing, fractional, or outside the range the
 * settings screen and the CHECK constraints allow falls back to the
 * documented default for its own slot rather than scheduling a date nobody
 * asked for. Unreachable through the route or the database today; this is the
 * behaviour if a row ever arrives by another path.
 */
function warningDaysOrDefault(stored: number | null, fallback: number, floor: number): number {
  if (stored === null || !Number.isInteger(stored) || stored < floor || stored > 365) return fallback;
  return stored;
}

/**
 * The offsets a single recipient's reminders for one item actually fire at (#479).
 *
 * Precedence, as scoped in the issue: an item that carries its own reminder
 * rules keeps them exactly: the reader set those per item, and the settings
 * screen never claimed to overrule them. The user-level pair is the default
 * for every item that says nothing — until #479 those items produced no
 * reminder at all, because the worker inner-joined `reminder_rules` and an
 * item without rules simply fell out of the join.
 *
 * The pair is per recipient, not per household, and that is the only honest
 * reading of the surrounding code: `notification_deliveries` already carries a
 * `user_id`, materialization already fans one row out per membership, and the
 * recipient's own `email_notifications`/`push_notifications` toggles already
 * decide their own channels. Two people in one household therefore each hear
 * about the same item on their own schedule, which is what a screen headed
 * with the reader's own name promises. Nothing here reads another user's row.
 *
 * The two warnings are returned as a set of offsets, not an ordered pair: the
 * first/final ordering is a promise the *labels* make ("14 days before closest
 * approach", then "3 days before"), and each offset is scheduled
 * independently, so a pair that somehow crossed over still raises two warnings
 * rather than none. A pair whose halves are equal is one warning, not a
 * duplicate. Both channels are open at this level because the item said
 * nothing about channels; the recipient's own toggles still gate them in
 * `enabledDeliveryChannels`.
 *
 * Two consequences worth naming, both inherited rather than introduced and
 * both handled by the caller's existing catch-up window:
 *  - An item created closer to its date than the first warning has already
 *    missed that warning; the moment is in the past, so only the final warning
 *    lands. The worker never back-fires a warning more than 24 hours stale.
 *  - A warning longer than the item's orbital period lands before the previous
 *    occurrence's date. Only the currently open `due_event` is ever considered,
 *    so that warning is simply already past and is skipped, rather than firing
 *    against an occurrence the reader has already dealt with.
 */
export function effectiveReminderOffsets(
  itemRules: readonly ReminderOffset[],
  recipient: RecipientWarningDays,
): ReminderOffset[] {
  if (itemRules.length) return [...itemRules];
  const first = warningDaysOrDefault(recipient.firstWarningDays, DEFAULT_FIRST_WARNING_DAYS, 1);
  const final = warningDaysOrDefault(recipient.finalWarningDays, DEFAULT_FINAL_WARNING_DAYS, 0);
  return [...new Set([first, final])]
    .sort((left, right) => right - left)
    .map((daysBefore) => ({ daysBefore, emailEnabled: true, pushEnabled: true }));
}

/**
 * The offsets for one materialization candidate row. The left join against
 * `reminder_rules` yields one row per rule for an item that has any, and a
 * single row with a null offset for an item that has none — which is exactly
 * the "no explicit rules" case the recipient's pair answers.
 */
function candidateReminderOffsets(candidate: {
  daysBefore: number | null;
  emailEnabled: boolean | null;
  pushEnabled: boolean | null;
  firstWarningDays: number | null;
  finalWarningDays: number | null;
}): ReminderOffset[] {
  return effectiveReminderOffsets(
    candidate.daysBefore === null
      ? []
      : [{
        daysBefore: candidate.daysBefore,
        emailEnabled: candidate.emailEnabled ?? true,
        pushEnabled: candidate.pushEnabled ?? true,
      }],
    candidate,
  );
}

/** True for IPv4 addresses reserved for loopback, link-local, or private use. */
function isPrivateOrReservedIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  return false;
}

/** True for IPv6 addresses reserved for loopback, link-local, or unique-local use. */
function isPrivateOrReservedIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPrivateOrReservedIPv4(mapped[1]);
  return false;
}

/**
 * Web-push subscription endpoints are supplied by authenticated members
 * (`/api/push/subscriptions`, validated there only as a well-formed URL)
 * and are handed straight to `web-push`, which issues an outbound HTTPS
 * POST built from the endpoint's own host and port (#383 finding 2). This
 * mirrors the outbound-boundary discipline the Tika adapter applies before
 * every fetch (src/server/documents/tika.ts): never let externally
 * influenced input reach an outbound request unconstrained. Real push
 * services are always `https:` on the default port, so this rejects
 * exactly the shapes a legitimate subscription never has.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.port && url.port !== "443") return false;
  // The WHATWG URL parser keeps IPv6 hosts bracketed (`[::1]`); node:net's
  // isIP does not recognise the brackets, so they are stripped only for
  // the address-family checks below.
  const hostname = url.hostname.toLowerCase();
  const addressCandidate = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
  const ipVersion = isIP(addressCandidate);
  if (ipVersion === 4) return !isPrivateOrReservedIPv4(addressCandidate);
  if (ipVersion === 6) return !isPrivateOrReservedIPv6(addressCandidate);
  return true;
}

async function materializeDueDeliveries(db: NotificationDatabase, now: Date): Promise<void> {
  // #383 finding 1: without a date predicate this join is instance-wide and
  // time-unbounded, so every open due_event × reminder_rule × membership row
  // pays a per-row householdReminderTime() call (a fresh Intl.DateTimeFormat
  // construction, ~150µs) below even though almost all of them are nowhere
  // near firing. Push a generous calendar-date window into SQL first — the
  // exact instant is still resolved and checked precisely afterwards, this
  // predicate only bounds *which rows* pay that cost. The slop on both sides
  // covers the full catch-up window plus the +/-1 day a household timezone
  // can shift the UTC reminder instant off the naive calendar date.
  const windowFloor = new Date(now.getTime() - notificationCatchUpWindowMs - 24 * 60 * 60_000);
  const windowCeiling = new Date(now.getTime() + 24 * 60 * 60_000);
  const windowFloorDate = windowFloor.toISOString().slice(0, 10);
  const windowCeilingDate = windowCeiling.toISOString().slice(0, 10);

  const candidates = await db
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
      firstWarningDays: userPreferences.firstWarningDays,
      finalWarningDays: userPreferences.finalWarningDays,
      snoozedUntil: items.snoozedUntil,
    })
    .from(dueEvents)
    .innerJoin(items, eq(items.id, dueEvents.itemId))
    .innerJoin(households, eq(households.id, dueEvents.householdId))
    // #479: a left join, so an item that carries no reminder rule of its own
    // still yields one candidate row per member — with a null offset, which
    // `candidateReminderOffsets` answers from that member's stored pair.
    // Under the old inner join such an item produced no reminder at all.
    .leftJoin(reminderRules, eq(reminderRules.itemId, dueEvents.itemId))
    .innerJoin(memberships, eq(memberships.householdId, dueEvents.householdId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(userPreferences, eq(userPreferences.userId, memberships.userId))
    .where(and(
      isNull(dueEvents.completedAt),
      eq(items.status, "active"),
      isNull(users.disabledAt),
      isNull(households.deletionRequestedAt),
      // The same bounded-window predicate as before, now branching on which
      // offsets the row will actually use. An item with rules is still judged
      // rule by rule (a rule out of the window drops its own row and cannot
      // fall through to the pair, because the left join only nulls the offset
      // when the item has no rule at all); an item without them is judged
      // against the recipient's own two offsets, defaults included.
      sql`case when ${reminderRules.daysBefore} is not null
            then (${dueEvents.dueDate}::date - ${reminderRules.daysBefore}) between ${windowFloorDate}::date and ${windowCeilingDate}::date
            else (${dueEvents.dueDate}::date - coalesce(${userPreferences.firstWarningDays}, ${DEFAULT_FIRST_WARNING_DAYS})) between ${windowFloorDate}::date and ${windowCeilingDate}::date
              or (${dueEvents.dueDate}::date - coalesce(${userPreferences.finalWarningDays}, ${DEFAULT_FINAL_WARNING_DAYS})) between ${windowFloorDate}::date and ${windowCeilingDate}::date
          end`,
    ));

  const catchUpBoundary = new Date(now.getTime() - notificationCatchUpWindowMs);
  const deliveries = candidates.flatMap((candidate) => candidateReminderOffsets(candidate).flatMap((offset) => {
    const scheduledFor = householdReminderTime(candidate.dueDate, offset.daysBefore, candidate.timezone);
    if (scheduledFor > now || scheduledFor < catchUpBoundary) return [];
    if (reminderIsSnoozed(scheduledFor, candidate.snoozedUntil, candidate.timezone)) return [];
    const channels = enabledDeliveryChannels({ ...candidate, ...offset });
    return channels.map((channel) => ({
      householdId: candidate.householdId,
      eventId: candidate.eventId,
      userId: candidate.userId,
      channel,
      scheduledFor,
    }));
  }));

  if (deliveries.length) {
    await db.insert(notificationDeliveries).values(deliveries).onConflictDoNothing();
  }
}

interface ClaimedDelivery {
  id: string;
  leaseToken: string;
}

async function claimDeliveries(
  db: NotificationDatabase,
  now: Date,
  nextLeaseToken: () => string,
  leaseDurationMs: number,
  limit = 25,
): Promise<ClaimedDelivery[]> {
  const nowIso = now.toISOString();
  const leaseExpiredBeforeIso = new Date(now.getTime() - leaseDurationMs).toISOString();
  return db.transaction(async (transaction) => {
    const rows = await transaction.execute(sql<{ id: string }>`
      select id
      from notification_deliveries
      where (
          (status = 'pending' and scheduled_for <= ${nowIso})
          or (status = 'retry' and scheduled_for <= ${nowIso} and (locked_at is null or locked_at <= ${nowIso}))
          or (status = 'processing' and locked_at < ${leaseExpiredBeforeIso})
        )
      order by scheduled_for, id
      for update skip locked
      limit ${limit}
    `) as unknown as Array<{ id: string }>;
    const claimed: ClaimedDelivery[] = [];
    for (const row of rows) {
      const leaseToken = nextLeaseToken();
      const [updated] = await transaction.update(notificationDeliveries).set({
        status: "processing",
        lockedAt: now,
        leaseToken,
        attempts: sql`${notificationDeliveries.attempts} + 1`,
        updatedAt: now,
      }).where(eq(notificationDeliveries.id, row.id)).returning({
        id: notificationDeliveries.id,
        leaseToken: notificationDeliveries.leaseToken,
      });
      if (updated?.leaseToken) claimed.push({ id: updated.id, leaseToken: updated.leaseToken });
    }
    return claimed;
  });
}

function createDefaultNotificationProviders(config: NotificationWorkerConfig): NotificationProviders {
  let transporter: ReturnType<typeof nodemailer.createTransport> | undefined;
  if (config.vapidSubject && config.vapidPublicKey && config.vapidPrivateKey) {
    webPush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  }
  return {
    async sendEmail(notification) {
      if (!transporter) {
        // Bounded to the same 5s connect/greeting/socket timeouts as the
        // verification path (#383 finding 1): this send runs inside the
        // household lifecycle advisory lock (dispatchUnderHouseholdLifecycleLock),
        // so an unbounded transporter lets a blackholed SMTP provider hold
        // that lock — and therefore every ordinary workspace write for the
        // household — for nodemailer's default minutes instead of seconds.
        transporter = createSmtpTransport(config);
      }
      await transporter.sendMail({
        from: notification.from,
        to: notification.to,
        subject: notification.subject,
        text: notification.text,
      });
    },
    async sendPush(notification) {
      await webPush.sendNotification(notification.target, JSON.stringify(notification.payload));
    },
  };
}

async function dispatchUnderHouseholdLifecycleLock(
  db: NotificationDatabase,
  delivery: { id: string; householdId: string; channel: "email" | "web_push" },
  leaseToken: string,
  currentTime: () => Date,
  leaseDurationMs: number,
  dispatch: (transaction: NotificationTransaction) => Promise<void>,
  beforeProviderDispatch?: NotificationWorkerDependencies["beforeProviderDispatch"],
): Promise<boolean> {
  await beforeProviderDispatch?.(delivery);
  const dispatchNow = new Date(currentTime().getTime());
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${householdOwnerLockKey(delivery.householdId)}, 0))`,
    );
    const [current] = await transaction.select({
      id: notificationDeliveries.id,
      deletionRequestedAt: households.deletionRequestedAt,
    })
      .from(notificationDeliveries)
      .innerJoin(households, eq(households.id, notificationDeliveries.householdId))
      .where(and(
        eq(notificationDeliveries.id, delivery.id),
        eq(notificationDeliveries.householdId, delivery.householdId),
        eq(notificationDeliveries.status, "processing"),
        eq(notificationDeliveries.leaseToken, leaseToken),
        gte(notificationDeliveries.lockedAt, new Date(dispatchNow.getTime() - leaseDurationMs)),
      ))
      .for("update")
      .limit(1);
    if (!current) return false;
    if (current.deletionRequestedAt) {
      await transaction.update(notificationDeliveries).set({
        status: "cancelled",
        lockedAt: null,
        leaseToken: null,
        lastError: "household_pending_deletion",
        updatedAt: dispatchNow,
      }).where(and(
        eq(notificationDeliveries.id, delivery.id),
        eq(notificationDeliveries.status, "processing"),
        eq(notificationDeliveries.leaseToken, leaseToken),
      ));
      return false;
    }

    await transaction.update(notificationDeliveries).set({
      lockedAt: dispatchNow,
      updatedAt: dispatchNow,
    }).where(and(
      eq(notificationDeliveries.id, delivery.id),
      eq(notificationDeliveries.status, "processing"),
      eq(notificationDeliveries.leaseToken, leaseToken),
    ));
    await dispatch(transaction);
    const [sent] = await transaction.update(notificationDeliveries).set({
      status: "sent",
      sentAt: dispatchNow,
      lockedAt: null,
      leaseToken: null,
      lastError: null,
      updatedAt: dispatchNow,
    }).where(and(
      eq(notificationDeliveries.id, delivery.id),
      eq(notificationDeliveries.status, "processing"),
      eq(notificationDeliveries.leaseToken, leaseToken),
    )).returning({ id: notificationDeliveries.id });
    return Boolean(sent);
  });
}

async function cancelDelivery(
  db: NotificationDatabase,
  id: string,
  leaseToken: string,
  now: Date,
  lastError: NotificationFailureCategory | null,
): Promise<void> {
  await db.update(notificationDeliveries).set({
    status: "cancelled",
    lockedAt: null,
    leaseToken: null,
    lastError,
    updatedAt: now,
  }).where(and(
    eq(notificationDeliveries.id, id),
    eq(notificationDeliveries.status, "processing"),
    eq(notificationDeliveries.leaseToken, leaseToken),
  ));
}

async function deliverClaimed(
  db: NotificationDatabase,
  claimed: ClaimedDelivery[],
  config: NotificationWorkerConfig,
  now: Date,
  currentTime: () => Date,
  providers: NotificationProviders,
  leaseDurationMs: number,
  retryDelay: (attempts: number) => number,
  beforeProviderDispatch?: NotificationWorkerDependencies["beforeProviderDispatch"],
): Promise<void> {
  if (!claimed.length) return;
  const leaseTokens = new Map(claimed.map((delivery) => [delivery.id, delivery.leaseToken]));
  const deliveries = await db
    .select({
      id: notificationDeliveries.id,
      leaseToken: notificationDeliveries.leaseToken,
      channel: notificationDeliveries.channel,
      scheduledFor: notificationDeliveries.scheduledFor,
      attempts: notificationDeliveries.attempts,
      userId: notificationDeliveries.userId,
      householdId: notificationDeliveries.householdId,
      email: users.email,
      title: items.title,
      dueDate: dueEvents.dueDate,
      itemId: items.id,
      itemStatus: items.status,
      snoozedUntil: items.snoozedUntil,
      timezone: households.timezone,
      householdDeletionRequestedAt: households.deletionRequestedAt,
      completedAt: dueEvents.completedAt,
      userDisabledAt: users.disabledAt,
      // #383 finding 4: a delivery already queued (pending/retry/reclaimed
      // after a lease expiry) is not cancelled when the recipient is
      // removed from the household, so this is re-checked at send time
      // instead of trusting the membership that was true when the row was
      // materialized.
      isMember: sql<boolean>`${memberships.userId} is not null`,
      userEmailEnabled: sql<boolean>`coalesce(${userPreferences.emailNotifications}, true)`,
      userPushEnabled: sql<boolean>`coalesce(${userPreferences.pushNotifications}, true)`,
      // #479: re-read at send time for the same reason the membership is —
      // a queued delivery must still match a warning the recipient currently
      // asks for, so retiming the pair retires the reminders it no longer
      // justifies instead of sending them on the old schedule.
      firstWarningDays: userPreferences.firstWarningDays,
      finalWarningDays: userPreferences.finalWarningDays,
    })
    .from(notificationDeliveries)
    .innerJoin(users, eq(users.id, notificationDeliveries.userId))
    .innerJoin(dueEvents, eq(dueEvents.id, notificationDeliveries.eventId))
    .innerJoin(items, eq(items.id, dueEvents.itemId))
    .innerJoin(households, eq(households.id, notificationDeliveries.householdId))
    .leftJoin(userPreferences, eq(userPreferences.userId, notificationDeliveries.userId))
    .leftJoin(memberships, and(
      eq(memberships.householdId, notificationDeliveries.householdId),
      eq(memberships.userId, notificationDeliveries.userId),
    ))
    .where(and(
      inArray(notificationDeliveries.id, claimed.map((delivery) => delivery.id)),
      eq(notificationDeliveries.status, "processing"),
    ));

  const rules = await db.select({
    itemId: reminderRules.itemId,
    daysBefore: reminderRules.daysBefore,
    emailEnabled: reminderRules.emailEnabled,
    pushEnabled: reminderRules.pushEnabled,
  }).from(reminderRules).where(inArray(reminderRules.itemId, [...new Set(deliveries.map((delivery) => delivery.itemId))]));
  const rulesByItem = new Map<string, typeof rules>();
  for (const rule of rules) rulesByItem.set(rule.itemId, [...(rulesByItem.get(rule.itemId) ?? []), rule]);

  for (const delivery of deliveries) {
    const leaseToken = leaseTokens.get(delivery.id);
    if (!leaseToken || delivery.leaseToken !== leaseToken) continue;
    try {
      const staleBoundary = new Date(now.getTime() - notificationCatchUpWindowMs);
      const matchingRule = effectiveReminderOffsets(rulesByItem.get(delivery.itemId) ?? [], delivery).find((offset) => (
        householdReminderTime(delivery.dueDate, offset.daysBefore, delivery.timezone).getTime() === delivery.scheduledFor.getTime()
        && (delivery.channel === "email" ? offset.emailEnabled : offset.pushEnabled)
      ));
      const preferenceEnabled = delivery.channel === "email"
        ? delivery.userEmailEnabled
        : delivery.userPushEnabled;
      if (delivery.householdDeletionRequestedAt || delivery.userDisabledAt || delivery.completedAt || delivery.itemStatus !== "active" || delivery.scheduledFor < staleBoundary || reminderIsSnoozed(delivery.scheduledFor, delivery.snoozedUntil, delivery.timezone) || !matchingRule || !delivery.isMember) {
        await cancelDelivery(
          db,
          delivery.id,
          leaseToken,
          now,
          delivery.householdDeletionRequestedAt ? "household_pending_deletion" : (!delivery.isMember ? "membership_removed" : null),
        );
        continue;
      }
      if (!preferenceEnabled) {
        await cancelDelivery(db, delivery.id, leaseToken, now, "recipient_preferences_disabled");
        continue;
      }
      const title = delivery.title.trim().slice(0, 160);
      const body = `${title} is due on ${delivery.dueDate}.`.slice(0, 320);
      const subject = `${title} is coming up`.slice(0, 180);
      const text = `Reminder: ${body}\nOpen Orbit to review it.`.slice(0, 500);
      if (delivery.channel === "email") {
        if (!config.smtpUrl) {
          await failDelivery(db, delivery.id, leaseToken, delivery.attempts, config.maxAttempts, "smtp_unconfigured", now, retryDelay);
          continue;
        }
        if (!await dispatchUnderHouseholdLifecycleLock(
          db,
          {
            id: delivery.id,
            householdId: delivery.householdId,
            channel: delivery.channel,
          },
          leaseToken,
          currentTime,
          leaseDurationMs,
          async () => providers.sendEmail({
            from: config.smtpFrom,
            to: delivery.email,
            subject,
            text,
            tlsMode: config.smtpSecurity,
          }),
          beforeProviderDispatch,
        )) continue;
      } else {
        if (!config.vapidSubject || !config.vapidPublicKey || !config.vapidPrivateKey) {
          await failDelivery(db, delivery.id, leaseToken, delivery.attempts, config.maxAttempts, "push_unconfigured", now, retryDelay);
          continue;
        }
        const subscriptions = await db.select().from(pushSubscriptions).where(and(
          eq(pushSubscriptions.userId, delivery.userId),
          isNull(pushSubscriptions.revokedAt),
          or(isNull(pushSubscriptions.expiresAt), gte(pushSubscriptions.expiresAt, now)),
        ));
        if (!subscriptions.length) {
          await failDelivery(db, delivery.id, leaseToken, delivery.attempts, config.maxAttempts, "push_unsubscribed", now, retryDelay);
          continue;
        }
        // #383 finding 3: a send to one subscription cannot be undone once
        // it succeeds. Previously, any other subscription's transient
        // failure threw out of this closure, rolling back the whole
        // dispatch transaction and leaving the delivery in `retry` — so the
        // next attempt resent to every still-active subscription, including
        // the one that had already received it. The whole delivery is now
        // only retried (which necessarily means resending to everyone
        // still active) when nothing got through at all; once at least one
        // device has genuinely received the reminder, the delivery
        // completes and any subscription that failed transiently is simply
        // not retried for this reminder, rather than risking a duplicate
        // send to a device that already got it.
        let transientPushFailure: unknown = null;
        if (!await dispatchUnderHouseholdLifecycleLock(
          db,
          {
            id: delivery.id,
            householdId: delivery.householdId,
            channel: delivery.channel,
          },
          leaseToken,
          currentTime,
          leaseDurationMs,
          async (transaction) => {
            let delivered = false;
            for (const subscription of subscriptions) {
              if (!isAllowedPushEndpoint(subscription.endpoint)) {
                // #383 finding 2: never make the outbound request at all for
                // an endpoint that fails the boundary check; treat it like a
                // permanently dead subscription instead of attempting delivery.
                await transaction.update(pushSubscriptions).set({ revokedAt: now })
                  .where(and(eq(pushSubscriptions.id, subscription.id), isNull(pushSubscriptions.revokedAt)));
                continue;
              }
              try {
                await providers.sendPush({
                  target: {
                    endpoint: subscription.endpoint,
                    keys: { p256dh: subscription.p256dh, auth: subscription.auth },
                  },
                  payload: {
                    title: subject,
                    body,
                    url: "/",
                  },
                });
                delivered = true;
              } catch (error) {
                const statusCode = (error as { statusCode?: number }).statusCode;
                if (statusCode === 404 || statusCode === 410) {
                  await transaction.update(pushSubscriptions).set({ revokedAt: now })
                    .where(and(eq(pushSubscriptions.id, subscription.id), isNull(pushSubscriptions.revokedAt)));
                  continue;
                }
                transientPushFailure = error;
              }
            }
            if (!delivered && transientPushFailure) throw transientPushFailure;
          },
          beforeProviderDispatch,
        )) continue;
        if (transientPushFailure) {
          // The delivery already committed as "sent" above (at least one
          // subscription received it); this only records, for admin
          // diagnostics, that another subscription did not — never the
          // provider error itself (`failDelivery`'s bounded-vocabulary rule).
          await db.update(notificationDeliveries)
            .set({ lastError: categorizeProviderError("web_push", transientPushFailure) })
            .where(eq(notificationDeliveries.id, delivery.id));
        }
      }
    } catch (error) {
      await failDelivery(
        db,
        delivery.id,
        leaseToken,
        delivery.attempts,
        config.maxAttempts,
        categorizeProviderError(delivery.channel, error),
        now,
        retryDelay,
      );
      const exhausted = delivery.attempts + 1 >= config.maxAttempts;
      log.warn({
        event: delivery.channel === "email" ? "delivery.smtp" : "delivery.push",
        state: exhausted ? "exhausted" : "retrying",
        reason: operationalNotificationReason(categorizeProviderError(delivery.channel, error)),
        action: exhausted ? "inspect_admin_diagnostics" : "retry",
        impact: "notification_delivery_delayed",
      });
    }
  }
}

/** Persists only a bounded failure code, never an untrusted provider message. */
async function failDelivery(
  db: NotificationDatabase,
  id: string,
  leaseToken: string,
  attempts: number,
  maxAttempts: number,
  category: NotificationFailureCategory,
  now: Date,
  retryDelay: (attempts: number) => number,
): Promise<void> {
  const status = deliveryFailureState(category, attempts, maxAttempts);
  const retryAt = status === "retry" ? new Date(now.getTime() + retryDelay(attempts)) : null;
  await db.update(notificationDeliveries).set({
    status,
    lockedAt: retryAt,
    leaseToken: null,
    lastError: category,
    updatedAt: now,
  }).where(and(
    eq(notificationDeliveries.id, id),
    eq(notificationDeliveries.status, "processing"),
    eq(notificationDeliveries.leaseToken, leaseToken),
  ));
}

export async function runNotificationCycle(
  config = getNotificationWorkerConfig(),
  dependencies: NotificationWorkerDependencies = {},
): Promise<void> {
  const db = dependencies.db ?? getDb();
  const currentTime = dependencies.now ?? (() => new Date());
  const now = new Date(currentTime().getTime());
  const leaseDurationMs = dependencies.leaseDurationMs ?? notificationLeaseDurationMs;
  const retryDelay = dependencies.retryDelayMs ?? notificationRetryDelayMs;
  const nextLeaseToken = dependencies.nextLeaseToken ?? randomUUID;
  const providers = dependencies.providers ?? createDefaultNotificationProviders(config);
  await materializeDueDeliveries(db, now);
  const claimed = await claimDeliveries(db, now, nextLeaseToken, leaseDurationMs, dependencies.claimLimit ?? 25);
  await deliverClaimed(
    db,
    claimed,
    config,
    now,
    currentTime,
    providers,
    leaseDurationMs,
    retryDelay,
    dependencies.beforeProviderDispatch,
  );
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
      log.info({ event: "notification.worker", state: "ready", action: "none" });
    } catch {
      workerState.__orbitWorkerLastErrorAt = new Date().toISOString();
      workerState.__orbitWorkerLastErrorCategory = "unknown";
      log.error({
        event: "notification.worker",
        state: "retrying",
        reason: "worker_cycle_failed",
        action: "inspect_admin_diagnostics",
        impact: "worker_degraded",
      });
    } finally {
      workerState.__orbitWorkerRunning = false;
      setTimeout(poll, config.pollMilliseconds).unref();
    }
  };
  void poll();
}
