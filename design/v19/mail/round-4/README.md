# Mail family — visioning round 4

Date: 2026-11-07. Issues: #1648 (every email Orbit sends uses the ratified
card) and #1421 (admin alerts by email).

## The problem

Only the invitation uses the ratified card. Every other mail Orbit sends is
plain text: the sending-address check, "could not match", the review notice,
reminders, sign-in approval, set and reset password, the key-locked alert and
its all-clear. #1421 adds the admin alerts. This round puts all of them in the
same card, so a mail from Orbit looks like Orbit.

## The ratified base, carried in verbatim

From round 3's verdicts (`design/v19/mail/round-3/README.md`, owner,
2026-09-06, on #481):

> G the living system — "even better!! This is the one." **Ratified: the
> template in `src/server/invitations/mail.ts` is built from
> `g-the-living-system.html`.**
>
> On the gold hairline along the card's top: "Why are they randomly yellow at
> the top on phones?" — it is deliberate (the sun's colour on the card edge, on
> desk too). Owner: "Drop the gold line at the top, and instead, give the whole
> card a feint, thin gold outline." **Applied in the template, not re-drawn as a
> round.**
>
> On the built template (real render, faint gold outline): "Templates are
> fantastic now." **Shipped as `src/server/invitations/mail.ts`.**

The shell is copied from `src/server/invitations/mail.ts` lines 142-315, with
the same limits: tables and inline styles only, 560px at most, no images, no
web fonts, no SVG, no gradients, no `position`. Wordmark, star scatter, sun and
rings, the caption ("A SUN · ONE RING · TWELVE MONTHS"), the card outline
(`1px solid #4f4118`) and the whole motion-only `<style>` block are unchanged.
Gmail and Outlook for Windows drop that block and show the finished frame.

## One direction, letter L: the family

Letters continue across the project; this round has one direction, L. It is
not a new look: it is the question "what does each mail say inside the same
card?"

### Shared decisions

- **One renderer, five slots.** Headline, body (one or more paragraphs),
  button (optional), facts (optional), footer. Everything above the headline
  (mark, stars, sun, rings, caption) is fixed.
- **The text part of every mail is unchanged.** Only the HTML part changes; the
  plain-text alternative stays as it is today.
- **Links only in the button and the text part.** No "copy this into your
  browser" line in the footer (the invitation has one; the family drops it, as
  the text part carries the link). Mails with no button carry no link.
- **Every footer ends with the "run by a household" line:** "Orbit at {host},
  run by a household, not a company." (The invitation says whose household; the
  family says "a household" because an alert or a reminder belongs to no one
  inviter.)
- **The admin alert is the same card.** No red, no warning banner: the facts
  block carries the context (what, since, where, what Orbit did) and the
  button opens Administration.
- Slot styling (mock-up choices, not ratified): the headline is one cream
  Georgia line at 28px (the invitation's gold display line is the household
  name, which the family has no equivalent of); body paragraphs are the
  invitation's grey 15px, 40px side padding, 12px apart; the button keeps the
  invitation's pill, with 36px side padding and 24px of cell padding so the
  longest label ("approve, or say it wasn't you") fits a phone on one line;
  facts are the mono block, label dim, value lighter, one `label · value` per
  line; footer lines are 8px apart, the host picked out in the lighter grey.
- Typographic apostrophes and quotes are used in the HTML; the em dashes are as
  supplied.
- A hidden preheader (as in the invitation) is added to each file.
- `?still` support is a tiny inline script that removes the `<style>` block.
  It is for mock-up capture only and is not part of the built template.

### Data story

Invented, documentation range only. Host `orbit.harlow.example`; recipient Ned
Harlow (given name Ned), `ned@harlow.example`; address being checked
`ned.harlow@mailbox.example`; links `https://orbit.harlow.example/…` with
obviously fake tokens; expires "7 Nov 2026 at 18:40 UTC"; reminder "Car
insurance" due "20 Nov 2026"; device "Firefox on Windows", from "Leeds, United
Kingdom", requested "7 Nov 2026 at 16:12 UTC"; scanner down since "7 Nov 2026
at 09:40 UTC"; import failure (household Harlow) at "7 Nov 2026 at 14:05 UTC";
sent "2026-11-07 16:20".

### Files

All twelve are self-contained HTML. Subjects are in each file's `<title>`.

| File | Subject | Button |
|---|---|---|
| `l-sending-address-check.html` | Check your Orbit sending address | yes, it's mine |
| `l-could-not-match.html` | Orbit could not match your message | none |
| `l-review-available.html` | Orbit review available | open your inbox |
| `l-reminder.html` | {title} is coming up | open Orbit |
| `l-reminder-expiry.html` | {title} is running out | open Orbit |
| `l-sign-in-approval.html` | Approve your Orbit sign-in | approve, or say it wasn't you |
| `l-set-password.html` | Set your Orbit password | choose a password |
| `l-reset-password.html` | Reset your Orbit password | choose a new password |
| `l-key-locked.html` | Orbit is locked: its encryption key needs attention | none |
| `l-key-restored.html` | Orbit's encryption key is working again | none |
| `l-admin-alert-scanner.html` (#1421) | Orbit needs you: the virus scanner is down | open Administration |
| `l-admin-alert-import.html` (#1421) | Orbit needs you: an import could not be undone | open Administration |

Decided on my own, for the owner to overrule:

- The key-locked copy as supplied ends its footer on "Sent {sentAt} UTC."; the
  "run by a household" line is added after it so the shared rule holds. The
  key-restored footer, which had no copy, is the same two lines ("Sent … UTC."
  then the household line).
- The reset-password mail reuses the set-password footer and facts; the
  reminder-expiry facts keep the `due` line ("due · 20 Nov 2026") beside
  `kind · expiry`.
- The import alert's time is 14:05 UTC, so it differs from the scanner's.
- Copy is verbatim from the brief, including "The household's owner has been
  told an administrator has been notified." and "Members have been told an
  administrator has been notified." — worth a read for wording.

## Capture notes

`capture.mjs` (Playwright, Chromium, `deviceScaleFactor` 2, full page) writes
to `shots/`, three per file:

- `<name>-680.png` — a desk mail client, 680px wide, after 7.5 s so the whole
  motion story has played (the marker has also started its lap, so it sits a
  little round the innermost ring);
- `<name>-390.png` — a phone mail client, 390px wide, same wait;
- `<name>-still.png` — 680px wide with `?still`: no `<style>` block, the frame
  Gmail and Outlook for Windows show.

Run it with `node capture.mjs` from this folder where Playwright resolves; on
this host, where it is not installed in the worktree, point `NODE_PATH` at a
Playwright 1.63 `node_modules`. 12 files, 36 shots.

## Owner verdicts

- 2026-11-07: **L ratified as the house set** for all twelve mails ("9a
  everything else is great"). The slot styling under "Shared decisions" is
  ratified with it. The key-locked and key-restored mails go to the operator
  alert address only (`src/server/key-alert.ts`), confirmed with the owner;
  members see the in-app locked screen, which says nothing more than that
  Orbit is unavailable. Build notes go on #1648 (wording) and #1421 (look).
