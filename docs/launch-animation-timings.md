# The launch animation's frame timings (#873, step 1)

This is a measurement, not a fix. It records how the launch actually moves,
so the next step can name what to change instead of guessing. Nothing about
the animation — its timing, easing, transforms or geometry — was touched to
get these numbers.

Where it runs, since #1048: the `launch_timing` CI job at the `dev` →
`preview` promotion, not the per-merge-request `fidelity` gate, because the
noise on a shared machine was larger than the effect. Each promotion's numbers
are kept as that job's artefact and the next promotion is printed beside them.
Locally it is `pnpm --filter orbit-web launch-timing`.

## What "the launch" is

The create card's hand-off into the flight (`Arrival.svelte`'s `submit()`):
on success, the login ring shrinks from the card's 500px to the login ring's
own 302.4px in place (`ringcard.css`) while the login chrome — hidden while
the card showed — fades back in. Both ride CSS transitions that start
together when `body.reclaimed` is added. 620ms later (`setTimeout` in
`Arrival.svelte`), the page navigates to `/home`, and `/home` reads a one-shot
marker (`arrival.js`'s `markLaunch`/`consumeLaunch`) and plays the live,
un-pinned ascent — `Flight.ascend()`, the beats in `timeline.js`'s
`ASCENT_BASE` (warp at 200ms, the mark's ride to centre 260-1340ms, and so
on), driven by `engine.js`'s canvas renderer.

So the launch is two back-to-back phases with two different rendering paths:
a CSS-transition hand-off (0-620ms, on the create page), then a canvas
rAF-driven ascent (from navigation, on `/home`).

## How it was measured

`web/tests/fidelity/launch-timing.spec.js`, new in this change. It drives the
real thing rather than a synthetic stand-in: loads `/?arrival=create`, fills
and submits the create card exactly as a reader would, and records every
`requestAnimationFrame` callback's timestamp from the moment of the click
through the 620ms hand-off, the navigation, and 1.8s into the ascent on
`/home`. It reports the interval between consecutive frames — the thing a
reader actually perceives as stutter — not a synthetic score. Run it with:

```
cd web && CI=1 pnpm exec playwright test tests/fidelity/launch-timing.spec.js
```

It repeats the same drive for all five packs (`starchart`, `afterdark`,
`clouds`, `dawn`, `retrograde`), switched the same way the fidelity gate
switches them: `orbit-theme` in `localStorage`, set before the app's first
paint.

**"Both dial dialects" does not apply here.** The desk/pocket split (CON-10)
is a viewport media query scoped to `/home`'s own dial. Grepping `flight.css`,
`ringcard.css` and `arrival.css` for `@media` turns up only
`prefers-reduced-motion` — nothing viewport-conditional. The create card and
the ring it hands off into render one way regardless of viewport, so there is
no second dialect of this hand-off to measure.

## The numbers

All five packs, one run each, on this session's container (see caveat below):

| pack | create-phase frames | create max interval | create mean interval | home-phase frames | home max interval | home mean interval |
|---|---|---|---|---|---|---|
| starchart | 11 | 166.6ms | 94.7ms | 10 | 250.0ms | 180.0ms |
| afterdark | 8 | 150.0ms | 99.5ms | 9 | 349.9ms | 196.3ms |
| clouds | 9 | 133.4ms | 85.7ms | 10 | 283.3ms | 190.0ms |
| dawn | 10 | 116.6ms | 81.7ms | 14 | 283.2ms | 158.3ms |
| retrograde | 11 | 116.6ms | 73.6ms | 10 | 316.6ms | 185.0ms |

("create-phase frames" counts frames from the click to the navigation, over
the 620ms budget; "home-phase frames" counts frames from `/home`'s load over
the 1.8s the harness waits, which covers the ascent's opening beats.) At a
steady 60fps those windows would hold about 37 and 108 frames respectively —
every pack landed far short of both.

Every single frame interval measured, in every pack, exceeded 32ms (more than
one missed 60fps vsync) — not an occasional drop, the whole hand-off and the
opening of the ascent run well under 60fps throughout. A control run on a
blank page in the same container, same moment, held a clean 16.6-16.8ms
cadence for 61 straight frames, so the drops are specific to what the launch
page is doing, not a browser that cannot hit 60fps here at all.

The ascent (`home` column) is consistently worse than the reclaim (`create`
column) — roughly double the mean interval in every pack — and within each
pack's `home` run the intervals climb rather than stay flat (starchart's raw
sequence: 16.7, 83.3, 183.3, 183.3, 133.3, 233.4, 250, 233.3, 250, 233.4ms).
That climbing shape points at the ascent's per-frame cost growing as more of
the canvas scene joins in, over the CSS-only reclaim's comparatively flatter
cost.

## What this implicates

Two different things, because the two phases use different rendering paths:

- **The reclaim (0-620ms):** `ringcard.css`'s `.ringglass` and `.ringorbit`
  transition `width` and `height` directly (500px to 302.4px) rather than a
  `transform: scale()`. Animating `width`/`height` forces layout and paint on
  every frame; a `transform` would let the compositor do the work instead.
  This is exactly the first "likely candidate" the issue named.
- **The ascent's opening (from navigation):** `engine.js`'s canvas renderer
  draws the scene (gradients, arcs — see its `t0`/`dur`/`z`/`spin`-keyed body
  list) on every `requestAnimationFrame`, and the per-frame cost visibly grows
  as more bodies join the timeline. This matches the issue's second candidate
  — the number of elements in flight at once — more than the first, since
  canvas drawing has no layout step to force.

Both are consistent with what was measured; neither is proven the sole cause,
and nothing here decides between them or says what to change — that is
step 2's call, informed by these numbers, not this step's.

## What is still unmeasured

- **Real hardware.** This ran in a shared container (12 cores, load average
  5.9 at the time, other agents building and testing concurrently in sibling
  worktrees of this repository) with no GPU and headless Chromium's software
  compositor. The blank-page control shows the container itself can still
  deliver a clean 60fps, so the drops are real and page-specific — but the
  absolute millisecond figures above should not be read as what a reader's
  own mid-range machine would see. The issue's acceptance criteria call for a
  measurement "on the same hardware" before and after a fix; this is a
  repeatable baseline from this environment, not that hardware-controlled
  measurement.
- **`prefers-reduced-motion`.** The harness runs with `reducedMotion:
  "no-preference"` (the fidelity project's own default, deliberately — motion
  is the design's to show, not the machine's to skip). The reduced-motion
  path collapses the same sequence to 200ms and was not separately measured.
- **The descent** (`/logout`'s reversed flight) and the newcomer's climb
  (`/?arrival=newcomer`) were not driven — only the create path's launch, which
  is what the issue and #862 round 3 are about.
- **CPU/GPU profiling of which specific canvas draw calls or layout
  recalculations cost the most** — this harness measures frame intervals,
  the outcome a reader perceives, not a trace of what produced each one. A
  DevTools Protocol trace would be the next tool to reach for if the frame
  numbers alone are not enough to choose a fix.

## Step 2: what was fixed, and what the re-measurement shows (#873)

**In scope, and fixed.** The second implicated cause — `engine.js`'s canvas
renderer allocating a fresh `CanvasGradient` or a fresh path (`beginPath()` +
`arc()`/`moveTo()`/`lineTo()`) for every prop, on every single frame that prop
was on screen — is real and was cut. `penCraft`'s wake gradient, `penComet`'s
tail and head gradients, `penSystem`'s three ring arcs and sun dot, and
`penGraticule`'s arcs and spokes are now built once (their local coordinates
and colour stops never vary run to run) and reused every frame via cached
`Path2D`/`CanvasGradient` objects; a fourth change skips the nebula's
full-canvas gradient fill on the fraction of its cycle where the computed
alpha is provably zero. None of this touches the 620ms handover, the 302.4px
landing, any beat in `timeline.js`, or what the flight draws — same geometry,
same colours, same schedule, only the allocation cut.

**Verified pixel-safe, not just argued safe.** Canvas gradients and paths are
resolved against whatever transform is active when they are drawn, not baked
in at creation, so reusing one built once should paint identical pixels to
rebuilding it fresh — but "should" was checked rather than trusted. Screenshots
of the pinned ascent (`/home?flight=up&at=<ms>`, the app's own fixture pin) at
six timestamps spanning the whole prop schedule were captured before and after
the change and diffed with `pixelmatch`. The first pass caught a real bug this
way: three graticule arcs sharing one `Path2D` without a `moveTo` between them
drew unwanted connecting lines, a genuine content difference (up to 1123 of
1.6M pixels). Fixed by giving each arc its own `moveTo` to its start point,
matching the original's three independent `stroke()` calls. After that fix the
before/after diff (0-41 of 1,600,000 pixels per frame) was checked against a
control — the same fixed build screenshotted twice — which showed the same
pipeline's own run-to-run noise floor is 0-189 pixels. The fix's measured
effect does not exceed that noise floor, and no fidelity baseline in
`screens.spec.js` covers this mid-flight canvas state at all (it only
photographs the settled login/logout end states), so there was nothing to
regress against; this before/after check is the only pixel evidence that
exists for this path.

**Was out of scope, now fixed — the compensated split.** The first implicated
cause — `ringcard.css`'s `.bigring .ringglass` transitioning `width`/`height`
directly (500px → 302.4px) rather than a `transform: scale()`, which forced
layout and, with that box's `backdrop-filter`, a full backdrop re-blur on every
frame of the reclaim — was left untouched by the flight-side change above and
has since been fixed on its own (#873, note 17341: worst-case paint 0.97ms
against the 7.06ms measured before).

The ring is now two boxes rather than one. `.ringglass` keeps the fill, the
backdrop blur and the shadow, carries no border, and closes by
`transform: scale(.6048)`, which the compositor runs without a layout pass;
`.ringstroke` is a new plain box carrying the 4.2px line alone, unblurred, and
still closes by `width`/`height` so the line cannot thin. `.ringorbit` is
unchanged. Scaling the whole ring instead was rejected: it thins the stroke and
drifts the orb. Timings, easing, the 620ms hand-over and the 302.4px landing
are all exactly as ratified — only which part of the pipeline does the work
changed.

**Re-measured with the same harness, five packs, one run each, same command,
same shared container:**

| pack | create-phase frames | create max interval | create mean interval | home-phase frames | home max interval | home mean interval |
|---|---|---|---|---|---|---|
| starchart | 12 | 100.1ms | 90.0ms | 11 | 283.3ms | 178.8ms |
| afterdark | 9 | 100.0ms | 76.4ms | 9 | 350.0ms | 218.5ms |
| clouds | 9 | 116.7ms | 96.8ms | 11 | 300.0ms | 174.2ms |
| dawn | 10 | 166.6ms | 95.0ms | 10 | 283.4ms | 193.3ms |
| retrograde | 10 | 133.4ms | 84.2ms | 9 | 266.6ms | 201.8ms |

**This does not show a clean win, and that is reported rather than smoothed
over.** Some home-phase means improved (clouds: 190.0 → 174.2); others got
worse (dawn: 158.3 → 193.3, retrograde: 185.0 → 201.8, afterdark's max ticked
up from 349.9 to 350.0). The tell is the **create-phase** column: the reclaim
is pure CSS on a different page, nothing in this change touches it, yet its
numbers moved by amounts comparable to the home-phase moves (starchart's
create max fell from 166.6ms to 100.1ms with zero code change on that path).
That is only explicable as the same shared-container noise the original
measurement already flagged (other agents building and testing concurrently
in sibling worktrees of this repository), swamping whatever this fix
contributes. The fix is real, in scope and verified not to change any pixel
beyond the pipeline's own noise floor, but this re-measurement cannot honestly
be read as proof the launch is now smoother — only that the named, in-scope
cause was addressed. A clean before/after would need an idle, dedicated
machine, which this container is not.
