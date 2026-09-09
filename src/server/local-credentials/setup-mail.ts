/**
 * MAILING A SETUP LINK (#911, ADR-0023 §3).
 *
 * The owner ruled on 2026-09-09 that an administrator who creates a local
 * user never sees that user's setup link: Orbit emails it to the address the
 * account is registered with, for as long as the administrator chose (1 to 14
 * days, default 7), single use. So the link exists in exactly two places —
 * the mail, and the recipient's browser — and this module is the only thing
 * that puts it in the first of them.
 *
 * Two consequences run through everything below.
 *
 *  - **The user survives a failed send.** Creating the account and sending
 *    the mail are separate acts, in that order, and a mail failure is
 *    reported rather than thrown. An administrator whose SMTP host is down
 *    gets an account they can send to again, not a 500 that loses the person
 *    they just typed in.
 *  - **A failure is one bounded word.** `smtp_unconfigured`,
 *    `smtp_unavailable`, `smtp_rejected` or `unknown`, exactly as the
 *    invitation mailer answers (`src/server/invitations/send.ts`, which this
 *    sends through). The provider's own message never reaches a response: it
 *    carries addresses, hosts and credentials.
 *
 * An instance with no outgoing mail configured therefore cannot add local
 * users. That is the limit ADR-0023 §3 accepts by name, and it is the same
 * limit invitations already carry.
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, localCredentials, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import {
  sendBoundedMail,
  type InvitationMailer,
  type InvitationSendError,
} from "@/server/invitations/send";
import {
  assertSetupTokenLifetime,
  createLocalUser,
  issueSetupToken,
  type CredentialSetupTokenPurpose,
  type LocalUser,
} from "@/server/local-credentials";
import { renderSetupMail } from "@/server/local-credentials/mail";

/** The mail provider seam, so a test can hand this module a fake one. */
export type SetupMailer = InvitationMailer;

/** The only words a send failure is allowed to answer in. */
export type SetupSendError = InvitationSendError;

/**
 * One absolute link, from the instance's public base URL and nothing else —
 * built exactly the way `invitationLink` builds an invitation's.
 */
export function setupLink(token: string, environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.APP_URL;
  if (!configured) throw new AppError("unsafe_input", "The setup link cannot be built", 503);
  try {
    const url = new URL(configured);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)) throw new Error("unsafe application origin");
    return new URL(`/setup/${encodeURIComponent(token)}`, url.origin).href;
  } catch {
    throw new AppError("unsafe_input", "The setup link cannot be built", 503);
  }
}

/** What an administrator is told about a send. Never the link, never the token. */
export interface SetupLinkDelivery {
  /** The registered address the link went to, so the administrator can see where. */
  sentTo: string;
  /** When the link lapses, whether or not the mail got out. */
  expiresAt: Date;
  /** Null when the mail was sent; otherwise the one bounded word for why not. */
  sendError: SetupSendError | null;
}

export interface SendSetupLinkOptions {
  /** Whole days a `setup` link lives, 1 to 14 (default 7). Recovery ignores it. */
  expiresInDays?: number;
  /** Supplied by tests; unset means the instance's configured SMTP transport. */
  mailer?: SetupMailer | null;
  now?: Date;
}

/** The one user this module is allowed to know anything about. */
interface Recipient {
  id: string;
  email: string;
  displayName: string;
}

/**
 * Mints a link for `recipient` and mails it, and records `setup_link_sent`
 * when — and only when — the mail actually went.
 *
 * The audit record is the instance's only durable answer to "did that link
 * reach them", because the token table deliberately stores nothing about
 * delivery. It names the user and the purpose and nothing else: no address,
 * and never the link.
 */
async function issueAndSend(
  recipient: Recipient,
  purpose: CredentialSetupTokenPurpose,
  actorUserId: string,
  options: SendSetupLinkOptions,
): Promise<SetupLinkDelivery> {
  const { token, expiresAt } = await issueSetupToken(recipient.id, purpose, {
    createdByUserId: actorUserId,
    expiresInDays: options.expiresInDays,
  });

  const outcome = await sendBoundedMail(
    recipient.email,
    renderSetupMail({
      displayName: recipient.displayName,
      email: recipient.email,
      link: setupLink(token),
      expiresAt,
      purpose,
    }),
    options.mailer,
    options.now ?? new Date(),
  );

  if (!outcome.sendError) {
    await getDb().insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "user",
      entityId: recipient.id,
      action: "setup_link_sent",
      changes: { userId: recipient.id, purpose },
    });
  }

  return { sentTo: recipient.email, expiresAt, sendError: outcome.sendError };
}

export interface CreatedLocalUser extends SetupLinkDelivery {
  user: LocalUser;
}

/**
 * The administration screen's "add a local user": the account, the link, the
 * mail (ADR-0023 §3).
 *
 * The caller has already proved it is an administrator and re-challenged
 * them (`requireRecentAuthentication`); this is everything that happens
 * after that. The account is created first and committed, so the failure
 * modes are "no account and nothing sent" or "an account with a link that
 * can be sent again" — never an account nobody can be told about with no way
 * to try once more.
 */
export async function createLocalUserAndSendSetupLink(
  actorUserId: string,
  draft: { email: string; displayName: string },
  options: SendSetupLinkOptions = {},
): Promise<CreatedLocalUser> {
  /* Before the account, not after it: a lifetime the administrator mistyped
     must refuse the request rather than leave a user behind with no link. */
  assertSetupTokenLifetime(options.expiresInDays);
  const user = await createLocalUser(draft, { createdByUserId: actorUserId });
  const delivery = await issueAndSend(user, "setup", actorUserId, options);
  return { user, ...delivery };
}

/**
 * Sends a fresh link to an existing user, from their row on the
 * administration screen (ADR-0023 §3).
 *
 * The purpose follows the account rather than the button: a user who has no
 * password yet has never set one, so this is still their `setup` link and it
 * lives as long as the administrator chose; a user who has one has forgotten
 * it, so this is `recovery` and ADR-0022 §5's ratified five minutes applies —
 * an administrator doing that is doing it with the person in front of them.
 * Either way the earlier link dies as this one is issued.
 */
export async function sendSetupLink(
  actorUserId: string,
  userId: string,
  options: SendSetupLinkOptions = {},
): Promise<SetupLinkDelivery> {
  const db = getDb();
  const [recipient] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      credential: localCredentials.userId,
    })
    .from(users)
    .leftJoin(localCredentials, eq(localCredentials.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!recipient) {
    throw new AppError("user_not_found", "That registered Orbit user is no longer available", 404);
  }

  return issueAndSend(recipient, recipient.credential ? "recovery" : "setup", actorUserId, options);
}
