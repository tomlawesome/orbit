/**
 * THE INVITATION MAIL, AND NOTHING ELSE (#481).
 *
 * Every word of the template lives in this file. That is the point of the
 * module: the look of the mail is one file's diff, with no sentence to chase
 * through routes, screens or tests. The HTML part is round 3 direction G, "the
 * living system", ratified 2026-09-06 on #481, carried over from
 * `design/v19/mail/round-3/g-the-living-system.html`. The card's faint gold
 * outline replaces that mockup's gold top edge, on the owner's verdict of the
 * same day.
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
   * "The living system" — round 3 direction G, ratified 2026-09-06 on #481 and
   * carried across from `design/v19/mail/round-3/g-the-living-system.html`.
   *
   * Tables and inline styles, 560px at most, no SVG, no images, no web fonts,
   * no gradients and no `position:` anywhere — the comet's tail and the sun's
   * warmth are stacked circles placed with margins. The `<style>` block is
   * progressive enhancement: Gmail and Outlook for Windows drop it and show the
   * finished frame, which is the design in its own right; the clients that keep
   * it play the story once. `prefers-reduced-motion` stops all of it.
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
  /* The card's outline. Gold #f0b429 mixed about 30% into the card's own
     #0b0f1a, because a low-alpha gold does not survive every mail client. It
     replaced the mockup's gold top edge on the owner's verdict of 2026-09-06;
     changing or dropping the outline is this line and nothing else. */
  const cardBorder = "1px solid #4f4118";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(subject)}</title>
<style>
  /* the sky: each star twinkles at its own rate, forever */
  @keyframes orbit-twinkle { 0%, 100% { opacity: .18; } 50% { opacity: 1; } }
  .o-s1 { animation: orbit-twinkle 2.6s ease-in-out 0s infinite; }
  .o-s2 { animation: orbit-twinkle 3.4s ease-in-out .9s infinite; }
  .o-s3 { animation: orbit-twinkle 2.2s ease-in-out 1.7s infinite; }
  .o-s4 { animation: orbit-twinkle 4.1s ease-in-out .4s infinite; }
  .o-s5 { animation: orbit-twinkle 3.0s ease-in-out 2.3s infinite; }
  .o-s6 { animation: orbit-twinkle 3.7s ease-in-out 1.2s infinite; }

  /* the sun ignites from an ember; its warmth blooms outward */
  @keyframes orbit-ignite { 0% { background-color: #2a1d06; transform: scale(.55); } 60% { background-color: #f0b429; transform: scale(1.18); } 100% { background-color: #f0b429; transform: scale(1); } }
  @keyframes orbit-glow-in  { from { background-color: #0b0f1a; } to { background-color: #221b0e; } }
  @keyframes orbit-glow-out { from { background-color: #0b0f1a; } to { background-color: #14120e; } }
  @keyframes orbit-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.09); } }
  .o-sun      { animation: orbit-ignite 1.6s cubic-bezier(.2,.7,.2,1) .3s 1 both, orbit-breathe 5.5s ease-in-out 2.0s infinite; }
  .o-glow-in  { animation: orbit-glow-in 1.4s ease-out .6s 1 both; }
  .o-glow-out { animation: orbit-glow-out 1.6s ease-out .9s 1 both; }

  /* three rings widen from the sun: a system forming */
  @keyframes orbit-ripple-in  { from { border-color: #0b0f1a; } to { border-color: #34405c; } }
  @keyframes orbit-ripple-mid { from { border-color: #0b0f1a; } to { border-color: #222c40; } }
  @keyframes orbit-ripple-out { from { border-color: #0b0f1a; } to { border-color: #1a2131; } }
  @keyframes orbit-lap { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .o-in  { animation: orbit-ripple-in 1.0s ease-out 1.2s 1 both, orbit-lap 40s linear 4.0s infinite; }
  .o-mid { animation: orbit-ripple-mid 1.1s ease-out 1.7s 1 both; }
  .o-out { animation: orbit-ripple-out 1.2s ease-out 2.2s 1 both; }

  /* the reader arrives: a comet from the upper right settles on the innermost ring */
  @keyframes orbit-comet { 0% { opacity: 0; transform: translate(88px, -88px); } 25% { opacity: 1; } 100% { opacity: 1; transform: none; } }
  @keyframes orbit-tail  { 0% { opacity: 0; transform: translate(88px, -88px); } 30% { opacity: .7; } 100% { opacity: 0; transform: none; } }
  .o-mark { animation: orbit-comet 1.3s cubic-bezier(.2,.8,.3,1) 2.7s 1 both; }
  .o-t1 { animation: orbit-tail 1.3s cubic-bezier(.2,.8,.3,1) 2.78s 1 both; }
  .o-t2 { animation: orbit-tail 1.3s cubic-bezier(.2,.8,.3,1) 2.86s 1 both; }
  .o-t3 { animation: orbit-tail 1.3s cubic-bezier(.2,.8,.3,1) 2.94s 1 both; }

  /* the words: the headline draws in, the rest settles, the button blooms once */
  @keyframes orbit-title  { from { opacity: 0; letter-spacing: .10em; transform: translateY(8px); } to { opacity: 1; letter-spacing: 0; transform: none; } }
  @keyframes orbit-settle { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @keyframes orbit-bloom  { 0% { box-shadow: 0 0 0 0 rgba(125,211,252,.55); } 100% { box-shadow: 0 0 0 18px rgba(125,211,252,0); } }
  .o-title  { animation: orbit-title 1.6s cubic-bezier(.2,.7,.2,1) 3.5s 1 both; }
  .o-lede   { animation: orbit-settle 1.2s ease-out 4.0s 1 both; }
  .o-act    { animation: orbit-settle 1.2s ease-out 4.4s 1 both; }
  .o-button { animation: orbit-bloom 1.4s ease-out 5.4s 1 both; }
  .o-facts  { animation: orbit-settle 1.4s ease-out 4.8s 1 both; }

  @media (prefers-reduced-motion: reduce) {
    .o-s1, .o-s2, .o-s3, .o-s4, .o-s5, .o-s6, .o-sun, .o-glow-in, .o-glow-out, .o-in, .o-mid, .o-out,
    .o-mark, .o-t1, .o-t2, .o-t3, .o-title, .o-lede, .o-act, .o-button, .o-facts { animation: none; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#05070d;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#05070d;">
<tr><td align="center" style="padding:36px 16px 56px;">

  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#05070d;">${safe.given} has a place for you in ${safe.household}. The link is good until ${safe.expires}.</div>

  <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">

    <!-- the mark, centred -->
    <tr><td align="center" style="padding:0 8px 26px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="width:22px;height:22px;padding:0;">
          <div style="width:16px;height:16px;border:2px solid #7c8699;border-radius:50%;"></div>
          <div style="width:7px;height:7px;background:#7dd3fc;border-radius:50%;margin:-15px 0 0 13px;"></div>
        </td>
        <td style="padding:0 0 0 10px;font-family:Georgia,'Times New Roman',serif;font-size:16px;letter-spacing:.06em;color:#e7e9ee;">orbit</td>
      </tr></table>
    </td></tr>

    <!-- the card -->
    <tr><td style="background:#0b0f1a;border:${cardBorder};border-radius:18px;padding:0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">

        <!-- the sky above the sun: a scatter of stars, each on its own clock -->
        <tr><td style="padding:22px 28px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="padding:0;vertical-align:top;"><div class="o-s1" style="width:2px;height:2px;background:#9aa4b8;border-radius:50%;opacity:.5;margin:14px 0 0 6px;"></div></td>
            <td style="padding:0;vertical-align:top;"><div class="o-s4" style="width:3px;height:3px;background:#c9d0dc;border-radius:50%;opacity:.5;margin:2px 0 0 18px;"></div></td>
            <td style="padding:0;vertical-align:top;"><div class="o-s2" style="width:2px;height:2px;background:#9aa4b8;border-radius:50%;opacity:.5;margin:26px 0 0 4px;"></div></td>
            <td style="padding:0;vertical-align:top;"><div class="o-s6" style="width:2px;height:2px;background:#9aa4b8;border-radius:50%;opacity:.5;margin:8px 0 0 30px;"></div></td>
            <td style="padding:0;vertical-align:top;"><div class="o-s3" style="width:3px;height:3px;background:#c9d0dc;border-radius:50%;opacity:.5;margin:20px 0 0 12px;"></div></td>
            <td style="padding:0;vertical-align:top;"><div class="o-s5" style="width:2px;height:2px;background:#9aa4b8;border-radius:50%;opacity:.5;margin:4px 0 0 26px;"></div></td>
            <td style="padding:0;vertical-align:top;"><div class="o-s1" style="width:2px;height:2px;background:#9aa4b8;border-radius:50%;opacity:.5;margin:30px 0 0 8px;"></div></td>
            <td style="padding:0;vertical-align:top;"><div class="o-s4" style="width:2px;height:2px;background:#9aa4b8;border-radius:50%;opacity:.5;margin:12px 0 0 34px;"></div></td>
          </tr></table>
        </td></tr>

        <!-- the sun: ember to star, warmth blooming; three rings; the comet's arrival -->
        <tr><td align="center" style="padding:4px 32px 0;">
          <div class="o-out" style="width:200px;height:200px;border:1px solid #1a2131;border-radius:50%;margin:0 auto;">
            <div class="o-mid" style="width:160px;height:160px;border:1px solid #222c40;border-radius:50%;margin:19px auto 0;">
              <div class="o-in" style="width:120px;height:120px;border:1px solid #34405c;border-radius:50%;margin:19px auto 0;">
                <!-- the marker and its tail share one 14px band; the tail dots
                     overlap it by negative margins and end invisible -->
                <div style="height:14px;margin:10px 0 0;">
                  <div class="o-mark" style="width:14px;height:14px;background:#7dd3fc;border-radius:50%;margin:0 0 0 94px;"></div>
                  <div class="o-t1" style="width:8px;height:8px;background:#7dd3fc;border-radius:50%;opacity:0;margin:-11px 0 0 97px;"></div>
                  <div class="o-t2" style="width:6px;height:6px;background:#7dd3fc;border-radius:50%;opacity:0;margin:-7px 0 0 98px;"></div>
                  <div class="o-t3" style="width:4px;height:4px;background:#7dd3fc;border-radius:50%;opacity:0;margin:-5px 0 0 99px;"></div>
                </div>
                <div class="o-glow-out" style="width:96px;height:80px;padding:16px 0 0;background:#14120e;border-radius:50%;margin:-12px auto 0;">
                  <div class="o-glow-in" style="width:64px;height:47px;padding:17px 0 0;background:#221b0e;border-radius:50%;margin:0 auto;">
                    <div class="o-sun" style="width:30px;height:30px;background:#f0b429;border-radius:50%;margin:0 auto;"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </td></tr>

        <!-- the sky below, and the caption -->
        <tr><td style="padding:0 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="padding:0;vertical-align:top;"><div class="o-s3" style="width:2px;height:2px;background:#9aa4b8;border-radius:50%;opacity:.5;margin:6px 0 0 22px;"></div></td>
            <td style="padding:0;vertical-align:top;"><div class="o-s6" style="width:3px;height:3px;background:#c9d0dc;border-radius:50%;opacity:.5;margin:18px 0 0 2px;"></div></td>
            <td style="padding:0;vertical-align:top;"><div class="o-s2" style="width:2px;height:2px;background:#9aa4b8;border-radius:50%;opacity:.5;margin:2px 0 0 40px;"></div></td>
            <td style="padding:0;vertical-align:top;"><div class="o-s5" style="width:2px;height:2px;background:#9aa4b8;border-radius:50%;opacity:.5;margin:14px 0 0 16px;"></div></td>
            <td style="padding:0;vertical-align:top;"><div class="o-s1" style="width:3px;height:3px;background:#c9d0dc;border-radius:50%;opacity:.5;margin:8px 0 0 36px;"></div></td>
            <td style="padding:0;vertical-align:top;"><div class="o-s4" style="width:2px;height:2px;background:#9aa4b8;border-radius:50%;opacity:.5;margin:20px 0 0 10px;"></div></td>
          </tr></table>
        </td></tr>
        <tr><td align="center" style="padding:4px 32px 0;font-family:'Courier New',Courier,monospace;font-size:11px;letter-spacing:.18em;color:#4a5468;">A SUN · ONE RING · TWELVE MONTHS</td></tr>

        <!-- the words: the headline draws in, the line under it settles -->
        <tr><td class="o-title" align="center" style="padding:26px 40px 0;font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.3;color:#f2f0ea;">
          ${safe.inviter} has a place for you in
        </td></tr>
        <tr><td class="o-title" align="center" style="padding:6px 24px 0;font-family:Georgia,'Times New Roman',serif;font-size:40px;line-height:1.1;letter-spacing:-.01em;color:#f0b429;white-space:nowrap;">
          ${safe.household}
        </td></tr>
        <tr><td class="o-lede" align="center" style="padding:16px 52px 0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#7c8699;">
          Orbit keeps a household’s year in one calm view. ${safe.given} would like you in theirs.
        </td></tr>

        <!-- the one action, centred, filled; it blooms once when the story ends -->
        <tr><td class="o-act" align="center" style="padding:32px 40px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
            <td class="o-button" style="background:#7dd3fc;border-radius:999px;">
              <a href="${safe.link}" style="display:inline-block;padding:16px 40px;font-family:Georgia,'Times New Roman',serif;font-size:17px;letter-spacing:.02em;color:#05070d;text-decoration:none;">Take your place</a>
            </td>
          </tr></table>
        </td></tr>

        <!-- the facts, centred, in mono -->
        <tr><td class="o-facts" align="center" style="padding:32px 40px 40px;font-family:'Courier New',Courier,monospace;font-size:12px;line-height:1.9;color:#4a5468;">
          sent to <span style="color:#7c8699;">${safe.email}</span> · sign in with that address<br>
          good until <span style="color:#7c8699;">${safe.expires}</span><br>
          not expecting this? nothing to do — the link simply lapses.
        </td></tr>

      </table>
    </td></tr>

    <!-- the footer, quiet, centred -->
    <tr><td align="center" style="padding:22px 8px 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#4a5468;">
      Orbit at <span style="color:#7c8699;">${safe.host}</span> · run by ${safe.given}’s household, not a company.<br>
      If the button does nothing, copy this into your browser: <span style="color:#7c8699;word-break:break-all;">${safe.link}</span>
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>
`;

  return { subject, text, html };
}
