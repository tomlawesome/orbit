import nodemailer from "nodemailer";
import { AppError } from "@/lib/app-error";
import {
  categorizeProviderError,
  createSmtpTransport,
  getNotificationWorkerConfig,
  type SmtpNotification,
} from "@/server/notification-worker";
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

/** One absolute link, from the instance's public base URL and nothing else. */
export function invitationLink(token: string, environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.APP_URL;
  if (!configured) throw new AppError("unsafe_input", "The invitation link cannot be built", 503);
  try {
    const url = new URL(configured);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)) throw new Error("unsafe application origin");
    return new URL(`/invite/${encodeURIComponent(token)}`, url.origin).href;
  } catch {
    throw new AppError("unsafe_input", "The invitation link cannot be built", 503);
  }
}

/**
 * The default provider: one transporter, used once, closed straight after.
 *
 * A long-lived transporter would be cheaper, but this send happens inside a
 * person's request rather than in a worker loop, and a pooled connection held
 * open across requests is a socket nobody owns.
 */
function defaultMailer(): InvitationMailer | null {
  const config = getNotificationWorkerConfig();
  if (!config.smtpUrl) return null;
  return {
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
  };
}

export interface InvitationSendOutcome {
  sentAt: Date | null;
  sendError: InvitationSendError | null;
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
  let provider: InvitationMailer | null;
  let from: string;
  try {
    provider = mailer === undefined ? defaultMailer() : mailer;
    from = getNotificationWorkerConfig().smtpFrom;
  } catch {
    /* An SMTP configuration this instance cannot even parse is the same fact
       to an owner as no SMTP configuration at all. */
    return { sentAt: null, sendError: "smtp_unconfigured" };
  }
  if (!provider) return { sentAt: null, sendError: "smtp_unconfigured" };

  const mail = renderInvitationMail(context);
  try {
    await provider.sendEmail({
      from,
      to: context.email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      tlsMode: getNotificationWorkerConfig().smtpSecurity,
    });
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
