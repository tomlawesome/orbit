# First-run tour — round 6 (#1093): chapter 8 re-cut

Round 5 is the ratified film (`../round-5/README.md`, owner-decisions.md §23)
and **eleven of its twelve chapters stand untouched**. This round re-cuts
chapter 8, "The belt", alone, because the belt changed twice underneath it:

- **#1062** made `← sooner` / `later →` real controls. Round 5's second
  correction already flagged the invented arrow keycaps and deferred the
  replacement to this round.
- **#1088** built the document preview §18 ratified: pressing a paper opens a
  reading card **beside** the item card. A document is never the centred
  body — so round 5's beat where the service history "comes to centre and
  the card becomes the document's" now shows a screen that does not exist,
  and the centred document card it cut from the mockups is deleted outright
  on `feature/1088-document-preview`.

Everything the film inherits still binds: one continuous take, no
step-through card; the Lift mechanic, no drawn pointer; demo data drawn on
screen only and removed on skip or finish, nothing written to the database;
desk dialect only (the pocket cut is #1083 and stays deferred).

## What round 5's chapter 8 loses

- **The invented ← → keycap buttons** and their label "← → step through the
  belt". No such control exists; the real steppers are the end-caps.
- **The document coming to centre** (`belt-doc.png`, the doc card, the mono
  captions `page 1 of 2` and `Service history · page 1 of 2`). The captions
  die with the card, and would die anyway: #1088 cut the page counter and
  its arrows by owner decision of 2026-09-22 — Orbit records no page count.
- **The 424×600 reader overlay.** §18's reader (the page as a button, `fit −
  % +`, round arrows) is #1059's and is not built; the preview card is the
  read surface the shipped screen actually has, and the film only teaches
  what ships.
- **The 28×38 page tiles** (`wearDocs`/`wearDim`). The shipped mark for a
  paper is document-card round-6's, ruled in `belt.css` ("THE DOCUMENTS'
  MARK"): a small rock inside a hard perimeter ring in `--paper`, a soft
  glow behind it over a faint disc, the document's name beneath in the same
  tone, the whole mark breathing on a 2.6s cycle. The film draws that mark
  (ring, halo, label) over its static captures so it breathes as the screen
  does; round 5's rule carries to it verbatim — the marks dim with the
  veiled screen whenever nothing lights them (chapter 9, and the
  certificate while the reading card holds the light).

What survives: the arrival seam, both belt callouts, the press-a-paper beat,
the reader line, and the two real renders in `../round-5/shots/`
(`preview-service-history.png`, `preview-mot-certificate.png`) — the page
pixels are still Orbit's own renderer's, nothing hand-drawn.

## The controls, named by the shipped code

Every lifted thing in this chapter corresponds to a real element on the item
screen (`web/src/routes/item/[[id]]/`), as built on `dev` plus
`feature/1088-document-preview`:

| Film beat | Shipped element |
|---|---|
| The Volvo pressed on the sky | the home screen's item body (unchanged from round 5) |
| The two ringed papers | `#seats g.seat > g.hit` for a `kind === "doc"` body: rock + `circle.rim` + the `--paper` mark (`.halo`, `.ring`, `.ringsoft`, `.doclabel`) |
| The paper pressed | the same `.hit` — click, Enter or Space call `openDoc(i)`; the rim stays lit while its reading card is out (`.hit.open .rim`) |
| The reading card | `aside.readcard` in `#lanes` — the grid widens on the paper's own side, the item card (`#cardwrap`) slides over, the pair centred together |
| `later →` pressed | `#ends g.endcap-hit[data-step="1"]` — `text.endcap` reads `later →`; the lift ring wraps its `rect.endtarget` hit box (≥ MIN_TARGET square), not the 9.5px ink |
| `← sooner` pressed | `#ends g.endcap-hit[data-step="-1"]`, same anatomy |

Both end-cap presses route into the screen's own `onStep` — the identical
function the ArrowLeft / ArrowRight keys call (#1062: one step, not two).
The demo belt seats the Volvo with an item on each side, so neither cap is
in its spent `.off` state during the chapter; the spent state is real
(`aria-disabled`, dimmed ink) but is not toured.

## The beats, in order

**Beat 1 — arrival** (unchanged from round 5). The inbox veils; `home.png`
crossfades up with the drawn body fading in with the sky (round 5's seam
fix). The dot travels to the Volvo's body, lifts it, presses; the item
screen crossfades in: the card at the apex, the band, and the two papers
ringed and breathing beside it.

**Beat 2 — the papers.** The certificate's mark is lit (no press):

> **"Every body carries its documents in a belt around it."**

Then the service history's mark is lit (no press):

> **"The belt is what you have attached to it."**

Both lines are round 5's, verbatim. The film lights the whole mark — ring,
halo, label — not a bare circle.

**Beat 3 — the paper pressed, the page beside the card.** The service
history stays lifted; its label appears above it:

> **"Click one to bring it in."** *(label, 2.0s hold — round 5's line,
> re-anchored: it is now literally true, the page comes in beside the card)*

The paper is pressed. What follows is the shipped choreography, re-enacted:

- The item card — cut from the capture — slides to its lane seat over 750ms
  (the shipped ease, `cubic-bezier(.4,.5,.15,1)`) while the backdrop
  crossfades beneath; the reading card grows on the paper's own side
  (right, in the demo layout), the pair centred together. The paper's rim
  stays lit.
- The reading card is drawn, as round 5 drew the reader: the glass panel at
  the shipped measure (480px lane, 28px gap), first the **focus block** —
  the reticle, "Focusing on the anomaly", the two `why` lines — held 0.9s,
  the shipped minimum beat, then the **sheet lands** (0.6s, the shipped
  `belt-landed` ease): page one of the service history, whole, in its own
  proportions, nearly edge to edge on the cream sheet with the tilted
  second sheet under it. No caption, no page counter, no arrows, no close
  control — the shipped card has none.
- Beside it:

> **"The page itself, read without leaving the sky."**

The page pixels are `../round-5/shots/preview-service-history.png` — the
real render, unchanged. The honest states (scanning, removed, refused,
undrawable) are the screen's own and are deliberately not toured: the demo
documents are clean and drawable, and a 34-second chapter teaches the happy
path. The card holds open through the next travel — about eleven seconds of
page on screen — because the thing that closes it is the next beat.

**Beat 4 — the belt steps, by pointer.** The dot travels to the `later →`
end-cap at the band's right edge; the cap lifts (ring around its real hit
box):

> **"later → steps the belt — so do the arrow keys."** *(new copy, the
> round's only new line)*

The cap is pressed. Exactly as the shipped screen does it, two things happen
together: the reading card folds away (its 0.8s fade — a paper folded inside
an item that is leaving the apex cannot stay open) and the belt rolls one
later — the Volvo's card rides out along the band, the neighbour's card
blooms in at the apex, the papers fold in.

Then the dot crosses to the `← sooner` end-cap at the left edge, lifts and
presses it, no callout: the belt rolls back, the Volvo's card returns,
papers out, reading card closed. One press each way shows the pair is a
pair; the copy has already said the keys do the same. End state: the
Volvo at the apex, both papers ringed and breathing — chapter 9's opening
frame exactly.

**How the preview closes, for the record:** on the real screen Esc, a press
on dead sky, or any move of the belt closes it. The film shows the third —
the step — because it is the one the chapter is already teaching, and adds
no copy for the others: not every affordance is toured, and round 5 never
toured Esc either.

## Reduced motion

Round 5's rule holds: **reading time is not motion**, so every callout hold
is the same length in either mode. The cut drops, as motion:

- the lane slide (the grid is simply open, the card simply seated),
- the focus beat and the sheet's landing (the page is simply there — the
  shipped screen's own reduced-motion behaviour, `openPreview`'s 0ms beat),
- the roll tween (the belt simply turned, the card simply the new one),
- the marks' breath (ring and halo held at full, as `belt.css` holds them),
- and film-wide: travel arcs, lifts, press bumps, crossfades.

Chapter 8 under reduced motion is its five holds: ≈ 19.5s (round 5's was
≈ 17.3s), putting the reduced-motion film at ≈ 2:09 (was 2:07).

## Timing

Computed from the film's own `T` constants and the shipped transitions, the
same arithmetic that reproduces round 5's measured 36s for this chapter:

| Beat | ≈ |
|---|---|
| 1 · arrival | 2.4s |
| 2 · the papers | 11.4s |
| 3 · the page beside the card | 8.9s |
| 4 · the steps | 11.1s |
| **Chapter 8** | **≈ 34s** (round 5: 36s) |

**The chapter shortens by ~2s, so every later chapter moves up:**

| # | Chapter | Round 5 | Round 6 |
|---|---------|---------|---------|
| 8 | The belt | 2:05 | 2:05 |
| 9 | Done | 2:41 | **2:39** |
| 10 | Other households | 2:57 | **2:55** |
| 11 | Your sky | 3:10 | **3:08** |
| 12 | Yours | 3:30 | **3:28** |
| — | film ends | 3:41 | **≈ 3:39** |

These are computed, not measured — the built film's own clock is the
measure, as round 5's was, and supersedes this table if it lands a second
either way. The transport's ticks take whatever the build measures.

## Builder's notes

- **Backdrops.** Chapter 8's belt captures (`belt.png`, the stepped
  neighbours, and a `belt-read.png` with the lanes open) are recaptured
  from the **shipped item screen** — `dev` plus
  `feature/1088-document-preview`, which must be merged or checked out for
  the capture — in after dark, at the film's stage size. Round 5's
  `belt-doc.png` retires. The papers' mark is drawn live over the captures
  (it breathes; a capture would freeze it), so capture with the marks
  suppressed or crop them out.
- **Chapter 9 is not reopened**, but three mechanical things follow it
  around: its `enter` point becomes the `← sooner` cap's position (chapter
  8's last dot); its `belt.png` cut rectangles (the card, the done button)
  are re-measured against the recapture; and its dimmed field papers are
  the drawn marks now, not page tiles — same dimming rule, round 5's,
  verbatim.
- The end-caps sit at `x = 28 + inset` and `W − 28 − inset` on the band's
  line in the real screen; take their stage coordinates from the capture,
  not from this document.
- Copy word-counts for the holds: the new line is 11 tokens under the
  film's `words()` (arrows count), so `holdFor` gives 4.85s.

## Known limits

- Round 5's two stand (the T−16d manifest date; `explore your world` under
  the transport), plus: the film shows page one only and never presses the
  page — **when #1059's reader ships, chapter 8 may earn a reader beat,
  and that is its own re-cut against the shipped reader**, exactly as this
  round was against the shipped preview.
- The preview's honest states and the end-caps' spent state exist and are
  untoured, by the decision recorded in beat 3 and the controls table.

## Decisions made here, and none needing the owner

Two calls a reader might have made differently, both mine to make and both
recorded above: the honest states are not toured (happy path only, length),
and the close is taught only by the step (no Esc copy). Nothing in this
round needs an owner ruling: the end-caps' existence is #1062's shipped
answer to round 5's open question, the preview's shape is §18 ratified and
#1088 built, and the counter's absence is the owner's own 2026-09-22
decision. The 2-second shortening and the knock-on starts are mechanical.

Written by Fable 5, 2026-09-23.
