# The document card — round 4 (#1059 previews and reader, #1054 download and restore)

One direction, F: the page is the card. Round 3's mechanism — the lanes —
stays exactly as it was; only the reading card itself is redrawn, to the
rule `design/v19/create-v3.html` sets in its `snap` state: the sheet fills
the card edge to edge inside 26px, one caption above, one thin attach row
below, nothing else. The reading card is now as tall as its page and no
taller, the page spans its width, and download and remove are quiet words
in the foot row. There is no primary button anywhere on it.

The owner counts this as round 3 ("we'll come back and do round 3 later",
then "Do round 3 now"); the directory numbering follows the repo, where
round 3 is `../round-3/` (the lanes) and this is round 4.

Served at
`http://<LAN address>:8336/1059-document-card/design/v19/document-card/round-4/<file>`.
`f-the-page-is-the-card.html` is the one direction. Its demo rail
(furniture, not design) has the same SHEET group as round 3: paper left ·
paper right · focusing · page 2 zoomed · still scanning · being removed ·
cannot draw · dead space. The same scenes answer to
`?scene=left|right|reading|zoom|scanning|removed|unrenderable|deadspace`
and every pack to `?theme=<pack>`.

## The verdict this round answers

Round 3, owner, 2026-09-19, verbatim, with a screenshot of the reading card
on the owner's own laptop (page 3 of 3 at "fit" = 26%, a small rectangle in
the middle of a full-height card, a full-width primary button under it):

> 1059 nope. The document front page is no where near enough of the card.
> The download button is pointlessly, clumsily big. It's not elegant. Look
> at it - most of the space is taken up by ... nothing but useless fluff?
> The mock up was far more elegant.

Cause: round 3's "fit" fitted the page's HEIGHT into a card that was always
full-height. On a screen shorter than the 1600×1000 gate the page shrank
while the head, the page bar, the attach row and the button kept their
size — about half the card was furniture. The owner's screen is roughly
1093×614 CSS px (a 1366×768 laptop at 125% scaling); round 3 was never
looked at at that size. This round is gated at 1093×614 as well as
1600×1000, 1280×720 and 390×844.

## What stays from round 3, untouched

The lanes: the item card centred alone; click a paper and the reading lane
grows on the paper's side with create-v3's grid transition; the pair stays
centred; the belt dims; Esc, `close` or dead space reverses it; phone is a
bottom sheet; a document Orbit cannot draw still opens the card. Pages
after the first are server rasters. The motion script (`.capture/motion.mjs`)
re-checks all of it: the item card's left edge moves 595→341px when the
right paper opens and returns to 595 on Esc; left-then-right closes and
reopens on the other side; dead space closes, a press on the card does not;
← → turn pages while open and step items once closed; no page errors.

## The one data story (identical to rounds 1–3)

The Lawson household's belt, arriving from the car. The same six documents;
the page renders are round 1's (`../round-1/pages/`), drawn from the story's
PDFs by the preview endpoint's own renderer.

| Document | Rides beside | State | What the reading card shows |
|---|---|---|---|
| MOT certificate 2025 (1 page, 240 KB) | Car MOT — Volvo V60, left paper | scanned clean | page one at the card's width; `one page · fit − 51% +` |
| Service history (3 pages, 88 KB) | Car MOT — Volvo V60, right paper | scanned clean | `PAGE 1 OF 3`, the sheet on its stack; page 2 at 150% |
| renewal-notice.pdf (312 KB) | Car insurance | still scanning | the plate breathing, "Still scanning this file"; no page, no download |
| tyre-invoice-2025.pdf (164 KB) | Winter tyre swap | removed 10 August 2026, kept until 9 September 2026 | dashed plate; the foot row shows the dates and `restore` |
| policy-schedule.pdf (812 KB) | Home insurance | scanned clean, preview refused (422) | the plate, the 422 sentence; `download` in the foot row |

## Direction F — the page is the card

**The composition call.** The card's height follows the page, not the
screen. Fit means fit the card's width: the sheet is exactly the card's
inner width (480 − 2×26 = 428px; the page image 410px, which is 51% of an
A4 page at 96 dpi) and as tall as the page is. Above it one line in
create-v3's caption register — `PAGE 1 OF 3` left, `CLOSE · ESC` right —
and below it create-v3's `.attach` row, and nothing else. On a
1600×1000 desk the card is 763px tall and the page is 595px of that: 78%.
It sits level with the item card's middle, as create-v3's reading card
sits beside the form; where it is taller than the item card it grows both
ways, held inside the screen's margins.

**When the page is taller than the screen leaves room for**, the card
stops at those margins — 84px under the chrome strip, 16px above the
mockup's rail — and the page scrolls inside it, still at full width, the
head line and the foot row pinned. The card is never shorter than the
screen allows while the page has more to show, and never taller than its
page when it does not.

**Zoom** is in the foot row: `fit − 51% +`. Fit is the minimum; `−` is
disabled at fit and a step down from 75% returns to fit. Past fit the
sheet is wider than the card and scrolls both ways inside it. Keys: `+`
`−` `0`; ctrl+wheel; two-finger pinch on touch, which cannot go below fit
either.

**The foot row** is create-v3's `.attach` verbatim in its register — 11px
mono, one hairline border, 9px radius. Line one: `◆ MOT certificate 2025
240 KB · scanned clean` on the left; `download` and `remove` as quiet
words on the right, in the register of create-v3's "not this one".
`remove` is two-press (#1054): the first press arms it and the row says
`tap again to remove`, the second removes. Page turning and zoom go on a
second thin line inside the same border — `← 1 of 3 →` and `fit − 51% +`
— because one line does not hold them at 480px: measured from the DOM,
the file, its size and scan and the two words come to 359px of the row's
404px, and the page turn and zoom are about 330px more. Being removed: the same
row shows `◆ tyre-invoice-2025.pdf` and `restore`, then `removed 10 August
2026 · gone for good 9 September 2026` beneath. Still scanning: the file,
its size and `scanning`; no words. No primary button anywhere.

**Reading and cannot-draw** use create-v3's focus block, content-height,
level with the item card, exactly as round 3 drew them; cannot-draw shows
the endpoint's own sentence and has `download` and `remove` in its foot
row.

**Phone (390×844).** CON-10's bottom sheet, now content-height inside 88vh:
the page at the sheet's width (43% of A4), one head line, one foot row, no
button. Pinch zooms. A long file name ("MOT certificate 2025") pushes
`download · remove` to a third thin line inside the row; "Service history"
holds on two.

## What was measured, not judged by eye

`.capture/shoot.mjs` reads the reading card's box, the page box and the
sheet from the DOM for every shot and writes them to `review/measure.json`.
The page's share of the card's height, single page (MOT certificate, paper
left), page 1 of 3 (Service history, paper right) and the phone:

| Screen | Card | Page box | Share | Card capped? |
|---|---|---|---|---|
| 1600×1000 | 480×763 | 595 | **78%** | no — content-height (cap 838) |
| 1280×720 | 480×558 | 390 | 70% | yes, at the screen's margins |
| 1093×614 (owner) | 480×452 | 284 | 63% | yes, at the screen's margins |
| 390×844, one page | 390×702 | 499 | 71% | no (foot on three lines) |
| 390×844, 1 of 3 | 390×670 | 499 | 74% | no (foot on two lines) |

Page 2 at 150% (zoom) is capped at every size; its share is the same as
the capped rows above (80% at 1600×1000, where the card reaches 838px).

**Why not 75% at every desk size.** The furniture is fixed at 166px:
26+22 padding, a 24px head line, two 10px gaps and a 74px foot row (two
32px lines inside a 4px-padded border). For the page to be 75% of the
card the card must be at least 664px tall. At 1093×614 the screen leaves
452px for it (614 − 84 chrome − 62 rail − 16), so the share is 63%; even a
one-line foot (40px, furniture 132px) would need 528px and still not
reach it. Without the mockup's 62px demo rail — the product has none —
the card would have 514px and the share would be 68% at 614 and 73% at
720. At 1600×1000, and on any screen 826px or taller, the card is
content-height and the share is 78%. Question **11** asks what to give up.

**The reading card's width at 1093.** It stays 480px: the pair is
480 + 28 + 480 = 988px and 1093 − 988 leaves 52px each side, more than the
24px asked for. The belt's own item card is `min(480px, 100vw − 56px)`,
so the two only narrow together below 1036px wide.

## What carries forward verbatim

- From `design/v19/item-belt.html`: everything above the ROUND 3 marker —
  markup, CSS and script untouched.
- From `../round-3/e-the-lanes.html`: the `.lanes` grid and its transition,
  the side rule, `openSheet`/`closeSheet`, the belt's dimming, the dead-space
  rule, the key hold, the focus block and its three honest states, the
  phone sheet's frame, the two-press remove. The build
  (`.capture/build.py`) is round 3's with only the reading card's own
  block replaced; every anchor asserts the base is unchanged.
- From `design/v19/create-v3.html`: the `.readcard` frame, 26px padding,
  fade and 16px slide; the `PAGE ONE` caption register; the cream `.sheet`
  and its under-sheet; `landed`; the `.attach` row's register (11px mono,
  hairline border, 9px radius) and its quiet word.

## Gates

- Packs: paper-left and paper-right captured in starchart, afterdark,
  clouds, dawn and retrograde at 1600×1000 and 390×844; nothing
  hand-coloured — the card is the belt's `.glass`, the words the pack's
  `--ink-faint`/`--ink`, the refusal line `--degraded`, the dates
  `--overdue-text`, scanned clean `--ok-text`, the pressed `fit`
  `--accent-text`.
- Screenshots: every scene × 1600×1000 × 1093×614 × 1280×720 × 390×844
  (touch enabled), plus remove armed, page 3 of 3 (the verdict's own
  scene) and reduced motion, in `review/`. Composites of create-v3 `snap`
  beside paper-left at 1600×1000 and at 1093×614:
  `review/composite-cv3-snap-vs-f-left-desk.png` and `-owner.png`. (At
  1093×614 create-v3 itself overflows the screen — its stage scrolls — so
  the elegance the owner remembers was seen at a taller size.)
- Looked at, every shot: no collisions or overflow in the round's own
  layer; the foot row's first line measured at 359px of 404 so the words
  stay beside the file name at 480px (`.capture/row.mjs`); the card
  re-levels when the page image arrives, so it never sits where the empty
  focus block put it.
- Motion checked by script (`.capture/motion.mjs`): as round 3, plus `−`
  at fit stays at fit; `+ + −` lands on 75%; a further `−` returns to
  `fit` with the word pressed; the card is 763px in a 938px lane, not
  full-height.
- `prefers-reduced-motion`: the lanes and the card change in place, the
  page lands without the settle; captured
  (`review/f-right-desk-reduced-motion.png`).
- Keyboard and aria: the card is `role="dialog"` with focus moved in and
  returned; page number and zoom percentage `aria-live="polite"`; every
  word that acts has a label (`Download Service history`, `Remove Service
  history: press again to confirm`).
- Targets: `close` 44px; the page arrows and zoom words 44px wide.

## Floors not met — said plainly

- The foot row's words — download, remove, restore, the page arrows, fit,
  − and + — are 32px tall, not 44: a 44px row of 11px words is the fluff
  the verdict names, and round 3's quiet remove set the same precedent.
  Arrows and ± keep 44px of width. Said, not fixed.
- The page's share of the card is under 75% on any screen shorter than
  826px (63% at the owner's 614), for the reason measured above: the
  screen, not the furniture, is the ceiling there.
- Phone at fit shows an A4 page at 340px wide: legible as a page, not as
  text, until pinched.
- Key hints are 9.5px, the belt's idiom for the same furniture.
- Seen, not this round's: at 1093×614 and 390×844 the belt's own end-caps
  (`← SOONER`, `LATER →`) sit under `← YOUR SKY` and the account orb.
  That is `item-belt.html` verbatim at a size it was never gated at; it
  wants an issue on the belt, not a fix here.

## Deliberately not done

- No second direction: the verdict names the mockup's rule; drawing it is
  the round.
- No page rail, no thumbnail strip, no drag-and-drop; no page for a
  document that is scanning, removed or refused. As round 3.

## Dependencies this round created

None new. Round 3's stand: `?page=N` and a page count on the preview
endpoint; a `?width=` for zoom past fit; `requestDocumentDeletion` and
`restoreDocument` already in `src/server/document-repository.ts`.

## Open questions for the owner

**11** On a 614px-tall screen the card reaches 452px and the page is 63%
of it. To get more page there, one of these gives: (a) accept it — the
page scrolls, and the screen is the ceiling; (b) let the card ride up
under the chrome strip to 16px from the top (cap 520px, share 68%); (c)
drop the second foot line on short screens and leave zoom to keys and
ctrl+wheel (share 70%). Which?

**12** On the phone a long file name pushes `download · remove` to a
third thin line. Keep that, or show the file name alone on line one and
the size and scan state with the page controls on line two?

## Verdicts

Not yet given.
