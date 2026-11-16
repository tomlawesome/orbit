import nodemailer from "nodemailer";
import { AppError } from "@/lib/app-error";
import {
  categorizeProviderError,
  createSmtpTransport,
  getNotificationWorkerSettings,
  type NotificationWorkerConfig,
  type SmtpNotification,
} from "@/server/notification-worker";
import { configFor, noteMailSent, resolveSendingAccount } from "@/server/mail-in/sending-settings";
import { renderInvitationMail, type InvitationMailContext } from "@/server/invitations/mail";

/**
 * Putting the invitation on the wire (#481).
 *
 * NOT the `notification_deliveries` queue. That table is keyed on a due event
 * and a member, and an invitee is neither: they have no membership, no
 * preferences to consult and, quite possibly, no account. So the send is
 * synchronous, bounded by the transporter's own 5s connect/greeting/socket
 * timeouts, and the retry is the owner pressing "resend" — a person who can
 * see the failure and decide, rather than a worker retrying into a mailbox
 * nobody has confirmed exists.
 *
 * What survives the attempt is a bounded class, never the provider's own
 * message: those carry addresses, hosts and credentials.
 */

export const invitationSendErrors = ["smtp_unconfigured", "smtp_unavailable", "smtp_rejected", "unknown"] as const;
export type InvitationSendError = typeof invitationSendErrors[number];

/** Exactly what this module needs of a mail provider, so a test can supply it. */
export interface InvitationMailer {
  sendEmail(notification: SmtpNotification): Promise<void>;
}

/**
 * One absolute link under this instance's own public base URL, from a route
 * segment and a token -- the one shape an invitation, a setup/recovery and a
 * sign-in approval link all share (#1151 A1-Q4), differing only in which
 * route they point at and the words their own error carries. `setupLink`
 * (`local-credentials/setup-mail.ts`) and `approvalLink`
 * (`sign-in-approvals.ts`) both import this rather than keeping their own
 * copy of it.
 */
export function absoluteAppLink(
  routeSegment: string,
  token: string,
  errorMessage: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.APP_URL;
  if (!configured) throw new AppError("unsafe_input", errorMessage, 503);
  try {
    const url = new URL(configured);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)) throw new Error("unsafe application origin");
    return new URL(`/${routeSegment}/${encodeURIComponent(token)}`, url.origin).href;
  } catch {
    throw new AppError("unsafe_input", errorMessage, 503);
  }
}

/** One absolute link, from the instance's public base URL and nothing else. */
export function invitationLink(token: string, environment: NodeJS.ProcessEnv = process.env): string {
  return absoluteAppLink("invite", token, "The invitation link cannot be built", environment);
}

/**
 * The default provider: one transporter, used once, closed straight after.
 *
 * A long-lived transporter would be cheaper, but this send happens inside a
 * person's request rather than in a worker loop, and a pooled connection held
 * open across requests is a socket nobody owns.
 *
 * The account is the sending row's (#1629), never the `SMTP_*` lines: no row
 * is `smtp_unconfigured`, a password the key cannot open `smtp_unavailable`.
 */
async function defaultMailer(): Promise<
  | { state: "ready"; mailer: InvitationMailer; from: string; security: NotificationWorkerConfig["smtpSecurity"] }
  | { state: "unconfigured" | "locked" }
> {
  const account = await resolveSendingAccount();
  if (account.state !== "ready") return account;
  const config = configFor(account, account.from);
  return {
    state: "ready",
    from: account.from,
    security: account.security,
    mailer: {
      async sendEmail(notification) {
        let transporter: ReturnType<typeof nodemailer.createTransport> | undefined;
        try {
          transporter = createSmtpTransport(config);
          await transporter.sendMail({
            from: notification.from,
            to: notification.to,
            subject: notification.subject,
            text: notification.text,
            ...(notification.html ? { html: notification.html } : {}),
          });
        } finally {
          transporter?.close();
        }
      },
    },
  };
}

/**
 * Whether a send through `sendBoundedMail` with this `mailer` could go out at
 * all: a supplied mailer counts as ready, `null` as not, and `undefined` asks
 * whether sending is set up and its password readable. For a caller that must
 * refuse before changing anything rather than discover the answer one failed
 * send at a time (#1676).
 */
export async function outgoingMailReady(mailer?: InvitationMailer | null): Promise<boolean> {
  if (mailer !== undefined) return mailer !== null;
  try {
    return (await defaultMailer()).state === "ready";
  } catch {
    return false;
  }
}

/** The From header and TLS mode a supplied mailer is handed: the row's, or the default sender when there is none. */
async function senderForSuppliedMailer(): Promise<{ from: string; security: NotificationWorkerConfig["smtpSecurity"] }> {
  try {
    const account = await resolveSendingAccount();
    if (account.state === "ready") return { from: account.from, security: account.security };
  } catch { /* fall through to the default sender */ }
  return { from: getNotificationWorkerSettings().smtpFrom, security: "starttls" };
}

export interface InvitationSendOutcome {
  sentAt: Date | null;
  sendError: InvitationSendError | null;
}

/**
 * Puts one already-written message on the wire, now, and reports which of
 * "sent" and "not sent, and why in one bounded word" happened.
 *
 * The person-facing sends share this rather than each opening their own
 * transporter: the invitation (#481) and the account setup link (#911,
 * ADR-0023 §3, which names this module as the mailer it goes through). Both
 * are somebody waiting on a link, so both are synchronous and both answer a
 * failure to the person who asked for the send.
 */
export async function sendBoundedMail(
  to: string,
  mail: { subject: string; text: string; html?: string; what?: string },
  mailer?: InvitationMailer | null,
  now: Date = new Date(),
): Promise<InvitationSendOutcome> {
  let provider: InvitationMailer | null;
  let from: string;
  let security: NotificationWorkerConfig["smtpSecurity"];
  const viaRow = mailer === undefined;
  try {
    if (viaRow) {
      const resolved = await defaultMailer();
      if (resolved.state === "locked") return { sentAt: null, sendError: "smtp_unavailable" };
      if (resolved.state !== "ready") return { sentAt: null, sendError: "smtp_unconfigured" };
      ({ mailer: provider, from, security } = resolved);
    } else {
      provider = mailer;
      ({ from, security } = await senderForSuppliedMailer());
    }
  } catch {
    /* A sending row this instance cannot even read is the same fact to an
       owner as no sending set up at all. */
    return { sentAt: null, sendError: "smtp_unconfigured" };
  }
  if (!provider) return { sentAt: null, sendError: "smtp_unconfigured" };

  try {
    await provider.sendEmail({
      from,
      to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
      tlsMode: security,
    });
    if (viaRow) await noteMailSent(mail.what ?? "a message", now);
    return { sentAt: now, sendError: null };
  } catch (error) {
    const category = categorizeProviderError("email", error);
    const sendError: InvitationSendError = category === "smtp_rejected"
      ? "smtp_rejected"
      : category === "smtp_unavailable"
        ? "smtp_unavailable"
        : "unknown";
    return { sentAt: null, sendError };
  }
}

/**
 * Renders and sends one invitation, and reports which of the two happened.
 *
 * Never throws for a provider failure: an owner who has just typed an address
 * gets a row they can resend from, not a 500 that loses the invitation they
 * created a moment ago.
 */
export async function sendInvitationMail(
  context: InvitationMailContext,
  mailer?: InvitationMailer | null,
  now: Date = new Date(),
): Promise<InvitationSendOutcome> {
  return sendBoundedMail(context.email, { ...renderInvitationMail(context), what: "an invitation" }, mailer, now);
}
