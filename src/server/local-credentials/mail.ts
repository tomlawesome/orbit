/**
 * THE SETUP AND RECOVERY MAIL, AND NOTHING ELSE (#911, ADR-0023 §3).
 *
 * The link an administrator issues is emailed to the address the account is
 * registered with and is never shown to the administrator (owner ruling,
 * 2026-09-09), so this mail is the only place the link exists. Every word of
 * it lives in this file, the way `src/server/invitations/mail.ts` owns the
 * invitation's words, and for the same reason: the wording is one file's
 * diff, pinned by a unit test rather than discovered in a mailbox.
 *
 * Plain text only. The invitation is the one message drawn like the product —
 * it is a stranger's first sight of Orbit — while this one goes to somebody
 * an administrator has just told about their new account, and its job is a
 * link and a deadline. Giving it an HTML part is a design round nobody has
 * held; until then a text part written to stand alone is the honest message,
 * not a fallback.
 *
 * Nothing here reaches a database, a clock or the environment: it is a pure
 * function of what it is handed.
 */

import { formatInvitationDate } from "@/server/invitations/mail";
import type { CredentialSetupTokenPurpose } from "@/server/local-credentials";

export interface SetupMailContext {
  /** The recipient's chosen display name; only its first word is used. */
  displayName: string;
  /** The registered address, as it appears in the mail's own "sent to" line. */
  email: string;
  /** One absolute link, built from the instance's public base URL. */
  link: string;
  expiresAt: Date;
  /** `setup` is a first password; `recovery` is a forgotten one. */
  purpose: CredentialSetupTokenPurpose;
}

export interface SetupMail {
  subject: string;
  text: string;
}

/** Two digits, so a time reads 09:05 rather than 9:5. */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * When the link lapses, in UTC.
 *
 * A setup link lives whole days, so a date says everything a reader needs. A
 * recovery link lives five minutes, where a bare date would read as "good
 * until today" and mislead, so that one carries the time as well.
 */
export function formatSetupExpiry(when: Date, purpose: CredentialSetupTokenPurpose): string {
  const date = formatInvitationDate(when);
  if (purpose !== "recovery") return date;
  return `${date} at ${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())} UTC`;
}

/** The first word of a chosen display name — "Hello Priya,". */
function firstName(name: string): string {
  return name.trim().split(/\s+/u)[0] || name.trim();
}

/** The instance's own host, read off the one link rather than passed twice. */
function hostOf(link: string): string {
  try {
    return new URL(link).host;
  } catch {
    return "";
  }
}

/**
 * The whole mail, from the five things it is allowed to know.
 *
 * It names no administrator and no other account: an administrator's own
 * name is not this reader's business, and the address this went to is the
 * only address it mentions. The typography is deliberately plain ASCII —
 * hyphens, straight quotes, hard wraps at a readable width — because that is
 * what survives every client.
 */
export function renderSetupMail(context: SetupMailContext): SetupMail {
  const given = firstName(context.displayName);
  const host = hostOf(context.link);
  const expires = formatSetupExpiry(context.expiresAt, context.purpose);
  const recovery = context.purpose === "recovery";

  const subject = recovery ? "Reset your Orbit password" : "Set your Orbit password";

  const text = [
    `Hello ${given},`,
    "",
    ...(recovery
      ? [
        "An administrator has sent you a new link for your Orbit account at",
        `${host}. Choose a new password and you are back in:`,
      ]
      : [
        `An administrator has created an Orbit account for you at ${host}.`,
        "Choose a password and you are in:",
      ]),
    "",
    `  ${context.link}`,
    "",
    `Sent to ${context.email}. Good until ${expires}.`,
    "The link works once. If it lapses, ask your administrator for another.",
    "Not expecting this? There is nothing to do - the link simply lapses.",
    "",
    `Orbit at ${host}, run by a household, not a company.`,
    "",
  ].join("\n");

  return { subject, text };
}
