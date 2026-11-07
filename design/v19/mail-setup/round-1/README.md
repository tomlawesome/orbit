# Mail setup, round 1 (#1629, one Mail card holding both the mailbox and outgoing mail)

Date: 2026-11-07. Branch `design/1629-mail-setup`.

## The problem

The owner: "why are there two places to set email settings. It should be one."
Today the Mailbox card (incoming) and the outgoing-mail setup (#1627) live as
separate things on Administration, so a person setting up mail has to find and
complete two places. This round draws one place.

## Shared decisions (both directions)

- Two halves in a fixed order: Mailbox first, then Sending.
- Sending defaults to the mailbox account (same host login, mailbox password
  reused). "Another account" is the choice, not the starting point.
- Verify before save: both editors sign in to the server first and only then
  store. The password is never shown again.
- The two tests keep their #1627 names: "mailbox test" and "outgoing mail test",
  with their two buttons "test this mailbox" and "test outgoing mail".
- Reused as built: the ratified Administration screen (`design/v19/administration.html`)
  spliced with `web/src/lib/packs.css`, shell copied the way
  `design/v19/administration-ops/round-2/build.py` does. The phone is drawn from
  the real pocket kit and the pocket Administration styles, read at build time.
  No new colours or components; only a small `.sublabel` for the half titles
  and a `.choice` pill pair for "send through".

## Data story

Ned Harlow's instance. All names and hosts are invented (`.example`).

- Mailbox: `orbit@harlow.example`, host `mail.harlow.example`, port 993,
  folder INBOX, provider mailcow, tls name `mail.harlow.example`, polling every
  300 s. Collection domain `harlow.example`, last check 2 minutes ago, ingest
  running, credential set by Ned 3 Nov 2026.
- Sending via the mailbox account: `mail.harlow.example`, port 587, STARTTLS,
  sends as `Orbit <orbit@harlow.example>`, last sent "a reminder, 41 minutes ago".
- Sending via another account: `smtp.sendgrid.example`, port 465, TLS, user
  `apikey`, password "set by Ned, 7 Nov 2026".

## Directions

Letters continue across the project.

- J, one card: a single "Mail" card with the two test buttons in its head, then
  a "Mailbox" half and a "Sending" half in one column, Operations beside it.
- K, two cards: a "Mailbox" card and a "Sending" card side by side, each with
  its own test and set-up button; Operations is its own card below Mailbox.

Files, relative to `design/` (served by the design host):

- `v19/mail-setup/round-1/j-one-card.html`
- `v19/mail-setup/round-1/k-two-cards.html`

Open at `#<scene>`. `?shot` hides the scene bar. `?phone` forces the phone
layout; otherwise the phone shows under the app's own width query.

## Scenes (the same seven in each direction)

1. `set-up`: mailbox working, sending via the mailbox account.
2. `another-account`: sending via a separate provider.
3. `fresh`: nothing set up; the warm line says Orbit cannot send invitations,
   reminders or address checks until sending is set up.
4. `mailbox-only`: mailbox set, sending not.
5. `editor`: the sending editor open, "the mailbox account" chosen.
6. `editor-another`: the editor with "another account" (host, port, security,
   user, password).
7. `imported`: sending carried over from an earlier setup, with a calm notice.

Phone: scenes 1, 3 and 5 as specified, plus `editor-another` (and a second shot
with the sheet scrolled to the bottom, since the sheet body scrolls). The editor
is a sheet, like the mailbox sheet.

## Capture

`NODE_PATH=<a node_modules holding Playwright 1.63> node capture.mjs`
(Playwright; desk 1600x1000, phone 390x844, scale 2). 24 shots in `shots/`:
14 desk, 8 phone, 2 phone "-end". Rebuild the pages with `python3 build.py`.

Every shot was looked at. Fixed after looking: wrapped value in the `via` row
(now right-aligned, no wrap); `largest message` value sitting mid-row; a double
hairline above "Sending"; slivers of neighbouring cards in the desk clip; K's
Public contact stretching to the Mailbox height; the shell footer showing above
the phone header; cramped line-height on the warm and imported sentences; the
phone editor sheet clipping (extra scrolled shot added).

## Decided on my own

- `change mailbox...` sits in J's Mailbox button row rather than the card head.
- K's Operations is its own card below Mailbox so the two mail cards pair up.
- Dates use the "7 Nov 2026" form the existing rows use.
- `fetch now` kept in the Mailbox buttons, as in the brief.
- `REMOVE CREDENTIAL` shows uppercase and grey on the desk: that is what the
  built CSS does inside `.placerow`; left faithful, not restyled.

## Known gaps

- On the phone the two head pills stack because they do not fit side by side at
  the real pill size.
- The J phone card is long (about 2,300 css px); K splits it in two.

## Owner verdicts

- 2026-11-07: **J ratified** ("One card is better."). One Mail card, Mailbox
  half then Sending half, Operations beside it; the Sending editor opens
  inline in the card on the desk and as a sheet on the phone. K is not
  pursued. Recorded as `design/owner-decisions.md` decision 50; build notes
  on #1629.
- Viewed on one index page (`index.html`, J above K per scene) after the
  owner found side-by-side "squashed".
