/**
 * THE INVITATION MAIL, AND NOTHING ELSE (#481).
 *
 * Every word of the template lives in this file. That is the point of the
 * module: the look of the mail is not settled — the owner is choosing between
 * three directions on #481 — so the HTML part below is a PLACEHOLDER, and
 * replacing it once the mockup is approved has to be one file's diff, with no
 * sentence to chase through routes, screens or tests.
 *
 * The plain-text part is the real one. It is
 * `design/v19/mail/round-1/text.txt` verbatim, with the story's names replaced
 * by parameters, and it is what a mail client with images or HTML off reads.
 * Its typography is deliberately plain ASCII — hyphens, straight quotes, hard
 * wraps at a readable width — because that is what survives every client.
 *
 * Nothing here reaches a database, a clock or the environment: it is a pure
 * function of what it is handed, so the wording is pinned by a unit test
 * rather than discovered in a mailbox.
 */

export interface InvitationMailContext {
  /** The inviting owner's chosen display name. Never their address. */
  inviterName: string;
  householdName: string;
  /** The invited address, as it appears in the mail's own "sent to" line. */
  email: string;
  /** One absolute link, built from the instance's public base URL. */
  link: string;
  /** When the link lapses. Rendered as a date, in UTC, with no time. */
  expiresAt: Date;
}

export interface InvitationMail {
  subject: string;
  text: string;
  html: string;
}

/* Written out rather than taken from Intl: a mail's date must not change
   spelling because the host's ICU data moved ("Sep" became "Sept" in CLDR 42),
   and the template's own line reads "20 Sep 2026". */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "20 Sep 2026", in UTC, so two readers in two time zones read one date. */
export function formatInvitationDate(when: Date): string {
  return `${when.getUTCDate()} ${MONTHS[when.getUTCMonth()]} ${when.getUTCFullYear()}`;
}

/** The first word of a chosen display name — "Sam would like you in theirs". */
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

/** Text is inserted into HTML attributes and content; escape it once, here. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/**
 * The whole mail, in both parts, from the five things it is allowed to know.
 *
 * There are no item names, no other members and no household detail beyond its
 * name (#481, "Nothing else"): this is the first thing a person sees of Orbit,
 * and it is also a message to an address nobody has proved anyone reads.
 */
export function renderInvitationMail(context: InvitationMailContext): InvitationMail {
  const inviter = context.inviterName.trim();
  const given = firstName(inviter);
  const household = context.householdName.trim();
  const host = hostOf(context.link);
  const expires = formatInvitationDate(context.expiresAt);

  const subject = `${inviter} invited you to ${household} on Orbit`;

  const text = [
    `${inviter} has a place for you in ${household} on Orbit.`,
    "",
    "Orbit keeps a household's year in one calm view - the boiler service,",
    `the insurance renewal, the MOT - and ${given} would like you in theirs.`,
    "",
    "Open your invitation and sign in with this address; you'll land",
    "straight in the house:",
    "",
    `  ${context.link}`,
    "",
    `Sent to ${context.email}. Good until ${expires}.`,
    "Not expecting this? There is nothing to do - the link simply lapses.",
    "",
    `Orbit at ${host}, run by ${given}'s household, not a company.`,
    "",
  ].join("\n");

  /*
   * PLACEHOLDER — replaced whole once the #481 mail mockup is approved.
   *
   * The same words as the text part in the plainest markup that renders
   * everywhere: one table, inline styles only, no remote images, no web fonts,
   * no gradients, and colours that read in both a light and a dark client. The
   * approved direction (the sun, the letter or the chart) lands here and
   * nowhere else.
   */
  const safe = {
    inviter: escapeHtml(inviter),
    given: escapeHtml(given),
    household: escapeHtml(household),
    email: escapeHtml(context.email),
    link: escapeHtml(context.link),
    host: escapeHtml(host),
    expires: escapeHtml(expires),
  };
  const html = [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(subject)}</title></head>`,
    '<body style="margin:0;padding:24px;background:#0b0e16;color:#d7dbe6;'
      + 'font-family:Georgia,\'Times New Roman\',serif;font-size:16px;line-height:1.55;">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"'
      + ' style="max-width:520px;margin:0 auto;"><tr><td>',
    `<p style="margin:0 0 18px;font-size:19px;color:#f2f4f8;">${safe.inviter} has a place for you in `
      + `${safe.household} on Orbit.</p>`,
    '<p style="margin:0 0 18px;">Orbit keeps a household&#39;s year in one calm view &mdash; the boiler '
      + `service, the insurance renewal, the MOT &mdash; and ${safe.given} would like you in theirs.</p>`,
    '<p style="margin:0 0 18px;">Open your invitation and sign in with this address; you&#39;ll land '
      + "straight in the house:</p>",
    `<p style="margin:0 0 22px;"><a href="${safe.link}" style="display:inline-block;padding:12px 20px;`
      + 'background:#d8b45a;color:#04060e;text-decoration:none;font-weight:bold;">Open your invitation</a></p>',
    `<p style="margin:0 0 18px;font-size:13px;word-break:break-all;"><a href="${safe.link}"`
      + ` style="color:#d8b45a;">${safe.link}</a></p>`,
    `<p style="margin:0 0 6px;font-size:13px;color:#9aa3b8;">Sent to ${safe.email}. `
      + `Good until ${safe.expires}.</p>`,
    '<p style="margin:0 0 18px;font-size:13px;color:#9aa3b8;">Not expecting this? There is nothing to do '
      + "&mdash; the link simply lapses.</p>",
    `<p style="margin:0;font-size:13px;color:#9aa3b8;">Orbit at ${safe.host}, run by ${safe.given}&#39;s `
      + "household, not a company.</p>",
    "</td></tr></table></body></html>",
    "",
  ].join("\n");

  return { subject, text, html };
}
