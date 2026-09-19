# The document card — round 5 (#1059 previews and reader, #1054 download and restore)

One direction, G: the whole page. Round 4's card (F) with two faults fixed
and nothing else redrawn: the page is always shown whole, in its own
proportions, and the sheet under it — `create-v3.html`'s tilted second
sheet — is drawn for every file, one page or many. The owner counts this as
round 4; the repo's round 4 is `../round-4/`.

Served at
`http://<LAN address>:8336/1059-document-card/design/v19/document-card/round-5/g-the-whole-page.html`.
Same demo rail, scenes (`?scene=left|right|reading|zoom|scanning|removed|unrenderable|deadspace`)
and packs (`?theme=<pack>`) as rounds 3 and 4.

## The verdict this round answers

Round 4, owner, 2026-09-19, verbatim:

> 1059, the aspect ratio is all fubar now and you're missing the multipage
> backdrop to it that stylised it.

Then: "Don't palm this off to a subagent" / "Fix it yourself". This round
was done by the top model directly.

What was actually wrong in F, found by measuring it rather than reading it:

- The page was sized to the card's width and the card to the screen's
  height, so on any screen shorter than the page the box scrolled and the
  page was cut off — a cropped rectangle, not a page.
- The under-sheet was drawn only for files with more than one page
  (`.sheet.stack::before`), and even then the page box was a scrolling box
  that clipped it, so it never showed at all. The owner had not been shown
  it in any round since the mockup.

## What changed

- `.sheet::before` for every file; the page box no longer clips at fit
  (`overflow:visible`), so the under-sheet's lean shows on every side.
- `fitWhole()`: at fit the image is bounded by the room left for it on this
  screen (`--page-h`, measured from the card's own furniture) and never by
  the card's width alone, so it keeps its A4 proportions whole. The card's
  width then follows the page (`--readw`): 480px when the page is
  width-bound (a tall screen), narrower when it is height-bound (the
  owner's 1093×614 laptop). Floor 330px so the foot keeps its lines; below
  400px the foot's size line takes a row of its own.
- The zoom percentage is repainted after the fit, so it reads the page as
  drawn (round 4 printed the pre-fit figure).

## Measured (`.capture/shoot.mjs`, this file, `?scene=left`)

| screen | card w | page (px) | aspect | whole | foot rows |
|---|---|---|---|---|---|
| 1600×1000 | 480 | 408×577 | 1.415 | yes | 2 |
| 1280×720 | 330 | 249×352 | 1.415 | yes | 3 |
| 1093×614 (owner) | 330 | 174×246 | 1.415 | yes | 3 |
| 390×844 (phone sheet) | full | 340×481 | 1.415 | yes | 3 |

A4 is 1.414. `whole` = the image's box sits inside the page box, top and
bottom. The under-sheet is visible in every shot with a page. Past fit the
box scrolls as before (`?scene=zoom`, 150%).

## Verdict

Awaiting the owner.
