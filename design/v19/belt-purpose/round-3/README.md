# What the belt is for — round 3 (#1304): the preview beside, tracked

Round 2's verdict: beside (D), with three changes. One direction, F,
from `../round-2/d-preview-beside.html`, everything else carried forward
verbatim.

- `f-preview-beside-tracked.html` — the preview card's top is level with
  the open item card's top, always: it is laid out as the card's sibling
  in the same row, not floated lower. Scrolling the page moves the two
  together, and when the item card is taller than the window the preview
  stays in view beside it (sticky within the card's height) so the page
  never scrolls the preview away while the card is still showing. A press
  anywhere off the card removes it at once: no fade, no slide. The pencil
  and link icons sit at the drawer's foot, at the right end of the action
  pills' row, the pills still centred.

And (owner, same day): "Notes go before the documents." The notes section
sits above the documents section in every scene.

Scenes `?scene=` listed at the top of the file; packs by `?theme=`.

## Notes from the build

- The preview is sticky at an 84px top gutter, not 24: at 24 the
  top-right buttons covered the page. Desk scenes scroll the drawer to
  84px too, so the two tops stay level.
- Closing is instant on the desk; the phone bottom sheet keeps D's slide.
- Under 560px the icons take their own line below the pills.
- The MOT drawer is about the window's height, so the stickiness only
  shows at 1280x800 (about 54px); at 1440x900 the preview is 13px taller
  than the drawer and never sticks. A longer item would prove it better.

## Verdicts (owner, 2026-10-08)

> approved. Very good.

Then, on the editing scene's section, type and period values (shown with
a chevron under an accent underline):

> I don't like these as drop downs very much.

And on the date:

> And typing the date isn't acceptable. We need a beautiful calendar
> picker to use with a mouse. When you click the date, the date line
> expands to show a picker.

And on the pickers:

> Similarly, the drop down lines also expand when you click to edit them

F is ratified as the direction. Settled for the date and the three
pickers: no dropdowns and no typed date. Pressing the row expands that
row in place: the date into a calendar picker made for the mouse,
section, type and period into their choices. How the expanded rows look
is still to be designed.
