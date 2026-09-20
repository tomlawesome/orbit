# The document card — round 6 (#1059 previews and reader, #1054 download and restore)

One direction, H: the preview and the reader. Round 5's card (G) stripped
to a preview — the page, and a pager — with round 1's reading room brought
back as a window over the belt. The owner counts this as round 5; the
repo's round 6 is this directory.

Served at
`http://<LAN address>:8336/1059-document-card/design/v19/document-card/round-6/h-preview-and-reader.html`.
Same demo rail, scenes (`?scene=left|right|reading|zoom|scanning|removed|unrenderable|deadspace`;
`zoom` now opens the reader at 150%) and packs (`?theme=<pack>`) as before.

## The verdict this round answers

Round 5, owner, 2026-09-19, verbatim:

> Still scanning - animated the page with a line that moves up and down in
> the same colour as the outline, with a slighly luminescent glow.
> The preview should be extremely basic. It's nearly edge to edge PDF
> preview top, right end left sides. Below, there's a page number and an
> arrow left/right (only show when you can go back/forward) to flick through
> the page preview images.
> This text: 2 documents ride in the belt beside this item — the ringed
> bodies either side. click one to open it. changes to: N documents.
> The document preview image goes back to being clickable, and expands into
> the reader view that was approved before.

"The reader view that was approved before" is round 1's C, the reading
room, as ruled on in `../round-1/README.md`: "the full page zoom of the
reading room is great, but it should be a window over the top of the belt,
not a separate page. We need to be able to zoom the document size for
readability." C's thumbnail rail and its band tile were dropped then and
stay dropped. Done by the top model directly, as round 5 was.

## What changed from G

**The preview.** The card's padding is 10px; the page fills it top, left
and right. No head, no file row, no zoom. Under the page: `1 of 3`, with
`←` and `→` either side shown only when there is a page that way — a
one-page file shows `1 of 1` and nothing else. The arrows and keys
(← → PageUp PageDown Home End) turn the page in place. Pressing the page
opens the reader; it is a button, with a focus ring and a zoom-in cursor.
Esc and dead space close the preview as before; on a phone it is the same
bottom sheet, the page filling it.

**The honest states.** The line above the plate says what is happening
("Still scanning this file", "Removed 10 August 2026", the 422 sentence);
the foot holds only what can be done: `restore` for a removed file,
`download` for one Orbit could not draw, nothing while scanning. While
scanning, a 2px line in the plate's outline colour (`--paper`) sweeps the
plate top to bottom and back on a 2.2s ease, lit by a two-layer glow; it
stops under `prefers-reduced-motion`.

**The item card.** "2 documents ride in the belt beside this item — the
ringed bodies either side. click one to open it." is now "2 documents."
(`1 document.`, `no documents.`).

**The reader.** Opens over the belt: the belt dims to 82% of the pack's
background and blurs, nothing on it moves. Head: the file's name, the item
it is attached to, `page N of M`, and `close · esc`. The page as large as
the window allows in its own proportions, on the cream sheet with the deep
shadow, landing with create-v3's settle. The bar beneath: the same pager
at its head; `fit − 75% +` in the middle (100% is A4 at 96dpi; keys + − 0,
ctrl+wheel, pinch on touch; past fit the page scrolls inside the window,
never the belt; below fit is not offered); `download` and `remove` at its
tail as the item card's own action pills — download in the accent, remove
in the overdue tone like the card's `retire`, filling when armed — remove
being the two-press "tap again to remove" (#1054). (Owner, 2026-09-20, on
first sight of H: "The download and remove buttons should now actually
made a bit louder that theyve moved into the reader view.") Esc, the
close word, or a press on the dim outside the page closes the reader back
to the preview, focus returning to the page. Turning a page in the reader
turns it in the preview too. `role="dialog" aria-modal`, focus moved in
on open; page number and percentage are polite live regions.

## Measured

| Screen | Preview card | Page | Fit % in reader | Reader page fits |
|---|---|---|---|---|
| 1600×1000 | 480×705 | 440×623 | 75% | yes (595×842 in 1548×860) |
| 1093×614 (owner) | 302×452 | 261×370 | 41% | yes (322×456 in 1041×474) |
| 1280×720 | 377×558 | 336×476 | 50% | yes (397×562 in 1228×580) |
| 390×844 (phone) | 390×589 | 348×492 | 44% | yes (348×492 in 366×658) |

Every page at 1.415 (A4 1.414), whole, under-sheet drawn. The pager's
arrows: `[no, yes]` on page 1 of 3, `[yes, yes]` on page 2, `[yes, no]` on
page 3, `[no, no]` for the one-page MOT certificate. The scan line is on
the plate in every scanning shot (`::after` at 2px with a box-shadow).
150% in the reader draws the page at 1191×1685 and scrolls on every
screen. Fixed before this commit: the reader was fitting the page before
its bar existed, so the page ran 26px under the bar; the reader's markup
had swallowed the mockup's demo rail, which then sat over the bar.

## Decisions taken here, not asked

- The preview has no close control of its own: Esc, dead space, and the
  phone sheet's handle are the ways out, as rounds 3–5 had. A close word
  would be the one thing on the card that is not the page or the pager.
- Download and remove live on the reader's bar, not the preview. "Extremely
  basic" leaves them nowhere on the preview; the reader is one press away.
- The reader's fit uses the whole window height; the head and bar are what
  they are (44px each), so the page on the owner's screen fits at 41% and
  zooms from there.

## Verdict

Owner, 2026-09-20: "Very good job on 1059 at last. I have just one, very
small criticism. The download and remove buttons should now actually made
a bit louder that theyve moved into the reader view." Done in place
(pills, above) rather than as a new round, at the owner's request: "We
don't need a full mockup for that, just show me a quick screen shot".
Approval of the whole awaits that screenshot.
