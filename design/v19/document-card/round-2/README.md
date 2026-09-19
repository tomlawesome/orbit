# The document card — round 2 (#1059 previews and reader, #1054 download and restore)

One direction, D: the paper's top sheet. Round 1's separate document card
is gone. A document stays a paper riding the belt beside its item; clicking
it (or Enter on it) opens create-v3's top sheet over the belt on the paper's
own side, with page one at full height. The sheet is the reader — pages
turn, the page zooms — and download, remove and restore sit at its foot.
Clicking dead space on the belt closes it. The belt beneath is
`design/v19/item-belt.html` verbatim and does not move; it dims.

Served at
`http://<LAN address>:8336/1059-document-card/design/v19/document-card/round-2/<file>`.
`d-the-papers-top-sheet.html` is the one sheet. Its demo rail (sheet
furniture, not design) has a SHEET group: paper left · paper right ·
focusing · page 2 zoomed · still scanning · being removed · cannot draw ·
dead space. The same scenes answer to
`?scene=left|right|reading|zoom|scanning|removed|unrenderable|deadspace`
and every pack to `?theme=<pack>`.

## The verdict this round answers

Owner, 2026-09-19, verbatim (also recorded in `../round-1/README.md`):

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

## The one data story (identical to round 1)

The Lawson household's belt, arriving from the car. The same six documents;
the page renders are round 1's (`../round-1/pages/`), drawn from the story's
PDFs by the preview endpoint's own renderer.

| Document | Rides beside | State | What the sheet shows |
|---|---|---|---|
| MOT certificate 2025 (1 page, 240 KB) | Car MOT — Volvo V60, left paper | scanned clean | page one, "one page", zoom, download, remove |
| Service history (3 pages, 88 KB) | Car MOT — Volvo V60, right paper | scanned clean | page 1 of 3 on a stack; page 2 at 150% |
| renewal-notice.pdf (312 KB) | Car insurance | still scanning | the plate breathing, "Still scanning this file"; no page, no download |
| tyre-invoice-2025.pdf (164 KB) | Winter tyre swap | removed 10 August 2026, kept until 9 September 2026 | dashed plate, the dates, restore |
| policy-schedule.pdf (812 KB) | Home insurance | scanned clean, preview refused (422) | the plate, the 422 sentence, download |

## Direction D — the paper's top sheet

**Where it opens.** The paper's own side. The sheet's lane is the sky
between the screen edge and the apex card: a paper left of the card opens
a sheet from the left edge to 22px short of the card; a paper on the right,
the mirror. The card, the rocks, the captions and the end-caps stay exactly
where they are and dim (band and rubble to 38%, other bodies to 42%, the
card to 72%); the open paper keeps its rim lit. On a desk narrower than
about 900px the lane is under 400px, so the sheet keeps its outer edge and
lies over the card's shoulder instead — a window, still, not a lane.

**How it opens.** create-v3's readcard, verbatim: it fades in over .55s and
slides its last 16px into place over .65s (the `.4,.5,.15,1` curve),
from the belt outward. While page one is on its way the sheet shows
create-v3's focus — the reticle, "Focusing on the anomaly" breathing, and
its two quiet lines — for at least a beat (900ms) and until the page has
actually loaded; then the page lands with create-v3's `landed` settle
(8px up, .985 to 1). The paper frame is create-v3's `.sheet` (the cream
sheet, the 44px shadow); a multi-page document shows the under-sheet at
-1.1° beneath, a single page does not.

**The sheet is the reader.** Page one at full height, fitted to the sheet.
Pages turn with ← → (also PageUp/PageDown, Home, End) and the bar's arrows,
announced "page N of M" on a polite live region; a one-page document says
"one page" and has no arrows. Zoom is a real control: `fit`, `−`, the
percentage, `+`, where 100% is A4 at 96dpi; keys `+`/`−`/`0`; ctrl+wheel;
pinch on touch. Past fit the page scrolls inside the sheet's page box,
never the belt. Round 1's page rail is dropped: at three pages it earned
nothing inside a sheet.

**The foot (#1054).** create-v3's attach row, verbatim — ◆ file · size ·
scanned clean — with the row's quiet button at its end being `remove`:
first press arms it and the wording turns to "tap again to remove" (the
household page's own two-press pattern), second press removes; it disarms
after four seconds. `download the original` is the one primary button,
beneath. A document pending deletion shows the dates in the row and
`restore` as its only primary. Scanning has no buttons: the row says
"scanning".

**The honest states** are the focus block held still — the reticle at rest,
the plate where the page would be, the line said once: "Still scanning this
file" (soon: the page and the download come once it scans clean); "Removed
10 August 2026" (kept 30 days, restore puts it back exactly as it was);
"Orbit could not draw a picture of this document." (the endpoint's own
sentence, in the pack's degraded tone) with the 422 explanation beneath
and download to hand. Never a blank or a fake page.

**Closing.** Esc; the sheet's own `close`; or a press on dead space.
Closing returns focus to the paper's hit on the belt.

**Phone (≤680px, the belt's own breakpoint).** The sheet becomes CON-10's
bottom sheet — `web/src/routes/home/pocket.css` `.sheet` verbatim: fixed to
the foot, 18px shoulders, the grab, panel-raised glass with the blur, up
from 105% below in .3s — at 88% of the screen, the page filling it, zoom by
pinch (and the same bar). The `· esc` hint is hidden where there is no
keyboard.

## What counts as dead space

While a sheet is open, a press anywhere that is not one of these closes it:

- the sheet itself;
- the apex item card and its buttons;
- a body's hit on the belt (rock or paper, the ringed circle);
- the chrome: `← YOUR SKY`, the `TL` orb and its menu, the find field;
- the mockup's own rail and pack swatches.

Everything else is dead space: the sky, the band and its rubble, the
captions under the rocks (they are `<text>` with no handler), the sooner /
later end-cap text, the item count under the find field. The `dead space`
scene draws a dashed outline round every live target so the rest reads as
closing. Pressing another paper's hit does not close-then-nothing: it opens
that paper's sheet (a paper folded inside a different item rolls that item
in first). Pressing an item's rock closes the sheet and rolls the item in,
as it does today.

## Gates

- Belt verbatim: `design/v19/item-belt.html` markup, CSS and script
  untouched above the ROUND 2 marker; packs from `web/src/lib/packs.css`.
  Nothing on the belt moves when the sheet opens.
- create-v3 verbatim: readcard transition, `landed`, `.sheet` frame and
  under-sheet, reticle, `breathe`, `.attach` row and its quiet button
  copied from `design/v19/create-v3.html`; only the line under the focus
  changed to say what is happening ("orbit is drawing page 1 of the file it
  holds / nothing is changed, and nothing is assumed").
- Packs: paper-left and paper-right captured in starchart, afterdark,
  clouds, dawn and retrograde; nothing hand-coloured — the sheet is the
  belt's `.glass`, buttons the pack's `--accent`, the refusal line
  `--degraded`, the dates `--overdue-text`, scanned clean `--ok-text`.
  Clouds holds: the cream sheet sits on the pack's panel glass.
- Screenshots: every scene × desk 1600×1000 × phone 390×844 (touch
  enabled), plus remove armed. Fixed before this commit: the zoom bar
  wrapping to a second row; download and restore wrapping under the attach
  row (now their own row beneath); a one-page document showing two dead
  arrows; the key hint truncating mid-word; the bar showing a percentage
  while the page was still on its way; a duplicate state-dressing hook.
- `prefers-reduced-motion`: the sheet appears in place, the focus block
  shows without breathing or sweep, the page lands without the settle, the
  belt dims without transition; the belt's own rule is untouched.
- Keyboard and aria: the sheet is `role="dialog"` with focus moved in on
  open and returned to the paper on close; belt keys are held while a sheet
  is open (← → turn pages there); on the belt itself ← → step items only,
  never into a paper; page number and zoom
  percentage are `aria-live="polite"`; every button has a label.
- Targets: close, the page arrows, download, restore are 44px; zoom
  buttons 38px inside a 44px pill; the quiet `remove` is 32px tall.

## Floors not met — said plainly

- The quiet `remove` is a 32px target, as create-v3's "not this one" is
  and as the household page's own two-press remove is; raising it to 44px
  would make the row's tail read as a second primary. Said, not fixed.
- Phone at fit shows an A4 page at 358px: legible as a page, not as text,
  until pinched — that is the zoom's job, and it is there this round.
- The sheet covers the open paper on a desk: the lane it opens into is the
  lane the paper rides in. Its rim stays lit but is under the sheet. On a
  phone the sheet covers the whole belt, as the pocket does.
- Key hints are 9.5px, the belt's idiom for the same furniture.

## Deliberately not done

- No E. A real fork was looked for and not found: the owner named the view,
  the side rule and the close rule. The two forks that remain are build
  questions (6 and 7 below), not compositions.
- No page rail; no thumbnail strip. Three pages do not earn one.
- No drag-and-drop onto the belt. create-v3's drop is how a document
  arrives; this sheet is how one is read.
- No page for a document that is scanning, removed or refused.

## Dependencies this round created

- **Pages after the first** still need either `?page=N` on the preview
  endpoint plus a page count in the document's metadata, or PDF.js in the
  browser over the download bytes (round 1's question 2, carried).
- **Remove and restore** have their server halves already:
  `requestDocumentDeletion` and `restoreDocument` in
  `src/server/document-repository.ts`. The sheet's two-press remove and
  its restore are the same calls the household page makes.
- **Zoom** past fit at 150–400% wants the page rendered wider than the
  848px round-1 renders; either a `?width=` on the preview endpoint or the
  client rendering (the same fork as pages).

## Open questions for the owner

**6** Pages after the first (round 1's question 2, still open): a page
parameter on the preview endpoint, or PDF.js in the browser from the
download bytes? Zoom beyond 150% depends on the same answer.

**7** Should a document Orbit cannot draw open the sheet at all (as drawn:
the plate, the sentence, download to hand), or should the paper's press go
straight to download?

**8** On a desk the sheet covers the paper you pressed. Keep (the sheet is
the paper, opened), or leave a strip of belt so the paper stays in view
beside its sheet?

## Verdicts

Not yet given.
