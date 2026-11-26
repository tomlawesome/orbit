# The shared door

The Earth door and the flight that open both the site and Orbit's sign-in:
the dawn, the launch, the bare sky, and the dusk to leave by, with their
engine, their timeline, the live Earth and the pictures they draw. This
folder is the one copy (ADR-0001, `docs/adr/0001-the-door-is-shared-with-orbit.md`):
it lives on the site, and Orbit's own job copies it from the site's `main`
unchanged and opens a merge request there. A change the door needs is made
here; Orbit never edits its copy.

It is self-contained: nothing in it imports from outside the folder, reads
the page's address, or makes a URL from its own location. The site's lint
holds it to that (`tools/ci/lint.sh`, "the shared door is self-contained").

## Licence

This folder is licensed under the GNU Affero General Public License v3.0 or
later (Orbit's licence) as well as under the site's own licence
(`LICENSE` at the repository root, section 3). Take it under either. The
imagery under `img/` is NASA's, in the public domain, credited in the root
`README.md`.

## The interface

`index.js` is the only file a host imports. Its entry point and its settings
are an interface between two repositories: change them deliberately, because
a break shows in Orbit's import merge request, not in the site's gate.

```js
import { createDoor } from "./assets/door/index.js";
const door = createDoor({
  image: (path) => `assets/door/img/${path}`,   // where a picture is; see Settings
  flags: {},                                     // the debug switches, read by the host
});
// createDoor may run on a server too (it touches no document). Call it again freely: each setting given replaces
// the earlier value (one left out, or undefined, keeps it) and the keyboard is watched once. Each dawn(), dusk()
// and journey() adds its own resize listeners; its destroy() removes them (the dawn's also takes down the live
// door, which the door3d debug flag starts; see below).
const dawn = door.dawn(document.querySelector("#door"));
const dusk = door.dusk(document.querySelector("#dusk"));
const journey = door.journey({ canvas, name, dawnGlyph, duskGlyph, on: { dusk, farewell } });
```

### Settings (`settings.js`)

| Setting | What | Site | Orbit |
| --- | --- | --- | --- |
| `image(path)` | Where a picture is: `"dawn/dawn.webp"` → a URL the page can load. Never built from `import.meta.url`: in a Vite build that leaks file paths into server-rendered pages and does not resolve in the browser | a relative base | its own map, `import.meta.glob(..., { query: "?url" })` |
| `flags` | The debug switches: `door3d`, `rich`, `lean`, `level` (`"0"`–`"2"`), `holdreveal`, `mainthread`, `ring` (`"stop"`/`"rush"`), `open` (`"late"`), `gpu` (`"force"`: the GPU gate accepts a software renderer, see below), `fit` (`"skip"`: the flight world's speed test is not run and the world is taken as fit, the console line saying `on (fitness skipped)`; for a tool that draws pictures on software GL, together with `gpu: "force"`, which it does not imply), `draw` (`"worker"` or `"page"`: where the flight is drawn, whatever the rule says; see The flight in a worker), `decode` (`"img"` or `"blob"`: how the pictures are decoded, whatever the rule says; see Where the pictures are decoded), `sun` (`"page"`: the sun is painted on the page, never in the `sunWorker`; the control), `links` (`"late"`: the flight's shaders asked for only at the host's word; see The flight in a worker). The folder never reads the address; the host does | from `location.search` | none |
| `storagePrefix` | The first word of every localStorage key the folder writes (`orbit-probe …`) | `orbit` | `orbit` |
| `settle` | `timeline.js`: ms after the landing at which the instrument arrives (the site's own amendment, 2026-10) | 1100 | 1100 |
| `typingWait` | `chores.js`: an unhurried chore waits while someone is typing, this long after the last key; 0 never waits (Orbit's addition) | 600 | 600 |
| `drawWorker` | `() => Worker \| null`: makes a **module** worker running `draw-worker.js`, the flight drawn there where the rule says (below). Absent (the default), no worker is ever made | `() => new Worker("assets/door/draw-worker.js", { type: "module" })` | none yet; when taken up, `() => new Worker(new URL("./draw-worker.js", import.meta.url), { type: "module" })` from its own code |
| `sunWorker` | `() => Worker \| null`: makes a **module** worker running `sun-worker.js`, in which the dawn's sun is painted and PNG-encoded off the page's thread (the same pixels as the page paints, from `sun.js`). Absent (the default), null, or failing (an error, no picture, no answer in 20 s), the page paints it. No `fonts` needed | `() => new Worker("assets/door/sun-worker.js", { type: "module" })` | none yet; when taken up, `() => new Worker(new URL("./sun-worker.js", import.meta.url), { type: "module" })` from its own code |
| `fonts` | `[{ family, weight, url }]`: the faces the flight's pens write with, loadable from the page's own origin, the very files the page's stylesheet uses (a worker has none of the page's fonts). Required with `drawWorker`: without it the flight stays on the page | JetBrains Mono, 500, `assets/fonts/jetbrains-mono-latin.woff2` | none yet; its own file's URL through Vite, as its pictures |

### The dawn: `door.dawn(host)` → `{ start, light, live, destroy, held, world, host }`

`host` is the `#door` element rendered from `dawnMarkup`. Mounting draws the
star fields and sets the glows' origin.

- `start()`: the Earth's pictures asked for and the glows drawn, once, after
  the next frame is on screen. Call it whenever the door is shown.
  `world.dataset.rasterised` reads `"pending"` from the moment `start()`
  returns (set at once, not after the frame), and `"ready"` once
  the door is drawn: the glows are drawn AND the Earth's pictures `start()`
  asked for (`dawn/dawn-pre.webp`, `dawn/dawn.webp`) have each loaded. A
  picture that fails to load counts as settled, as the first light already
  treats it (`critical()`): the door is then "ready" drawn without it, never
  held "pending". (Interface change, 2026-10: "ready" used to mean the glows
  alone. The dusk's world is unchanged: its glows alone.)
- `light({ firstVisit, wait, after, onLit, onOpen, aside })`: first light,
  once per showing. The ring runs while the door's pieces (the fonts, the
  Earth's first picture) come; `firstVisit` makes it run at least a lap;
  `wait` makes it run on until the promise `after()` returns has settled
  (the host caps that promise). `after()` is called once the ring is up and
  running: the host readies what it has to. `onLit()`: `body.lit` is set and
  the reveal begins. `onOpen()`: the chores are open (`openChores` has been
  called); the host may start what waits for them. `aside`: whether shader
  compiles here are in the background (`compilesAside()` unless the host
  says: asking it makes the GPU gate decide, unless the `mainthread` flag
  answers first, so a host that cares when passes its own). The flags `ring` and `open` apply here.
- `live`: the live door (`door3d.js`), only where `flags.door3d` is set,
  else `null`: `compile()`, `start()` → the live door, `measured` (a promise:
  it has been measured and shown), `firstCompiled()`. The live door is an
  experiment behind its flag. The dawn's `destroy()` calls its own teardown: its
  frame loop stops, its resize and visibility listeners and its observers are
  removed, nothing it was waiting for acts any more (a door destroyed before it
  was shown never becomes the flight's door), and it leaves the sharp strip's
  queue (so it holds no other context back). What it put on the page's context
  (its textures, framebuffer and vertex array) is deleted, an upload landing
  after it included; its compiled programs are kept for the next door, and its
  canvas loses its `live` class. A lost context takes it down the same way, and
  it stays down until a remount, which is handed a fresh context. (Interface
  change, 2026-10, #84: its textures used to stay on the context.)
  `dawn.live.start()` on a destroyed dawn returns `null`.
- `held`: the pictures decoded ahead of the light (`decode-ahead.js`), a list of `{ ready, held }` as
  `decodeAhead` returns them: the glows' and the Earth's, plus one for each glow the dawn draws itself (with its
  `url`; a resize replaces the old size's). `[]` before `start()`. They are kept until the light's reveal has
  drawn them in (so the browser does not throw the decoded copies away before they are shown), and let go then:
  from that point `held` is `[]` and nothing more is held (a later glow, such as a resize's, is not); `destroy()`
  before then lets them go too. (Interface change, 2026-10, #76: they used to be kept until `destroy()`.)
- `destroy()`: the surface taken down (a host that remounts its door): its
  resize listeners removed, a glow build under way stopped, and a first light
  under way stopped: after it, no `body.lit`, no `onLit`, no `onOpen` (from
  the 13 s backstop or any other timer or promise of that light), no error;
  the ring's `body.loading` is taken off if the light put it on; a later
  `light()` on the destroyed dawn does nothing (it does not even run the
  page's GPU test, with or without `aside`), and neither does `start()`
  (one asked for but not yet run when `destroy()` comes is dropped, so the
  dead world is never drawn and no resize listener is added after it).

### The dusk: `door.dusk(host)` → `{ start, destroy, held, world, host }`

`start()`: the dusk's pictures decoded ahead of the beat that shows them
(`decode-ahead.js`), its glows' origin set. Call it when the sign-out begins.
A dusk made with `asDawn` (Markup, below) also asks for the dawn's two Earth
pictures then and shows them as the dawn does, and `world.dataset.rasterised`
reads `"pending"` from the moment `start()` returns and `"ready"` once its glows are drawn and
those pictures have loaded or failed (a plain dusk: its glows alone). `held`: what `decodeAhead` returned (`{ ready, held }`), `null` before
`start()`; the decoded pictures are kept until `destroy()`, which also
removes the resize listeners.

### The journey: `door.journey({ canvas, name, dawnGlyph, duskGlyph, on })`

`canvas` is `#warp`, `name` is `#launchname`, the glyphs are functions
returning the two lockups' SVGs. Returns `{ fly, ascend, descend, reset,
destroy, later, reduced, warm, warmDocs, compiled, verdict, aside }`. `journey()` takes no
context of `canvas`: its 2D context is taken at the first `warm`, `warmDocs`,
`fly` or `descend` (ADR-0004 6a.4: a canvas with a context can never be handed
to a worker), and `destroy()` before any of them takes none. `compiled()`
before any of them resolves at once. A journey may replace the canvas element
it was given (the worker's fallback, below), so a host keeps no reference to it
(the site reads `#warp` once, at `journey()`).

- `fly(profile, { title, subtitle, ready, on, at })`: the climb, `profile` a
  flight profile (`UP`, or one made from it: the site's `assets/js/journeys.js`);
  `ready`, a promise the clock holds for just before the canvas comes up, at
  most `WORLD_FAILED` (30 s, `journey.js`): past that the world has failed, the
  hold lets go, the flight goes on painted and the engine is told (`abandon()`:
  `flight world: off: not ready in 30 s`, the world remade by the next `warm()`). Hooks, each optional, in order: `release` (the surface
  flown from may go), `land` (the bare sky is readable), `settled` (the
  instrument has arrived).
- `descend({ title, subtitle, onto, from, homes, ready, on, at })`: the descent, `onto`
  `"dusk"` or `"dawn"`, `from` the profile flown up (mirrored on the way
  down). `homes`: the other households met again on the way down,
  `mirrored(homeProps(homes))` added to the end of the props, whatever the
  base; with `from`, only if the climb did not carry them (both would pass
  them twice). Left out, the descent is exactly as before. Hooks:
  `released`, `surface` (the dusk or the dawn comes up), `farewell`. `ready`
  (ADR-0002 6.8), as `fly` has it: the clock holds at the descent's first beat,
  before the surface flown from withdraws (so it stays as it is while it
  waits), `holding` set meanwhile, with the same `WORLD_FAILED` backstop; not
  under reduced motion nor when pinned. A host passes `ready: journey.warm()`.
  At its warp it draws the world if the verdict on it is in and fit, and
  otherwise flies painted (a refused or failed world, or a descent given no
  `ready`).
- On the worker path a profile is posted by name (`engine.js`: `wireProfile`):
  one given to `fly` must carry `UP`'s or `DOWN`'s curves (`speed`, `atm`,
  `duskMix`; everything else is data), and any other throws
  `ProfileCurveError`. The site's flights are all `UP`'s curves with data.
- `on` given to `journey()` holds the defaults: `release`, `land`,
  `settled`, `released`, `dusk` (the descent's surface), `farewell`.
- `warm({ prove = true })`: the flight's world made ready; `warmDocs({ prove = true })`: the docs' galaxy, ready on its
  own (#101): `warmDocs({ prove: false })` resolves once the world is made, the galaxy compiled or given up and its stars
  on the GPU, which may be before `warm({ prove: false })` does, the flight's maps still landing; `warmDocs()` proves the
  world on that alone (one galaxy test frame, and the fitness test shared with `warm()`'s proof: one verdict a visit), so
  a trip to the docs may begin while the maps are still landing, drawn with those that have; a host that wants the maps
  too waits on `warm()` as well. `compiled()`: its shaders compiled. `reset()`: everything off. Where the page may not use the GPU (the gate,
  below) there is no world: nothing of it is made or fetched and these resolve once the Earth's picture is in.
  `prove: false` is the speculative ask (the door's, while it waits): the world's programs made and its pictures
  put on the GPU (as chores, so as the host opens them), and no frame drawn, no pixel read back. The default
  proves it: the host asks it at leisure once the door is lit (`later`) where a pass is remembered (`rememberedFit()`,
  below), and at once behind the load where none is, so the verdict is in before anyone flies, and
  a flight up asked first holds on it (`ready`); it draws the
  warm-up frames, and runs the fitness test (median frame against `FIT_MS`), each visit, a remembered verdict never
  deciding what is drawn. Under save-data (`navigator.connection.saveData`) there is no world: nothing is made or
  fetched, the GPU is not asked, and `verdict()` is in at once (`refused`, `flight world: off: save-data`). The
  world is drawn only once proved; a world too slow (or a context lost) is let go and the flight draws on its
  own canvas, as it always could. A world lost after it was made is replaced by the next `warm()`. No picture is
  waited for longer than `PICTURE_WAIT` (20 s, `chores.js`): a download that never finishes is given up and asked
  again by the next ask, and an Earth's picture that has not come by then settles `warm()` without proving the
  world, which the next `warm()` does once the picture is in.
- `verdict()` → `Promise<{ fit, ms, how }>` (ADR-0002 6.3): what a way in onto the flight waits for, with its
  proper version's load (the site's gate: `Promise.all([warm({ prove: false }), verdict()])`). In at the first of: a
  remembered pass read at the first `warm` (`how: "remembered"`), this visit's judgement (`"tested"`, or `"skipped"`
  under `fit: "skip"`), the GPU refused or save-data (`"refused"`, at once), the world not made, lost or abandoned before
  any judgement (`"failed"`). Never on a remembered unfit, and never "not yet". Renewed when a lost or abandoned world
  is remade.
- `later(fn, { after = 4000 })` → `stop()`: `fn` at leisure, `after` ms from now and once the page's painted
  animations have finished; never called if `stop()` is, or if a `fly()` or `descend()` begins first (both drop
  every pending `later`: a compile on the page's own thread, started mid-flight, would be a pause in the middle
  of it). A host that needs its readying after a descent makes it in the descent's hook.
- `destroy()`: the journey taken down: `reset()`, its clock's pending beats
  dropped, its resize listener removed, every pending `later` dropped, and
  its flight's world stopped: a warm-up still under way draws and judges
  nothing more, and never gives up the page's one WebGL context, so a journey
  mounted after it still has its world; and what its world put on the GPU
  is released, so a host that remounts its door does not fill the context
  visit by visit. A single-page host calls it when
  the component unmounts; a page that keeps one journey never needs it.

`at` (both): pin the journey at a moment, in milliseconds into the journey
as it plays (its own time, after a profile's `rate` has quickened it and the
chart descent has moved its beats). The beats at or before `at` are applied at
once, in order, with their hooks, and the flight is drawn as it stands then;
nothing after them is scheduled, so a pinned journey stands still (for a
screenshot or a test). Left out, the journey plays live. A pinned `fly()` does
not wait for `ready`. A pinned journey never asks for the world either: it is
drawn with the world only if a warm-up has already proved it fit, and painted
otherwise, so the same `at` can look different before and after the host's
leisure warm-up. Like any `fly()` or `descend()`, a pinned one drops every
pending `later`; a host that pins and still wants the warm-up asks for it
again.

A `fly()` or `descend()` whose `ready` never settles holds the clock at most
`WORLD_FAILED` (30 s), and that is a failure (above); a `descend()`, `reset()`
or later `fly()` lets a flight's hold go at once.

The journey sets body classes the stylesheet answers: `arming`, `showdawn`,
`showwarp`, `launching`, `bare`, `instrument`, `withdrawing`, `dispersing`,
`showdusk`, `farewell`, `holding`. The host's surfaces style themselves on
them.
`dawn()` also sets `loading` and `lit` (its `light()`, first light, below);
`dusk()` sets neither. The site's host sets `ready-flight` (below).

### Markup (`markup.js`)

`dawnMarkup({ image, lockup, gate, foot, heading, tag, indent })` and
`duskMarkup({ image, gate, foot, farewell, asDawn, tag, indent })` are pure string
functions: the door's markup with the host's parts in the slots (`lockup`,
between the glyph and the name; `gate`, inside `.gate-wrap`; `foot`, at the
surface's foot). `heading` (dawn only, default `true`): whether the wordmark is
the page's `<h1 class="name">`; `false` writes `<div class="name">` as the dusk
does, for a page that has an h1 of its own (a docs page), styled the same
(added 2026-10, #40; the default is unchanged). The site writes them into `index.html` with
`node tools/door-markup.mjs` (the lint fails if the page differs); Orbit
renders them in its components. `image` is the same resolver as the setting; what it answers is escaped where it
goes into an attribute, so it cannot add an attribute or an element.

`tag` (both, default none; added 2026-10, #63): the release tag under the
wordmark. It is TEXT, one string, escaped like `farewell`: nothing of it is
markup or an attribute. Its first word is the channel and anything after the
first whitespace is the build: `"alpha"`, `"beta"`, `"preview 3f2a9c1"`. It is
written right after `.name` as `<div class="release" data-channel="C">W</div>`,
`W` the word and `C` that word (in any case, shown in lowercase) if it is `alpha`, `beta`
or `preview`, else `build`; whitespace runs fold to one space, a non-string is no tag, and a tag
longer than the ring's inside is cut with an ellipsis; a build follows as `<span class="build">…</span>`. Empty or left out,
the markup is byte for byte what it was. Orbit will pass its channel or short
commit (a follow-up in `ai/orbit`); the site passes none.

**Text and raw HTML.** `farewell.said`, `farewell.sub` and `tag` are text: they are
escaped, so a person's name in them is never markup. `lockup`, `gate` and `foot`
are raw HTML, put in as given (the host's own markup: never put a person's words
in them). `indent` is whitespace.

`asDawn` dresses the goodbye as the sign-in (Orbit's; the site keeps its own
and leaves it off, and without it the markup is byte for byte unchanged): the
dawn's glyph (the lit ring and discs, their gradients' ids prefixed `d-`) with
the gold planet on its trail, shown after the farewell beat; the dawn's Earth
photo under the ember rim, and no `.shimmer` ring (left out on purpose, #41); the farewell hung under the way back in (inside the
ring on a phone), as the last child of `.gate-wrap`, not beside the lockup. All
of it hangs off `#dusk.asdawn` in `door.css`, so a dusk without the option
matches none of it. Needs `img/dawn/planet-gold.webp`, `dawn-pre.webp` and
`dawn.webp`. It takes the sign-in's measures, and its lit look follows
`html.rich` as the dawn's does.

### Stylesheet (`door.css`)

Loaded before the host's own sheet. Its header lists what it asks of the
host (`--star-far`, `--star-near`, `--display`, `--mono`, `html.rich`) and
the keyframes it defines that a host may use (`driftf`, `driftn`,
`spinback`). Every `url()` in it stays inside the folder.
Its fixed text sizes are in `rem` (orbit-site #79), so they follow the host's
root font size: a host that scales its root for a reader's text size scales
the door's text with it. At the default 16px root they are the old pixel sizes.
Sizes tied to the surface (`--R`) stay as they are.

`.release` (the tag under the name, above): positioned from the name's measure
(`--R` where the surface sets it), coloured and sized by the sheet, and shown
with the name once `body.lit`. It asks nothing of the host; the host styles
nothing of it. `#dusk.asdawn` hides it on a phone with the name.

The host's own body class: `ready-flight`. The gate is hidden until
`body.lit.ready-flight` (`door.css`), so the host adds `ready-flight` to the
body once the flight is ready to begin (the site: `openWays` in
`assets/js/main.js`). Only the site's host needs it: Orbit shows its gate on
`body.lit` (its own `flight.css`).

### What the folder touches in the host page

- `#door`: `capability.js` and `door3d.js` look it up (`#door .world`), so the
  dawn's host must have that id.
- Body classes it sets: `loading` and `lit` (first light, `dawn.js`); the
  journey's `arming`, `showdawn`, `showwarp`, `launching`, `bare`, `instrument`,
  `withdrawing`, `dispersing`, `showdusk`, `farewell` and `holding`
  (`journey.js`).
- Body classes it reads: `launching`, `departing` and `showwarp` (`door3d.js`
  watches the body's class to stand down while a flight leaves; `departing` is
  the host's), and `ready-flight` (`door.css`).
- `window.__chores`: set only under the `door3d` flag, by `createDoor`, to a
  function returning the chore queue as it is now (for the live door's tests).

### What a page's Content-Security-Policy must allow for the door

Found by reading what the folder loads (`fetch`, `Image`, `createObjectURL`,
`toDataURL`, `style.` and `import(` in `*.js`; `url()` in `door.css`):

- `img-src 'self' data: blob:`: `glows.js` draws each glow as an image from a
  `data:image/svg+xml` URL, then rasterises it into a `blob:` URL (a `data:`
  PNG where a canvas cannot make a blob); the stylesheet's pictures and the
  flight's own textures are same-origin files.
- `connect-src 'self'`: `chores.js` `fetchOnce` fetches the pictures
  (`image(path)` URLs) with `fetch`, so they must be on the page's own origin
  (or named here if the host serves them from another).
- `script-src 'self'`: the modules import each other, and `door3d.js` is
  loaded with `import()`; nothing is evaluated (no `eval`, no `new Function`),
  so `'unsafe-eval'` is not needed. The folder adds no inline script.
- `style-src 'self'`: its sizes and origins are set from script through the
  style object (`style.setProperty`, `style.width`), which a policy does not
  block, and the markup has no `style=""` attribute. A host that keeps
  `'unsafe-inline'` for its own styles loses nothing.
- `worker-src 'self'` where the host passes `drawWorker` or `sunWorker` (the
  folder makes no worker itself, and never from a `blob:`; the sun's worker
  needs nothing else, it fetches nothing), and `font-src 'self'` for the font
  the host names in `fonts`. The worker runs under the page's policy where the
  browser carries it into a dedicated worker (Firefox) and under none where it
  does not (Chromium, where the site sends no headers), so it needs nothing the
  page does not allow: the same-origin pictures (`connect-src`) and the font.
  No frames, no `object-src`.

### The GPU gate (`fitness.js`, ADR-0002)

`gpu()` → `{ canvas, gl, parallel, renderer } | null`: whether the page may use the GPU at all, decided
synchronously on first asking, once a page, from ONE WebGL2 context made with
`failIfMajorPerformanceCaveat: true`. It is `null` where the browser declines that context and where the renderer
(`isSoftware(name)`: llvmpipe, softpipe, SwiftShader, Microsoft Basic Render) is software, and then the console
says why, once (`orbit · flight world: off: software renderer (…)`). Accepted, the context is kept and is the flight's
(`#warpgl` is its canvas) and the probe's: the folder makes no other context for them. The host asks it first, at a
moment of its choosing (the site: when the door is shown, before first light; arriving elsewhere, the leisure
warm-up's), and may ask it again (`compilesAside()` and the host's own worlds do). A host's own worlds that need
a different context (an alpha channel) ask `gpu()` first and take their no-WebGL2 path when it is `null`.
The flag `gpu: "force"` takes the context without the caveat and without the name check (a debug switch for a
machine that is software on purpose, the site's own live check); `level` never grants the GPU.

`compilesAside()`: whether shaders compile off the page's thread, read from `gpu().parallel`; `true` when the GPU
is refused or absent (nothing will compile), `false` under the `mainthread` flag.
`probe()`: only with the `door3d` flag and an accepted GPU, on the gate's context (its bindings and viewport put back, not lost); else
nothing is made and it resolves `{ ok: false }` without a console line, and `level()` is 0.
`drawnAside()` (not exported: the journey asks it at its first need, after the gate): whether the flight is drawn
in a worker, below.
`FIT_MS` (30): the most a frame of the flight's world may take on the fitness test, run on the flight's first
proving `warm()`: two frames warmed, then whole frames timed one at a time and judged on their median, stopped once
most of 5 agree (`frameCost(gl, draw)` in `fitness.js`, imported directly by tests, is the same judgement taken back to
back). Each timed frame is taken only while the GPU is quiet (below), else thrown away. The console says the verdict:
`flight world: on (frame N ms)`, or `off: frame N ms`; and before it one line of how the frames went: `flight world: N
frames timed (…), K thrown away`, with `not quiet in time` where the wait ran out.

### What the GPU is busy with (`busy.js`, #104)

A frame timed while another part of the site compiles a program or uploads a picture times that work too, so the
fitness test times a frame only while nothing else runs. `watch(gl)` → `gl`: a context watched (once, however often
asked; `null` and `undefined` pass through): a shader or program is under way from `compileShader` / `linkProgram`
until its status is read (`COMPILE_STATUS`, `LINK_STATUS`, `COMPLETION_STATUS_KHR` answering true) or it is deleted,
and never longer than 5000 ms; every `texImage*`, `texSubImage*`, `compressed*` and `generateMipmap` is a pulse. The
door watches its own contexts (the gate's, the live door's); a host watches the contexts it makes itself (the site:
its planets and its worlds). Each thread keeps its own ledger. A worker's ledger reaches the page as
`{ type: "busy", n, gen }` posted by its page adapter's `busy({ n, gen })` (`page.js`, an additive change: the default
does nothing; `draw-worker.js` posts it), and the page tells each worker everyone else's in the same message, never
the worker's own back. For a host's own worker: `busyPeer(name, post)` → `{ heard(message), gone() }` (the worker's
`busy` messages heard under a name of its own, everyone else's posted to it as they change, until `gone()`), or by
hand `busyHeard(name, { n, gen })` and `busyGone(name)`. The test waits for nothing under way anywhere and nothing
ended for 100 ms; a frame during which anything began, ended or pulsed is thrown away. Bounded: after 8 s of the tab
shown with no quiet moment, or 10 frames thrown away, the rest are timed whatever runs; hidden, it waits, and the 8 s
start again when the tab is shown. Under `fit: "skip"` nothing waits. A host that watches nothing has the door as
before, its own work unseen.

The verdict is kept a week (ADR-0002 6.4): localStorage key `<storagePrefix>-fit <renderer> <w>x<h>@<dpr>` (the
gate's renderer, the screen and the device pixel ratio), value `{ t, fit, ms }`, valid while
`t <= Date.now() && Date.now() - t < WEEK`; written at every measured judgement, either way; neither read nor written
under `fit: "skip"` or save-data. `rememberedFit()` → `{ fit, ms, t } | null`: the kept verdict, read once a page (on
the page, never in a worker), after the gate; the console says `flight world: remembered on (frame N ms, D d ago)` or
`remembered off (frame N ms), tested again`. Only a pass opens a way in ahead of this visit's test; the host decides
by it whether the proof is at leisure or at once. `WEEK` (exported, and the probe's too: `capability.js`).

### The flight in a worker (ADR-0004 6a; Firefox)

Where the host gives `drawWorker` and `fonts`, the journey may draw the flight
in that worker: both canvases are handed over (`transferControlToOffscreen`),
`#warpgl` is made and placed beneath `#warp` by the page, and the engine and its
world run in the worker as they do on the page, the page keeping the clock, the
beats, the hooks and the body classes (`remote-flight.js` on the page,
`draw-worker.js` in the worker). Decided once a page at the journey's first need
(`fitness.js`: `drawnAside()`): `draw: "page"` keeps the page; `draw: "worker"`
takes the worker wherever `drawWorker` and `fonts` are given; otherwise all of:
the gate accepted the page and compiles on the page's own thread (`parallel`
false), no `navigator.userAgentData` (Chromium keeps the page), the gate not
forced (`gpu: "force"`: every live test keeps the page), a `Worker`, an
`OffscreenCanvas` and a canvas that can be handed over, not under save-data.
On the worker path the gate's context stays on the page, idle, and the world's
is made in the worker: two contexts, one of them holding nothing. The worker
posts its judgement (`verdict { fit, ms, skipped, how }`), which the page keeps
and resolves `verdict()` on; the page reads the kept verdict itself, and
`abandon` is posted to the worker and also fails the page's `verdict()`
(`{ fit: false, how: "failed" }`) if none is in: the first verdict wins, so it
stays failed whatever a stalled worker says later. A fallback to the page hands `verdict()` to
the page's engine.

The console says which, once, when the host gave a worker: `orbit · flight:
drawn in a worker` or `orbit · flight: drawn on the page: <why>`. Every other
line the flight prints is printed on the page as it would be there.

`journey.aside()` → `Promise<boolean>`: true once the worker has said it is up,
false once the flight is on the page (the page path, at the journey's first
need; a fallback before the worker was up; `destroy()`). It settles at the
first need. A host that draws its own worlds in a worker of its own reads it
before letting the page's context go: a worker that fell back before it was up
drew on the page, with that context.

Any failure (the worker's `error`, its `up` not ok, a `dead` (which says `why`, and `at`: the first lines of the
stack where it stopped), and under the
automatic rule no `up` within 5000 ms; under `draw: "worker"` there is no
limit) falls back to the page: `#warp` is replaced by a fresh canvas with the
same attributes, `#warpgl` removed, the worker terminated, the pending warm-ups
asked again of a page engine, and a flight under way picked up where it was.
The console says `orbit · flight: drawn on the page: <why>`.

Under the flag `links: "late"` (#119), a world made in a worker with no
background compile (no `KHR_parallel_shader_compile`: Firefox) is made with its
vertex shader alone, and its three programs (scene, over, post) are asked for
only at the host's word, `statusGo()` (`status.js`), told on to the worker as
`status` (to a worker made after it too), or `STATUS_LATE` (9000 ms) after the
world would have asked, whichever first: built one at a time on the GPU's queue,
they kept the host's own first work waiting behind them. A flight started gives
the word itself, and a world lost or taken down while it waits asks for nothing
(its `warm` is answered not ok). The host gives the word once its first work is
done, or at once if it readies nothing; without the flag nothing waits, and on
the page or with the extension the flag changes nothing. `journey.compiled()`
settles only after the word.

### Where the pictures are decoded (ADR-0004 6e; Firefox)

Firefox decodes a blob's picture on the page's thread, whichever thread asked, and stalls it for the decode's length.
So where the family tell says Firefox (`fitness.js`: `decodeAside()`: the gate accepted the page, `parallel` false, no
`navigator.userAgentData`; `gpu: "force"` does not change it) the pictures are decoded by the browser's image loader:
an `<img>` on a `blob:` URL, `decode()` awaited, the bitmap wrapped from it. `decode: "img"` takes that route anywhere,
`decode: "blob"` keeps `createImageBitmap(blob, options)` (the control). The console says `orbit · pictures: decoded by
the image loader` once, when taken. On that route only the resize options (`resizeWidth`, `resizeHeight`,
`resizeQuality`) reach the wrap: `colorSpaceConversion` and `premultiplyAlpha` are dropped, as either makes Firefox
decode again on the page's thread. A decode or wrap that fails is made the old way. The flight's and the install's
workers ask the page for it (`hello.decode`, `"page"` or `"here"`; the `decode` and `decoded` messages) and receive the
bitmap transferred. Nothing a host does changes with this beyond the exports below.

### Also exported from `index.js`

For a host's own worlds and skies, so their work takes its turn with the
door's: the chores (`chore`, `fetchOnce`, `fetchBitmap(url, options)` (a picture fetched once and decoded by the route
above, in place of `createImageBitmap` of the blob), `linked`, `counted`, `note`,
`noteChores`, `quiet`, `openChores`, `openCompiles`, `openSoft`, `softRan`,
`hurryChores`, `programs`, `compilesAside`, `holdReveal`, `moving`, and the wait limit for
a background compile, `compiledWithin` and `COMPILE_WAIT`), `uploadBanded`, the GPU gate (`gpu`,
`isSoftware`, `FIT_MS`, below), whether the flight is drawn in a worker
(`drawnAside()`, for a host that puts its own drawing beside it), whether the pictures are decoded by the image loader
(`decodeAside()`) and a blob decoded as `fetchBitmap` does (`decodeBlob(blob, options)`), for a host's workers, the host's word
that its first work is done (`statusGo()`, above: The flight in a worker), the capability probe
(`probe`, `level`, `liveDoor`, `lateDoor`), what the GPU is busy with (`watch`, `busyHeard`, `busyGone`, `busyPeer`,
above), `seededRng`, `el`,
`measureTile`, the engine (`createFlight`, `UP`, `PROPS_UP`, `UPDUR`,
`homeProps(homes)`, `docsRest`) and `decodeAhead`, and the glows' graphs (`DAWN`, `DUSK`).
For a host's own worker, which must answer for the page and run its queue
unpaced as `draw-worker.js` does: `setPage(over)` (`page.js`: the page's
answers replaced by the worker's), `pace("none")` (`chores.js`: the rests
and the one-band-a-frame uploads dropped) and `askPage(post)` (`chores.js`: the worker's `decode(blob, options)`
for `setPage`, which asks the page and falls back to decoding here, and `heard(message)` for the page's `decoded`).
Such a worker wraps every canvas the page hands it in `askedOnce(canvas)` (`page.js`) before anything asks it for a
context: each kind of context is then made once and given to every later ask. Firefox 159 refuses a second
`getContext` made in a worker on a canvas handed over, whatever it asks for, and the worker stops (#154). Its `dead`
can say where with `stoppedAt(error)` (`page.js`: the first lines of the stack, without the line repeating the message).
All of them are optional: a host that uses none of them has the door as before.
`page.decode(blob, options)` (`page.js`) is an additive change to the page interface (#113), and `picture`'s `loaded`
is called once the picture's `decode()` has settled rather than at `load`. A host's own page adapter given to `setPage`
need not have `decode`: `setPage` only replaces what it names.
`page.yield(fn)` (`page.js`) is an additive change to that page interface (#101):
the next task with no clamp (a `MessageChannel` message, else `setTimeout(fn, 0)`),
which the chore queue hops on during the door's reveal instead of 0 ms timers. A host's own
page adapter given to `setPage` need not have it: `setPage` only replaces what
it names, and where a page without `yield` is in use `chores.js` falls back to
`setTimeout(fn, 0)`, as before.
The page's chore queue runs its share inside the animation frame's callback, before the paint, with a 50 ms
timer behind it for a page whose frames are slow or absent (#101); `moving()` (`chores.js`) → `release()` says
something moves on the page's thread (the flight's own loop does, on the page path), so the share is the smaller
one until released. A host with its own loop on the page's thread may call it; one that never does has the door as before.
`docsRest({ width, height })` → `{ distance }`: how far from the galaxy's core
the docs' flight comes to rest on a screen of that size (CSS px), in the
galaxy's own units (its disc's radius is about 1). The flight reads the
screen's shape itself, once, as it starts (turning the screen mid-flight does
not switch it): on a landscape screen the camera rests inside the disc, 0.56
from the core, the band across the sky; on a portrait one (width / height at
most 10/11, the door's own threshold) it stops short, 1.1 from the core and
above the disc, rolled a quarter turn more, so the whole spiral stands up the
screen (`engine.js`: `PATH`, `PATH_TALL`). A host that draws the sky the flight
ends in draws one picture for each (the site's `tools/docsky.cjs`).
`homeProps(homes)` is the other households passing on a flight: one `"home"`
prop each from `[{ name, bodies: [[x, y, colour, r]] }]`, a home's prop
depending only on its place in the list (the site's `demoFlight` uses it).
`descentProfile({ onto, from, homes })` is the profile `descend` flies (pure,
for tests: `DOWN` itself, `DOWN_DAWN` itself, or the climb `from` run
backwards, with the `homes` on the end); `DOWN`, `DOWN_DAWN`, `DOWNDUR` and
`mirrored(props)` come with it. `mountDawn` and `mountDusk` are the very
functions `door.dawn(host)` and `door.dusk(host)` return, exported by name too
(`dawn.js`); `createJourney` is likewise `door.journey`. They read the settings
`createDoor` has given, so call `createDoor` first.

## Files

| File | What |
| --- | --- |
| `index.js` | The entry point: `createDoor`, and the exports above |
| `settings.js` | The settings store the modules read |
| `dawn.js` | The dawn and the dusk mounted on their markup; first light |
| `journey.js` | The journey's clock and `createJourney` |
| `engine.js`, `timeline.js`, `voyage.js` | The flight's canvas engine, its beats, its WebGL world |
| `door3d.js` | The live door: the Earth drawn as it is, where the level allows |
| `fitness.js` | The GPU gate (`gpu()`), the fitness budget and `frameCost`, the back-to-back judgement tests import (the flight world's own verdict is `voyage.js` `quietFitness`), the software renderers refused |
| `busy.js` | What the GPU is busy with, for the fitness test's quiet frames (`watch`, the ledger, what workers tell the page) |
| `capability.js` | The probe for the live door (`?door3d`), and the level it gives |
| `chores.js`, `upload.js` | The background work a piece at a time; pictures put on the GPU in bands, a flight map's ready-made sizes smallest first (`uploadSized`, eased in by `easeLevels`) |
| `page.js` | The page as the flight's modules see it (size, frames, visibility, pictures, the console): every touch of the page by `engine.js`, `voyage.js`, `chores.js` and `fitness.js` goes through it (ADR-0004 6a.2); in the worker, `draw-worker.js` answers for it (`setPage`) |
| `remote-flight.js` | The flight drawn in a worker, as the page sees it: the engine's surface, the messages, the fallback |
| `draw-worker.js` | The worker's entry (the host's `drawWorker` runs it): the handshake, the engine on the handed-over canvases |
| `sun-worker.js`, `sun.js` | The sun painted in the host's `sunWorker`: the worker's entry, and the DOM-free band routine (`sunBand`) it shares with the page's own path in `glows.js` |
| `stars.js`, `glows.js` | The star fields; the glows' graphs and the sun painted per size |
| `decode-ahead.js` | Pictures decoded before they are shown |
| `markup.js`, `door.css` | The markup and the stylesheet |
| `img/dawn/` | The door's Earth (`dawn-pre`, `dawn`), its glows, the gold planet (`planet-gold`, the goodbye's under `asDawn`), and the near maps and light strips the live door draws |
| `img/dusk/` | The dusk's glows |
| `img/flight/` | The flight's Earth maps and the gold moon |
| `img/{flight,dawn}/<map>-<width>.webp` | Each flight map's smaller sizes (#148; `tools/map-sizes.py`, `voyage.js` `FULL` and `SIZED_PATHS`). A host's `image()` places them as it places the full maps; one that returns these paths unchanged gets the full maps whole, as before |
