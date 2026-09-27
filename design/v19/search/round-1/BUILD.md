# Build notes — desk search C, "Unrolled" (#1161)

Owner's verdict, 2026-09-27, on #1161: *"Great job Fable! Three really cool
options, but I think the one that's going to give us the most going forward,
has to be C - unrolled!"*

This is the whole brief. Every design call is settled below; if something
is not covered, do the least thing that keeps every rule here true and say
so on the issue. Reference drawing: `c-unrolled.html` in this directory
(`?step=1..5`). Its numbers are the numbers. The mockup's JS is a sketch,
not code to lift: build it in Svelte the way the palette was built.

## 1. What the reader sees and does

**At rest** — nothing changes. The field is the hairline under centred
type at `top:calc(75vh + 160px)`, placeholder `explore your world`, no box,
no icon, no label. ⌘K / Ctrl-K focuses it (keep `home.behaviour.js`'s
listener). The fidelity `home` baseline must still pass untouched.

**Focus (empty query).** Two things happen together:

- The dial dissolves: `.dial :is(.chrome, .body-link, .ping, .belt)` and
  the other skies (`.minisys`) go to the opacities in §3. The sun, its
  halo and `#dial-name` stay as they are.
- The strip appears above the field and its axis draws itself left to
  right. The two items the palette shows today (`groups.attention` with
  `days >= 0`, first two) stand on the line as their own planets with
  leader-line labels. The note line under the strip reads
  `→ complete "<closest title>"  ·  → add an item` exactly as the palette's
  two `.act` rows read today (they are inert today; keep them inert — do
  not wire them in this issue).

**Typing.** Matching is `searchPocket()` from `pocket-search.js`, unchanged.
Each keystroke redraws the marks; the axis stays. Matching items stand at
their due date; a matching document lights its item's mark and adds a
bright `◆ <name>` line to that mark's label. The note line reads
`N in your orbit · M document(s)` (omit the document part when M is 0)
followed by ` · ←→ step · ↵ open` in the faint tier.

**One match** — one planet, its label, the axis, today's ▲. **Many
matches** — every match gets a body; labels are placed by §4's tier rule
and a mark that fits neither tier is drawn without a label until it is
selected. **No match** — the axis draws with nothing on it; the note line
reads `nothing in your orbit is called "<query>"  ·  → add "<query>" as an
item` (inert, as today). **Unscheduled match** (`days === null`, so no body
on the dial) — no planet: a label anchored `end` at x=790, tier 0, no stem,
title over `no date · <cost>`; selectable and openable like any other.

**Selection.** Exactly one entry is selected whenever there is at least one
item or document match: the first, in `searchResults` order (items in
manifest order, soonest first, then documents). The selected mark's title is
`--ink`, its leader `--accent`, and it wears a halo ring. `→` / `↓` step to
the next, `←` / `↑` to the previous, wrapping. Hovering a mark selects it.
Actions and the no-match sentence are never selectable.

**Enter** opens the selected entry with `openSearchResult(id)` exactly as
today; for a document entry the id is its `itemId`. With nothing selectable,
Enter does nothing. **Click** on a mark opens it the same way. **Escape**
blurs the field and keeps the query (as built today). **Blur** closes after
the same 150 ms the palette uses; the strip hides (`display:none`) and the
dial returns.

## 2. What it replaces and what it reuses

Replace:

- `web/src/routes/home/+page.svelte` — the `.palette` block inside
  `.splash-search` (the `<div class="palette" id="palette">` and its
  `{#if}` chain). `paletteOpen` becomes `stripOpen`; `onExploreFocus`,
  `onExploreBlur`, `loadSearchDocuments`, `searchRows`, `searchResults`
  and `openSearchResult` stay as they are. `onExploreKeydown` grows the
  arrow keys and "Enter opens the selected entry" (today it opens
  `items[0]`; with the selection defaulting to the first entry this is the
  same result until the reader steps).
- `web/src/routes/home/home.css` — the POL-9 `.palette` rules and every
  `.palette` mention in the dawn/clouds glass overrides (`backdrop-filter`,
  `box-shadow`, `border-top-color` lists). The strip has no panel, so none
  of that carries over.
- `web/src/routes/home/home.behaviour.js` — `openPalette()` and the two
  `on(explore, "focus"/"blur", …)` lines. Svelte owns focus and blur. Keep
  the ⌘K listener.

Reuse, do not duplicate:

- `searchPocket()` (`pocket-search.js`) for matching. Do not add a second
  filter and do not change its tests.
- The dial's body objects from `dialBodiesOf()` (`web/src/lib/data/chart.js`)
  — look each matched item up by id in `bodies` so `days`, `size`, `paint`,
  `kind`, `documentCount`, `costMinor`, `currency`, `costIsEstimate` are the
  same values the dial draws with. Never recompute them.
- The dial's body drawing: lift the `{#if b.kind === "expiry"} … {/if}`
  branch chain (expiry dashed ring, ruby/amber, sky, jade with and without
  documents, inspection crescent, renewal core, suggestion hollow) into one
  Svelte 5 `{#snippet}` taking `(b, cx, cy, r)` and render it from both the
  dial and the strip. The strip's gradients are the dial SVG's `<defs>`
  (`url(#p-ruby)` etc.), which resolve across inline SVGs in one document.
- `tlabel()` from `bands.js` and `money()` for the meta line.
- The §30 focus ring (`.splash-search input:focus-visible` — 2px accent
  outline, `border-radius:999px`, hairline hidden while the ring shows).
  Unchanged.
- The pure geometry goes in a new `web/src/routes/home/strip-layout.js`
  (x-of-days, month ticks from today, tier assignment, flip), tested in
  `tests/unit/` the way `searchPocket` is.

## 3. Measurements, tokens, timings

Container: `.strip` is `position:absolute; bottom:100%; left:50%;
transform:translateX(-50%); margin-bottom:6px` inside `.splash-search`,
`width:820px`, a flex column, `gap:6px`, centred. `.hero-foot` keeps
`z-index:5` (#1160). Below 868px of viewport width the SVG scales with
`width:min(820px, 100vw - 48px)`; the desk dialect starts at 901px so this
is a guard, not a case to design for.

The SVG: `viewBox="0 0 820 150"`, `overflow:visible`, `font-family:var(--mono)`.

- Axis at `y=76`, from `x=30` to `x=790`: 760px for 396 days, −40 to +356,
  so `x = 30 + (clamp(days, −40, 356) + 40) × (760/396)`. Today is
  `x=106.8`. Past segment (30→today): `stroke:var(--overdue)`,
  `stroke-opacity:.45`, 1px, `stroke-dasharray:3 5`. Future segment:
  `stroke:var(--chart-line)`, 1px.
- Today's mark: `path d="M<tx> 80 l4.5 8 h-9 Z" fill:var(--accent)` — the
  dial's own ▲, pointing up at the line from below. No text.
- Month ticks: one per 1st-of-month from tomorrow through +356 days,
  computed from `today` (never hard-coded): 6px tall centred on the axis,
  `stroke:var(--chart-line)` 1px; name in 8.5px `fill:var(--chart-ink)`
  `letter-spacing:.08em` `text-anchor:middle` at `y=92`, upper-case three
  letters. A name is omitted when a mark's x is within 16px of its tick.
- Bodies: `r = max(3.5, size × 1.1)` where `size` is the dial's. Drawn by
  the shared snippet at `(x, 76)`.
- Labels are mono. Title 12.5px `fill:var(--ink-mid)` (`--ink` when
  selected); meta 11px `--ink-mid`: `<tlabel> · <d MMM> · <money>` with the
  date from `today + days` in UTC (`en-GB`, `day:"numeric", month:"short"`);
  matched documents 11px `--ink`, `◆ <name>`, one line each, after meta.
  Lines stack 13px apart. Text width for layout is
  `max(chars) × fontSize × 0.6 + 6` (mono makes this exact enough); no
  measuring.
- Leader: stem from the body's edge (`r + 1`) to the run line, then a
  horizontal run from `x` to `x + W`. `stroke:var(--chart-line)` 1px,
  `fill:none`; selected: `stroke:var(--accent)`, `stroke-opacity:.85`.
- Tier 0 (label above): run at `y=62`; text baselines at `run − 5`,
  `run − 18`, `run − 31` counting up from the last line. Tier 1 (label
  below): run at `y=102`; baselines `run + 12`, `+25`, `+38`.
- Selected halo: circle `r + 4`, `stroke:var(--accent)` 1px `.8`, no fill.
- Note line: 11px mono, `letter-spacing:.08em`, `color:var(--ink-mid)`,
  `min-height:16px`, items separated by ` · ` in `--ink-faint`; actions in
  `--accent-text`; the keyboard hint in `--ink-faint`.

Dissolve while the strip is open: `.dial :is(.chrome, .body-link, .ping,
.belt)` → `opacity:.05`; `.minisys` → `.2`; `transition: opacity .55s ease`
both ways. The sun link and `#dial-name` are not in the selector.

Motion on open: the two axis segments draw with `stroke-dasharray:780;
stroke-dashoffset:780` → `0` over `.7s cubic-bezier(.2,.7,.2,1)`; ticks,
names, today's ▲ and every mark fade in `.5s ease` with a `.25s` delay. A
keystroke re-renders marks with the fade only; the axis does not redraw.
`prefers-reduced-motion: reduce`: no draw, no fade, no delay, and the dial
dissolve is instant (`transition:none`).

Tokens only, no literals. The strip uses `--chart-line`, `--chart-ink`,
`--ink`, `--ink-mid`, `--ink-faint`, `--accent`, `--accent-text`,
`--overdue`, `--bg` (the body's own stroke, via the snippet) and the `p-*`
gradients, which are already per-pack variables. Every pack in
`web/src/lib/packs.css` (star-chart, after dark, dawn, clouds, retrograde)
must be checked by eye at step 3; on dawn and clouds the dissolved ring
reads as nearly gone, which is the intent. Retrograde recolours accent
inside `.dial` and `.minisys` by selector in `home.css` — add `.strip` to
that selector list so the strip's accent matches the dial's.

Short windows: the strip is 172px tall above the field (150 + 6 + 16). At
1536×730 its top is at about y=506 with the dissolved ring behind it and
the sun at y=365 clear of it; at 1600×1000 it sits in open sky. Nothing may
ever render below the field's own bottom edge; the e2e check in §4 pins it.

## 4. Checks

Change:

- `tests/e2e/v19-explore-search.spec.ts` — it locates `#palette` and reads
  `b` elements. Point it at the new ids: `#strip` (the SVG's wrapper),
  `#strip-note` for the no-match sentence, and the screen-reader list
  `#explore-results` for titles (`li` text). Keep every assertion's intent:
  title / section / provider each match; the other item disappears; the
  no-match sentence; Enter opens the top item and the URL carries `item=`.
- Add to the same spec: (a) at `1536×730`, with "mo"-style input, every
  `#strip` bounding box bottom is above `#explore`'s top and its top is
  ≥ 0; (b) `ArrowRight` moves `aria-selected` to the second `li` and
  `Enter` then opens that item; (c) at rest `#strip` is not visible;
  (d) hovering a mark sets `aria-selected` on its `li`.
- Add `tests/unit/strip-layout.test.mjs` (node, beside
  `tests/unit/pocket-home.test.mjs`, which covers `searchPocket`): x-of-days at −40, 0, 356 and clamping; month
  ticks for a fixed `today` (13 Aug 2026 → SEP 19d … AUG 353d); tier
  assignment for two marks 11px apart (second goes below) and three within
  12px (third unlabelled); flip when `x + W > 812`; unscheduled at 790.
- `tests/e2e/v19-axe-sweep.spec.ts` and `v19-screen-reader.spec.ts` run as
  they are; they must stay green with the strip open. The SVG is
  `aria-hidden="true"`; `#explore` has `role="combobox"`,
  `aria-expanded`, `aria-controls="explore-results"`,
  `aria-autocomplete="list"`, `aria-activedescendant` on the selected
  `li`; `#explore-results` is `role="listbox"` with `role="option"` items
  reading `<title> · <tlabel>` or `document <name> · <item title>`, visually
  hidden (the `.sr` recipe in the mockup), rendered only while open.

Must not change:

- `web/tests/fidelity/baselines/home.png` and `screens.spec.js`'s `home`
  entry: the rest state is untouched, so the baseline is untouched. Do not
  regenerate it.
- `pocket-search.js` and its tests; `pocket.svelte`, `pocket.css`,
  `pocket.behaviour.js` (the phone has its own ratified sheet).
- `tests/e2e/support/keyboard.ts`'s settle helper: it waits for `#explore`
  attached — keep the id and the placeholder.
- `v19-reduced-motion.spec.ts`: keep green; the reduced-motion branch in §3
  is what makes that true.

## 5. Must not

- No box, panel, border, blur or icon around the field or the strip, in
  any state. No change to the field's position, size, type or hairline.
- Nothing below the field. Nothing on the sky at rest.
- No count, badge or sentence on the sky outside the strip's note line.
- No second matching implementation and no change to match order.
- No pixel literals for colour; no fonts beyond `--mono` / `--ui`.
- Do not touch the film/tour: `.hero-foot` is already hidden under
  `body.bare` and animated under `body.instrument` / `body.withdrawing`;
  the strip lives inside it and inherits that for free.
- Do not wire `→ complete` or `→ add` in this issue; they stay the inert
  rows they are today (file the follow-up if it is not already filed).

## 6. owner-decisions.md entry

Append after §30:

```
## 31. Searching unrolls the year (owner, 2026-09-27)

Round 1 of #1161 drew three desk searches (`design/v19/search/round-1/`):
A lifts the built palette above the field as bare rows; B lights the
matching planets on the dial and hangs the chart's callout on the top
match; C dissolves the ring on focus and draws the year as a line above
the field, with the matches standing on it as their own planets at their
due dates. The owner chose C: *"Great job Fable! Three really cool
options, but I think the one that's going to give us the most going
forward, has to be C - unrolled!"*

What is fixed by that choice: the field stays where §3 put it, with no box
and no icon; results never go below it; the ring gives way to the line on
focus and comes back on blur (POL-8's own dissolve); a match is drawn by
the same code and tokens as its planet on the dial; matching stays
`pocket-search.js`'s, shared with the phone. Round 1's B survives as a
feature idea (search that lights the dial); A is the fallback that was not
needed. The build brief is `design/v19/search/round-1/BUILD.md`.
```
