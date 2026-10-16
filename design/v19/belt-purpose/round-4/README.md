# What the belt is for — round 4 (#1304): the date and the pickers

Round 3 (F) is ratified. On its editing scene the owner said:

> I don't like these as drop downs very much.

> And typing the date isn't acceptable. We need a beautiful calendar
> picker to use with a mouse. When you click the date, the date line
> expands to show a picker.

> Similarly, the drop down lines also expand when you click to edit them

And on how to proceed: "build as i've said and let fable generate an
alternative." Two directions, both from F with only the editing view's
due, section, type and orbital-period rows changed:

- `g-rows-expand.html` — **the rows open** (as the owner said): pressing
  the value opens its row in place and the rows below move down. The date
  opens into a month calendar on a glass plate (due day filled, today
  ringed, a `today` word and the chosen day's T-minus at its foot);
  section, type and period open into a row of the drawer's own pills.
- `h-chooser-beside.html` — **the chooser beside** (Fable's alternative):
  the rows never grow. Pressing a value lights its row and the chooser
  stands beside the drawer where a document's preview stands, in the same
  card and column. The calendar's foot reads the day under the pointer
  with its T-minus; section says how many items orbit in it, type shows
  its key swatch, period draws its orbit ring and the next date it would
  come round to. On a phone it is the bottom sheet.

Scenes `?scene=`: `editing-date`, `editing-section`, `editing-period`,
`narrow-editing-date` (view at 390x844), plus all of round 3's. Packs by
`?theme=`.

## Notes from the build

- G's calls the owner did not specify: the plate's width and right
  alignment, six fixed calendar rows so it never changes height, the
  `today` word, the T-minus, closing on a press elsewhere.
- H: Escape closes the chooser only; a second Escape cancels the edit.
  The preview and the chooser hand over to each other, one card beside
  at a time.
- Both builders found that a `?scene=` link could fire before the last
  script defined its scenes (F's code, seen most in clouds). Fixed in
  both round-4 files by waiting for the document to parse; 48 scene loads
  across both files and two packs, no misses. Round 3's file is left as
  reviewed.
- Screenshots of every new scene in starchart and clouds, checked by eye.

## Verdicts (owner, 2026-10-08)

> chooser beside, but I don't like the radio dials and the N in orbit is
> useless information. The box should also have the proper outline
> colour, as it looks odd without it

H is the direction, with three changes: no ring marks before the
choices, no "N in orbit" count on the sections, and the chooser card
takes the outline the other cards beside the drawer carry. G is dropped.
