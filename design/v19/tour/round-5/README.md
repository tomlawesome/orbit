# First-run tour — round 5 (#866)

Round 4 was "very close now" (verdict verbatim in `../round-4/README.md`), so
round 5 carries it forward verbatim except the four things the verdict named.
One direction: **F — one take**, at
http://192.168.11.30:8335/v19/tour/round-5/f-one-take.html

Same twelve chapters, same ratified copy, same Lift mechanic, same holds, same
backdrops (copied from round 4 so the round browses on its own).

## The four fixes

**1 · After dark, not star chart.** Round 4's `:root` carried star chart's
tokens — they had ridden along mislabelled "after dark" since round 1 — while
every backdrop was captured in after dark, so everything drawn sat one pack
away from the screens it sat on. The block is now `packs.css`'s
`[data-theme=afterdark]` wholesale: ground, lines, all the ink tiers, and the
accent (`#7dd3fc`), so the callouts, the drawn drawer fields, the chips, the
lift glow and the transport match the screens under them. The two star-chart
ground literals in the drawn chrome (keycaps, ask-to-join) moved with it.
Chapter 11's dawn wear stays, and now also carries dawn's own accent
(`#1f7ac2`), which the transport and the lift rings wear there.

**2 · A compact centred transport.** The edge-to-edge bar is gone. The
transport is a 470×44 pill centred at the bottom: play/pause and stop at the
left, the time bar with its chapter ticks, the current chapter's name above
the playhead, `m:ss / m:ss` at the right. Painted marks are small; hit
targets are not — the buttons are 32px circles, and each tick is an 18×38
transparent button around its 1×8 painted mark (18px is the widest the tick
spacing allows without overlap). Everything round 4 proved is kept: space
toggles, Esc stops, tick jumps land on their chapters, hovering a tick names
it (the chapter label yields while it does), the focus ring, dawn wear. The
pill also recedes to 38% while the film plays and returns on hover, focus or
pause; the ended/stopped state keeps round 4's 16% ghost.

**3 · The relay in one movement.** Round 4 switched the background twice back
to back into chapter 6 — the first switch a cut — with the drawn body
vanishing between them. Now the sky dims first, the body dimming with it, and
the relay fades up under the veil: one directed movement. The same sweep
found the drawn body popping in *after* the crossfade at three other seams;
in chapters 7, 8 and 9 it now fades in with the sky. No other seam changed.

**4 · The belt shows the page itself.** The one place the round grows, drawn
from what #1059 (document previews in the UI) should ship:

- The centred card shows a real page-one render where round 4's line-plate
  was, captioned `page 1 of 2`; the "not something Orbit holds yet" note goes
  (the belt sentence beneath it stays, because it is still true).
- A new beat: the page is pressed — the Lift, like every other control — and
  opens to read at 424×600 over the veiled belt, held long enough to see it
  is a real document. One new callout line covers it (below).
- Out in the belt, a document body wears its page: a 28×38 page-shaped tile
  carrying the top of the real render. **Decision:** a raster thumbnail at
  asteroid scale would be grey mush, but a white page-shaped tile stays
  legible at belt scale and is still the real render — legibility floor over
  literalism, without inventing an icon. Both ringed documents wear one
  (`MOT certificate 2025` is no longer a plain asteroid), and the tiles dim
  with the veil whenever nothing lights them (chapter 9, and the certificate
  while the card holds the light).

## The renders are real

`shots/preview-service-history.png` and `shots/preview-mot-certificate.png`
are the output of Orbit's own preview renderer — `renderDocumentPagePreview`
in `src/server/documents/preview.ts`, the function the `#476` endpoint runs,
same parser options, same 1200px edge — over two PDFs authored for the data
story (a garage service history and an MOT certificate for the Volvo V60,
printed by Chromium). The fixture app could not serve them: its `/api`
fixtures are metadata only, and the preview endpoint has no fixture route —
its real path needs a session and a database — so the renderer was driven
directly on real PDF bytes rather than drawing a fake page. What is drawn is
only the tiles' and card's placement; no page pixel is hand-made.

## New copy

The round's only new text, all in the belt chapter: the callout **"The page
itself, read without leaving the sky."** and the mono labels `page 1 of 2`
and `Service history · page 1 of 2`. Everything else is round 4's.

## The film

Measured length **3:41** (round 4 ran 3:34; the reader beat costs the
difference). Measured chapter starts:

| # | Chapter | Starts |
|---|---------|--------|
| 1 | Arrive | 0:00 |
| 2 | Add | 0:22 |
| 3 | Lands | 0:47 |
| 4 | Below the dial | 0:57 |
| 5 | Time runs | 1:11 |
| 6 | Paper by post | 1:27 |
| 7 | Inbox | 1:42 |
| 8 | The belt | 2:05 |
| 9 | Done | 2:41 |
| 10 | Other households | 2:57 |
| 11 | Your sky | 3:10 |
| 12 | Yours | 3:30 |

Reduced motion measures **2:07** and keeps round 4's rule: reading time is
not motion, so callout holds are the same length in either mode.

## Backdrops

All thirteen backdrops in `shots/` are round 4's, copied unchanged — origin,
recipe and the stitched/drawn caveats are in `../round-4/README.md`. New in
this round are only the two preview renders above. Drawn rather than
captured, as round 4 drew: the drawer's five fields, the scroll's two orbs,
ask-to-join — plus this round's page tiles and the card's render-for-plate
swap.

## Self-review

Every chapter and every changed surface photographed through the design host
into `shots/review/` (untracked), looked at, fixed, recaptured: the tick
tip overprinted the chapter label (the label now yields), the reader's
caption collided with the belt screen's own header (it now sits below the
page), and the field pages floated at full strength above chapter 9's veil
(they now dim with the screen).

Headless end to end: **no console errors**, the clock ends `3:41 / 3:41`,
pause holds the reading dead still for three seconds and resume continues
it, ticks 4, 8 and 11 land on their chapters, space toggles, Esc stops and
fades the pill, hover brings it back.

## Known limits

- Round 4's two stand: the manifest lists the fixture's MOT at T−16d, and
  `explore your world` sits under the transport on the home screens — the
  receded pill (and the end-state ghost) overlap it there.
- The reader shows page one only; page-turning is #1059's to design against
  the real endpoint, which serves page one today.
