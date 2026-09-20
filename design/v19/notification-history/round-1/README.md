# Sent to you lately — round 1 (#1003 notification history)

One direction, A: a list of what Orbit has actually sent this person,
under the two reminder switches in the settings Reminders card. Drawn on
`design/v19/settings.html` verbatim (nothing above the ROUND 1 marker is
changed). The owner chose the place before anything was drawn (2026-09-20,
"60. a." — the settings Reminders card).

Served at
`http://<LAN address>:8336/1003-notification-history/design/v19/notification-history/round-1/a-sent-to-you-lately.html?scene=some|none|off`.

## What it reads

`notification_deliveries` (`src/db/schema.ts:720`): one row per send —
recipient, item, channel (email or browser alert), when it was due, when it
went, status (sent / retry / failed / cancelled) and the last error. The
list is the last five rows for the signed-in user, newest first. Nothing
new is stored.

## What it shows

- A row per send: the item's name (a link — the item is a place), the
  small line "first warning · email" / "final warning · browser alert", and
  on the right when it went ("today · 08:00", "Thu 17 Sep").
- A send that did not go says so in the row, in the pack's own tones:
  `couldn't send · mail not set up` (`--overdue`), `still trying · device
  was offline` (`--warm`). Nothing is hidden and nothing is dressed up.
- Nothing sent yet: one line — "nothing sent yet · the first warning goes
  out 14 days before closest approach, by email and by browser alert if
  they are on".
- Both switches off: a warm line above the list — "both switches are off ·
  nothing more will be sent until one is on". Past sends stay listed.
- Nothing here is a control; the two switches above are the controls.

## Borrowed, not invented

The sub-heading is the card's own Sign-in methods head
(`.card .methods-head`); the row is the "Your systems" row's shape (a mark,
a name with a small line, the right-hand value). The mail and bell glyphs
are chart-pen line icons in `--ink-faint`.

## Measured (`.capture/shoot.mjs`)

Desk 1600×1000, owner 1093×614, phone 390×844; the five packs on the desk.
Row 65px; no name clipped; no horizontal overflow anywhere. The card is
607px tall with five rows (339px empty), which is why five and not ten:
Reminders sits in a two-column grid beside Your relay and Your systems.

## Build notes

- Needs a read of the last five `notification_deliveries` for the user in
  the settings loader; no route or table changes.
- "Couldn't send" wording comes from a small map of `lastError` classes to
  plain sentences; unknown errors say "couldn't send" alone.
- The row's link goes to the item on the belt.

## Verdict

Owner, 2026-09-20, verbatim: "61 approved". **Ratified as drawn.** #1003
builds from this file; `design/owner-decisions.md` §20 has the decision.
