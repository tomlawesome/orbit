/**
 * THE SIGN-IN APPROVAL MAIL, AND NOTHING ELSE (#1033, ADR-0027 §5).
 *
 * Every password sign-in sends one of these, and the link inside it is the
 * only thing that lets the waiting browser through. So this mail is where the
 * second factor actually lives, and every word of it is in this one file --
 * the way `src/server/local-credentials/mail.ts` owns the setup link's words,
 * and for the same reason: the wording is one file's diff, pinned by a unit
 * test rather than discovered in a mailbox.
 *
 * WHAT COMES FIRST, AND WHY. ADR-0027 §5 puts the bullets before the link:
 * the instance, the browser, the address and the time. A reader who was not
 * expecting this has to be able to decide without pressing anything, and a
 * link at the top of a message is pressed before the message is read. The
 * closing line is the other half of the same promise -- ignoring the mail is
 * a complete answer, because nobody gets in without an approval.
 *
 * Plain text only, plain ASCII, hard wrapped: the same choice the setup mail
 * makes, for the same reason. Nothing here reaches a database, a clock or the
 * environment -- it is a pure function of what it is handed.
 */

import { formatInvitationDate } from "@/server/invitations/mail";

export interface ApprovalMailContext {
  /** The recipient's chosen display name; only its first word is used. */
  displayName: string;
  /** One absolute link to the approval page, built from the instance's public base URL. */
  link: string;
  /** The browser that typed the password, already reduced to a coarse pair. */
  device: string;
  /** Where the request came from, as a phrase: "your home network", "192.0.2.10". */
  where: string;
  /** When the password was typed. */
  requestedAt: Date;
  /** When the approval link lapses. */
  expiresAt: Date;
}

export interface ApprovalMail {
  subject: string;
  text: string;
}

/** Two digits, so a time reads 09:05 rather than 9:5. */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * A moment, in UTC, to the minute: "18 Sep 2026 at 09:05 UTC".
 *
 * A ten-minute link makes a bare date meaningless, so unlike a setup link's
 * whole days this always carries the clock, and always says which clock.
 */
export function formatApprovalMoment(when: Date): string {
  return `${formatInvitationDate(when)} at ${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())} UTC`;
}

/** The first word of a chosen display name -- "Hello Priya,". */
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
 * The whole mail, from the six things it is allowed to know.
 *
 * It names no password, no address of the account's own and no other account:
 * everything in it is a fact about the REQUEST, which is the only thing the
 * reader is being asked to judge.
 */
export function renderApprovalMail(context: ApprovalMailContext): ApprovalMail {
  const given = firstName(context.displayName);
  const host = hostOf(context.link);

  const text = [
    `Hello ${given},`,
    "",
    "Your Orbit password has just been used to sign in. Nobody gets in",
    "until you approve it:",
    "",
    `  - Orbit at ${host}`,
    `  - ${context.device}`,
    `  - From ${context.where}`,
    `  - ${formatApprovalMoment(context.requestedAt)}`,
    "",
    "Approve it, or say it wasn't you:",
    "",
    `  ${context.link}`,
    "",
    `The link works once and lapses at ${formatApprovalMoment(context.expiresAt)}.`,
    "Opening it approves nothing by itself - you choose on the page.",
    "If this wasn't you, ignore it - nobody gets in without approval.",
    "",
    `Orbit at ${host}, run by a household, not a company.`,
    "",
  ].join("\n");

  return { subject: "Approve your Orbit sign-in", text };
}
