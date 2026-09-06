/**
 * The one reply mail-in ever sends outward, and the conditions that stop it
 * being turned against anybody (ADR-0017 decision 3, slice 4, orbit#745).
 *
 * A message that matches no verified member is deleted, and the sender is told
 * once. That reply is mail-in's first outbound action, so every condition
 * below exists to make sure it cannot be aimed:
 *
 * - ONLY AN AUTHENTICATED SENDER IS ANSWERED. A forged `From` naming a
 *   stranger would otherwise make Orbit email that stranger — the backscatter
 *   path. If the provider did not vouch for the address, nobody is written to.
 * - AUTOMATED MAIL IS NEVER ANSWERED. Replying to a mailing list, an
 *   autoresponder or a bounce is how a household mailbox joins a loop or
 *   lands on a blocklist.
 * - AT MOST ONE REPLY PER SENDER PER DAY, counted against a digest of the
 *   address rather than the address itself: an unattributed sender is not a
 *   member and Orbit keeps nothing readable about them.
 * - THE ORIGINAL IS NEVER QUOTED. Quoting would put the sender's own content
 *   back on the wire and would make the reply a reflector for anything they
 *   wrote.
 *
 * Where any condition fails, the message is still deleted and still counted.
 * Suppressing the reply is not the same as keeping the mail.
 */
import { createHash } from "node:crypto";
import { lte } from "drizzle-orm";
import { getDb } from "@/db";
import { mailInUnattributedReplies } from "@/db/schema";
import {
  createSmtpTransport,
  getNotificationWorkerConfig,
  type NotificationWorkerConfig,
} from "@/server/notification-worker";
import { isAutomatedMail, senderIsAuthenticated, type ParsedHeader } from "./core/sender-authentication";

/** One reply per sender address per day. */
export const UNATTRIBUTED_REPLY_INTERVAL_MS = 86_400_000;

export type ReplySuppression =
  | "sender_unreadable"
  | "sender_unauthenticated"
  | "automated_mail"
  | "already_replied_today"
  | "smtp_not_configured";

export interface UnattributedReplyDependencies {
  sendMail?: (message: { from: string; to: string; subject: string; text: string }) => Promise<void>;
  smtpConfig?: () => NotificationWorkerConfig;
  now?: () => Date;
}

function digestAddress(address: string): string {
  return createHash("sha256").update(address, "utf8").digest("hex");
}

/**
 * The reply's whole body.
 *
 * It names redirect as the likely cause, because that is what the supported
 * path rules out: a redirect keeps the original sender's address, so the
 * provider's check fails against it and the message matches nobody. It quotes
 * nothing, carries no subject from the original, and says only what the reader
 * can act on.
 */
export function unattributedReplyText(): string {
  return [
    "Orbit could not match this message to anyone, so it has been deleted and nothing was kept.",
    "",
    "The usual cause is a redirect rather than a forward. A redirect keeps the original sender's",
    "address, so it looks to Orbit as though somebody else sent it. Forward the message instead,",
    "from your own mail program, and it will arrive from you.",
    "",
    "The other cause is an address Orbit has not checked yet. Sign in to Orbit, open your relay",
    "settings, and check the address you send from.",
  ].join("\n");
}

/**
 * Sends the reply if every condition allows it, and says why when it does not.
 *
 * The caller deletes the message either way. The return value exists so the
 * caller can record what happened without having to know the rules.
 */
export async function replyToUnattributedSender(
  headers: ParsedHeader[] | undefined,
  senderAddress: string | undefined,
  trustedAuthservId: string,
  dependencies: UnattributedReplyDependencies = {},
): Promise<{ sent: true } | { sent: false; suppressed: ReplySuppression }> {
  const now = dependencies.now?.() ?? new Date();
  if (!headers || !senderAddress) return { sent: false, suppressed: "sender_unreadable" };
  const domain = senderAddress.slice(senderAddress.lastIndexOf("@") + 1);
  if (!senderIsAuthenticated(headers, domain, trustedAuthservId)) {
    return { sent: false, suppressed: "sender_unauthenticated" };
  }
  if (isAutomatedMail(headers)) return { sent: false, suppressed: "automated_mail" };

  let smtp: NotificationWorkerConfig;
  try {
    smtp = (dependencies.smtpConfig ?? getNotificationWorkerConfig)();
  } catch {
    return { sent: false, suppressed: "smtp_not_configured" };
  }
  if (!smtp.smtpUrl || !smtp.smtpFrom) return { sent: false, suppressed: "smtp_not_configured" };

  /* The claim is taken BEFORE the send, in one statement the database
     arbitrates: two poll cycles racing on the same sender must produce one
     reply, not two, and a send that then fails must not free the slot for an
     immediate retry — a stranger's mailbox is not the place to retry into. */
  const digest = digestAddress(senderAddress);
  const cutoff = new Date(now.getTime() - UNATTRIBUTED_REPLY_INTERVAL_MS);
  const claimed = await getDb().insert(mailInUnattributedReplies)
    .values({ addressSha256: digest, lastRepliedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: mailInUnattributedReplies.addressSha256,
      set: { lastRepliedAt: now, updatedAt: now },
      setWhere: lte(mailInUnattributedReplies.lastRepliedAt, cutoff),
    })
    .returning({ addressSha256: mailInUnattributedReplies.addressSha256 });
  if (claimed.length === 0) return { sent: false, suppressed: "already_replied_today" };

  const send = dependencies.sendMail ?? defaultSender(smtp);
  await send({
    from: smtp.smtpFrom,
    to: senderAddress,
    subject: "Orbit could not match your message",
    text: unattributedReplyText(),
  });
  return { sent: true };
}

function defaultSender(smtp: NotificationWorkerConfig) {
  return async (message: { from: string; to: string; subject: string; text: string }) => {
    const transporter = createSmtpTransport(smtp);
    try {
      await transporter.sendMail(message);
    } finally {
      transporter.close();
    }
  };
}
