# The document card — round 1 (#1059 previews and reader, #1054 download and restore)

Three compositions for what happens when a document is the centred body on
the v4 item belt: page one shown for real in place of the PDF plate, a way to
read the whole document without leaving Orbit, and where download and restore
sit. Every sheet is the shipped belt verbatim (`design/v19/item-belt.html`
markup and CSS, packs from `web/src/lib/packs.css`); only the document card
and the reader are new. Belt positions and the sooner/later end-caps are not
touched.

Served at
`http://<LAN address>:8336/1059-document-card/design/v19/document-card/round-1/<file>`.
The demo rail at the foot of each sheet (sheet furniture, not design) has a
DOCUMENT group: page one · reader · 3 pages · still scanning · being removed ·
cannot draw. The same scenes answer to `?scene=card|reader|scanning|removed|
unrenderable` and every pack to `?theme=<pack>`.

## The one data story (identical across directions)

The Lawson household's belt, arriving from the car. Six documents ride it;
five are used by the scenes.

| Document | Rides beside | State | What the card shows |
|---|---|---|---|
| MOT certificate 2025 (1 page, 240 KB) | Car MOT — Volvo V60 | scanned clean | page one, download, read |
| Service history (3 pages, 88 KB) | Car MOT — Volvo V60 | scanned clean | page one; the reader turns three pages |
| renewal-notice.pdf (312 KB) | Car insurance | still scanning | plate breathing; no page, no download yet |
| tyre-invoice-2025.pdf (164 KB) | Winter tyre swap | removed 10 August 2026, kept until 9 September 2026 | dashed plate, restore |
| policy-schedule.pdf (812 KB) | Home insurance | scanned clean, preview refused (422) | the plate as shipped; download; reader says why |

The page pixels are real. `.capture/make-pages.ts` prints the story's PDFs
with Chromium and pushes page one of each through
`renderDocumentPagePreview` — the exact function the preview endpoint runs
(`src/server/documents/preview.ts`, 1200px edge, PDF.js legacy build on
`@napi-rs/canvas`). Pages two and three of the service history come from the
same PDF.js build with the same parser options, because the endpoint takes no
page parameter yet (see the dependency below). Nothing is an SVG stand-in.

Copy, every direction: the belt subline says `scanning` or `being removed`
in place of the size; the card's scan row says `scanned clean` / `scanning` /
`removed` + `gone for good`; the refusal sentence is the endpoint's own 422
wording, "Orbit could not draw a picture of this document", followed by what
is still true: the file scanned clean and is yours to download.

## The four calls, answered

**Page one on the card.** The plate's seat holds page one as Orbit drew it —
a white sheet with the pack's paper line round it — and the "not something
Orbit holds yet" note is retired. Pressing the page reads the document. The
plate stays only for the three honest cases: still scanning (the outline
breathes on the belt's 2.6s period; still under reduced motion), being
removed (dashed, dimmed) and a file Orbit could not draw (the plate exactly
as shipped, with the 422 sentence). Never a blank or a fake page.

**The paper in the band.** A and B keep the ratified 17px rock and mark:
at that size a page is a white chip, not a page, and the owner has already
killed the v3 paper symbol. A adds a look on hover or keyboard focus (the
lens, below). C is the deliberate counter-example — the rock wears its own
page one — so the owner can see it and say no.

**The reader.** Three answers: over the belt (A), the card grown in its
berth (B), a room of its own (C). All three turn pages with ← → (also
PageUp/PageDown, Space, Home, End), close on Esc, are `role="dialog"
aria-modal`, and announce "page N of M" through a polite live region. A
document Orbit cannot draw opens the same reader with the plate and the 422
sentence in place of the page, download to hand — the reader is where the
reader expects to be told.

**Download and restore (#1054).** On the card, under the page, in the
belt's own action row: `download the original` is the one primary button of
a live document, with `read · N pages` quiet beside it. A document pending
deletion has one action, `restore`, primary, with the removed and gone-for-
good dates in its rows and one plain sentence of what happens. A scanning
document has no actions: the rows say why. Inside the reader, download rides
at the right of the bar.

## Directions

**A — the page in the seat** (`a-page-in-the-seat.html`). The card changes
least: page one in the 104px column the plate had, so no row beside it
moves; the actions beneath. Reading opens over the dimmed, blurred belt in a
760px stage with prev/next, a page strip, a key hint and download; Esc gives
the belt straight back, exactly as left. In the band, hovering or focusing a
ringed paper shows a lens — an 88×124 page one beside the rock — so a paper
can be told apart without leaving the belt or growing the rock. Refusal
shrinks the stage to the words. Recommended: it answers every call without
moving anything the owner has already ratified.

**B — the card is the page** (`b-card-is-the-page.html`). Page one leads the
card at full width, cropped to the top of the page (34vh, capped 340px) with
a caption "the top of page 1 of N · read the whole page →"; rows and actions
follow. Reading grows the same card in its berth to 900px and the pages turn
inside it; Esc shrinks it back. Nothing new is opened — the card is the
reader. The cost is visible in the shots: the grown card is ~700px tall on
desk and no longer reads as riding in the band, and on phone it goes full-
bleed anyway. Non-renderable states shrink page one to a small plate beside
the name.

**C — the reading room** (`c-reading-room.html`). A larger page on the card
(132px), the paper in the band wearing its own page one inside the ratified
ring, and reading leaves the belt for a room: sky only, "← THE BELT" top
left, the page as large as the screen allows, a rail of page thumbnails
down the left with the current one ringed, the bar beneath. The strongest
reading experience of the three and the most literal — but the band tile is
a 24×34 white chip, which is the v3 paper symbol by another name. Kept in so
the owner sees it rather than reads about it.

## Gates

- Renders real: page one via `renderDocumentPagePreview`; pages 2–3 via the
  same PDF.js pipeline (`.capture/make-pages.ts`).
- Packs: card and reader captured in starchart, afterdark, clouds, dawn and
  retrograde for all three directions; nothing hand-coloured — the sheet's
  border and the rail's ring use `--paper`, buttons the pack's `--accent`.
  Clouds (light) holds: the white page sits on the pack's `--panel` glass
  with its `--paper` line; the room's floor is `--bg` at 86%.
- Screenshots: every scene × desk 1600×1000 × phone 390×844, every pack for
  card and reader, plus A's belt with a paper focused. Fixed before this
  commit: read wrapping under download in the narrow column; the page-
  count suffix breaking the kind row; a white focus ring on the stage; A's
  refusal opening a huge empty stage; phone chrome colliding (find over
  "← YOUR SKY", footer and rail over the card) — the shipped 680px rule
  applied, footer hidden while reading; B's card at 810px tall (now cropped
  top); B's grown card under the chrome on phone; C's room showing chrome
  and rail through; C's title breaking mid-word on phone (sheet drops to
  104px); B's small plate label overflowing; A's lens covering the rock's
  label; the reader's page and bar running 16px past a phone's edge in A
  and B.
- `prefers-reduced-motion`: the plate's breath, the lens, the reader and the
  grown card all go still; the belt's own rule is untouched.
- Keyboard and aria: page is a button; reader is a modal dialog with focus
  moved in and returned on close; belt keys are held while reading; page
  number is `aria-live="polite"`; every rock's label speaks its state
  ("still being scanned", "removed, kept until 9 September 2026").
- Targets: download, restore, read, close, the page buttons and the room's
  way back are all 44px tall (the belt's own item buttons keep their
  shipped 33px; only the document's are raised); the belt's hits are the
  shipped ones.
- Density: nothing added to the belt itself beyond A's lens, which appears
  only on hover or focus.

## Floors not met — said plainly

- Phone reader is fit-to-width: an A4 page at 362px is legible as a page
  but not as text without zoom, in all three directions. Pinch-zoom on the
  page is a build question, not a composition one; none of the sheets
  pretends otherwise.
- C's band tile (24×34) is under the legibility floor by design — it is
  there to be rejected or ratified on sight.
- Key hints and captions are 9.5px, the belt's own idiom for the same
  furniture (rock sublines, plate labels); not new.

## Deliberately not done

- No "remove" action on the card: #1054 asks for download and restore; where
  deletion starts is the item card's question, not this one's.
- No zoom in the reader; no page-N endpoint (that is a build ask, below).
- No page for a document that is scanning or removed — the plate is the
  honest answer and the belt's subline says the same.
- The lens is A only; B and C answer identification differently (B: not at
  all beyond the label; C: the tile).

## Dependencies this round created

- **Pages after the first** need either a page parameter on the preview
  endpoint (`?page=N` plus a page count in the document's metadata) or the
  client rendering pages itself with PDF.js over the download bytes. That
  is an architecture call, not a composition one — question 2 below.
- The 422 refusal sentence and "Orbit could not draw a picture of this
  document" are the endpoint's own; the sheets quote them, they do not
  restyle them. (ADR-0027 at HEAD is the email second factor, not a copy
  ADR; the copy here follows the refusal vocabulary in
  `src/server/documents/preview.ts`.)

## Open questions for the owner

**1** Which direction — A over the belt (recommended), B the card grown, or
C a room of its own?

**2** Pages after the first: a page parameter on the preview endpoint
(server draws every page, one raster each) or the browser drawing pages
itself with PDF.js from the download bytes (one fetch, client work)?
The sheets are neutral; the build is not.

**3** C's band tile — the paper wearing its page one at 24×34 — keep or
kill? The sheets lean kill (it is the v3 symbol again).

**4** Should a document Orbit cannot draw open a reader at all, or should
the card's download button be the whole answer? The sheets open the reader
so the reason is said in the same place a page would be.

**5** Where "remove" starts is not answered here; is that the item card's
question or this card's?

## Verdicts

Not yet given.
