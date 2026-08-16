# Owner design decisions — the v19 record

Distilled from the full design conversation of 11–14 August 2026 (747 turns,
both sides). **Supersessions are resolved**: where a decision was later
overturned, only the final position is stated as current, with the earlier one
shown as history so it is not accidentally reinstated.

## How to read this

The design ran 19 iterations. **Where something was judged good, it stopped
being discussed** — so the late-version conversation alone does not describe
what v19 is. A ruling made at v7 and never revisited still binds. That is what
this file exists to hold.

Three sources sit above it, and win on conflict:
`design/v19/home.html` and `design/family/*.html` (the ratified screens),
`design/polish-register.md` (POL/CON units and their status), and
`design/mockups-brand-decision.html` (the ratified mark).

**Owner's binding statement on fidelity (14 Aug):**

> "The new UI must look exactly, almost pixel for pixel like the new mock up.
> It was pored over at great length. Spacing, colours, every single tiny aspect
> of the design was pored over until it was approved. It took us NINETEEN
> iterations to get to that mock up. It is the very identity of the new
> product. We should not shoe horn old elements of the old UI just to satisfy
> them. If things are missing along the way you should stop and ask me
> specifically what I want to do, but the answer is for now mostly going to be;
> implement the approved design, raise the missing functionality in an issue
> against the new front end and we will work through it when appropriate."

---

## 1. The identity

**The year is the orbit.** One ring, twelve months, the household's obligations
as bodies approaching perihelion. The same drawing is the mark, the dashboard
hero, and the explanation of the product.

**The gravity well is the instrument** (the owner's own concept, v4):

- **angle** = the calendar month
- **radius** = time remaining — nearer to due sits closer in
- **size** = typical cost
- a dashed **perihelion threshold**; inside it is overdue
- so every item traces a slow inward spiral over the year, and **closer means
  more danger**

**Star-chart is the primary identity**: deep navy void, fine graticule
linework, gold accents, layered drifting starfield, the household as a sun.

> History: star-chart was first built as bright aged paper and rejected — "quite
> bright for something named 'star chart'". The paper treatment survives
> renamed **Atlas**.

**Mission vocabulary**: `T−16d` / `T+16d` countdowns, "orbital period · 1 year".

## 2. The mark (CON-19, ratified — do not re-open)

**Exactly three flat geometric shapes: the ring, the planet riding it, and a
plain filled circle at the centre (the household).** No gradients, no glow, no
3D, no decoration of any kind, at any size, in any medium. Colour comes only
from the theme tokens. **The word always sets plain, beside or under the
glyph** — never with the ring through it, and nothing inside the ring.

The only motion permitted anywhere in the identity: **the planet drifts slowly
around the ring, once per 40s, on live surfaces.**

Ratified geometry (200-unit viewBox): ring `cx100 cy100 r72` stroke-width 7;
centre `r7` filled `--sun`; planet `cx163 cy63.5 r16` filled `--accent`; drift
`spinback 40s linear infinite` about `100px 100px`.

> History, in order: the three-arc mark retired; all wordmark decoration
> rejected across three passes ("the brand parts I don't like are the word mark
> words"); ring + planet only; then "we do need something in the middle but
> it's just a simple filled circle"; then "I said no 3D effects. Just flat
> geometric shapes." The mark was found in the product, not invented for it —
> it is the gravity-well dial reduced to a glyph.

**Strapline:** none on the sign-in — *"the hero is the name."* CON-11 records
*"your year, in orbit"* for surfaces that want words (README, launcher splash).

## 3. The home screen

### The hero

- The splash is **just the star chart**. No header, no top bar, no left column.
- The search field sits **midway between the bottom of the screen and the
  dial**, placeholder **`explore your world`**, and doubles as the POL-9
  command palette (⌘K focuses it; matches items *and* actions).
- **No count anywhere on the sky.** "N need your attention" was rejected three
  times — as a band, as an arc annotation on the threshold, and inside the
  dial ("it clutters and adds no value at all"). The ambient forms instead
  (CON-4): the **tab title** and the **PWA app badge**.
- The summary, where it appears at all, is a **full-width row beneath the
  chart** — never an area on the left.
- **"Everything in your orbit" was cut** as clutter.
- The starfield **drifts constantly** in the real product, not just the mockup:
  perceptible within **3–5 seconds without staring**, parallax by depth,
  seamless tiled wrap, no snap or reversal (POL-11).

### The bodies

- **Everything is circular** — "all be circular to represent planets". The type
  language (CON-3): **● service · ◉ concentric renewal · ◐ terminator
  inspection · ○ hollow suggestion**. Below ~5px radius the character degrades
  to a plain dot and the callout carries the type in words.
- **Planet materials** (POL-14): ruby, jade, amber and sky radial bodies with a
  lit limb toward the sun — "richness not flat colour". **Chart only** —
  manifest dots and key swatches stay flat tokens so the colour language stays
  honest.
- **Belts mean attached documents** (CON-1) and are **passive badges** — not
  click targets.
- **Hovering** a body shows a glass-backed chart callout at 13.5px, quadrant-
  aware so the leader line never crosses the cluster, with bidirectional
  highlight between dial and manifest.

> History: diamonds and triangles were tried and rejected. Belts were briefly
> clickable; that was withdrawn because threading a 1.3px ellipse with a cursor
> is fiddly.

### Click grammar (CON-5)

**Exactly one clickable thing per body — the planet.** Click = approach (fly to
the manifest entry; for an asset centre, zoom into its sub-system). Everything
else lives in the hover callout, including the documents chip. **Touch:** first
tap summons the callout, second tap approaches.

### The manifest

Grouped, not a flat chronology: **"Needs attention" / "Suggested from your
documents" / "Later this year"**, ordered by date within each group. Each row is
a colour dot, a bold title, one quiet line (`Home · orbital period 1 year ·
~£150`) and a T-minus with the date. **Costs are printed** so size is never
geometry-alone.

### Chrome — the four edges

- **Left edge**: a single vertical word, always present. Green **`status`** when
  healthy, orange **`degraded`**, red **`offline`** (front end serving, back end
  worse than degraded). `degraded` must be **clearly orange** — gold read as
  normal.
- **Right edge**: **`key`**, in a theme-appropriate white, opening the key as a
  list (shapes, colours, belts, physics).
- **Top centre**: the **north star** (CON-12) — one slightly brighter star with
  a four-point glint; click opens a full-width top drawer for creation. The star
  is the drawer's handle and rides the slide. It gained a **scrim** (the sky
  dims beneath) and an explicit **close** chip, because when open it was hard to
  find the way back up.
- **Top right**: the account orb — identity, menu, theme swatches, sign out.

**Drawer rules:** the edge word **rides its drawer**, staying attached as it
slides; clicking pulls it out and pushes it home. **All drawers animate back to
their closed positions on scroll down** (POL-12). Layout must **pad for the
scrollbar**, which was overlaying the `key` label.

**Light dismiss (owner, 2026-08-14, amending the create-drawer-only rule
above; issue #416).** One rule for every transient surface on home — the three
drawers, the document card and the account panel. Clicking anywhere outside an
open surface closes it, Escape closes it, and opening one closes the others,
so **only ever one sits over the hero**. The scrim remains create-only, exactly
as CON-18 ratified: nothing else dims the sky. Previously click-outside
belonged to the create drawer alone, which left all three drawers able to sit
open together and left the document card — opened from a callout that then
vanishes — with no exit but its own close button.

**Status drawer contents** — bounded states only, never values: per-container
rows with status, last health-check result and how long ago, a reason from the
fixed vocabulary. **Never** versions, ports, paths, config values or raw
provider errors. Deep detail belongs to container logs and the repair flow.

### Documents

The document view opens from the callout's chip, sited **midway between the dial
edge and the screen edge**, vertically centred, breathing symmetrically up and
down as the count changes, capped with internal scroll.

### The galaxy (CON-13)

- A user belongs to **at most 5 households** — a product cap.
- Households hold **permanent coordinates in a shared map**; the layout is
  **stable across sessions** so it becomes learnable muscle memory.
- **You never see your own constellation — you are inside it.**
- Others sit in the backdrop as small living systems, **dimmed by distance**,
  wearing their status colours dimmed for at-a-glance cross-household health,
  each with a cartographer's annotation: the rule runs **underneath the name**,
  extends past it, then breaks at an angle toward the system.
- Clicking one **never swaps**. The **camera** travels: the starfield streams
  with parallax, the destination holds its bearing and grows, and the household
  you left appears on the **reverse bearing**.
- **Clean flights** (CON-18): the departing chart leaves *completely* with the
  camera — no low-opacity remnant trailing like a catch-up.
- **One motion, no dwell, no pop** (v18.2): the destination arrives *precisely*
  at centre screen — the two suns align concentrically (measured to 0.02px) —
  and only then does the dial bloom out of that shared centre over **2.4s**.

### Sky moods

- **Quiet** (POL-8, v19 rewrite): **the chart itself fades away** — chrome to
  6% over a slow two-second dissolve, name to 30%. The sun, the far jade
  planets and the celebrating sky remain. **No words, ever** — order is
  rewarded atmospherically, not announced.
- **Storm** (POL-10, v19 rewrite): the camera **leans in** — the dial zooms
  1.26 toward the trouble, far greens are pushed out past the month ring, the
  danger ring thickens and glows, angry colours saturate, and meteors burn
  **red, orange and gold**.

## 4. The page family (CON-9)

One identity, a distinct personality per page, each with a full-screen starfield
moving in its own way.

| Screen | Personality | Notes |
| --- | --- | --- |
| **Sign-in** | first light | The dawn breaks **once on load**. "This is our ultimate hero moment — the first screen after the install launcher." Horizon low, in the bottom fifth. Starfield "a fair bit faster, not fast, slow, but not glacial — constantly buttery smooth". |
| **Sign-out** | sunset (CON-17) | The same limb world performing the day ending well: the sun sinks, scattering cools amber→ember→indigo, the stars take over, an ember rim holds. Bookends for every session. |
| **404** | the gravity well (CON-14) | **The gravity well ships as the one served 404.** The conjunction and uncharted concepts stay in the repo, unrouted — "you never know". Anything crossing the page travels **behind** the content, never over it. |
| **Maintenance** | totality (CON-15) | A total eclipse: the corona only a black sun can show, eclipse-dark sky with daytime stars, a 360° horizon sunset, the moon's transit doubling as the progress bar, and a diamond-ring flash as the service returns. Copy is **three words: "maintenance — back soon"**. |
| **Admin** | observatory | Instrumented, telemetric. Judged "perfectly acceptable" and deliberately parked for another time. |
| **Create** | genesis (CON-12) | A document condenses into a world. Four type chips plus a live document drop target. Progressive disclosure — the fuller field set unfolds once there is something to describe. The left-offset card layout was rejected as "a weird layout". |
| **Settings — mail** | relay | Per-user mail-in with signal rings; the user's own listening address, rotate and pause. |
| **Mobile** | the pocket sky (CON-10) | The dial owns the width; callouts, drawers and the doc panel become bottom sheets; households collapse into an "other skies" strip. **First-class concern** — "incredible on a laptop but it gets squashed on mobile". |

> History: the 404 was briefly "all three served at random" (v17). The owner
> changed his mind at v18 — the gravity well serves alone. The maintenance copy
> was briefly "There's a hiccup in the flux capacitor, but we'll be right with
> you"; that was cut as cheesy in favour of three words.

## 5. Craft standard

Stated when v16 was rejected: *"There's no detail in any of it, it's just basic
shapes blobbing around. There's no blur, no pulse, no sense of entropy."*

The light stack (POL-13) is the answer, and it is the standard for every
atmosphere page: every bright body layered (core + blurred halos), edges
noise-displaced with `feTurbulence` + `feDisplacementMap`, whole-frame film
grain, several slow animations on **distinct periods so nothing beats in sync**,
depth via differential blur, and a vignette.

Two further rules:

- **Show-stopper or nothing** — "this has to be an all out show stopper to pull
  it off." A merely promising effect is a failed effect.
- **Motion must be perceptible without staring**, and buttery smooth: seamless,
  linear, no snap, no stutter.

## 6. Theme architecture

Four packs — **star-chart** (primary), **after dark**, **atlas**, **dawn** — as
semantic token sets under `[data-theme]`. Components reference tokens only,
never raw colour. **The separate light/dark/system toggle is retired: lightness
lives in the pack choice.**

**The urgency palette retired the orange tier** as provably CVD-inseparable from
amber. Four states only: on-track green, upcoming ice, due-soon amber, overdue
red. On light surfaces overdue shifts toward raspberry for the same reason.
`--degraded` is its own orange token, hotter than the gold accent.

Contrast is not negotiable: filled accent buttons carry **dark** text
(`--accent-ink`) because every pack failed white-on-accent, worst case 1.66:1.

## 7. Function decided during the design

These are real product commitments, not decoration:

- **Mail-in never opens a port.** One user-supplied mail server, one mailbox;
  per-user addresses are plus-addressing aliases delivering into it; Orbit
  **pulls** and sorts locally. Providers that matter: **Mailcow, Gmail,
  Outlook/Hotmail** (the last needs OAuth2 — consumer IMAP basic auth died in
  late 2024). Container mail config becomes **sending only**.
- **Per-user mail settings**, not admin-only — explicitly flagged as "not just
  mockup front end work it's real feature. You should track it."
- **The dial is not the accessible source of truth — the manifest list is**, and
  costs are printed so size is never geometry-alone.
- **Reduced motion and non-JS both degrade to the plain list.**
- Sub-systems / assets (CON-2): a car is not one obligation but a small system
  — approved in concept, zoom by the same click grammar.

## 8. Process rules the owner has set

- **Collect the whole feedback batch, then ask before building.** "Ask before
  building a new mock up v because you keep racing off before I've finished."
- **Direction is settled only when the owner says so.**
- **Concise, layman's terms, bulleted sections, questions at the end — not mid
  prose.** The owner is technical; the failure mode is verbosity and jargon,
  not vocabulary. **Do not use the question card** — ask in plain text.
- **No third-party hosting.** Serve locally.
- **Nothing development-internal under `docs/`** — that folder is the public
  Pages site. The mockups now live at top-level `design/` for this reason.
- **main is the branded relaunch.** "I'm not launching subpar. All release on
  main shipped broken and under delivering. We're going to polish and ratify
  before shipping to main this time." Gaps become promotion blockers, not
  interim patches.

## 9. Why #408 happened — the failure to avoid

The overnight build was told to preserve the existing app and keep its tests
green. Those tests encoded the old copy, so the old markup and words survived
and the new artwork was painted behind them. The clearest case: the approved
sign-in is three elements, and what shipped re-added a tagline, a headline and a
privacy paragraph, and reworded the button.

The builder also **put the section list back** into the account panel
*because* v19 didn't have one — overruling the design to preserve a working
feature. The owner's verdict: *"the single clearest example of shoehorning the
old thing into the new one."*

**The rule that follows:** the mockup is the specification for the *markup* —
its structure, class names, copy and controls — not a reference for the look.
The old front end is not an input to any decision, and its tests are not the
specification. A faithful port can be checked by diffing rendered structure
against the mockup; nothing like that existed before.

## 10. Decisions taken after ratification (this rebuild)

These post-date the mockups and supersede them where they conflict:

- **Sections are gone as navigation.** Search plus the manifest carry it. (The
  manifest still prints the section name as each row's category, as drawn.)
- **The sign-in ribbon `PRIVATE · SELF-HOSTED · YOURS` is removed entirely.**
- **The sign-in button reads `Authenticate`**, is smaller than before, and is a
  thin white outline pill with a transparent centre, sitting inside the ring
  directly beneath the word, its line thinner than the ring's.
- **The lockup is centred** in the viewport.
- **The mark is much larger** on the sign-in, with the word `orbit` set plain
  *inside* the ring and no filled centre (the word occupies that space).
  **CON-19 is amended for the sign-in hero only** (owner, 2026-08-14, recorded
  in the register). Everywhere else the ratified rule stands unchanged: three
  flat shapes, nothing inside the ring, the word plain beside or under the
  glyph.
- **A planet-orbit loading animation on sign-in was built and then dropped** for
  now.

## 11. Membership and the empty sky (owner, 2026-08-15)

The design family gains the journeys the ratified eight never covered:

- **The remaining screens get mockups** — due next, documents, inbox, settings,
  administration — built in the established star-chart identity. The owner
  expects these to converge in few iterations now the identity is strong.
- **Core membership model.** Any user can create a household and becomes its
  owner. Instance admins see everything by default. Ordinary users can see what
  households (sub-systems) exist.
- **The empty sky.** A signed-in user with no household still sees the
  starfield and the sub-systems — but each constellation shows only its basic
  household label, none of its contents. Clicking one asks
  **“Request to join X system?”**; the request goes to that household's owners
  to approve.
- **Adding members.** Owners can add any user to their household; instance
  admins can add any user to any household.

## 12. Nothing on the dial is decoration (owner, 2026-08-16)

**"Nothing on the dial is there for decoration, it's all real information.
Planet colour, location, size, style, rings etc etc."** The dial is totally
empty at zero entries; green planets exist only when entries are months away
from needing attention. The mockups' hand-drawn "asteroid field" (and the
pocket dial's decorative dots) are removed from the designs and the product
alike — every body drawn is a real item placed by the law.

## 13. The v1 batch is ratified for build (owner, 2026-08-16)

**"Honestly, let's just build them for now. They look great and small front
end tweaks will be easy to rectify later. We should continue."** The six #452
proposals — due next, documents, inbox, settings, administration, and the
pocket's signals surface — are ratified as-is at v1. They are built now, each
through the fidelity gate like the original eight; visual tweaks arrive later
as ordinary fix-both changes rather than blocking the build.

## 14. The walk-stack review batch (owner, 2026-08-16)

- **One schedule surface.** The home manifest is displayed exactly like the
  due-next corridor — a full scrollback through events, nearest at the top
  down to the furthest away — with suggestions appearing in chronological
  order within it. The due-next page therefore does not need to exist; it
  retires (mothballed, not deleted).
- **Documents retires too** (mothballed, not deleted): the coming asteroid
  belt (#458) with a well-placed search box is the document surface. People
  mostly want the item; the document is a click away from it.
- **Forms dismiss on click-off.** Clicking off the create form returns to the
  landing page; clicking off the relay card returns to the previous screen.
- **Form-specific backdrops, mockups first.** Rather than patching missing
  starfields, forms may earn their own backdrops (settings: star charts;
  new items: charts in progress; and so on) — designed as mockups before
  anything is built.
- **Considered, mockups first:** an inbox button next to the menu orb that
  changes colour when something waits; the inbox screen using its left
  section for mail-found items.
- **Constellations spread out when space allows** (owner, mid-review): rings
  were overlapping while a laptop/desktop sky had room to spare. Separation
  scales with the viewport, the universe arrangement stays natural, and
  bearings remain sacred.
- **Settings uses the desk** (owner, mid-review): the single 640px column is
  too narrow on a laptop/desktop — at least a third of the screen, ideally
  half. The helm widens to the administration screen's scale: the pack cards
  earn one full row, the remaining cards sit in two columns.
- **Backdrop verdicts** (owner, mid-review): the inbox orb is approved as
  drawn. The v1 settings/create backdrops are the right idea but overly
  subtle and overly simple — "a good start but not enough". The starfield
  overlay reads well but must not be overused: **create keeps the
  starfield** (bolder chart-in-progress); **settings and admin try totally
  new ideas** — a charting / tool / spaceship / observatory vibe, classy
  and elegant, never tacky.
- **The inbox is three lanes** (owner, mid-review): "what your mail became"
  is titled **Filed**; on a large screen the inbox runs Filed → For your
  review → Failed to process as three lanes, stacking vertically on mobile.
  Still reading sits below the for-your-review items.
- **The corridor spine fades out** (owner, mid-review): the manifest's
  time-spine is right, but its ends fade into the background rather than
  stopping hard; the red zone's edge-line fades in the same way.
- **Any scroll closes the drawers** (owner, mid-review): the v17 retract only
  fired scrolling down; scroll movement in either direction now sends every
  open drawer home.
