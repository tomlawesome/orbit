# Search on a phone — round 1 (#1058 row f)

One question, drawn as a before/after pair at 390×844 so the owner can flick
between them on a phone: *what does search do on a phone?* The owner said
this cannot be decided "without seeing it now and after", so this round is
two sheets rather than a spread of directions.

Served at `http://<LAN address>:8336/1058-phone-search/design/v19/phone-search/round-1/<file>`.
Each sheet has a step strip at the top (furniture, not design): **1** idle ·
**2** tap the field · **3** typing "mo" · **4** "mot" · **5** tap the result ·
**6** second tap. `?step=N&theme=<pack>` opens straight to a state. The five
pack dots switch theme; After Dark is the default, as shipped.

## What "now" actually is

The pocket dialect ships a search field that does nothing:

- `web/src/routes/home/pocket.svelte:319` —
  `<div class="msearch"><input placeholder="explore your world" readonly></div>`
- `web/src/routes/home/pocket.behaviour.js` binds nothing to it (the file
  wires `#sheet`, `#maccount`, the dial bodies and the signal rows; the word
  "search" does not appear in it).
- `web/src/routes/home/pocket.css:72-74` draws it: an 88%-wide centred
  hairline under the other-skies strip, 12.5px mono.

So a reader who taps it on a phone gets nothing: a readonly field raises no
keyboard, and on iOS Safari does not even take focus. The desk field's
palette (`home.css:586-594`, `+page.svelte:1168-1176`, wired at
`home.behaviour.js:580-581`) lives inside `.desk`, which `pocket.css:39`
hides below 901px, so none of it reaches a phone. **#1057 has not landed on
`dev`** (HEAD `f78558d`): `grep -ri palette web/src` finds only the desk's
focus-toggled list, no matching.

**A — now** (`a-now.html`) is that screen verbatim — markup and CSS lifted
from `pocket.svelte`/`pocket.css`, the shipped starfield, the same field
with its `readonly`. Steps 2–6 draw the same screen with a caption saying
what the reader tried and what happened, which is nothing.

## The one data story

The Lawson Home of the v19 mockups, today Wed 13 Aug 2026: Gutter clearing
(overdue T+16d), Car MOT — Volvo V60 (T−16d, £54.85, two documents: MOT
certificate 2025, Service history), Boiler service (T−22d), Chimney sweep,
Smoke alarm batteries, Car full service (T−161d, two documents), the relay's
Home insurance renewal suggestion; other skies Seaside Cottage, Mum & Dad's,
The Narrowboat, Gran's Flat.

## The proposal

**B — the bottom sheet** (`b-bottom-sheet.html`). POL-9's palette spoken in
CON-10's dialect. Tapping the field raises a sheet in the pocket's own frame
(`.sheet`'s panel-raised glass, 18px radius, grab handle, the same .3s rise)
standing on the keyboard rather than the floor, with the explore field riding
at the sheet's top so field, results and keys are one stack under the thumb.
Before a keystroke it shows exactly what the desk palette shows (the two
nearest attention rows, "→ complete …" for the closest, "→ add an item").
Rows narrow with every key and list downwards from the field: matching
items in the pocket's row grammar (13.5px title, 11px mono meta, T-label and
date at the right, 44px targets), matching documents with the ◆ mark, and
one accent action for the top match — "→ complete “Car MOT — Volvo V60”",
which arms on the first tap and asks again ("tap again to complete") the way
the pocket's suggestion sheet already does. Tapping an item is the first tap
of CON-10: the keyboard drops and the item's sheet rises, `pocket.svelte`'s
`#sheet` verbatim (title, meta line, open · documents · close). Tapping
**open** is the second tap: the same sheet grows to everything Orbit holds
about the item — the desk's expanded row (`home.html`'s `.itemview` fields)
plus its documents and "manage this item →". No match reads "nothing in
your orbit is called “…”" with "→ add “…” as an item" under it.

Composition calls made here, for the owner to confirm or overturn:

- The field moves into the sheet when it opens. Leaving it in the page would
  put it 60–100px above the keyboard, with results either above it (away
  from the thumb) or below it (behind the keys).
- Result rows use the pocket's `.mitem` type sizes, not the desk palette's
  12.5px mono rows: a thumb needs 44px and the pocket already speaks this
  way.
- Step 6 (approach) is row g's drawing, not a decision this round asks for;
  it is drawn so the pair reads end to end. One honest rendering, open to
  change when g is built.

No third direction. An inline answer (the field pins to the top and the
lists below become results, Spotlight-style) was considered and not drawn:
it fights the dial for the screen and breaks CON-10's "callouts become
sheets" grammar for no gain a phone reader would feel.

## Gates

- Dataviz palette validator: N/A — no data palette; every colour is a pack
  token (`web/src/lib/packs.css` blocks inlined verbatim, comments stripped).
- Screenshots: both sheets × six steps at 390×844 (2x) on After Dark; B also
  on star-chart, dawn, clouds and retrograde; A on dawn. Reviewed. Fixed
  before this commit: the ◆ document mark clipping at 7px, captions
  overrunning the strip, the redundant "documents" button once approach lists
  them. Shots are untracked under `review/`.
- Floors: 44px targets on every result row and key; the item sheet's own
  buttons are shipped at ~36px (`pocket.css`, `.sheet .acts button`) and are
  carried verbatim — flagged, not fixed here. Smallest text is the shipped
  9.5px mono date under a T-label.
- `prefers-reduced-motion`: the sheet, keyboard and approach transitions are
  off; staging is kept.
- The drawn keyboard is OS chrome (iOS, ~300px at 390 wide) so the space it
  takes is honest; the sheet's input is `inputmode="none"`, so on a real
  phone the OS keyboard stays down and the drawing stands in. Keys work.
- Copy: every word on screen is either shipped copy or the palette's own
  ("→ complete …", "→ add an item"); the no-match line is plain English with
  no blame.

## The one question

**Does search on a phone become this sheet on the keyboard — field at the
top, results downwards, first tap summons the item's sheet, second tap
approaches?** Yes ratifies B for #1057's mobile half; no, with what is
wrong, opens round 2.

## Verdict

Owner, 2026-09-19: "1058 search looks good." **B ratified** as #1057's mobile
half: the palette as a bottom sheet on the keyboard, field at the top, results
downwards, first tap summons the item's sheet, second tap approaches.
