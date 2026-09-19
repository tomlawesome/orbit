# The document card — round 3 (#1059 previews and reader, #1054 download and restore)

One direction, E: the lanes. Round 2 was rejected (verdict below). This
round draws the mechanism the owner pointed at — `design/v19/create-v3.html`
in its `doc` and `snap` states — on the item belt. The item card sits
alone, centred, as it does today. Click a paper on the belt (or Enter on it)
and the lanes grid widens on the paper's side: the item card slides off
centre and the reading card fades in beside it, the pair centred together
above the belt. The belt does not move; it dims beneath, as create-v3's
chart recedes. The reading card is create-v3's reading card, with page
turning and zoom added in its own quiet register. Esc, `close`, or a press
on dead space runs the transition in reverse. The belt beneath is
`design/v19/item-belt.html` verbatim.

Served at
`http://<LAN address>:8336/1059-document-card/design/v19/document-card/round-3/<file>`.
`e-the-lanes.html` is the one direction. Its demo rail (furniture, not
design) has a SHEET group: paper left · paper right · focusing · page 2
zoomed · still scanning · being removed · cannot draw · dead space. The
same scenes answer to
`?scene=left|right|reading|zoom|scanning|removed|unrenderable|deadspace`
and every pack to `?theme=<pack>`.

## The verdicts this round answers

Round 1, owner, 2026-09-19, verbatim (recorded in `../round-1/README.md`):

> the full page zoom of the reading room is great, but it should be a
> window over the top of the belt, not a separate page. We need to be able
> to zoom the document size for readability. What I don't like is having a
> wholly separate card for the document. In the past there was a view where
> you can drag and drop a file and the view expands with a full page view
> on the right. I loved that full page top sheet view, it was really slick.
> I'd like the view to open like that when you click on a document. If it's
> on the left, open it left. If it's on the right, open it on the right.
> Clicking off anywhere on the belt that's not already clickable (dead
> space) closes the preview view.

Round 2, owner, 2026-09-19, verbatim (recorded in `../round-2/README.md`):

> 1059 no, you clearly didn't bother checking the old mockups did you? You
> just briefed the agent and ignored what I said

The mockup meant is `design/v19/create-v3.html`, states `doc` and `snap`
("That's the exact mockup I meant"). It was rendered at 1600×1000 and
looked at before anything here was drawn (`review/cv3-doc.png`,
`review/cv3-snap.png`); `review/composite-cv3-snap-vs-e-left.png` puts its
`snap` beside this round's paper-left at the same scale. What round 2 got
wrong: a separate tall panel at the screen edge with the item card left in
place — two unconnected things, not one view expanding.

Also answered: question 47 (owner, 2026-09-19: "Sheet") — a document Orbit
cannot draw still opens the reading card.

## The one data story (identical to rounds 1 and 2)

The Lawson household's belt, arriving from the car. The same six documents;
the page renders are round 1's (`../round-1/pages/`), drawn from the story's
PDFs by the preview endpoint's own renderer.

| Document | Rides beside | State | What the reading card shows |
|---|---|---|---|
| MOT certificate 2025 (1 page, 240 KB) | Car MOT — Volvo V60, left paper | scanned clean | page one, "one page", zoom, download, remove |
| Service history (3 pages, 88 KB) | Car MOT — Volvo V60, right paper | scanned clean | page 1 of 3 on a stack; page 2 at 150% |
| renewal-notice.pdf (312 KB) | Car insurance | still scanning | the plate breathing, "Still scanning this file"; no page, no download |
| tyre-invoice-2025.pdf (164 KB) | Winter tyre swap | removed 10 August 2026, kept until 9 September 2026 | dashed plate, the dates, restore |
| policy-schedule.pdf (812 KB) | Home insurance | scanned clean, preview refused (422) | the plate, the 422 sentence, download |

## Direction E — the lanes

**The composition call.** create-v3's `.lanes` grid, mirrored per side. The
belt's `.cardwrap` stops being a fixed element at the apex and becomes the
card lane of a two-lane grid centred over the belt; the second lane is 0px
wide until a paper opens, then `--readw` (480px, or what the viewport
leaves) with create-v3's 28px gap. Paper on the left: the reading lane is
the first column and the card slides right. Paper on the right: the
mirror. Because the grid is `justify-content:center`, the card and the
reading card are one composition and stay centred as a pair; nothing is
pinned to a screen edge. The card's apex y and its `--cdx/--cdy/--csc`
drift are untouched, so it still rides where the belt puts it.

**How it opens.** create-v3's own transition: `grid-template-columns` and
`gap` over `.75s cubic-bezier(.4,.5,.15,1)`; the reading card fades in
over `.55s` and slides 16px into place over `.65s`, both after `.18s`.
While the page is on its way the reading card is content-height and
levelled with the card's middle — create-v3's `doc` state, the reticle
sweeping and the focus line breathing. When the page lands the card grows
to full height (88px from the top to 62px above the foot) and the cream
sheet settles in with `landed`. The belt recedes: band and fore rubble to
50%, other bodies and their captions to 55%, the end-caps to 55%; the item
card and the open paper are not dimmed. Opening a paper on the other side
while one is open closes the first (reverse transition) and then opens the
second on its side.

**What is inside.** Top: `page N of M` in the caption register and
`close · esc` (44px). The cream `.sheet` on its under-sheet, the page
scrolling inside the card past fit. A quiet bar beneath in the caption's
10.5px mono: `← page 1 of 3 →` and `fit · − 50% +`, buttons 44px and
unbordered so the bar reads as text until hovered. Keyboard: ← → turn
pages, `+` `−` `0` zoom, Esc closes; ctrl+wheel and two-finger pinch zoom
about the page. Foot: create-v3's `.attach` row with the paper's name, size
and `scanned clean`, and the two-press `remove` at its tail (first press
arms it, the row says `tap again to remove`); below, `download the
original` as the primary.

**The other states.** Still scanning holds the focus block without its
sweep, "Still scanning this file", no page and no download. Being removed
shows the dashed plate, "removed 10 August 2026 · gone for good 9 September
2026", and `restore` as the primary. Cannot draw opens the reading card
with the plate, "Orbit could not draw a picture of this document." in the
degraded tone, an honest pair of lines ("the file is fine — scanned clean,
and yours to download / orbit just could not turn it into a page to read
here") and `download the original`.

**Closing.** Esc, `close`, or a press on dead space: sky, band, captions,
end-cap text — anything not already clickable. Both cards run the
transition backwards; the item card returns to centre; the belt undims.
The demo's dead-space scene outlines what is live so the rule can be
checked by eye.

**Phone (390×844).** No second lane: the grid stays one column and the
card stays put. The reading card is CON-10's bottom sheet, re-checked
against pocket.css's grammar: fixed to the foot, 88vh, 18px shoulders, the
grab, raised glass, up from 105% below in .3s. The page fills it at fit;
pinch zooms; the bar and attach row sit beneath the page.

## What carries forward verbatim

- From `design/v19/item-belt.html`: everything above the ROUND 3 marker —
  markup, CSS and script untouched. `.cardwrap`'s transform, drift
  variables and z-order are kept; only its `position` and grid placement
  are overridden inside `.lanes`.
- From `design/v19/create-v3.html`: the `.lanes` grid and its
  column-plus-gap transition; the `.readcard` fade and 16px slide with
  their timings; `.glass`; the `.focus` block with the reticle's sweep and
  pull, `breathe` and the focus line; `.topsheet`, the cream `.sheet` and
  its `::before` under-sheet; `landed`; the `.cap` caption register; the
  `.attach` row and its quiet button. Only the lines under the focus say
  what the belt is doing ("orbit is drawing page 1 of the file it holds /
  nothing is changed, and nothing is assumed").
- From round 2: the phone bottom sheet (CON-10), the two-press remove, the
  dates-and-restore state, the refusal sentence from
  `src/server/documents/preview.ts`, the dead-space rule and the belt's
  key hold while a document is open.

## Gates

- Packs: paper-left and paper-right captured in starchart, afterdark,
  clouds, dawn and retrograde; nothing hand-coloured — the reading card is
  the belt's `.glass`, buttons the pack's `--accent`, the refusal line
  `--degraded`, the dates `--overdue-text`, scanned clean `--ok-text`.
  Clouds and dawn hold: the cream sheet sits on the pack's panel glass.
- Screenshots: every scene × desk 1600×1000 × phone 390×844 (touch
  enabled), plus remove armed and the composite against create-v3 `snap`.
  Fixed before this commit: the reading card sitting 16px off its lane on
  the left; the left-side sheet hidden on phone; a band of empty card
  under the focus block; a full-height empty card while focusing (now
  content-height and levelled with the item card until the page lands).
- Motion checked by script: the card's left edge moves 595→341px when the
  right paper opens and returns to 595 on Esc; the reading card is hidden
  after the reverse; left-then-right closes and reopens on the other side;
  a dead-space press closes, a press on the card does not; ← → turn pages
  inside the card and step items on the belt once it is closed; no page
  errors.
- `prefers-reduced-motion`: the lanes and the reading card change in
  place, the focus block shows without sweep or breathing, the page lands
  without the settle, the belt dims without transition.
- Keyboard and aria: the reading card is `role="dialog"` with focus moved
  in on open and returned to the paper on close; page number and zoom
  percentage are `aria-live="polite"`; every button has a label.
- Targets: close, the page arrows, the zoom buttons, download and restore
  are 44px; the quiet `remove` is 32px tall.

## Floors not met — said plainly

- The quiet `remove` is a 32px target, as create-v3's "not this one" is
  and as the household page's own two-press remove is; raising it to 44px
  would make the row's tail read as a second primary. Said, not fixed.
- Phone at fit shows an A4 page at about 358px wide: legible as a page, not
  as text, until pinched — that is the zoom's job.
- On a desk the reading card covers the paper you pressed: a centred pair
  of a 480px card and a 480px reader reaches the paper's seat. Its rim
  stays lit under the glass. Round 2's question 8 still stands.
- The reading card is 480px wide, not create-v3's 404px, so a page at fit
  is readable; the frame, glass and timings are otherwise create-v3's.
- Key hints are 9.5px, the belt's idiom for the same furniture.

## Deliberately not done

- No second direction. The owner named the mockup, the mechanism, the side
  rule and the close rule; a second composition would be a distraction.
- No page rail; no thumbnail strip. Three pages do not earn one.
- No drag-and-drop onto the belt. create-v3's drop is how a document
  arrives; the lanes are how one is read.
- No page for a document that is scanning, removed or refused.
- Pages after the first are server rasters (`?page=N` plus a page count) —
  decided, not reopened.

## Dependencies this round created

- **Pages after the first**: `?page=N` on the preview endpoint and a page
  count in the document's metadata (decided).
- **Zoom** past fit at 150–400% wants the page rendered wider than the
  848px round-1 renders: a `?width=` on the preview endpoint.
- **Remove and restore** have their server halves already:
  `requestDocumentDeletion` and `restoreDocument` in
  `src/server/document-repository.ts`.

## Open questions for the owner

**9** While a page is on its way the reading card is content-height and
levelled with the item card (create-v3's `doc` state), then grows to full
height when the page lands. Keep, or open at full height from the first
frame so nothing resizes?

**10** The reading card is 480px wide so a page at fit reads at 50%.
create-v3's is 404px. Keep 480, or match 404 and let fit sit nearer 40%?

## Verdicts

Not yet given.
