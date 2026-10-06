# Desk search — round 1 (#1161)

The owner's brief, 2026-09-27: on the live build the results list opens
*below* the "explore your world" field, and the field sits at the foot of the
first screen, so at 1536×730 the whole list lands off the bottom of the
window (measured: field top at 692, list top at 732 in a 730-high window).
*"The easy answer is above the box, but … this needs to be elegant not
clumsy."* And: *"make it more than just a generic search box … do it in a way
that really adds value to the app."*

Three directions, each a self-contained page built on `design/v19/home.html`
(the drawing of record) with the built palette cut out and the direction
spliced in. Everything else on the page is home.html verbatim, so what
differs between the three is only the search.

Served at `http://<LAN address>:<port>/<file>` — one URL per direction:

- **Rise** — `a-rise.html`
- **Lit sky** — `b-lit-sky.html`
- **Unrolled** — `c-unrolled.html`

Each page has a small state strip top-left (furniture, not design):
**1** idle · **2** click the field · **3** typing "mo" · **4** "mot" ·
**5** no match ("piano"). `?step=N` opens straight to a state, and the field
is live — type into it, use the arrow keys, press Enter or Escape. Resize the
window to check the short case; nothing in any direction ever goes below the
field.

## What all three keep

- The field at rest is unchanged: a hairline under centred type, no box, no
  icon, no label (owner-decisions §3; added chrome rejected three times). The
  focus ring is the §30 pill.
- The field stays where it is ratified to sit. Results go **above** it.
- Matching is `pocket-search.js` as built: items by title, section and
  provider; documents by name; a title that starts with the query outranks
  one that contains it; Enter opens the top match the way a clicked manifest
  row does. Before typing: the two nearest items that need attention,
  `→ complete …` and `→ add an item`. No match: *nothing in your orbit is
  called "piano"* and `→ add "piano" as an item`.
- ⌘K / Ctrl-K focuses the field (POL-9). Escape clears and leaves.
- Every direction keeps a real list for screen readers (`role=listbox`,
  `aria-selected`), whatever it draws for sighted readers.
- No new colours: every direction draws with the pack's own tokens (accent,
  ink tiers, chart line, the four planet materials), so there is no data
  palette to validate beyond what the packs already passed.

## The one data story

The Lawson Home of the v19 mockups, today Wed 13 Aug 2026: Gutter clearing
(overdue T+16d), Car MOT — Volvo V60 (T−16d, £54.85, documents *MOT
certificate 2025* and *Service history*), Boiler service (T−22d, British
Gas), the relay's Home insurance renewal suggestion (T−51d), Chimney sweep
(T−61d), Smoke alarm batteries (T−122d), Car full service (T−161d, two
documents). "mo" finds Car MOT, Smoke alarm batteries and the MOT
certificate; "mot" finds the MOT and its certificate; "piano" finds nothing.

## A — Rise

**What you see.** Click the field and the chart's linework steps back to a
ghost (the sun and the bodies stay). Rows rise out of the hairline, nearest
match nearest the field, so the row Enter will open is the one right above
where you are typing. Each row is a flat dot in the item's urgency colour,
the title, and its T-label; documents carry the ◆ mark and the item they
belong to. Further rows sit further up and are dimmer. As you type, the
bodies that no longer match fade in the sky; the top match's body swells
(POL-4's `.lit`). No panel, no border: rows over sky.

**What it adds.** The list is the built palette turned the right way up and
stripped of its box, plus one coupling to the chart: you can see which
planets your words picked out.

**Cost.** Small. The palette's CSS moves from `top:100%` to `bottom:100%`
and loses its panel; a `searching`/`typing` body class dims the chart chrome
and non-matching bodies (both already have transitions); the hit/lit classes
already exist. Half a day including tests.

## B — Lit sky

**What you see.** The chart is the answer. Click the field and the two
items that need you light up with a thin accent ring; the nearest carries
the chart's own callout (POL-6's panel and leader line) reading title,
T-label, date, cost, its documents, and `open ↵`. Type, and everything that
is not what you asked for fades to a rumour — bodies to 12%, the month ring
to half — while the matches stay lit and ringed; the top match pulses once
(POL-2's ping, in accent) and wears the callout. A matched document lights
the planet it belongs to and reads bright in the callout. Under the ring a
one-line readout above the field says `2 in your orbit · 1 document`, or the
two actions, or the no-match sentence. ↑↓ step the callout from match to
match; Enter opens; mouse users click a lit body as they already can.

**What it adds.** Searching becomes pointing at the sky. You learn *where*
the thing sits — how close to due, what it will cost, what it has attached —
without leaving the chart or reading a list, and the answer is in the
instrument the product is built on. With forty items and a one-letter
query, forty lit planets and one callout still read; a forty-row list does
not.

**Cost.** Medium. The hover callout code and CSS are reused for placement;
new work is the hit rings (a `<g>` in the dial SVG), the keyboard stepping,
the dim classes, the readout line, and a visually-hidden list so screen
readers get the same results as a list (drawn here). The pocket is
untouched. One to two days.

## C — Unrolled

**What you see.** Click the field and the ring dissolves (POL-8's own move;
the sun and the household name stay) while a horizon line draws itself
above the field: the year unrolled, today's ▲ near the left, a short dotted
overdue run before it, month ticks along it. Matches stand on the line as
their own planets — same materials, same sizes — at their due date, each
with a leader to its title, T-label, date, cost and any matched document.
Where two stand too close (MOT and Boiler, six days apart) the second hangs
its label below the line. ←→ step along the line; Enter opens. Let go of the
field and the ring returns.

**What it adds.** The dial's physics read left to right: when several
things match you see the order and the gaps at a glance — which comes first
and how far apart they are — which the ring shows only as angles.

**Cost.** Medium-high. A new SVG component (date→x mapping, month ticks,
leader lines, label collision), its own keyboard model, and the
dissolve/return choreography. Two to three days. It is also a second drawing
of the year on a screen that already has two (the dial and the manifest),
which owner-decisions §14 argued against: "ONE schedule surface".

## Recommendation

**B — Lit sky.** It is the only one of the three that answers the second
half of the brief — it makes searching do something a filter cannot, and it
does it with the product's own instrument rather than beside it. Nothing new
is drawn at rest, the moving parts are all grammar the chart already speaks
(ring, ping, callout, leader), and it holds up at 730 high because it needs
no room below the dial at all.

If B's cost is too much for M14, **A — Rise** is the honest fallback: it fixes
the defect, keeps the splash clean, and its sky-dimming is the first step of
B. **C** should not ship as the search, but the unrolled line is worth
keeping as a feature idea for a later "what's coming" view.

Composition calls made here for the owner to confirm or overturn:

- Rows in A grow upward with the top match nearest the field (Enter's target
  is the nearest row). If the owner prefers reading order, the list flips
  and Enter's target moves to the top.
- In B the callout follows the built hover placement (right of the body,
  leader line), so it can sit over a month label as the hover already does.
- In C the ring dissolves on focus, not on the first keystroke, so the line
  is already there when you start typing.
- The readout line in B and C shows a keyboard hint (`↑↓ step · ↵ open`).
  Easy to drop if it reads as chrome.
