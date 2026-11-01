# Home sky · round 5: J, the notice after an upgrade

Issue: #1618 (what's-new notice after an upgrade). Date: 2026-11-01. One
direction, J (letters run on from round 4's G, H, I). Design decided before
drawing; this round draws it and shows it on both layouts.

## The problem

After a server upgrade a member opens the home sky with no hint that planets now
wear their section's colour, that size is cost or importance, or that near
planets carry names. The issue's pattern: a release can carry one note for
members and one for administrators, and each person sees each once. The notice
has to be seen once, say what changed in plain words, and get out of the way.

## The decided design

A what's-new card, shown once over the home sky after an upgrade. Behind it the
round-4 sky as the owner settled it: log scale, close-up 14 days, horizon 365
days, names for planets due within 30 days, every planet the plain accent colour
(no importance palette). While the card shows the sky is dimmed to about 55% by a
dark scrim, as in any dialog.

The card, desk: a rectangular frosted-glass card centred on the screen, 460 px
wide at most, 28 px padding, 16 px radius, no ring. A mono-caps eyebrow
`WHAT'S NEW · ORBIT 0.3.4`, a 20 px / 600 heading `New in this release`, then
four bullets (accent dot, bold lead, one plain sentence). For `who=admin`, after
the bullets, a thin divider, a second eyebrow `FOR ADMINISTRATORS` and two more
bullets. The footer holds `Got it` (the sign-in button, right) and a quiet link
`All release notes` (left). No close cross, no checkbox, no "remind me later".

The card, phone: a bottom sheet, full width, rounded top, a short drag handle,
22 px padding, at most 80% of the viewport high; the body scrolls inside it and
fades at the foot when there is more. The footer is pinned: the quiet link centred above
`Got it`, which is full width and 48 px high; the link is 44 px tall; both stay
visible while the body scrolls.

Keyboard and screen reader: `role="dialog" aria-modal="true"` labelled by the
heading; focus starts on the heading; Tab cycles heading, link, button; Escape
dismisses. In the mock-up, dismiss (Escape or `Got it`) fades the card and scrim
out in 160 ms and shows the sky. Nothing else moves; reduced motion removes the
fade.

**Draft copy for 0.3.4, not approved words.** Everyone: "Planets wear your
section's colour. Each section has a colour you choose; its items show it on the
sky." / "Size is cost or importance. Pick which one planet size shows, in
Settings." / "Items now have an importance. Your existing items say "not set"
until you give them one." / "Names up close. Planets due within 30 days show
their name. Change the days in Settings." Administrators: "The first-run tour is
off. New members land straight on the sky." / "Notes like this one. Every release
can carry a note for members and one for administrators; people see each once."

## Data story

Harlow Home, as in round 4: seven active items, today 13 Aug 2026 (the
fixture's pinned date). Planets, all plain accent: Gutter clearing (16 days
overdue), Car MOT (16 days), Boiler service (22), Chimney sweep (61), Roof
replacement (100), Smoke alarm batteries (122), Car full service (161). The three
due within 30 days carry names; the other four do not. Size shows yearly cost, as
today (the importance choice is the owner's later verdict and is not drawn here).

## Scenes and links

`j-whats-new.html`, one file, `?scene=desk` (default) or `?scene=phone`, and
`?who=member` (default) or `?who=admin`. Desk is 1440 x 900, phone 390 x 844.
Under `http://127.0.0.1:8307/v19/home-sun/round-5/`:

- `j-whats-new.html?scene=desk&who=member` and `...&who=admin`
- `j-whats-new.html?scene=phone&who=member` and `...&who=admin`

Press Escape (or `Got it`) to lift the card and see the sky behind.

## Tokens

After dark, as round 4 (`src/core.css` and `src/core.js` inlined from round 4;
Inter Variable and JetBrains Mono from `fonts/`, copied from round 4). The glass
is `web/src/lib/ringcard.css` `.ringglass`, copied: `background rgba(6,10,22,.56)`,
`backdrop-filter blur(20px) saturate(1.1) brightness(.74)`, the same two-part
box-shadow. The ring has no border, so the rectangle's 1 px edge uses that
card's own `--line-soft` (`rgba(240,244,251,.14)`). Ink on the glass is that
card's: ink `#f0f4fb`, ink-2 `#c0cade`, ink-3 `#9aa6bf`. `Got it` is `.card .act`
(`#d8b45a` on `#04060e`, 99 px radius, 11 x 30 px padding, 12 px / 600); the link
is `.quietline` (mono, `#8f9bb5`, underlined) at 12 px. The phone sheet is
`Sheet.svelte`'s: 18 px top corners, a 36 x 4 handle in a 24 px strip, scrim
`rgba(4,7,16,...)`. Tap targets on the phone measured 344 x 48 (`Got it`) and
344 x 44 (link). No data palette is proposed, so the dataviz validator was not run.

## Capture notes

`node capture.mjs` writes five shots to `shots/`: `j-desk-member`, `j-desk-admin`,
`j-phone-member`, `j-phone-admin` and `j-desk-dismissed` (after Escape). Phone
shots are device scale 2. All five were looked at. Fixed after looking: the quiet
link sat 4 px right of the bullet column; the admin sheet's text cut off
mid-line under the foot with no sign it scrolls (a fade now says so). Known and
left: on the desk the card covers the near planets and their names, as a centred
dialog over a centred sky must; the dismissed shot shows them. The card is
dark on a dark scrim; the 1 px edge and the footer button carry it.

## Decisions taken without the owner

- Phone sheet corners are the app's 18 px, not the brief's 20 px, so it matches
  the app's own sheets. Cost if wrong: a 2 px radius change.
- Rectangle edge: the ring card has no border, so I used its `--line-soft`.
  Cost if wrong: one border value.
- Eyebrow and link ink use the ring card's lifted tiers (`#9aa6bf`), not round 4's
  `#717c8e`, which is under 4.5:1 on glass. Cost if wrong: a dimmer eyebrow.
- `Got it` is set in Inter, not the app's `--display` (Space Grotesk), which is not
  among this round's fonts. Cost if wrong: a different face on one button.
- The quiet link is 12 px, not the door's 10.5 px, for reading and tapping. Cost
  if wrong: a smaller link.
- Scrim is `rgba(4,7,16,.45)` over the sky (55% remains); the app's own sheet
  scrim is .55. Cost if wrong: a slightly darker or lighter sky.
- Bullet lead and sentence run on in one paragraph, not lead above sentence.
  Cost if wrong: a taller card.
- Admin copy, the version number and `All release notes` are mock-up wording; the
  link goes nowhere. Cost if wrong: copy edits.
- Desk sky is drawn at 1.2 times round 4's size to fill 1440 x 900. Cost if
  wrong: nothing visible beside the card changes meaning.

## Owner verdicts

Owner, 2026-11-01, on direction J as drawn: **"14a looks fantastic, great
job."** Ratified: the build ports `j-whats-new.html`, desk card and phone
sheet, member and administrator variants. Build note (lane): on desk the
scrim leaves the sky almost invisible behind the card; the built screen
keeps the planets faintly readable through the glass. Copy stays draft until
the release notes for v0.3.4 are written.
