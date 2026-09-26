# Orbit on a phone — the review round

Written 2026-09-26 for #1120 step b, against the live build the owner used
on a real phone (2026-09-25: "mostly really impressed", then six asks) and
the review shots in `/tmp/orbit-phone-vision/review/` (390 and 360 wide,
after dark / starchart / clouds) beside the desk baselines. Opus builds
from this; nothing here is re-decided at build time. Where a rule names a
desk file it is carried over from there, not invented.

Real floors: assume 390×664 and 360×640 visible (browser bars eat 100–180px
of the 844/780 the shots were taken at). Every rule below is checked at
those.

What the owner ruled, kept: no grain on signed-in screens; the filled pill's
glow on the dark packs; the north star and the home type lift stay as
trials (verdicts in §2.1); other-households chips fly to that household.

---

## 1. Kit changes — every screen inherits these

### 1.1 The row opens on a tap (replaces the swipe)

The desk's own grammar, home.css "THE ROW IS THE ITEM" (#424): the row
grows in place into a panel under it. One `Row.svelte` change; every list
follows (members, invited, sections, signed-in devices, sign-in methods,
administration's people and systems, inbox failures, home's manifest).

**Behaviour**

- Tapping anywhere on the face opens the row; tapping the face again
  closes it. Tap outside the row closes it (pointerdown outside, as now).
  Escape closes and returns focus to the face. Opening another row in the
  same list closes the first (`data-row-group` on the list, the kit keeps
  one open per group). Scrolling does **not** close it, and there is no
  timer: the 6 s hold and the swipe tracking in `row.js` go, and the face
  drops `touch-action:pan-y`.
- A row never both navigates and holds acts. Where a row used to link and
  now has a panel (home's manifest), the way onward is an `open →` pill in
  the panel — the desk's `manage this item →`. A screen passing both
  `href` and `acts` is a dev-time error.
- A control inside the face (`end`: the section switch) works on its own
  tap and does not open the row (`stopPropagation` on `.end`).
- Acts run and then the row closes (as `run()` does now). An arming act
  arms on the first tap with the row staying open, fires on the second,
  then the row closes. Full armed words now fit ("tap again to remove"),
  so `ArmButton`'s default `armedLabel` is used; the "tap again" short form
  goes.
- The trail and meta stay visible while open (they were hidden under the
  swipe tray).
- Keyboard: Enter/Space on the face toggles; Tab walks the panel's pills
  (they are in the Tab order only while open — `hidden` attribute when
  closed, no more opacity hiding); Escape closes. Screen reader: the face
  is a `button` with `aria-expanded` and `aria-controls` pointing at the
  panel; each act keeps its full name ("Remove Emma Lawson"). The sr-only
  move buttons go (see §1.1 reorder).
- Reorder (sections): the opened panel holds `move up` and `move down`
  ghost pills; see question **7** for whether long-press stays beside them.

**Look** (`Row.svelte`, plus `kit.css` for the panel)

- Open face: `background:var(--panel-raised)`; an accent rail
  `box-shadow:inset 2px 0 0 var(--accent)`; `border-radius:12px 12px 0 0`.
  Home's own-glass rows additionally take `border-color:var(--accent)`
  (the desk `.item.open`) with their bottom corners handed to the panel.
- Panel `.p-row-open`, directly under the face, same width:
  `background:var(--panel-raised)`, the same inset accent rail,
  `border-radius:0 0 12px 12px`, padding `4px var(--p-gutter) 12px
  calc(var(--p-gutter) + var(--p-row-mark) + var(--p-row-gap))` so its text
  edge is the row's text edge. Inside, in order: the screen's `detail`
  snippet (`.p-kv` lines, `kit.css`), then `.p-pills` with the acts, each
  44px, `flex:1 1 150px` (two share a line when each gets ≥150px, else they
  stack), primary first, danger last.
- Unfold: wrapper `display:grid; grid-template-rows:0fr → 1fr` over 200ms
  `var(--p-ease)`; the panel's content `opacity:0, translateY(-6px) → 1, 0`
  over 300ms `cubic-bezier(.2,.7,.2,1)` — home.css `ivopen`, verbatim.
  Close is the reverse at 200ms. Reduced motion: appear and vanish.
- The hairline between rows (`.face::before`) stays; the open row's panel
  draws none below it, the next row's own hairline does that job.
- Hints that say "swipe" ("swipe a device to sign it out", "swipe a
  message to remove it") become "tap a device to sign it out" / "tap a
  message to remove it". Same place, same size.

### 1.2 Sheets: acts live in a pinned foot; a callout is never capped at 45%

The class of fault (buttons cut or below the fold) is fixed structurally:
no act ever sits in the scrolling body.

- `Sheet.svelte` gains a `foot` snippet, rendered after `.body`, outside
  the scroller: `flex:none; margin:0 calc(var(--p-gutter) * -1)
  calc(-16px - env(safe-area-inset-bottom)); padding:12px var(--p-gutter)
  calc(16px + env(safe-area-inset-bottom)); border-top:1px solid
  var(--line-soft); background:var(--panel-raised); display:flex;
  flex-wrap:wrap; gap:var(--p-pill-gap)`. Pills inside are `flex:1 1
  150px`: at 390 two fit on a line (175px each), at 360 two fit (164px),
  three stack. Primary (filled) first in DOM, so it is leftmost or topmost.
- Rule for Opus: **every button in a sheet goes in the foot** — the only
  exceptions are picker rows (a list sheet's rows are the choice), a
  stepper's `−`/`+`, and a quiet link row (`review & amend →`), which is the
  last row of the body at 44px tall, 13px mono, `--accent-text`.
- Callout height: `max-height:calc(var(--h) - env(safe-area-inset-top) -
  56px)` — the top chrome's height of page stays visible so it still reads
  as a sheet. The `* .45` cap is deleted. Content taller than that scrolls
  in the body with the foot pinned. List stays 60% (drags to full); full
  unchanged.
- Which size (so nobody guesses): **callout** for anything under six rows
  or fields (record a completion, reschedule, snooze, retire, invite
  someone, setup link, change password, add a section, new system, set
  contact, rotate addresses, alert and service detail); **list** for
  pickers and lists of six or more (first/final warning, time zone,
  currency, place in a system, documents, search, the hatch); **full** for
  create/edit, review & amend, import preview, the reader.
- Keyboard: `.body{scroll-padding-bottom:calc(var(--p-foot, 80px) +
  12px)}` and the sheet writes its foot's height to `--p-foot`, so a
  focused field lands 12px above the foot, which stands on the keyboard.
- Two-field side-by-side rows in a sheet (completed on · next orbit) stay
  side by side at 390 and stack at 360 (`grid-template-columns:repeat(auto-
  fit, minmax(150px, 1fr))`).

Audit list, resolved by the above: home suggestion (now in-place, §2.1);
item complete/record → callout with `record` in the foot; settings change
password → `save it` in the foot; first/final warning → list; invite and
setup link → callout, `create` / `send it` in the foot, the stepper in the
body.

### 1.3 The wake and the north star

`NorthStar.svelte` sets `data-northstar` on `<body>` while mounted; the
wake host reads it: `body[data-northstar] .p-wake-host{padding-bottom:
calc(12px + 56px + 20px + env(safe-area-inset-bottom))}`. The wake rises
above the star, never over it. Nothing else moves.

### 1.4 Motion the desk has and the pocket lacks

Screenshots cannot show this; it is a third of "basic". All transform or
opacity only; all off under reduced motion.

- **Cards land.** `.p-card{animation:p-landed 600ms cubic-bezier(.3,.7,.2,1)
  backwards; animation-delay:calc(var(--i, 0) * 60ms)}` from `opacity:0;
  transform:translateY(8px) scale(.985)` — belt.css `belt-landed`,
  verbatim. Each screen sets `--i` 0–4 on its first five cards in DOM order;
  the rest land at once. Once per page load, not on re-render (keyed
  blocks). The desk's manifest groups do the same at 700ms (`.desk .group`);
  the pocket uses the belt's tighter curve because rows are closer to the
  thumb.
- **The dial arrives.** On home's first paint in a session:
  `.mdial{animation:arrive 1s cubic-bezier(.2,.7,.2,1) 1}` from
  `scale(.16); opacity:0` (home.css `arrive`), gated by the desk's own
  once-per-session arrival flag so a back-navigation does not replay it.
- **The sun breathes** and **the nearest body pings** (§2.1, dial).
- **Body press.** `.pk-body:active > circle:first-of-type{transform:
  scale(1.18)}` with `transition:transform 120ms; transform-box:fill-box;
  transform-origin:center`.
- **Theme change crossfades.** The desk's `body{transition:background .4s,
  color .4s}` applies on every pocket route too (root layout), so a swatch
  tap in the hatch fades the sky rather than snapping it.
- Kept as built: sheet rise 300ms, chrome 200ms, row press 120ms, wake
  250ms, breathing marks 2.4s, north star pulse 5.5s, the belt's card roll
  and halo breath, the approach view transition.

### 1.5 Depth and light

- **Sky.** `Sky.svelte` is too sparse next to the desk: raise the tile to
  60 far and 30 near stars and add 5 "bright" near stars per tile (r 1.8–2.4,
  opacity .95, `--star-near`). Same seed order, same drift. Still one SVG,
  transform only.
- **Cards on the dark packs** keep the inset edge light; add `0 10px 30px
  -18px rgba(0,0,0,.6)` so a card lifts off the sky as the belt's card does
  (`0 18px 44px .45`, cut down for a stack of cards). Light packs unchanged.
- **The opened row** is the raised plane (§1.1); a sheet is raised further
  (built). Three planes: sky → card → open row / sheet. Nothing else casts.

### 1.6 Type and ornament

Built to the scale already (16/13/12 tracked, display titles, mono data);
no change. Ornament rules stand: `→` on words that leave the page, `·`
between data, dashed for what Orbit proposes, the hazard rule on the
danger card. One addition: the count bead on a caps head ("FOR YOUR REVIEW
· 1" on inbox is drawn as a ring bead) is the one bead style everywhere —
administration's card heads take it for `PEOPLE · 5`, household for
`MEMBERS · 4`, instead of the inline number.

---

## 2. Per screen

### 2.1 Home (`/home`)

**The manifest item opens a drawer, not a card sheet** (owner ask 2). The
item sheet, its `documents` growth and the suggestion sheet are removed;
the search sheet and the hatch are home's only sheets.

- A manifest row opens in place (§1.1). Its `detail`: `.p-kv` lines exactly
  as the desk `ItemView.svelte` orders them — due (T-label · long date, in
  the urgency ink), snoozed until, section, type, orbital period, cost,
  provider, reference, reminders; then a `DOCUMENTS` caps head and one
  `.p-paper` line per paper (name, size · pages; not tappable here, as on
  the desk); then `NOTES` and the note in `.p-prose`. Its pills: `open →`
  (act-accent) and `complete` (act-ok; the record sheet, or an instant
  complete with an undo wake for items with nothing to record). Then
  `copy link` as a quiet 13px mono line, 44px hit, `--ink-quiet` —
  the desk's `.ivcopy`, the one place the address is offered.
- A **suggestion row** (the relay's catch) opens the same way: `detail`
  is the readings as `.p-kv` (`provider` · value, with `sure`/`unsure` in
  12px caps after the value), then the attachment line (◆ name · size ·
  `scanned clean` in `--ok-text`); pills `Add to orbit` (filled, arms) and
  `Dismiss` (act danger, arms), then `review & amend →` as the quiet line.
- The opened panel carries `view-transition-name:pocket-item` (moved from
  `.pk-card`), so `open →` still morphs into the belt's card.
- **Dial body tap** does what the desk's does (`<a href="#id">` on
  `.body-link`): scrolls the manifest so the row sits centred and opens it;
  the body wears the lit ring while its row is open (an accent stroke ring
  at r+4, 1.5 wide — the desk `.lit`). Second tap on the lit body
  approaches. See question **6** if the owner would rather go straight to
  the belt.
- **Search result tap** closes the sheet and opens the row the same way
  (on the belt it approaches directly, as built).

**The dial's richness** (the biggest single gap next to `desk/home.png`):

- Bodies take the desk's spheres: copy `p-ruby`, `p-jade`, `p-amber`,
  `p-sky` (`radialGradient cx=34% cy=30% r=72%`, stops verbatim from
  `+page.svelte` 1010–1025) into the pocket SVG's `<defs>` and fill bodies
  `url(#p-…)` by paint; radius unchanged.
- The sun: keep the 8-unit core `#fff6e6`; add under it a 16-unit circle,
  same fill, opacity .28, `filter` `feGaussianBlur stdDeviation 5` (the
  desk `#sun`, scaled), with `animation:breathe 4.2s ease-in-out infinite`
  on its opacity (.55–1). Static geometry, opacity only.
- The household's name under the sun: `<text>` at y+28, 15 viewBox units
  (13px at 360), `--ink-mid`, `--ui` — the desk's `#dial-name`. It is a
  name, not a count.
- Twelve month ticks on the ring: 6 units long, `--line`, at each month;
  the quarter labels stay as built.
- The inner danger ring gets the desk's `danger4` radial wash (a circle at
  r 62 filled `url(#danger4)`, the desk's stops).
- The nearest-due body pings: a ring at r+3, stroke `currentColor` .7,
  `animation:ping 3.4s ease-out infinite` (`scale(.6)` → `3.2`, opacity to
  0) — home.css `ping`, `transform-box:fill-box`.

**Trials, judged.** North star: keep — bottom-right, 56px, in reach, and
now clear of the wake (§1.3). Type lift: keep — 16/13 rows read at arm's
length in every shot and the manifest is still under the fold, where it
belongs.

### 2.2 Item and the belt (`/item/<id>`)

Record a completion, reschedule, snooze, retire: callouts with the act in
the foot (§1.2). `completed on` · `next orbit` share a line at 390 and
stack at 360. Nothing else changes; the belt already carries its halos,
roll and landed card.

### 2.3 Inbox (`/inbox`)

Failed rows open on a tap → `remove` (arms). Hint reworded (§1.1). The
review card's acts stay visible. Lane heads' counts are the bead (§1.6).

### 2.4 Settings (`/settings`)

Sign-in method rows open → password: `change` (opens the callout),
`remove` (arms); identity provider: `unlink` (arms). Signed-in devices
open → `sign out` (arms). First/final warning are list sheets. Change
password: `save it` in the foot. `sign out of every device →` stays a pill
at the card foot.

### 2.5 Household (`/household/<id>`)

Members open → `hand over` (opens the callout), `remove` (arms); your own
row → `leave` (arms; the "nothing you added goes with you" sentence is the
panel's `detail`). Invited rows open → `resend`, `withdraw` (arms).
Sections open → `move up`, `move down`, and `remove` on custom sections
(arms); the switch stays in the face and toggles without opening. Knocks
keep their visible approve/decline. Invite, add an account, add a section,
delete: callouts with the act in the foot.

### 2.6 Administration (`/administration`)

People open → `place in a system` (list sheet), `new setup link`,
`disable` (arms). Deleted systems keep the visible `restore`; `delete now`
sits in the opened panel (arms). Invite: callout, `create` in the foot, the
stepper in the body. Setup link: `send it` in the foot.

### 2.7 The door (`/`, `/login`, setup, approve, invite, sign-out) — #1127

The ring moves to the upper-middle. In `door-phone.css`:

- Bare door, held dawn, sign-out, invite outcome, other-status errors (the
  ring with nothing but the gate or a line under it): ring centre at 40% of
  the visible height — `--door-top:clamp(calc(env(safe-area-inset-top) +
  28px), calc(40dvh - var(--door-ring) / 2), calc(env(safe-area-inset-top)
  + 200px))`. At 844 the top is 187px (was 44); at 664 it is 115px.
- Card modes (sign in, local, claim, first administrator, waiting, approve,
  setup): centre at 30% — `calc(30dvh - var(--door-ring) / 2)` in the same
  clamp. At 664 (a 240px ring, next rule) the top is 79px, the bottom
  319px and the card starts at 339px.
- `--door-ring` is 302.4px at ≥760px visible and 240px below it on card
  modes only (the bare door keeps 302.4). At 640 tall with the 240 ring the
  first administrator's card (the tallest, 326px) ends at 652px; the
  chrome already scrolls if a platform's bars take more.
- Typing still closes the ring to 96px (built).

### 2.8 Off the chart (`+error.svelte`, `static/screens/notfound.css`)

The well is fitted to the whole 1600×1000 scene, so at 390 it is 358px
wide and the hole is 60px. Fit the well's own box instead: `--kw:min((100cqw
- 2 * var(--p-gutter)) / 760, 58cqh / 640)` — the two 4s span x 440–1160
and the glow y 130–770 in scene units. The SVG stays centred on (800,450)
at 50% height as built (`.fall`/`.first` keep their formulas, they read
`--kw`). At 390 the 4s then span 339px and the hole is ~108px; at 360, 318px
and ~100px. The hole's glow bottom (~482px at 664) stays above the title
(fixed at 142px + safe from the foot). Text sizes unchanged.

### 2.9 Everything else

Kit route, hatch, create, settings › mail, maintenance, approve, 500: only
the kit-level changes above. The hatch's `Items` row (not in the proposal)
stays; it is harmless and the owner did not object.

---

## 3. Build order for Opus

1. `Sheet.svelte` foot + height rule (§1.2); wake over the star (§1.3).
   Every audit defect clears here; the fidelity gate's expected failures
   flip to passes.
2. `Row.svelte` tap-to-open, panel, `detail` snippet, one-open-per-group
   (§1.1); delete the swipe path in `row.js`; update every caller's acts
   and hints (§2.3–2.6).
3. Home: manifest and suggestion drawers, dial tap → row, search → row,
   remove the item/suggestion sheet faces, move the view-transition name
   (§2.1).
4. Dial richness and motion (§2.1 dial, §1.4): gradients, sun, name,
   ticks, ping, arrive, cards land, theme crossfade, sky density (§1.5).
5. Door ring station (§2.7) and the well's fit (§2.8).
6. Reshoot the review set at 390×664 and 360×640; the owner judges the
   home from that set.

---

## 4. Questions for the owner

Numbering continues the proposal's (1–5 are answered).

**6** (asked on 2026-09-26 as question 2) Tapping a planet on the dial. The desk's body is a link to its row;
the proposal had it raise the item sheet, which is now gone.
 a) The body scrolls the manifest to its row and opens the drawer; second
    tap on the lit body goes to the item (my recommendation: one grammar,
    and it is the desk's own behaviour).
 b) The body goes straight to the item screen; the drawer is reached from
    the manifest only.

**7** (asked on 2026-09-26 as question 3) Reordering sections, now that the opened row can hold `move up` /
`move down` pills.
 a) Pills only; drop the long-press lift (my recommendation: discoverable,
    accessible by default, and one less gesture to teach).
 b) Keep the long-press lift as well, with the pills as the accessible
    route.

---

## 5. Build rulings (2026-09-26)

On Opus's build of §2.7/§2.8 (`feature/phone-review-door`, `ed10d549`).
Numbers are at 390×664 and 360×640 unless said; `--door-top` is the ring's
top edge as `door-phone.css` defines it.

**5.1 Sign-out: the pill goes into the flow under the line.** At 664 the
line under the ring runs 443–487px and the pill's fixed 68% station is
452px, so they meet. Stop fixing the pill to a share of the height: the
farewell's `.sub` and the gate stand in one column under the ring, on the
axis. `.sub` keeps `margin-top:26px`; the gate takes `margin-top:max(24px,
calc(68dvh - var(--door-top) - var(--door-ring) - 70px))` (70 = the line's
26px gap plus its two 13px/1.7 lines). That leaves the pill at 68% wherever
there is room (at 844 it lands at 583px, 9px under today's 574) and 24px
under the line where there is not: 511–555px at 664, 501–545px at 640,
both clear of the ember rim (the limb burns at 92% of the frame: 611px and
589px). Three lines of text on a large-text setting still cannot collide,
because the pill is in flow. The `/logout` known defect in
`door-station.spec.js` flips to a pass; add to it: gate top ≥ line bottom
+ 24px, gate bottom ≤ 92% of the visible height.

**5.2 The rule stands; the example was wrong.** Below 760px visible a card
mode's ring is 240px, so at 664 the top is 79px, the bottom 319px, the
card starts at 339px — Opus's numbers. §2.7's example is corrected above.
Two things follow for the 240 ring: it keeps the glyph's proportion, so
its stroke is 3.4px and its orb 23.4px (302.4 : 4.2 : 29.4, as the 96px
typing ring already does at 1.5/9.4); and the question inside it (`.ask`)
is 200px wide at 20px, so a two-line heading sits inside the chord.

**5.3 The well: 459px is right.** The scene stays centred at 50% as built;
my "482" was a slip. At 664 the glow's bottom is 459px against the
heading's top at 490px; at 640, 439px against 466px. The spec's
`glowBottom < headingTop` is the gate; nothing changes.

**5.4 The ring travels between stations; it never jumps.** A jump is not
wanted; a ring that closes and moves is the desk's own hand-over grammar
(#873, the 500px ring closing to 302.4 over 500ms). So:

- `.ringcard .bigring` rests at the bare door's station while no card
  shows — 302.4px with its top at the 40% `--door-top` — even though it
  is invisible there. `body.showform` moves it to the card's station
  (30%, and 240px under 760px). `margin-top`, `width` and `height` already
  transition at `.5s cubic-bezier(.55,0,.2,1)` on that element; the
  opacity crossfade with the lockup (.16s out, .8s in after .46s) is as
  built. The card's `#formlayer` rides the same 500ms `margin-top`
  transition it already has, so it arrives under the ring, not before it.
- On launch (`body.launching`) the ring goes back the same way: station
  40%, 302.4px, over 500ms on the same curve, while its opacity leaves;
  the lockup's return waits for it (delay its opacity-in by .5s in the
  launch's first beat). If `timeline.js`'s first beat is shorter than
  500ms, the return runs at the beat's length and never longer; the ring
  must be at the 40% station before the lockup flies.
- The word→question swap inside the ring is the crossfade as built.
- Reduced motion: no travel — each ring appears at its own station, as
  the existing reduced-motion block already forces.

**5.5 Side bleed is acceptable; the well itself must stay whole.** The
glow (r 520 scene units → 245px at 390) and the falling bands and labels
are sky, and sky bleeds — the desk's own `slice` crops the scene on a
1440-wide screen. The rule: the two 4s and the disc's rings (out to r 288
→ 136px at 390, 127px at 360) stay wholly on screen and centred, which the
spec's well-box check already holds; `.world{overflow:hidden}` stays so
nothing bleeding makes a horizontal scroll. No change.

No new owner question: every point above is settled by the desk or by an
earlier ruling.

---

## 6. Build rulings, round 2 (2026-09-26)

On Opus's build of §3 steps 1–4 (`feature/phone-review-round`, `a465bd37`).
Questions **6** and **7** stay parked with the owner.

- **a. Section `edit` stays, first.** §2.5's list was short: the name and
  the "tap to swap" mark are only reachable through the edit sheet on a
  phone. Order in the panel: `edit` (act-accent) · `move up` · `move
  down` · `remove` (arms, empty custom sections only).
- **b. New system is a list sheet.** It is a picker (the owner-to-be is
  the row you tap), and §1.2 puts pickers in list sheets. Keep it; the
  name and password fields ride at the top of the body as built.
- **c. Stack at 360: use `minmax(170px, 1fr)`.** At 390 the body is 358px
  and two 170px columns plus the 8px gap (348px) fit; at 360 the body is
  336px and they do not, so the pair stacks. 150px was the pill rule
  (§1.2 foot) applied to fields by mistake.
- **d. `scroll-padding-bottom:12px`.** The foot sits outside the scroller,
  so the scroller already ends at the foot's top; padding by the foot's
  height double-counts it. Drop `--p-foot`.
- **e. A result with no row approaches.** The manifest lists what needs
  attention, so a result off it goes straight to `/item/<id>`, as it does
  from the belt. The item-sheet face is deleted, not kept as a fallback:
  the owner rejected that card. Searching is the reader's intent; one tap
  to the item is the right cost.
- **f. Print only what the data holds.** `name · size · added <date>` for a
  paper; the suggestion's attachment as `◆ name · scanned clean` without a
  size. Never a dash or "?" for a missing value; the line just omits it.
  §2.1's "size · pages" was wrong about the data.
- **g. The dial arrives on every forward arrival, never on Back.** That is
  the desk's own flag and rule (`+page.svelte`, `arrive`), and the desk is
  the reference; §1.4's "once per session" is withdrawn.
- **h. "nothing needs you" opens as the next item up.** Intended: it is
  that item's row in quiet dress, and its panel shows where `open →`
  leads. Keep.
- **i. `pk-*` gradient ids.** Fine.
- **j. `disable` arms, and the wake still offers undo.** §1.8 arms every
  act that shuts someone out; the undo (§1.13) is the second guard, not a
  reason to drop the first. Keep as built. `enable` acts at once.
- **k. Unify on the kit's landing.** `hh-rise`, `st-rise`, `rl-rise` and
  the inbox receipts' entrance are the same idea at slightly different
  numbers. Replace them with the kit's `p-landed` (600ms, `cubic-bezier(.3,
  .7,.2,1)`, `--i` × 60ms): `.p-card` lands by itself; add a `.p-land`
  utility in `kit.css` with the same keyframe for a page's header, caps
  heads and any non-card block that rises, taking `--i` the same way. The
  screens keep their own art (the household glyph's land and chip orbit,
  the relay's waves and craft) — those are personality, not entrance.

No new owner question.
