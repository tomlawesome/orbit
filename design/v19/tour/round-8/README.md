# First-run tour — round 8 (#1083): the pocket cut

Round 5 is the ratified film (owner-decisions.md §23), round 6 re-cut
chapter 8 and round 7 gave it a script. All three are drawn for the desk
dialect only — `(min-width: 901px)`, the cut home itself uses (CON-10) — and
§24 says a phone shows nothing until this round ships. This round draws the
same film in the pocket dialect. One direction: **G — the pocket cut**,
`g-pocket.html`, at 390×844 (open with `?w=360` for the 360-wide check).

## What binds

Everything the desk film settled, verbatim: the twelve chapters in the
ratified order, every line of the ratified copy (rounds 5–7's corrections
included), the Lift mechanic (no pointer; the control rises, glows and
presses), one continuous take with a transport under it, the clock and the
holds (`holdFor`, `T.*` — copied unchanged from round 5), demo data drawn
on screen only, round 7's script and announcement, and the rule that the
pocket cut runs on **#866's engine** — one clock, one vocabulary, one
player, one transport — not a second one. Nothing in the copy is
reopened.

## What changes, and why

Three things did not survive narrowing (the issue names them) and one
more turned up in the captures.

**1 · The stage is the real pocket screens.** Every backdrop is the pocket
dialect as the fixture app renders it at 390×844, in after dark (recipe
below). Not a desk layout shrunk: the pocket home has no north star, no
inbox orb and no account orb on the sky — its one door is the avatar
(`#morb`) and the account sheet behind it, which holds *Add an item*,
*Inbox*, *Settings* and the theme swatches. The other households are a
strip of chips under the dial, not suns in the sky. The item screen's
reading card is a bottom sheet. The whole page scrolls, chrome and all.

**2 · The transport, cut for a thumb.** Round 5's pill is 470 wide with
twelve 18px tick buttons; neither fits a phone. The pocket pill is the
page's own width (12px margins, 366 at 390), 60 tall, two rows: the words
above (chapter name at the left, `m:ss / m:ss` at the right), the controls
below (play/pause and stop at 44px, the rail). The twelve ticks are
painted marks only — 1×6 — and **the rail is the hit**: a tap anywhere on
it lands on the nearest chapter's start, never mid-sentence, and while a
finger is down the chapter name yields to the name of the chapter it
would land on (round 5's hover tip, by touch). Ticks stay buttons for a
keyboard, as built. Space and Esc still work where there is a keyboard;
on a phone Stop is the only stop, so it stays 44px. The pill recedes to
38% while playing and returns on touch or pause; ended keeps the 16%
ghost. It wears dawn in chapter 11.

**3 · The transport gives way to a sheet.** The pocket's sheets own the
foot of the screen — the account sheet (chapters 2, 7, 11), the item sheet
and the reading sheet (chapter 8). A pill at the foot would sit on their
buttons. So whenever a bottom sheet is up the pill docks to the top edge
(10px down), and comes home when the sheet goes. The film never needs to
say this: the built transport watches `.msheet.open, .sheet.open,
.readcard.open` and moves itself, so a reader's own taps while paused get
the same behaviour. **Owner question 1** below offers the alternatives.

**4 · Callouts sit above or below, never beside.** There is no left or
right on a 390px screen. A callout is centred on its anchor, clamped to
the page's 12px margins, at most 300px wide, and never under the
transport wherever it is docked. A chapter written for the desk that asks
for `left` or `right` gets whichever of top/bottom has more room — that
rule belongs in the vocabulary, so the same chapter file serves both
dialects (builder's notes). Sky lines whose subject is on the dial sit in
the dial's empty lower half, under the sun (`NOTE` in the file): the
pocket dial's upper half is where the bodies are, and a line laid over
them is what round 5 called messy.

**5 · The Lift travels between the pocket's controls**, found by selector
at run time as the build already does. Where the pocket has no such
control, the film uses the pocket's own route to the same place; the
table below names every substitution.

## The controls, desk → pocket

| Chapter | Desk (as built) | Pocket |
|---|---|---|
| 1, 3, 5, 9, 12 | `.dial`, `.sun-link` | `.mdial` (366px, ring r 144.5), the sun `circle[r="8"]` at its centre — lit only, never pressed |
| 1, 10 | `.minisys .msring` (other suns) | `.skies .msys` — the strip chips under the dial; lit, and *ask to join* drawn beneath the first, as round 4 drew it |
| 2 | `#nstar` | `#morb` → sheet → `#maccount nav a[href$="/create"]` (*Add an item*, #1036) |
| 2 | the drawer's fields | `/create`'s own form: `#f-name`, `#types [data-type=inspection]`, then the drawer **unfolds** (§4's progressive disclosure) and the page scrolls to `#f-date`, `#f-cost`, `#f-recur` (a select, already *yearly* for an inspection — pressed for the gesture, as the desk pressed its chip) and `.btn-primary` |
| 4 | `#manifest-top`, `.today`, `.item` | the page scrolled 360px (its whole travel), the first `.mgroup h3` (*needs attention* — the pocket has no *today* line) and its first `.mitem` |
| 6 | `.relay-card` | the same card, full width; the address box is the lit thing |
| 7 | `.inbox-orb` | `#morb` → `#maccount nav a[href$="/inbox"]`; then the three lanes, **stacked** in one column, so the film scrolls lane to lane (0, 300, 720px) and back to the review card for *Add to orbit* |
| 8 | `.body-link` → `/item` | the MOT body on `.mdial` → the **item sheet** (`#sheet`, the pocket's first tap, CON-10) → its `open` button → `/item` |
| 8 | the two ringed papers | the card's own *2 documents ride in the belt…* line for the first sentence, the visible paper for the second (see question 2) |
| 8 | `aside.readcard` beside the card | the same element as a **bottom sheet** (belt.css ≤680: fixed to the foot, 18px shoulders, the page at 60vh) |
| 8 | `later →` / `← sooner` end-caps | the same end-caps, which the pocket puts in the **top row** beside *← your sky* |
| 9 | `.acts button:first-child` | the same `complete` button on the full-width card |
| 11 | `button.orb`, `#account` | `#morb`, `#maccount` — the settings link, the swatches row, `[title=dawn]`, `[title="after dark"]` |

## The beats that moved

- **Chapter 2.** The avatar is pressed, the sheet rises (transport docks
  top), *Add an item* is pressed, the create screen comes up whole and the
  card is lit for the drawer line. The name is typed into the real
  heading; *inspection* is pressed; the drawer unfolds — the captured,
  typed drawer replaces the drawn one and the page scrolls 176px to the
  fields — due and cost typed, recurrence pressed, then a last 120px
  scroll to *Add to orbit*. On the pocket the lower fields are below the
  fold, so the film scrolls the way a thumb would.
- **Chapter 4.** The page scrolls its whole 360px (1204 tall less the 844
  viewport). Nothing needs drawing back: nothing on the pocket home is
  `position:fixed`.
- **Chapter 5.** The toast comes from the top, as a phone's notification
  does, and **the sky dims under it** — the desk had an empty quarter for
  the toast and its line; the pocket dial has none, and a line over the
  bodies is worse than a veil.
- **Chapter 7.** Three lanes in a column: each is scrolled to, lit and
  labelled in turn, then the film scrolls back to the review card.
- **Chapter 8.** The body's first tap raises the item sheet — the pocket's
  own grammar — and `open` is pressed. On the item screen the belt's ring
  runs off both edges at 390 wide (the papers' hit boxes measure x −58 and
  370), so the papers show as edge slivers. The film lights the card's own
  documents line for *Every body carries its documents in a belt around
  it.*, the visible paper for *The belt is what you have attached to it.*
  and *Tap one to bring it in.*, and presses the sliver: the reading sheet
  comes up with the real page in it (round 5's render), the transport
  docks top, and *The page itself, read without leaving the sky.* sits
  above the sheet. Then — a change from round 6's order — **the sheet
  folds first** (Esc, or a tap on dead sky), the transport comes home, and
  only then do the end-caps step, because on a phone the end-caps sit
  where the docked transport is. One press each way, as round 6.
- **Chapter 11.** The sheet holds all three subjects in one place: the
  settings link, the swatches row, dawn pressed and after dark pressed
  back. The pill wears dawn for the hold.

## Decisions made here

- **Same length, not shorter.** The issue left this open. Every beat the
  desk plays, the pocket plays: the pocket cut measures **3:44** against
  the desk's 3:41 — the sheets rising and the scrolls cost the three
  seconds. Nothing was found worth cutting for a phone that is not also
  worth cutting for a desk, and one film with one script (round 7) is
  simpler to hold than two. The owner can ask for a shorter cut.
- **Dock to the top, not shrink the pill.** A sheet needs the foot; a pill
  small enough to share it would fail the 44px targets it exists for.
- **The rail is the target, ticks are marks.** Twelve 18px buttons across
  a 250px rail are 20px apart — the spacing the desk already called the
  narrowest possible — and a thumb needs 44. One target that snaps to a
  chapter keeps round 4's promise (a jump lands on a chapter's first line)
  without twelve targets nobody can hit.
- **Callouts go above or below.** Not a preference: there is no room
  beside anything at 390.
- **Sky lines sit under the sun.** Both chapters that ring a body and then
  speak about the sky put the line in the dial's lower half rather than
  over the bodies in its upper half.
- **The veil comes up for the toast** (chapter 5) — the one place the
  pocket dims where the desk did not.
- **Chapter 8's sheet folds before the steps**, for the reason above.
- **Drawn, not captured, and why:** the typed name, due and cost (as every
  round drew them); *ask to join* (the fixture reader belongs to every
  household — round 4's rule); the reading sheet (the main checkout's
  build predates #1088; the sheet is drawn from belt.css's own ≤680 rules
  with round 5's real render); the MOT body on the dial (drawn by
  `dialPlacement`'s law, scaled to `.mdial`'s 366px, as the desk film
  drew it by the chart's).

## The transport, for the record

390 wide: pill 366×60 at `left/right:12px; bottom:12px` (the build adds
`env(safe-area-inset-bottom)`), radius 18; row one 20px, row two 36px;
play/pause and stop 44×36; the rail flexes to ≈250px. 360 wide: 336×60,
rail ≈220px; the words row still fits *OTHER HOUSEHOLDS* and `3:12 /
3:44` with room. Docked: `top:10px`, same width. The Script button and
the script region are round 7's, visually hidden, unchanged.

## Reduced motion

Round 5's rule holds: reading time is not motion, so every hold is the
same length in either mode. The cut drops, as motion: the sheets' rise
and fold (simply up, simply down), the scrolls (simply there), the
drawer's unfold, the body's walks, the travel arcs, lifts, presses and
crossfades. The pocket cut measures **2:09** reduced (round 6 computed
2:09 for the desk).

## Timing

Measured by the film's own clock (headless, `window.__chapters`):

| # | Chapter | Desk (round 6) | Pocket |
|---|---------|------|--------|
| 1 | Arrive | 0:00 | 0:00 |
| 2 | Add | 0:22 | 0:22 |
| 3 | Lands | 0:47 | 0:50 |
| 4 | Below the dial | 0:57 | 1:00 |
| 5 | Time runs | 1:11 | 1:14 |
| 6 | Paper by post | 1:27 | 1:28 |
| 7 | Inbox | 1:42 | 1:43 |
| 8 | The belt | 2:05 | 2:08 |
| 9 | Done | 2:39 | 2:42 |
| 10 | Other households | 2:55 | 2:59 |
| 11 | Your sky | 3:08 | 3:12 |
| 12 | Yours | 3:28 | 3:32 |
| — | film ends | ≈ 3:39 | **3:44** |

The built film's clock is the measure and supersedes this if it lands a
second either way.

## Backdrops

`shots/` at 390×844 (2× pixels, 780×1688), after dark, captured
**2026-09-24** from the fixture app: the main checkout's adapter-node
build served read-only with `ORBIT_FIXTURES=1` and the fidelity gate's
own placeholder environment (`web/playwright.config.js`), Playwright
chromium, `isMobile`, the gate's settle rules per screen, `orbit-theme`
set before first paint, SVG timelines paused.

| File | Route and state |
|------|-----------------|
| `home.png` | `/home`, settled |
| `home-full.png` | `/home` as one 390×1204 strip (the page scrolls whole) |
| `home-menu.png` | `/home`, avatar pressed — the account sheet |
| `home-sheet.png` | `/home`, the MOT body tapped — the item sheet |
| `home-dawn.png`, `home-menu-dawn.png` | the same two in the dawn pack |
| `create.png` | `/create` as it opens |
| `create-typed.png` | `/create`, name typed and *inspection* chosen — the drawer unfolded, 390×1020 |
| `inbox-full.png` | `/inbox` as one 390×1611 strip |
| `belt.png` | `/item/i-mot`, at rest, reduced motion (as the gate photographs it) |
| `belt-n1.png` | `later →` once |
| `relay.png` | `/settings/mail` |
| `w360-home.png`, `w360-belt.png` | the same two screens at 360×800, for comparison with the `?w=360` check |
| `preview-service-history.png` | round 5's real render, unchanged |

The `?w=360` check scales the 390 captures to 360 (the pocket page is
fluid to 400px, so the scale is close but not exact — the two real
360-wide captures sit beside it for the eye); it is a check that the
transport and the callouts fit, not a second set of backdrops.

## Self-review

Every chapter's key frame photographed headless through the film's own
hold marks into `shots/` (`01-arrive.png` … `12-yours.png`, `ended.png`,
and `w360-*.png`), looked at, fixed, recaptured. Fixed on the way: the
unfolded drawer sat unlit under the veil; the drawer's lower cut-outs
took the strip's offset the wrong way round and the drawn fields did not
scroll with the page; chapter 4 scrolled 110px past the end of the page;
the body's ring covered its own label; the end-cap cut-outs clipped
their ink by a few pixels; the far body's line ran into the fixture's
bodies (now under the sun).

Headless end to end at 390 and 360: **no console errors**, the clock ends
`3:44 / 3:44`, every mark reached, the transport docks and returns at
every sheet.

## Known limits

- Round 5's stand: the fixture's MOT at T−16d in the rows; the fixture's
  own bodies on the dial under the drawn one.
- The pill sits over the *signals* heading on the home screen at rest
  (the desk's *explore your world* limit, moved down a row).
- Chapter 8's second line is anchored to a paper that is mostly off the
  edge; its stem points up from below the card. Honest to what the belt
  does at 390 (finding below); the alternatives are question 2.
- The film presses the item sheet's `open`, which is inert in the product
  today (pocket.behaviour.js: "approach is drawn nowhere yet") — the same
  licence the desk cut takes with `.body-link`, recorded here so the
  build does not mistake it for a working door.

## Findings for issues (not this round's to fix)

- **The belt has no phone layout.** At 390 wide `/item`'s ring runs off
  both edges: the papers' hit boxes measure x −58 and x 370, their labels
  clip, and the top row crowds — *← YOUR SKY* ends at x 115 and *← SOONER*
  starts at 121.
- **The pocket's other-skies strip is not tappable.** Chapters 1 and 10
  say *tap one to ask to join*; on a phone with a household the chips
  take no tap (the labelled sky's `askrow` does, but that is the empty
  sky).
- **The item sheet's `open` and `documents` are inert** — already noted
  in code; the pocket has no door from the dial to `/item`.

## Builder's notes

- **Dialect at mount, not per chapter.** `Tour.svelte` already reads the
  CON-10 query; hand `createFilmContext` a `pocket` flag and let each
  chapter's `SELECTORS` carry a pocket set beside the desk one. The
  chapter's `play` stays one function; the measurement pass runs the
  same branch the film will, so the ticks stay honest.
- **Vocabulary:** `callout`'s side resolution (top/bottom only below the
  cut, by room); `goto` must **scroll the control into view** before
  travelling (nothing in vocabulary.js scrolls today — chapters 2, 4 and
  7 need it); a `sheet()`/`unsheet()` pair for the account and item
  sheets on the same terms as `read()`/`unread()` — the sheets' openers
  mutate nothing that outlives the film (`#morb` toggles a class;
  `[data-sheet-title]` sets the sheet's text).
- **Transport:** the pocket CSS under the same `(max-width: 900px)`; the
  rail's pointer handlers and the aim state; a `MutationObserver` on the
  three sheet selectors for the dock.
- **Selectors the pocket lacks:** the sun has no class (`.mdial
  circle[r="8"]` today — give it one); the drawn body needs
  `dialPlacement` scaled to `.mdial`'s box rather than the desk chart's.
- Copy word-counts are round 5's; no line is new.

## Questions for the owner

**1** Where the transport lives on a phone while a sheet is up:
- a. as drawn — docks to the top edge while a bottom sheet is up, returns
  after;
- b. always at the foot, over the sheet's own buttons (it recedes to 38%
  while playing);
- c. always at the top on a phone, and the film works around it (it would
  cover the avatar on home and the end-caps on the belt).

**2** Chapter 8 on a belt whose papers ride off-frame at 390:
- a. as drawn — the card's own documents line, then the visible paper's
  edge, then the reading sheet from that edge;
- b. cut the paper beats from the pocket until the belt has a phone
  layout — the chapter plays arrival, the card and the two steps (about
  20s shorter);
- c. give the belt a phone layout first (a product issue) and re-cut this
  chapter against it, as round 6 was cut against #1088.

**3** *later → steps the belt — so do the arrow keys.* on a phone:
- a. verbatim, as drawn (ratified copy; a keyboard is possible);
- b. the pocket drops the clause — *later → steps the belt.*

Written by Fable 5, 2026-09-24.
