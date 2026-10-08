# The tour's drawer chapter — round 1 (#1319)

The belt and `/item/<id>` retire (owner-decisions §34): home's item drawer
holds everything. The first-run film's chapter 8, "The belt"
(`web/src/lib/tour/chapters/08-the-belt.js`), has no screen left to show, so
this round cuts its replacement, for the owner to review before the belt
route goes (owner, 2026-10-08: a new chapter showing the drawer, designed
for the owner to review).

One direction, **A — the drawer chapter**, `a-the-drawer.html`: the
ratified drawer mockup (`../../belt-purpose/round-8/m-colour-per-option.html`,
approved 2026-10-08) kept verbatim, with the film's chrome laid over it —
the veil, the Lift, the callouts and the transport pill, all round 5's
(`../../tour/round-5/`), re-hung on a live page so every ring is measured
off the real drawer. The film plays the new chapter 8 and the opening of
chapter 9 on the real drawer, preview, editing rows and calendar, driven by
the mockup's own functions; nothing is drawn over a screenshot.

Cut against the film as it is on `dev` (the one-take film, §23, chapters in
`web/src/lib/tour/chapters/`). `gitlab/feature/m9-tour-and-marks` (MR !941)
was checked and is not where the tour is heading: it is the ten-beat film
§23 superseded, last touched 2026-09-20 and 1,400 commits behind `dev`.

## The beats, in order

New copy is marked ✎; everything else is the film's own line, carried.
Holds are the film's (1000ms + 350ms a word, 2400 minimum).

**8 · The drawer** (≈ 43s; the belt's was ≈ 34s)

1. **Arrival.** The dot travels to the Volvo's body on the dial, lifts it,
   presses. Its row opens in the manifest and the page scrolls to it
   (#424: the row is the item's destination). The whole drawer is lit.
   > ✎ **"The row is the item: everything Orbit holds about it, in one place."**
2. **The papers.** The three document rows are lit as a group, under the
   notes (notes before documents, §34).
   > ✎ **"Its documents sit beneath, after your notes."**
3. **The page beside.** The service history's row is lifted:
   > **"Click one to bring it in."** *(label, 2.0s; "Tap" on the pocket — 08's line)*

   Pressed, the preview card stands beside the drawer, level with it (the
   bottom sheet on a phone; the pocket pill docks to the top). The card
   is lit:
   > **"Read the full document, right here."** *(08's line)*

   The card goes — at once on the desk, folding on a phone.
4. **The foot row.** The four pills are lit:
   > ✎ **"Snooze, complete, attach, retire — anything you’d do to it, from here."**

   The dot travels to the pencil, lifts it, presses. The rows go live
   (the values underlined, the choosers' chevrons out, save and cancel in
   the pills' place). The field rows are lit:
   > ✎ **"Edit it where it stands: each value is live."**
5. **The calendar.** The due row is lifted and pressed: the calendar
   stands beside the drawer, where the preview stood (the sheet on a
   phone), the due day filled, today ringed, the foot reading the day and
   its T-minus. The card is lit:
   > ✎ **"A date is picked from a calendar, never typed."**

   The card goes. The dot travels to **cancel**, presses: the read view
   again, nothing written. End state: the drawer open and lit, the pills
   showing — chapter 9's opening frame.

**9 · Done** — only its opening is re-anchored; the rest is unchanged.

6. The dot travels to the **complete** pill in the drawer's foot row:
   > **"MOT passed — mark it done and it swings back out to next year."** *(09's line)*

   Pressed. The row closes, the page returns to the sky undimmed, and the
   Volvo swings out to next year (the film's own drawn body in the build;
   the mockup's own swing here), then 09's closing line as now.

## The handover to 09, and what the build changes

- **`09-done.js`.** `setScreen("/item")` and the `.item-card` /
  `'.acts[aria-label="Item actions"] button:first-child'` selectors go.
  Chapter 9 opens on `/home` with the Volvo's row open — played on from
  chapter 8 it already is; on a cold jump the chapter opens it itself
  (press the body, as 8 does) — and lights the drawer's own complete pill
  (ItemView's foot row, by the button's own label, not position). The
  `carriesPapers` branch goes: a drawer always has a complete pill, papers
  or not. The swing-out beat is untouched. Its header's
  "`+page.svelte:546`" note is stale once the route is gone.
- **`08-the-belt.js` → `08-the-drawer.js`** (`id: "drawer"`, name "The
  drawer"); `index.js` imports it. The paper beats become `optional`
  controls (07's idiom): a household whose item carries no document plays
  beats 2 and 3 with nothing lit, the same length, never a different beat.
  `householdCarriesPapers` then has no caller left in 8 or 9 and leaves
  `film.js`'s context.
- **`vocabulary.js` ~576.** `setScreen`'s `/item` special case ("a chapter
  asking for `/item` while the film stands on `/item/<id>` stays put")
  goes with the route.
- **`Tour.svelte` `walkTo`.** The `/item` and `/item/[[id]]` navigations
  go; the film crosses only `/home`, `/inbox`, `/create` and
  `/settings/mail`. The header's route list follows.
- **Home itself** must let the film open a body's row: on the desk today
  `.body-link`'s click is unbound beyond a hover tooltip (08's own note);
  the chapter presses the body for the gesture and opens the row by the
  product's own means (`/home?item=<id>`, §34). On the pocket the body
  already opens its row (`tapBody`/`openRow`).
- **Transport ticks** take whatever the build measures. Computed here:
  8 at 2:05 as now, 9 at ≈ 2:48 (was 2:39), the film ≈ 3:48 (was 3:39).
  Reduced motion: chapter 8 is its seven holds, 27.6s.
- Tests pinning 08's and 09's selectors
  (`tests/unit/v19-tour-chapter-the-belt.test.mjs`, `…-done.test.mjs`)
  are re-pointed at home's markup.

## What was weighed

- **One chapter, five beats (chosen)** over two shorter chapters. Splitting
  the drawer from editing would add a tick and a name for ten seconds of
  film; the transport already has twelve.
- **The calendar as the one chooser shown.** The section tiles, type tiles
  and the period band are left to be found: each would add ≈ 8s, the
  calendar is the one the owner asked for by name ("a beautiful calendar
  picker"), and the line says what they share — a value is chosen, never
  typed. If the colour-per-section tiles should be taught, a section beat
  after the calendar is the cut (see Questions).
- **Cancel, not save.** The film never writes (its own rule); cancel also
  shows the read view returning, which closes the loop the pencil opened.
- **Chapter 9 keeps its complete beat and its swing**, re-anchored on the
  drawer's pill. Folding "complete" into chapter 8 would leave 9 with only
  the swing-out, and the owner's line "MOT passed — mark it done…" is
  already about the pill.
- **The name.** "The drawer" is the owner's own word for it (§34). "The
  item" and "The row" were considered; "row" is what it is on the screen,
  "drawer" is what the product calls it everywhere else.
- **What carries from the belt chapter:** "Click/Tap one to bring it in."
  and "Read the full document, right here." verbatim. "Every body carries
  its documents in a belt around it." and "The belt is what you have
  attached to it." retire with the belt — nothing on this screen is a
  belt — and the second is restated as "Its documents sit beneath, after
  your notes."

## Scenes

`?scene=<mark>` holds the film at that moment; `#c2` starts at Done.
Desk at 1440x900; phone at 390x844 (no forced width — the page's own
breakpoints). The mockup's own `?scene=open|preview|editing-date|…` names
from round 8 still work for the drawer alone once the film is skipped.

| mark | held at |
|---|---|
| `drawer-row` | the Volvo's row open, lit, the first line |
| `drawer-docs` | the documents lit under the notes |
| `drawer-bring` | "Click one to bring it in." on the service history |
| `drawer-read` | the preview beside the drawer (the sheet on a phone) |
| `drawer-acts` | the four pills |
| `drawer-editing` | the pencil pressed, the rows live (no line yet) |
| `drawer-edit` | "Edit it where it stands" |
| `drawer-calendar` | the calendar beside |
| `done-complete` | chapter 9's opening: the complete pill |
| `done-swung` | the Volvo swung out to next year |
| `done-round` | chapter 9's closing line |

Review hooks as round 5's: `window.__hold`, `__jump(k)`, `__pause()`,
`__play()`, `__skip()`, `__reading()`, `__offsets`, `__total`.

## Notes from the build

- Measured: chapter 8 42.7s, Done's cut 16.7s (round 5's whole chapter 9
  was 16s), film 59.4s; reduced motion 27.6s + 10.1s. Desk and phone
  within 0.1s of each other.
- A callout above or below its anchor scrolls the page to make its room
  rather than clamping over the thing it names (the built film's
  `room()`): on the desk this moves the drawer's foot line clear of the
  drawer's edge; on the phone it puts the first line above the row, clear
  of the orbs. That scroll is real time the dry run does not budget, so
  the clock can read a second short on the phone.
- **The phone's dial beats are not this base's to show.** The round-8
  mockup is the desk page at 390px — its dial is the desk dial cropped —
  so the arrival (beat 1) and the swing-out (chapter 9) are only
  proved at 1440; on the pocket those two beats are the pocket film's own
  (`../../tour/round-8/`, §32) and do not change. The drawer, the sheet,
  the editing rows and the calendar sheet are proved at 390.
- Palettes: nothing new drawn; the chooser colours are round 8's, already
  validated there.

## Self-review

Every scene at both widths photographed with Chromium, looked at, fixed,
recaptured: chapter 9's line sat over the snooze pill (now below the
pill); the phone's documents line covered the notes it names (now below
the documents); the phone's first line sat over the field rows (now above
the row, the page scrolled to make room); the desk's pills line clipped
the drawer's edge (same fix). No page errors in any run.

## Questions for the owner

**1** Should the film also show one tile chooser (section, with its colour),
after the calendar — ≈ 8s more — or leave the tiles to be found?

**2** The chapter's name on the transport: "The drawer", or "The item"?

## Verdicts (owner)
