# #1083 — the pocket cut of the one-take film: build notes

For the builder (a cheaper model). Fable made the design calls below under the
owner's decision of 2026-09-30 (desk film = precedent; this is a translation,
not a new design; no verdicted round before the build; the owner reviews the
built pocket film). Everything here is buildable as written. Where a call is
mine rather than the owner's or round 8's, it says so and gives the reason.

Reference drawing: `1083-drawings/transport.html` beside this file (the pill
in its three places). Round 8's mockup and shots are the picture of every
chapter: `git show gitlab/design/1083-tour-pocket:design/v19/tour/round-8/README.md`
and `g-pocket.html` (branch `design/1083-tour-pocket`, commit `bc3a179b`, not
on dev).

## 0. Where things stand (checked 2026-09-30 against dev `069ecc58`)

- The desk film, engine and transport are **on dev**: `web/src/lib/tour/`
  (film.js, clock.js, player.js, vocabulary.js, transport.js, veil.js,
  chapters/01–12, trigger.js, Tour.svelte). They came in via
  `feature/866-one-take-tour` / !972, not !941. **!941
  (`feature/m9-tour-and-marks`) is a stale draft of the superseded ten-beat
  design; ignore it.**
- Round 8 (the pocket cut, 2026-09-24) is on `gitlab/design/1083-tour-pocket`
  only. The owner answered its three questions on 2026-09-25:
  **1a** (the pill docks to the top while a bottom sheet is up and returns
  after, with two measured fixes: it returns only once the sheet's fade has
  finished; chapter 2 scrolls the create card clear of the pill at 390;
  acceptance = the per-250ms clash measurement at 390 and 360 shows zero);
  **2c** (chapter 8 is re-cut against the built `/item` phone layout, #1072,
  and the real route from a body to `/item`, #1119 — both merged);
  **3b** (the phone line reads *later → steps the belt.*; desk unchanged).
- Ratified copy: `design/owner-decisions.md` §23 (round 5 + rounds 6–7's
  corrections, as built in `chapters/*.js`). §24 says a phone shows nothing
  until this ships and does not spend `tourSeenAt`; this build ends that.
- The pocket grammar: `design/v19/phone-vision/proposal.md` (§1.4 sheets,
  §1.6 type floor 12px, §1.7 44px targets, gutters 16/12), `review-round.md`
  (§1.2 acts in a pinned foot), `round-3.md` §1 (prose rules); tokens in
  `web/src/lib/pocket/tokens.css`; the switch is `isPocket()` /
  `POCKET_QUERY` in `web/src/lib/pocket/media.js`:
  `(max-width: 900px), (max-height: 600px)`.
- Two of round 8's findings are already fixed on dev and change the cut:
  the belt has its phone layout (papers ride at ±20% of the width with 44px
  hits, end-caps are 44px ghost pills at the plate's shoulders, the reading
  card is a kit Sheet); and the pocket's route from a body to `/item` is
  **tap the body → its manifest row opens → the row's `open →` act** (owner's
  6a, `tapBody`/`openRow`/`itemActs` in `routes/home/pocket.svelte`). There
  is no "item sheet with an `open` button" any more. Chapter 8 below follows
  the built route.
- One of round 8's copy assumptions is stale: the desk's chapter 1 line 4 is
  now *"…— tap one to fly there."* (`bfd99cc8`), and the pocket's chips do
  fly. No "ask to join" is drawn anywhere.

## 1. Scope, and what must not change on desk

Build: the pocket dialect of the same film, on the same engine. One clock,
one vocabulary, one player, one transport module, one chapter file per
chapter, one script.

Must not change on desk (a fidelity frame or a unit test should catch each):
- Any callout string, chapter order, beat, mark name or hold on the desk.
  `__script` on a desk viewport is byte-identical before and after.
- The desk transport: 470×44 pill, 32px buttons, 18×38 tick buttons, hover
  tips, Space/Esc, recede 38%/16%. Its stylesheet stays under a desk-only
  query or unchanged selectors; pocket rules go under `@media (max-width:
  900px), (max-height: 600px)`.
- The desk film's length (3:41 normal / 2:07 reduced, as measured by the
  player) and the ticks' places. The desk chapters' dry-run paths do not
  change because every pocket branch keys off `ctx.pocket`, fixed at mount.
- `tour-dark` and `tour-light` fidelity frames stay within budget.
- The film still never writes into a field, never persists a click's side
  effect, never leaves the DOM different from how it found it.

Non-goals: no new copy (two phone strings only, §6); no second engine; no
shortened cut (§7); no change to when the film plays (§23) other than that a
pocket viewport now plays it.

## 2. Dialect at mount

- `Tour.svelte`: replace `phone: !matchMedia(DESK).matches` with
  `pocket: isPocket()` (from `$lib/pocket/media.js`), so the film picks the
  dialect the screens themselves pick — CON-10 includes the height clause,
  and a short desk window shows pocket screens. Pass `pocket` into
  `createFilm({ pocket })` → `createFilmContext({ pocket })`. Remove the
  `DESK` constant and the §24 comment; point at §24's shipped note instead.
- `trigger.js`: delete the phone gate. `beginFilm` no longer takes `phone`
  and never returns `"phone"`. Everything else (failed-read, already-seen,
  no-household, the single `writeSeen` on end) is unchanged and now applies
  to a pocket login too. Update `tests/unit/v19-tour-trigger.test.mjs`: the
  "phone writes nothing" case becomes "a pocket viewport starts the film and
  writes once on end".
- `offer.js` needs nothing: `.adrift` is on the pocket's labelled sky too.
- `vocabulary.js`: `createFilmContext` gains `pocket = false`, exposed on the
  context as `pocket` (boolean) so chapters can choose selectors and anchors.
  Chapters never call `matchMedia`.
- Chapter files: each `SELECTORS` becomes two frozen sets, `DESK` and
  `POCKET` (names below), chosen once at the top of `play` via
  `const S = ctx.pocket ? SELECTORS.POCKET : SELECTORS.DESK`. Unit tests pin
  both sets against the real markup (§10).
- `owner-decisions.md`: append to §24 a dated line — "Shipped by #1083 on
  <date>: the pocket cut plays on a pocket viewport and spends `tourSeenAt`
  the same way the desk cut does." — and add a new numbered section
  "The pocket cut of the one-take film (Fable's call, 2026-09-30)" recording
  the calls marked **Call** below. Also cherry-pick `bc3a179b` (round 8) onto
  the build branch so `design/v19/tour/round-8/` lands, and copy this file
  there as `design/v19/tour/round-8/build-notes.md`.

## 3. Vocabulary changes (`web/src/lib/tour/vocabulary.js`)

All additive; the desk path through every word is unchanged.

**3.1 `goto` scrolls the control into view first (pocket only).** Before
`travel`, when `ctx.pocket` and the control's ring box is not wholly inside
the band between the top chrome (`.p-chrome`, 56px + safe area) and the
pill's current rect: `els[0].scrollIntoView({ block: "center", behavior:
"auto" })`, then wait one animation frame (`clock.stall()` around it, as
`setScreen` does, so the budget is untouched), then measure. The veil's
holes follow via veil.js's scroll listener. Nothing on desk scrolls
(chapter 4 does its own scroll and keeps doing so).

**3.2 Callout placement on the pocket.** In `showCallout`/`callout`, when
`ctx.pocket`:
- `left` and `right` resolve to `top` or `bottom` — whichever has more room
  between the anchor edge and the band's limit (chrome below / pill above).
  Explicit `top`/`bottom` is kept unless the box does not fit (< box height
  + 18px gap), in which case it flips. `dy` is honoured after resolution.
- Horizontal: centred on the anchor point, clamped to `--p-gutter`
  (16/12px) rather than `CALLOUT_EDGE`; `max-width: min(300px, 100vw −
  2·gutter)`; a chapter's `w` still caps it.
- Vertical clamps: never above the top chrome's bottom + 8px, never inside
  the pill's rect + 8px **wherever the pill is** (read
  `#orbit-tour-transport.getBoundingClientRect()` when mounted; fall back to
  `TRANSPORT_LANE` at the foot when not), never off the bottom.
- Label callouts (`label: true`) are 12px mono on the pocket (the floor);
  body lines stay 13.5px/1.45.
- The stem still points at the anchor point, clamped 14px from the corners.

**3.3 Sky lines sit under the sun.** Round 8's rule: on the pocket, a line
whose subject is the dial or a body on it is anchored to the sun, side
`bottom`, `dy: 30`, so it sits in the dial's lower half beneath the
household's name rather than over the bodies. Chapters do this by choosing
the anchor (§6); no new word.

**3.4 `open(c)` and `close()` — the pocket's sheet and row openers.** A
generalisation of `read()`/`unread()` on the same terms (dispatch one real
click where the opener mutates nothing that outlives the film):
- `open(c)`: `c.els[0].dispatchEvent(new MouseEvent("click", { bubbles: true,
  cancelable: true }))`. Allowed targets, each recorded here so nobody
  mistakes it for a licence to click anything: `#morb` (sets `hatchOpen`; the
  kit Sheet pushes a shallow history entry it pops on close), a dial body
  `.pk-body` (opens its manifest row in place and lights it — UI state only),
  a paper's `g.hit` (already `read()`; raises the preview sheet). Nothing
  else. `open()` pushes an undo onto a list: for a sheet, `close()`; for a
  row, a click on `[data-row-face][aria-expanded="true"]` in the same row.
- `close()`: dispatch `new KeyboardEvent("keydown", { key: "Escape", bubbles:
  true, cancelable: true })` **on `doc`, not `window`** — the kit sheet's
  `holdSheet` listens on the document in the capture phase. Mark the event
  with a property `tourfilm = true` so the transport (§4.6) ignores it. Then,
  under `clock.stall()`, wait until no `.p-sheet-layer.open` is in the
  document and `history.state?.pocketSheet` is unset (poll each frame,
  bounded at 800ms). Dry mode: no-op, zero time — the sheet's rise and fold
  are motion and are already priced by `w(T.sheet)` in the chapters (add
  `T.sheet: 300` to `T`, matching `--p-rise`).
- `unread()` changes its dispatch target from `window` to `doc` for the same
  reason (a document-dispatched keydown still reaches the item page's
  window handler). `read()` unchanged.
- `clear()` runs the undo list in reverse for any target still connected
  (a screen change already disposed of the rest), then empties it. This is
  what makes a jump or a stop leave no sheet up and no row open.

**3.5 `ControlSpec.ringless`.** `light()` on a ringless control cuts the
veil's hole and lifts nothing, drawing no ring. Used to keep an open sheet's
panel (`.p-sheet-layer.open .p-sheet-panel`) bright while a row inside it is
ringed — round 8's `menu` cut-out.

**3.6 The drawn bodies (chapters 3, 5, 9, 12).** `dialPlacement()` returns
coordinates in the dial's 380-unit viewBox; the pocket dial's SVG is the same
viewBox (`.mdial svg viewBox="0 0 380 380"`), so the groups append to
`.pocket .mdial svg` with no scaling. Only the parent selector changes.

**3.7 Inert exclusion.** Every element the film mounts on `<body>` — the veil
(`#orbit-tour-veil`), the chrome layer (`#orbit-tour-film`) and the transport
(`#orbit-tour-transport`) — carries `data-pocket-above=""`. `focus.js`'s
`inertPage` already skips that attribute, so the pill stays pressable while a
kit sheet is up. Harmless on desk.

## 4. The transport on the pocket (`transport.js`)

One module, one DOM, two stylesheets' worth of rules. Pocket rules under
`@media (max-width: 900px), (max-height: 600px)`; measure the pill's actual
place from the DOM, never from the query, when clamping callouts.

**4.1 Shape.** `left/right: var(--p-gutter)` (358 wide at 390, 336 at 360);
`bottom: calc(12px + env(safe-area-inset-bottom))`; height 64; radius 18;
`display:grid; grid-template-rows: 18px 44px; padding: 1px 8px`. Row one
(`.words`): chapter name at the left (`.now`, 12px mono, `.14em` tracking,
uppercase, `white-space:nowrap; overflow:hidden` — **no `text-overflow:
ellipsis`**, round 3's guard flags it), `m:ss / m:ss` at the right (`.clock`,
12px mono, tabular). Row two: play/pause and stop 44×44 (radius 12), then
the track. **Call:** 64 not round 8's 60 and 12px not 9.5/10px, because the
kit's floor is 12px and the transport is drawn on the kit. Icons unchanged.

**4.2 The rail is the target.** `.track` is `role="slider"`, `tabindex="0"`,
`aria-label="Chapter"`, `aria-valuemin=0`, `aria-valuemax=11`,
`aria-valuenow=<chapter>`, `aria-valuetext="Chapter n: Name"`, 44px tall,
`touch-action:none`. Pointer: `pointerdown` → `setPointerCapture`, add
`.touched` to the bar, `aim(nearest(clientX))`; `pointermove` while aiming →
re-aim; `pointerup` → `player.jump(nearest(clientX))`, un-aim, drop
`.touched` after 1200ms; `pointercancel` → un-aim. `nearest(x)` maps x along
the track to a reading and returns the chapter whose offset is closest
(round 8's function). While aiming, the aimed tick's mark grows 1×6 → 1×10 in
the accent and `.now` shows the aimed chapter's name in the accent
(`.tipping`); on release it shows the playing chapter again. Keyboard on the
slider: ArrowRight/ArrowLeft jump ±1 chapter, Home/End first/last. **Call:**
the twelve ticks are painted `<i class="tick">` marks on the pocket, not
buttons — twelve buttons cannot meet the 44px floor on a 250px rail without
lying about their hit box, and a slider is the keyboard route the desk's tick
buttons were. On desk the ticks stay buttons exactly as built (branch on
`isPocket()` at mount inside `buildTicks`).

**4.3 Recede.** `.dim` (38%) while playing and not ended; `.gone` (16%) when
ended; `.touched`, `:hover`, `:focus-within` bring it to 1. A `pointerdown`
anywhere on the bar sets `.touched` for 1200ms.

**4.4 Dock and stand (owner 1a + Call).** The transport owns this; chapters
never say it. A `MutationObserver` on `document.body` (subtree, attributes
`class`) plus a `ResizeObserver`:
- A kit sheet is up (`.p-sheet-layer.open` exists) → `.top`: `bottom:auto;
  top: calc(10px + env(safe-area-inset-top))`, same width.
- No sheet, but a fixed foot bar owns the foot (`.pk-bar` on `/create`) →
  `.raised`: `bottom: calc(<bar height> + 12px)`, the bar's height measured
  each resize. **Call:** the save bar is the pocket's own foot on `/create`
  exactly as a sheet is; standing on it keeps the reader's back link and
  avatar uncovered, which a top dock would hide for the whole chapter.
- Otherwise home at the foot.
- **Moving is a fade, not a slide:** opacity → 0 in 150ms at the old place,
  reposition, opacity → its recede level in 200ms. Reduced motion: instant.
  **Call:** a pill sliding across a rising sheet clashes with it by
  definition; round 8 drew a slide, the clash sampler is what decides, and a
  fade cannot clash.
- **Return timing (owner's fix 1):** leave `.top` only 350ms after the last
  `.p-sheet-layer.open` disappears (the sheet's `--p-rise` is 300ms). Going
  to `.top` is immediate on `.open` appearing.
- Also add `data-tour-pocket=""` to `<html>` while the pocket transport is
  mounted; `routes/create/pocket.svelte` adds
  `:global(html[data-tour-pocket]) .pk-column { padding-bottom: +76px }` so
  the form's last field can scroll clear of a raised pill (owner's fix 2 in
  its built form).

**4.5 Dawn.** Nothing to do: the pill is pack tokens (`--panel-raised`,
`--line`, `--ink-quiet`, `--accent`), and `wear("dawn")` sets
`data-theme` on `<html>`. Check in the held `sky-dawn` frame that the pill
reads on dawn (it does on desk).

**4.6 Keys.** Register the document `keydown` listener with `{ capture: true
}` so Esc still stops the film under a kit sheet (whose own capture handler
stops propagation). Ignore events with `event.tourfilm === true` (the film's
own dispatches, §3.4). If Esc arrives while a sheet the film did not open is
up, let it pass (the reader is closing their own sheet). Space unchanged.
The Script button and region (round 7) are unchanged and stay `.vh`.

**4.7 Announcement copy** (round 7) is unchanged; it already says "a
transport at the bottom" — acceptable, the pill is at the bottom at rest.

## 5. Selectors, desk → pocket

Verified against dev on 2026-09-30. Pin each in the chapter's unit test
against the named source file.

| Ch | Desk (as built) | Pocket | Source |
|---|---|---|---|
| 1,3,5,9,12 | `.dial` (svg) | `.pocket .mdial` (ring, round); drawn bodies append to `.pocket .mdial svg` | `routes/home/pocket.svelte` |
| 1,12 | `.sun-link` | `.pocket .mdial .pk-sun` — **add `class="pk-sun"` to the `<circle cx="190" cy="190" r="8">`** in pocket.svelte (one attribute; no style change) | pocket.svelte ~l.767 |
| 1,10 | `.minisys .msring` | `.pocket .skies .msys` (pill chips, radius 22, `all`/first, optional) | pocket.svelte l.811 |
| 2,7,11 | `#nstar` / `.inbox-orb` / `button.orb` | `#morb` (round) | pocket.svelte l.690 |
| 2 | — | Hatch row `.p-sheet-layer.open [data-row-face][href$="/create"]` (radius 10) | `lib/pocket/Hatch.svelte`, `Row.svelte` |
| 2 | `#card` | `#pocket-entry .pc-form > .pc-card:first-child` (radius 16) | `routes/create/pocket.svelte`, `EntryForm.svelte` |
| 2 | `#f-name` | `#pocket-entry input[id$="-name"]` (radius 10) | EntryForm.svelte l.136 |
| 2 | `#types button[data-type="inspection"]` | `#pocket-entry .pc-kinds .pc-chip:nth-child(3)` (radius 22); test pins `KINDS[2].id === "inspection"` | `routes/create/entry.js` l.20 |
| 2 | `#f-date` | `#pocket-entry input[id$="-due"]` (radius 12) — exists with no kind chosen (`kindHasDate(null)` is true) | EntryForm.svelte l.185 |
| 2 | `#f-cost` | `#pocket-entry input[id$="-cost"]` (radius 12) | EntryForm.svelte l.215 |
| 2 | `#f-recur` | **none — beat dropped on the pocket** (§6, ch 2) | EntryForm.svelte l.190 |
| 2 | `#card .btn-primary` | `.pk-bar .pk-save` (radius 22) | create/pocket.svelte l.182 |
| 4 | `#manifest-top`, `.today`, `.item` | `.pocket .pk-below`; first `.pocket .pk-below h2.p-caps` (optional); first `.pocket .pk-below .p-row` (optional, radius 14) | pocket.svelte l.826+ |
| 6 | `.relay-card` | same | `routes/settings/mail/+page.svelte` |
| 7 | — | Hatch row `[data-row-face][href$="/inbox"]` | Hatch.svelte |
| 7 | `.lanes .lane.filed` / `:nth-of-type(2)` / `(3)` | `.pki-lane[aria-labelledby="pki-review-h"]`, `[aria-labelledby="pki-reading-h"]`, `[aria-labelledby="pki-filed-h"]` (all optional, radius 16) | `routes/inbox/pocket.svelte` l.226–280 |
| 7 | `.receipt .actions button.yes` | `.pki-lane .rv-yes` (ArmButton "Add to orbit", optional, radius 22) | `lib/pocket/ReviewCard.svelte` l.84 |
| 8 | `.body-link` | `.pocket .mdial .pk-body` (first, round, optional) — opened for real, §3.4 | pocket.svelte l.783 |
| 8 | — | the opened row's act `.pocket .pk-below [data-row-acts] a[aria-label^="Open"]` (optional, radius 22) | pocket.svelte `itemActs`, Row.svelte l.186 |
| 8 | `#caps .doclabel` | same (pocket captions keep `doclabel`) | `item/[[id]]/belt.behaviour.js` l.443 |
| 8 | `g.hit[aria-label*="a document attached to"]` | same | belt.behaviour.js l.382 |
| 8 | `#cardwrap` (anchor for "The page itself…") | `.p-sheet-layer.open .p-sheet-panel` (the preview sheet), side `top` | `lib/pocket/Sheet.svelte` |
| 8 | end-caps `#ends g.endcap-hit[data-step="±1"] text.endcap` / `rect.endtarget` | **same selectors** (pocket pills are `g.endcap-hit.pocket` with `rect.endtarget.endpill`) | belt.behaviour.js l.548 |
| 9 | `.item-card`, `.acts[aria-label="Item actions"] button:first-child` | `.item-card` (same), `.ip-acts[aria-label="Item actions"] .ip-complete` (radius 22, optional) | `item/[[id]]/+page.svelte` l.1240 |
| 11 | `#account nav a[href$="/settings"]`, `#account .swatches`, `button[title="dawn"]`, `button[title="after dark"]` | `.p-sheet-layer.open [data-row-face][href$="/settings"]`, `.p-sheet-layer.open .swatches`, `.p-sheet-layer.open .swatch[title="dawn"]`, `.p-sheet-layer.open .swatch[title="after dark"]` | Hatch.svelte; titles from `lib/theme-swatches.js` |
| any sheet | — | `.p-sheet-layer.open .p-sheet-panel` (ringless light, §3.5) | Sheet.svelte |

`chapter.enter` is unused by every chapter today; leave it.

## 6. The chapters, beat by beat

Copy is §23's, as built in `chapters/*.js`, **unchanged** except the two
pocket strings marked ✎. Marks keep their names so the fidelity hooks and
round 8's shots line up. "by room" = §3.2's resolution. "sky line" = §3.3.

**1 · Arrive.** Same beats. Pocket anchors: "This is your star chart." → sky
line (dial ringed); "Every sun…" → sky line with `.skies .msys` all lit;
"That's your sun…" → sky line; "The rest of the sky … tap one to fly
there." → first `.msys`, by room (lands below the strip). Marks
`arrive-chart`, `arrive-suns`, `arrive-gran`.

**2 · Add.** Pocket: `/home`, `veil(false)`; `orb = ctl(#morb, round)`;
`veil(true)`; `goto(orb)`; `press(orb)`; `open(orb)` → hatch rises, pill
docks (automatic); `w(T.sheet)`; `light(panel, ringless)`; `addLink` goto,
press; `mark("add-star")`; `unlight`; `close()`; `setScreen("/create")` →
pill stands on the save bar (automatic). Card lit, "Add anything here…" by
room, `mark add-drawer`. Name: goto (scrolls), press, `typeInto("Car MOT —
Volvo V60", { mark: "add-typing" })`. Inspection chip: goto, press, `quiet`.
Due: goto, press, `typeInto("29 Aug 2027")`. Cost: goto, press,
`typeInto("54.85")`. **Recurrence beat dropped on the pocket** (`add-yearly`
is desk-only): the pocket form only renders "comes round" once a kind is
really chosen, and really choosing one dirties the form so `/create`'s
"Leave without adding?" sheet would block chapter 3's `setScreen("/home")`.
**Call**, and the one place the pocket plays fewer beats. Add: `.pk-save`
goto, press, `mark("add-add")`. The card is left lit as on desk.

**3 · Lands.** Body drawn into `.mdial svg` (same coordinates). "Bodies
orbit by when they're due." → anchored to the body, by room; "The nearer the
ring, the sooner." → sky line. Marks unchanged.

**4 · Below the dial.** `manifest = .pk-below`; scroll it `block:"start"`
(the page clamps at its end, ≈360px at 390×844); `mark manifest-scrolled`;
`veil(true)`; head lit, "The manifest lists what's ahead, nearest first."
(`w:196`, by room, `mark manifest-today`); first row lit, "Same law as the
dial…" by room (`mark manifest-row`); `veil(false)`; scroll to 0. Nothing on
the pocket home is fixed except the top chrome, which retracts on scroll.

**5 · Time runs.** Body walk as desk. "Time runs. The nearer the sun, the
sooner." → sky line. Then **pocket only: `veil(true)` with the body lit
(hole)** before "At a month out it warms, and Orbit reminds you." anchored
to the dial, side `top` (clamps under the chrome — round 8's toast
position), `mark time-toast`; `veil(false)` after. Round 8's rule: the
pocket dial has no empty quarter, and a line over the bodies is worse than
a veil. The desk keeps `veil(false)` throughout.

**6 · Paper by post.** Unchanged: `.relay-card`, lines `top` then `bottom`.
The relay page's ≤620px rules already lay the card full width.

**7 · Inbox.** `/home`; `orb` goto; "Mail lands here first…" anchored to the
orb, by room (lands beneath the chrome, over the dial's top — fine),
`mark inbox-orb`; press; `open(orb)`; `w(T.sheet)`; `light(panel,
ringless)`; inbox row goto, press; `close()`; `setScreen("/inbox")`. Lanes:
**pocket order review → reading → filed** (the page's own order, one scroll
down; the labels are pictures, not script, so the transcript is unchanged):
each `goto` (scrolls), label callout `hold:1500`, `mark inbox-lane-<id>`
with the desk's ids (`review`, `reading`, `filed`). `mark inbox-lanes`. Then
review lane lit as a group, `.rv-yes` goto, press, `mark inbox-add`,
"Nothing joins your orbit without your say-so." by room, `mark inbox-sayso`.

**8 · The belt (re-cut per 2c).** `/home`, `veil(false)`; `body = ctl(.pk-body,
round, optional)`; `veil(true)`; `goto(body)`; `press(body)`; `open(body)` —
the row opens and the page scrolls to it (the product's own scroll);
`w(T.scroll)`; `mark("belt-arrive")`; `openAct` goto (scrolls into view),
press (gesture only); `unlight` both; `setScreen("/item")`; `w(T.cross)`.
Papers: `#caps .doclabel` all, optional (at most two ride on the pocket,
`POCKET_RIDE`); goto; "Every body carries its documents in a belt around
it." by room, `mark belt-cert`; "The belt is what you have attached to it."
`w:220`, by room, `mark belt-svc`; ✎ label **"Tap one to bring it in."**
(`label:true, hold:2000, mark belt-doc`; desk keeps "Click one…") — a label,
not in the script; `press(papers)`; `read(docHit)` → the preview sheet
rises, pill docks (automatic); `w(T.sheet)`; "The page itself, read without
leaving the sky." anchored to `.p-sheet-panel`, side `top`, `mark
belt-read`; `dropCallout`; **`unread()` first** (the sheet is modal, and
round 8's order) → pill home; `w(T.sheet)`; `later` goto; ✎ **"later →
steps the belt."** (`mark belt-later`) by room; `press`; `unlight`;
`w(T.cross)`; `sooner` goto, press, `mark belt-sooner`, `unlight`,
`w(T.cross)`; `light(papers)`. The desk's `unread()` stays where it is (after
`press(later)`). Both end-caps optional as on desk. The step is still only
named, never driven (#1094).

**9 · Done.** `/item`, `veil(true)`, card lit, `.ip-complete` goto, "MOT
passed — mark it done…" (`w:240`, by room, `mark done-complete`), press.
`/home`, swing as desk in `.mdial svg`, `mark done-swung`; "A repeat is never
finished…" → sky line, `mark done-round`.

**10 · Other households.** First `.msys` (optional), `veil(true)`, goto; "The
rest of the sky holds households you don't belong to." by room, `mark
others-gran`; "Tap one to fly there — Gran's flat, the narrowboat." by room,
`mark others-ask`; `veil(false)`.

**11 · Your sky.** `orb` goto, press, `mark sky-orb`, `open(orb)`,
`w(T.sheet)`, `light(panel, ringless)`; settings row goto, "Settings holds
your sky…" by room, `mark sky-settings`; swatches goto, label "star chart ·
after dark · clouds · dawn · retrograde" (`hold:2600`, `mark sky-swatches`);
dawn swatch goto, press, `wear("dawn")`, `veil(false)`, `w(T.cross)`, `mark
sky-dawn`, `hold(2400)`; `veil(true)`; after-dark swatch goto, press,
`wear(null)`, `veil(false)`, `w(T.cross)`, `mark sky-back`; **`close()`** (the
desk never opened anything; the pocket must fold the hatch).

**12 · Yours.** Body year as desk; "That was a year, in one turn of the
ring." and "Now it's yours." → sky lines. Marks unchanged.

## 7. Length and reduced motion

**Same length as desk, not shorter** (round 8's call, kept): every beat the
desk plays the pocket plays, less chapter 2's recurrence beat (≈ −2.2s) plus
chapter 8's row route (≈ +2s) and the sheets' rises. Expect ≈ 3:44 normal
(round 8 measured 3:44; the built clock is the measure). The player measures
per dialect at mount, so the pocket's ticks are its own. Reduced motion:
round 5's rule holds — holds are reading and keep their length; `w()` goes
to nothing (sheets appear and vanish, scrolls are simply there, the pill's
fade is instant). Expect ≈ 2:09. Record both measured figures in the PR.

## 8. Themes

Nothing pack-specific to build. The veil is the pack's `--bg` with holes;
`tour.css`'s light-pack rule (dawn/clouds push the lit thing forward rather
than dim) applies unchanged; the pill and callouts are tokens. Verify by
eye at 390 on all five packs (`orbit-theme` in localStorage before load) at
held marks `others-gran`, `sky-settings` (docked), `add-drawer` (raised),
`belt-read` (docked over the preview). The fidelity gate pins star chart and
dawn (§10); dawn is also worn live in chapter 11.

## 9. Product touches (all small, all named)

- `routes/home/pocket.svelte`: `class="pk-sun"` on the sun circle.
- `routes/create/pocket.svelte`: the `html[data-tour-pocket]` padding rule.
- `lib/tour/*`: everything in §§2–4.
- `design/owner-decisions.md`: §24 note + new section (§2).
- No change to `focus.js`, `sheet.js`, `Sheet.svelte`, `belt.*`, inbox or
  Hatch.

## 10. Tests

**Unit (vitest, happy-dom, `tests/unit/`).**
- `v19-tour-chapter-*.test.mjs` ×12: pin `SELECTORS.POCKET` against the
  source files in §5 (read the file, assert the class/id/attribute text is
  present — the existing pattern). Add: chapter 2 pins `KINDS[2].id ===
  "inspection"`; chapter 8 pins `data-step` on the pocket end-caps and
  `POCKET_RIDE >= 1`.
- Dry-run both dialects for every chapter: `ctx.pocket` true/false, assert
  the transcripts are identical **except** chapter 8's `later → steps the
  belt.` vs the desk line; assert the desk transcript is byte-identical to a
  committed snapshot (guards §1).
- `v19-tour-vocabulary.test.mjs`: side resolution (left/right → top/bottom by
  room; explicit side flips when it does not fit; clamps to the pill's rect
  and the chrome); `open()`/`close()` undo runs on `clear()`; `close()` and
  `unread()` dispatch on the document with `tourfilm = true`; `ringless`
  lights with no ring; `goto` scrolls on the pocket and not on desk.
- `v19-tour-transport.test.mjs` (mock `matchMedia` for the pocket query):
  slider attributes; `nearest()`; pointerdown/move/up aims then jumps;
  ArrowRight/Home/End; ticks are `<i>` on pocket, `<button>` on desk;
  `.top` on `.p-sheet-layer.open` appearing, home 350ms after it goes;
  `.raised` when `.pk-bar` exists; `data-pocket-above` on all three film
  elements; Esc in capture phase stops; `tourfilm` events ignored; the
  desk DOM unchanged (snapshot).
- `v19-tour-trigger.test.mjs`: the pocket starts and writes once.
- `v19-tour-script.test.mjs`: the pocket script carries the shortened line
  and not "Tap one to bring it in.".

**Fidelity (`web/tests/fidelity/screens.spec.js`).** Three new owned frames,
`viewport: { width: 390, height: 844 }`, `tourDue`, `reducedMotion:
"reduce"`, settle as `tourHeldAtOthers` but keyed on `.msys` instead of
`.minisys`:
- `tour-pocket-dark` — starchart, mark `others-gran` (veil up, chip ringed,
  callout, pill at the foot).
- `tour-pocket-light` — dawn, same mark (the ring's 3.03:1 case on the
  pocket).
- `tour-pocket-docked` — starchart, chapter `sky`, mark `sky-settings`
  (hatch up, pill docked top, row ringed). Settle also requires
  `.p-sheet-layer.open` and `#orbit-tour-transport.top`.
Add the three to the baseline set the gate compares against.

**Pocket measure (`pocket-states.js` → `SIGNED_IN`).** Three states, each
`reach` first `page.route("**/api/settings/tour", …tourSeenAt:null)` then
`go("/home")`, wait for `__chapters`, then:
- `/home` `film-rest`: `__pause()` at chapter 0 (pill at the foot, playing
  face → paused).
- `/home` `film-hatch`: `__hold="sky-settings"`, `__jump(10)`, wait
  `__held` (pill docked, sheet up).
- `/home` `film-create`: `__hold="add-drawer"`, `__jump(1)`, wait `__held`
  (on `/create`, pill raised over the bar).
The floors then check the pill for real: 44px targets, 12px text, whole
and reachable, nothing covered. The ticks being `<i>` and the words being
12px is what makes these pass.

**Clash sampler (owner's acceptance, 1a).** New opt-in spec
`web/tests/fidelity/tour-pocket-clash.spec.js`, `test.skip(!process.env.
TOUR_CLASH)`, normal motion, at 390×844 and 360×780: start the film, sample
every 250ms until `ended`, record any intersection of the pill's rect with
`.p-sheet-layer.open .p-sheet-panel`, `.pk-bar`, `.tourfilm-callout`, or the
top chrome's controls (`.p-chrome a, .p-chrome button`); any
callout/callout overlap; any callout past the viewport. Assert zero at both
widths and paste the counts into the PR. This is round 8's `/tmp` script
made durable.

**E2E (`tests/e2e/v19-tour.spec.ts`).** Remove the mobile `test.skip`. On the
mobile project add: the pill is visible with `.track[role=slider]`;
`__jump(10)` → within 10s `.p-sheet-layer.open` exists and the pill has
`.top`; `.stp` click → no `.p-sheet-layer.open`, veil hidden, `tourSeenAt`
written once.

**By eye before the PR** (the owner reviews the built film): play it end to
end at 390×844 and 360×780 on after dark and dawn, once normal, once reduced;
note the measured lengths; screenshot every held mark into the PR or a
`/tmp` folder referenced from it (not committed).

## 11. Known limits to record (issues, not fixes here)

- A reader who dismisses a film-opened sheet by drag or scrim while a
  chapter is inside it makes the next `ctl()` throw `TourControlMissing`
  and the film stops honestly. Same class as a desk reader navigating away
  mid-film. File it; do not paper over it.
- The `open →` act is pressed for the gesture and `setScreen("/item")` lands
  on the soonest-due item, which may not be the row that opened (the desk
  takes the same licence with `.body-link`).
- Chapter 2's recurrence beat is desk-only until the pocket form can show
  "comes round" without a real kind chosen (a product change, not the
  film's).

## 12. Acceptance checklist

- Desk: `__script`, ticks, length, transport DOM and the two desk tour
  frames unchanged.
- Pocket: plays on `isPocket()`; every mark reachable at 390 and 360;
  transcript = desk's except the one line; ends `3:4x / 3:4x`; no console
  errors; the DOM after stop equals the DOM before start (no sheet open, no
  row open, `data-theme` restored, no history `pocketSheet` state left).
- Pill: 64 tall, 12px words, 44px controls, slider rail; docks on any kit
  sheet, returns 350ms after; stands on `.pk-bar`; fades, never slides.
- Clash sampler: zero at 390 and 360. Pocket-measure: the three states pass.
- Fidelity: three new pocket frames within budget.
- `owner-decisions.md` updated; round 8 folder and this file committed under
  `design/v19/tour/round-8/`.

Written by Fable, 2026-09-30.

## Addendum A (2026-09-30) — the lift inside a tight clip

**The failure.** `film-hatch` fails the pocket-measure `cut` check at all four
widths: chapter 11's `goto(settingsLink)` applies the film's universal lift
(`applyLift`: inline `transform: translateY(-2px)` + a drop-shadow filter) to
the hatch row's face, and the kit Row (`Row.svelte` l.208, `.p-row{overflow:
clip}`), sized exactly to its face, clips the top 2px. The check is right:
a lifted face that leaves its row is a control shown cut.

**Call: the lift yields to a clip.** The film does not translate a control
whose 2px rise would leave a clipping ancestor; the ring alone says
"lifted". Reason: the film's rule is to leave the product's DOM and picture
as it found them, and a Row's clip is the product's own — it gives the row
its rounded corners and its unfold, and every kit Row shares it. Inside such
a clip the glow is invisible anyway (it falls outside the row), so nothing
is lost but 2px of movement nobody can see whole. Runtime detection, not a
per-control flag: it is the same rule wherever the film later lights a
clipped control (the inbox's `.rv-yes` inside a card, the row act in
`.p-row-open{overflow:hidden}`), and it needs no chapter to know.

**Exact change — `web/src/lib/tour/vocabulary.js`, `applyLift(c)`.** Before
the `for` loop, compute per element:

```js
/** True when a 2px rise would leave an ancestor that hides or scrolls its
 *  overflow — a kit Row's `overflow:clip`, a sheet body's `auto`. */
function clipped(el) {
  if (typeof window.getComputedStyle !== "function") return false;
  const r = el.getBoundingClientRect();
  for (let node = el.parentElement; node && node !== doc.body; node = node.parentElement) {
    const cs = window.getComputedStyle(node);
    if (cs.overflowY === "visible" && cs.overflowX === "visible") continue;
    const box = node.getBoundingClientRect();
    if (r.top - LIFT_PX < box.top + 0.5) return true;
  }
  return false;
}
```

with `const LIFT_PX = 2` beside `DEFAULT_RADIUS`. In the loop, keep the
`c.saved.push(...)` and the `transition` line as they are, then:

```js
if (clipped(el)) continue;           /* the ring alone says lifted */
style.transform = "translateY(-2px)";
style.filter = "drop-shadow(0 0 14px color-mix(in srgb,var(--accent) 34%,transparent))";
```

`c.lifted` stays `true` (so `press()` still bases its scale on the lifted
state — `translateY(-2px)` in its keyframes would move the face again, so
`press()` must read a per-element flag: record `flat: true` in the saved
entry and use `translate(0,0)` as the base for those elements). `restore()`
is unchanged: it puts back whatever inline values were saved, which for a
flat element is the original transform. `goto` still calls
`ringState(c, "strong")`, so the ring brightens as on every other control.
No ControlSpec change; no chapter change; nothing under `dry()` (the guard
sits inside `applyLift`, which already returns in dry mode).

**What must not change.** `Row.svelte`: nothing — not `overflow:clip`, not
the reorder-only `[data-lifted]` rule (that state carries a shadow and a
background the film must not borrow). The desk: no built desk control sits
inside a tight clip, so `clipped()` is false for every desk target and the
desk lift is pixel-identical; add a unit assertion that `applyLift` on the
desk chapter-11 markup (`#account nav a`) still sets `translateY(-2px)`.
`press()` on desk is unchanged.

**Against the floors the state asserts** (`pocket-measure.spec.js`,
`film-hatch`): the face now sits exactly inside `.p-row` → `cut()` finds no
clipper it leaves (`within` with 1px slack); its label was never cut; the
row's 56px face still passes the 44px floor; the 12px floor is untouched;
`covered` is unaffected (the ring lives in the `pointer-events:none` chrome
layer, as in the two states that already pass). Also re-run `film-rest` and
`film-create` (the create fields are not in a clip; behaviour there is
unchanged) and the clash sampler at 390 and 360 — the pill does not move,
so the counts should not.

**Tests to add.** `v19-tour-vocabulary.test.mjs`: a control inside a
`overflow:clip` parent sized to it gets no inline transform/filter after
`goto`, `c.lifted` is true, the ring is `strong`, and `unlight` restores the
original inline style; a control with room above (parent 8px taller,
`padding-top:4px`) is still translated. `v19-tour-chapter-your-sky.test.mjs`:
pocket dry/wet run of the settings beat leaves `[data-row-face]`'s
`style.transform` empty.

Written by Fable, 2026-09-30.
