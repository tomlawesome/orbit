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
  Amended on seeing the v2 mockup: **Still reading lives in the right-hand
  lane, above Failed to process** (superseding the earlier
  below-the-review-items placement).
- **The corridor spine fades out** (owner, mid-review): the manifest's
  time-spine is right, but its ends fade into the background rather than
  stopping hard; the red zone's edge-line fades in the same way.
- **Any scroll closes the drawers** (owner, mid-review): the v17 retract only
  fired scrolling down; scroll movement in either direction now sends every
  open drawer home.
- **Still reading lives in the right lane** (owner, on the v2 inbox mockup):
  above Failed to process — superseding the earlier below-the-review-items
  placement. Ratified with "inbox looking good in v2"; the three-lane build
  proceeds from this.
- **The create screen grows from its centre** (owner, mid-review, mockup
  first): the create backdrop reads spartan — it should carry the instance's
  ACTUAL household constellations, display-only, never clickable. The New
  Entry card sits vertically centred until a document is added, then expands
  symmetrically up and down as fields are required. Adding a document splits
  the screen into two lanes: the form slides left, a new card fades in on the
  right and "Focusing on the anomaly" quietly pulses until a real top-sheet
  snapshot of the document — an image of its first page — lets the user
  visually confirm it's the right one at a glance. (The snapshot needs a
  server ask: no page-one thumbnail rendering exists yet.)
- **Create v3 is nailed; both backdrops are still too quiet** (owner, on the
  #474/#475 proposals): the create-v3 flow is ratified as drawn ("that agent
  NAILED the create-v3") but its backdrop — and the relay's — need more
  presence. The satellites must vary in size, shape and position, and the
  roster grows to famous craft: the James Webb telescope, the famous probes
  of the years of space exploration. And the administration backdrop could
  be based around the International Space Station ("YES I love this train
  of thought") — superseding the plotting-sheet chartroom proposal as the
  admin direction to explore.
- **The sky drifts as one** (owner, on the living-backdrop proposals): the
  satellites — and the constellations — are part of the sky behind, so they
  drift with the starfield. "We can't have a drifting starfield with fixed
  objects, it doesn't make sense." Nothing in the sky sits static while the
  stars stream past; near objects may drift faster than far ones (parallax),
  and the test is WHERE an object exists: anything that lives in the space
  field lives with the space field in motion; anything that's an overlay —
  chart marks, cards, forms and their furniture — can stay static with the
  forms. The one screen where the constellations don't move is the dial
  view: there they're functional — flyable, law-positioned — and we need
  them still. Everywhere else they're scenery and they drift.
- **The sky never loops** (owner, same batch): the drift is a constantly
  changing backdrop, not a carousel — the current seamless-tile repeat is
  out. As the sky drifts, newly revealed regions roll fresh from the seed
  stream and what scrolls away doesn't come back. And the constellation
  population grows: the real instance households are obviously limited, so
  the sky mixes in random non-real constellations bearing actual
  galaxy/constellation names (genuine astronomy — Lyra, Vela, Cassiopeia,
  Andromeda — never invented words), so the universe reads bigger than the
  instance while the household marks stay the only ones that mean anything.
- **The living backdrops are ratified; the real world reads a notch clearer**
  (owner: "Love love love the new back drops"): the direction stands, but
  the names and lines of the real-world objects — the famous craft, the
  real star systems and constellations — are all a bit too faded. They
  must be easier to read without becoming bright or distracting: up from
  too-subtle, still below the household marks that mean something.
- **Backdrops are alive, and never the same twice** (owner, mid-review,
  mockups first): the relay backdrop gets 2–3 satellites — "we're conveying
  messages after all" — not too big, not too small, placed at random. The
  same concept applies to every screen: each keeps its own style, but is
  somewhat random within that style on every load. The instance's own
  households float in the distance of the backdrops — not necessarily all of
  them every time. (Build note: the fidelity gate needs a seeded arrangement
  under fixtures so mockup and app can still be compared; live loads roll
  fresh.)

## 15. The walkthrough batch (owner, 2026-08-16)

The full open-questions list, walked in order and ruled:

- **The living backdrops are ratified for build**: relay-satellites v2,
  administration-iss, and create-v3's loudened backdrop — all approved as
  drawn (admin's bolder atlas rendering included).
- **Settings gets no verdict yet — three concepts instead**: the
  observatory-slit proposal is set aside; the owner likes all three of the
  new directions in text — *inside the observatory* (sky only through the
  slit), *the cartographer's desk* (no sky at all; your chart being drawn),
  *the gimbal room* (inside your own craft; stars only through portholes) —
  and wants all three mocked for review.
- **Relay lives in one place, wears two hats elsewhere**: settings keeps
  the full relay card; the inbox shows its relay bar ONLY when the queue is
  empty (the address is the call to action); administration's panel
  retitles to mail machinery and sits with operations.
- **The pack refresh is ordered**: atlas re-materialises as a printed
  thing (opaque paper panels, engraving hatch, ink planets, gold-leaf sun,
  paper grain); dawn gets a temperature story (cool-to-warm vertical
  ground, hazy pastel planets, sunrise amber); retrograde earns its
  structural signature (faint horizon grid low in the sky, restrained
  bloom on accents only, brighter mid-ink).
- **A manifest row expands in place** (#424): everything Orbit holds about
  the item, in the row, at a real address — the browser bar quietly updates
  as it opens; the URL itself is never printed in the interface (a small
  copy-link affordance is fine).
- **The sky is a fixed map** (#428): placements derive from absolute
  coordinates, relaxation is deterministic, flights never reshuffle what
  the sky already taught.
- **Dawn-terminator: liked, and the scroll is a descent** (owner): on
  scrolling down, the sky — the terminator crossing and its stars — goes
  out of view above, "like you're going down over the planet/sun's
  surface", leaving a gradient that changes very slowly as you scroll
  further: from the lighter colour at the top down to the pinky-orange
  that sits at the bottom of the dial screen. The deep manifest reads
  over warm surface light, not sky.
- **The launch, second pass** (owner: "a great first pass! I love it"):
  logout is a DIRECT REVERSAL of login — the same flight backwards, not
  a bespoke quieter descent. The bloom at the end becomes a slower, more
  careful reveal (extend the time as needed). The 3-second dwell comes
  BEFORE the dial lines or any annotations: the arrival settles on just
  the planet symbols and the centre sun — no dial rings, no inbox orb,
  no menu, no search box — dwells there, and only then does the
  instrument draw in. And the non-admin newcomer (not the first user)
  gets the same login launch, settling on the dial screen with NO dial
  and every household as sub-systems, under the question "Where do you
  belong?"
- **The slit, second pass** (owner: "I like it! But—"): REVERSE the
  scroll — start more open, CLOSE UP as you scroll down. The doors must
  not be straight verticals: real observatory domes have curved,
  spherical shutter forms — reflect that for intrigue and depth. And
  it's missing something that makes it unmistakably OBSERVATORY DOORS —
  research real observatories for the telling details, and subtly
  name-drop a real one in the background.
- **The login/logout flight is ratified verbatim** (owner: "nothing
  short of amazing... Ship these in that exact form."): first-run v2's
  ascent (ignition, climb, slowed bloom reveal, bodies condensing, the
  dwell) and its mirrored descent (logout = the login played backwards,
  name written on the void, dusk farewell) ship into the app exactly
  as the mockup plays them at 159ec9f. And they are NOT first-run
  dressing (owner: "they're too good") — they ship as THE login and
  logout screens for every user, every time; first-run just happens
  to use them. The create-system card is NOT part of this ratification
  (it failed separately, below).
- **Newcomer arrival is ratified verbatim** (owner: "fantastic, great
  job. It ships exactly like that."): the non-admin newcomer's journey
  as first-run v2 plays it at 159ec9f — the same login climb, settling
  on the labelled sky with every household as sub-systems, the 3s bare
  dwell, then the north star and the centred "where do you belong?"
  card (ask to join, or name your own system) — ships exactly as is,
  with one amendment (owner, immediately after): the "N systems
  discovered in this universe" count belongs to the NEWCOMER journey,
  not the first admin's create screen — a first admin always joins
  with 0 households, so it would be pointless there. And it is not a
  fixture but a MOMENT in the choreography, boxless (no card, no
  border, words and number directly on the sky): starburst, the dwell
  over the households that exist, the count fades in then out over
  2–3s, and only then does the "Where do you belong?" card come in.
  Trimmed and sealed (owner, after seeing it built): the dwell before
  the count REDUCES BY 1s — everything after shifts earlier with it,
  the beat's internal rhythm unchanged — "otherwise perfect."
- **The observatory has failed** (owner, after the second pass): the
  slit/dome-doors concept is retired for settings — two passes could
  not make it earn the screen. Three fresh concepts commissioned in
  text; go mad with creativity.
- **First-run fails at the card** (owner): the create-system card is
  stuffed full — dense helper prose crowding three simple fields — and
  it buries the sunrise behind it. Strip it to almost nothing: the
  fields, the button, air. The launch sky must stay visible through
  and around it.
- **The #424/#428 ratifications** (owner): off-screen constellations are
  rejected — the shipped never-on-chart trade stands (crowding accepted
  as the lesser wrong, as long as it functionally works). The expanded
  row's scroll-survival is blessed "for now". And the item's command
  surface (complete, reschedule, snooze, edit, retire) MOVES INTO the
  expanded row form — the row becomes the whole item, /item's fate to be
  settled once the commands have moved.
- **Retrograde keeps the ceiling — and the corridor turns on scroll**
  (owner: "I'm still undecided... I think it should.. probably"): the
  top grid stays, and retrograde's scroll answer is the corridor
  cleverly transitioning into grids at the SIDES, either side of the
  manifest, fading at the edge closest to the manifest — the room
  rotating around you as you descend from the dial to the list.
- **Settings: EVA wins, the Movement dies** (owner): the Movement is
  a no (file stays as the record). EVA is the settings concept "for
  now but it needs work" — specifics to be gathered before a second
  pass is built.
- **Household backdrop: inside this system** (owner): the berth is a
  no (record kept); H2 — the household's own constellation at room
  scale, fully data-true — is the household screen's backdrop.
- **The galactic plane is approved — with a bottom glow in the deep**
  (owner: "excellent... Very good though"): after dark's plane ships
  as its default sky, with one amendment — after scrolling down, the
  bottom edge of the frame gains a slight gradient glow, so the deep
  manifest's foot carries a glow similar to the plane's own.
- **Retrograde goes walls-only** (owner: "the same concept just more
  elegant"): the bare-dial trial WINS — no floor, no ceiling, no
  horizon haze at rest; only the side walls arrive on descent, with
  the trial's delayed, eased entrance. Supersedes the shipped
  floor+ceiling corridor from #480/cff21ea; fix-both into the app and
  home.html. The trial file stays as the record.
- **The landing dwell trims, the dial slows** (owner: "First run is
  excellent, but—"): the dwell on the bare sky before the instrument
  arrives is 1s too long (3s → 2s), and the dial's pop is slightly too
  fast — slow its draw-in a touch. The stated test: it must feel like
  a DELIBERATE WAIT, not a slow load. Otherwise perfect.
- **Retrograde trial: bare dial, walls only** (owner): try a version
  with NO grid on the dial view — no floor, no ceiling at rest — where
  the only grids are the side walls that rotate in as you scroll down.
  A trial mockup beside the shipped treatment, not a replacement;
  the shipped corridor-turn stays ratified until the owner compares.
- **Belt v4 sealed, one criticism: no discoloured box** (owner: "Belt
  v4 is great, only one criticism left"): the band's glow/haze must
  not read as a discoloured rectangle at the screen edges — the
  discolouration was already asked to go. Fix: fade the band's edges
  to nothing (owner's own suggestion) so the glow dies smoothly before
  any hard bound can show.
- **The create screen is not "form over login"** (owner: "this is a
  mess!"): the create-system card appears AFTER login, so the login
  screen must be gone entirely while it shows — no identity-provider
  button, no orbit wordmark, no orbit logo, no footer. Clean sky, the
  small centred card, nothing else. When the user submits, the orbit
  logo and word REAPPEAR and the ratified login intro runs exactly as
  approved, with one tweak only: no login button this time (already
  authenticated). Otherwise identical.
- **Theme-morph is a YES — and the judder was always hated** (owner,
  correcting the record): the accidental juddery blend seen when
  switching themes was not liked, it was hated; the ask was always to
  make the transition SMOOTH. A deliberate, smooth sky-morph on theme
  switch is approved for development.
- **Settings concepts ruled** (owner): the Projection Room is a NO.
  Try THE MOVEMENT (clockwork behind the dial) and EVA (the spacewalk
  along the hull) as mockups — the owner favours the spacewalk so far.
- **Household backdrop: try H1 and H2** (owner): mock the berth (the
  household as a craft in for service) and inside-this-system (the
  household's own constellation huge and faint behind the cards). H3,
  the registry annex, dies with the observatory it leaned on.
- **Homescreen style roster ruled** (owner): aurora, deep field, orbit
  trails and galactic plane go forward. METEORS ARE A NO for styles —
  meteors are reserved for THE DANGER: the danger/storm mode will be
  reworked at some point (quiet mode is good; the danger mode sucked),
  and meteors belong to that vocabulary. Also try: colourful gas
  clouds, and things of interest that GLINT. Confirmed alongside:
  galactic plane doubles as AFTER DARK'S DEFAULT sky (owner: "I am
  happy with galactic plane belonging to after dark as its default")
  while remaining a selectable style.
- **#484 demo data is ratified** (owner: "Yes, that was the idea I laid
  out"): first-run populates the workspace with fake data for the
  welcome tour, and it CLEANS ITSELF at the end of the tour — or the
  moment the tour is skipped. Nothing demo survives past the tour.
- **Dawn cloud sea is approved as a main lighter theme** (owner):
  clouds (the cloud-sea pack on the final roster) is not merely
  admitted — it is one of Orbit's MAIN LIGHTER THEMES. This supersedes
  the "no light pack" consequence noted under the roster ruling:
  clouds carries the lighter end of the range.
- **After dark adopts the happy accident** (owner): the galactic-plane
  style — the warm band lying diagonally across the sky, reading as
  the Milky Way, born as an accident during the dawn work — becomes
  part of AFTER DARK's own identity, not merely a homescreen style
  candidate. Mockup first, as always; the universal scroll-descent law
  applies to how the plane leaves as you scroll from the dial.
- **Retrograde: the top grid returns for everyone, and the walls close
  in** (owner): the ceiling grid is IN on all viewports — the
  tall-viewport gate goes. As you scroll down, the horizontal grids
  rotate and align as walls (the corridor-turn, as shipped) — but the
  walls must stand CLOSER to the manifest items: if they currently
  come in 1/3 of the gap from the edges toward the manifest, they
  should come in 2/3 of the gap, on both sides.
- **Belt: the centred item's documents ride IN the band** (owner):
  when an item seats at the apex, its documents appear as bodies in
  the band beside it — not as a list on the card — made easily seen
  by obvious highlighting: a different-coloured perimeter line around
  them, some sort of glow/pulse, possibly both (owner offered the
  treatments as candidates; try them and show).
- **Solarium is a no, and the v1.3.0 roster is FINAL** (owner, "for
  now, haha!"): the release theme list is star chart, after dark,
  CLOUDS (cloud sea graduates from a dawn treatment to its own
  selectable pack), dawn terminator, and retrograde. Solarium joins
  the records shelf with the other retirees (code and file stay).
  Consequences: the release ships without a true light pack — ruled
  and accepted; "dawn" the pack means the terminator treatment (its
  post-fix form is hereby confirmed in); clouds needs pack tokens, its
  own custom symbols (every-theme-owns-symbols law) and its
  through-the-deck descent ported app-side.
- **Miami is ruled: day drops, dusk keeps on file** (owner): Miami day
  is dropped outright. Miami dusk stays on file as a record — "it's a
  no for now" — not in the release, not built, revisitable. Neither
  enters the roster; #438 closes on this ruling. With atlas, hanami
  and porcelain retired and Miami day dropped, the release ships
  without a true light pack unless solarium is later admitted.
- **Atlas and hanami are officially retired; solarium is reserved**
  (owner): both retire from the RELEASE — their code and files stay, but
  neither ships as a selectable pack in v1.3. Solarium's judgement is
  deliberately reserved. The release roster stands at star-chart, after
  dark, dawn and retrograde, plus whatever the owner later admits from
  the candidates (solarium, Miami day/dusk). Removing atlas from the
  live swatch rosters is a release-build task alongside #480.
- **Hanami is dropped** (owner: "still sucks"): the washi-and-blossom
  direction ends; the v2 file stays as the record. In its place, the
  Miami Beach concept (#438) goes for a spin — a light form (sun-bleached
  sand and stucco, turquoise structure, coral accent, engraved treatment
  per #426) and a dusk form (deep ocean indigo, neon coral and aqua,
  visibly its own thing rather than retrograde re-neoned). Ground first;
  the §15 symbols and scroll-descent laws apply to both.
- **First-run asks three things only** (owner): the first user ever — the
  admin — gives the first system's name, the time zone and the currency.
  Nothing else: sections auto-populate from the defaults, changeable on
  the household screen after the tour. The "you are not the first here"
  notice becomes a see-through card OFF TO THE LEFT with a BIG number —
  "5 systems discovered in this universe already.." — the number real,
  and shown only once the first admin exists. A non-admin newcomer gets
  the card in the MIDDLE — "Where do you belong?" — choosing one of the
  households to ask to join, or the option to name their own system;
  options kept similarly thin, the rest changeable in settings later.
- **The observatory becomes the slit itself** (owner, rejecting the
  polished room as "clunky and clumsy — the basic premise feels like it
  could have real impact but..."): the left and right sides of the
  SCREEN are the shutters, their inner edges near the edges of the
  settings cards; the backdrop behind the cards is the starfield — you
  are looking out of the slit. ALL the linework goes: no instrument, no
  setting circles, no ribs, no log.
- **Belt, second pass** (owner: "GREAT first pass. But..."): the actual
  CARD rides in the belt — no crown asteroid standing in for it; the
  card moves up and sits in the belt itself, with the arc reaching its
  apex at the centre of the screen. The arc is not a literal semicircle
  ("the rainbow was just a description... I could think of at the
  time") — and real asteroid belts are denser and disorderly: make the
  belt WIDER, more items, a scattered band rather than beads on a line.
- **The belt corrected: it is an ITEM belt** (owner, superseding the
  third pass below): #458 was always meant as an alternative way to
  view the MANIFEST — all the household's items together in the band,
  with a search box, in chronological order by renewal/required date
  (direction immaterial; each asteroid sits among its date-neighbours
  from the linear list). But NOT an orderly line — the items are
  jumbled around a little within the band, scattered members that
  happen to run in date order. v2's rock aesthetic was better; the
  v3 paper-document symbols are hated and dead. Documents belong to
  the centred item's card, a click away.
- **Belt, third pass** (owner: "Better... but" — SUPERSEDED above; the
  "document items" here were a misreading of intent): the asteroid belt
  should be made up of document items — LOTS of them, all over the
  place. The band's ambient population reads as tumbling sheets of
  paper at every attitude, not anonymous rocks and dust; the item's
  real documents stay clearly more substantial than the ambient paper.
- **The belt is a rainbow, and the card rides in it** (owner, correcting
  the #458 shape): the documents do NOT orbit the item card. The
  documents nestle in a rainbow-shaped belt — an arc of asteroids — and
  the card itself is one of the asteroids. Clicking an asteroid moves
  the belt so that one comes to the centre and displays. (Display shows
  what Orbit honestly has: details and download until #476's page
  render exists, then the page itself.)
- **Cloud sea is approved too** (owner): both dawn skies are ratified —
  the terminator (with its visibility fix) and the cloud sea with its
  through-the-deck descent. Cloud sea survives as an approved treatment
  for the homescreen-style family rather than retiring; how the two are
  offered (which is dawn's default, where the other is selected) is a
  build-time question for the style selector.
- **Dawn is the terminator, approved — except the crossing must be seen**
  (owner, with screenshot): the diagonal split's position/scale fails in
  practice — "mostly non-existent on a 14-inch laptop, barely shows on a
  32-inch desktop, won't show on mobile at all". The night side must
  occupy a meaningful, always-visible share of the sky at every viewport;
  the seeded variation gets bounded so no roll can hide it. (This also
  resolves the earlier mis-send: the "approved + custom symbols" message
  said solarium but the owner had dawn-terminator open.)
- **Every theme earns its own symbols** (owner): every theme gains real
  character the way retrograde did — custom theme-specific symbols.
  ALL themes carry their own symbol
  vocabulary, EXCEPT star-chart and after dark, which SHARE theirs:
  "they just both look great, they're slight twists on one theme."
  (Hanami's symbol set follows once its base is reviewed.)
- **Every theme's backdrop changes as you scroll away from the dial**
  (owner): the descent law goes universal. Dawn's variants already
  descend; each theme answers in its own vocabulary. For star-chart and
  after dark specifically: the heliosphere lifts up out of sight as you
  scroll down, leaving the plain starfield behind the deep manifest.
- **Porcelain: the palette pleases, the pattern doesn't fit** (owner):
  "the blues, the whites, the gradient, nice, but the pattern just does
  not fit with the starfield." In its place, try a JAPANESE-INSPIRED
  light theme: soft creamy whites, cherry-blossom hues, elegant not
  tacky — the starfield a mix of cherries, plums and pinks. The
  porcelain file stays as the record.
- **The heliosphere is home's default — and home styles become a choice**
  (owner): the sub-identity mockups were a happy misunderstanding (the
  ask had been backdrops for the HOUSEHOLD screen), but the heliosphere
  is kept as the home screen's DEFAULT dressing, and since the route is
  now open, the homescreen style becomes selectable somewhere — a
  second axis beside the theme pack (pack = palette, style = weather).
  Bridge is a no — "not in its current form at least" — it doesn't join
  the selectable styles as drawn (the file stays as the record). Meanwhile
  household-manage is "90% there — the actual form, everything is
  great; the background is the only issue" — its backdrop ideas are
  still owed.
- **Dawn-rays is dropped** (owner): the crepuscular-rays concept is out;
  the dawn decision now sits between terminator and cloud sea, both of
  which gain scroll-descents. The rays file stays as the record.
- **Dawn-cloudsea: nice idea, and its scroll descends too** (owner):
  scrolling down takes you below the cloudline and into more blue hues —
  the deep page reads as under-the-weather altitude, not sky.
- **Home's sub-identity: heliosphere and bridge go to mockup** (owner):
  of the three directions pitched, the living heliosphere (the sun's
  weather) and the bridge view (faint HUD furniture) are to be tried;
  the master-plate margin treatment is not pursued.
- **Two light-theme candidates, and dawn stays** (owner, on the atlas
  succession): Porcelain (cobalt underglaze on glazed white) and Solarium
  (light through frosted glass, etched lines, stained-glass bodies) are
  both to be tried — with the explicit warning that each "will require
  very clever execution to be visually impressive and remain clear...
  do it your way." The inlaid orrery is rejected. Dawn is liked and
  keeps its place; the new pair are additional options, not dawn
  replacements.
- **Household-manage v2 review** (owner, with screenshot): sections moves
  UNDER "the system" card in the left column, and members takes the
  right-hand side instead of sitting below — no awkward unfilled area.
  And the danger line must look like one: request-deletion gets far more
  angry — red, a proper danger zone, not a polite paragraph.
- **Settings is the observatory** (owner, choosing among the three §15
  concepts): "Observatory is the strongest, but it definitely needs a lot
  more polish." The slit-and-instrument room is the direction; the
  cartographer's desk and the gimbal room are set aside (their files stay
  as the record). Polish before any build.
- **The household-management rulings (2a–2m)** (owner, on the first
  drafts): email invitations are deferred as a cleanly isolated later
  package — v1.3 adds members from registered accounts only. Sections:
  the editor is visible to owners (and admins wearing the owner screen),
  never to plain members; their icons and accent marks return to the UI
  (mock to judge). Fields save independently to the eye — "it's more
  human" — while the client quietly sends the bundled command. Hard
  delete is admin-only and appears in no household UI; the
  restore-from-deletion banner lives on the admin panel only. Join
  requests live in household management ONLY — the administration screen
  drops its block; admin surfaces are for admin-only functions, and an
  instance admin needing owner powers simply sees the owner's screen for
  the household selected from the dial (no separate admin variant,
  ever). First-run seeds a generous set of sections — four might not be
  enough; onboarding must not feel bare. Member rows stay single-line
  (instances are small; no joined-date route change). Settings' "Your
  systems" rows become the door into household management. The
  sign-out-everywhere audit stays; and BEFORE any sign-out-all, the user
  should see where they're currently signed in, with the choice of
  signing out just one place — a new server ask. Filed-lane provenance
  keeps riding the inbox's single request.
- **Retrograde is fully approved** (owner): the §15 refresh ships as the
  pack — horizon-grid floor, the mirrored ceiling (gated to tall viewports
  per the honest read, not shrunk), the neon wireframe Tron beacon as this
  pack's north star (classic glint stays elsewhere), the brighter mid-ink
  family, bloom on accents only. pack-retrograde-refresh.html graduates
  from proposal to spec; the treatment migrates into packs.css and the
  home screen fix-both.
- **Atlas is retired** (owner, after the materiality rescue): "we've tried
  to save it" — the aged-paper concept never quite worked as a screen and
  the §15 refresh, though its best version, didn't change that. The pack
  leaves the roster once a replacement is ratified (no interim removal —
  the five swatches stay functional until the successor lands). In its
  place: 1–2 totally different light-theme concepts, to be explored fresh
  — not paper. pack-atlas-refresh.html stays in the tree as the record of
  the rescue attempt.
- **First-run is a launch, not a form** (owner, on the first draft): the
  first-run screen was too plain and it doesn't get its own page — it sits
  ON TOP of the login screen, filled out over the login's dawn. No reveal
  until everything is ready: when the user hits enter and the server
  succeeds (no errors), the screen ACCELERATES UP — away from the dawn of
  the login screen and into the dark of space, colour-matching the default
  theme, a cool trip through impressive visuals, the whole thing lasting
  3–4 seconds — landing on the populated home page. Dwell 3 seconds so the
  demo data can be seen, then the welcome tour (#477) pops up to guide.
  Errors keep you on the form; the launch only fires on success.
  Amended in the same breath: the launch belongs to EVERY successful
  login, not just first-run (first-run simply adds the form stage), and
  logout plays the reverse — it is already the reverse in the family's
  own palette: dawn to log in, dusk to log out. Ascend into your sky on
  arrival; descend into dusk on leaving.
- **Engineering calls**: #298 closed as delivered (plumbing may be large;
  the brains are out and tested); #301 closed on the coverage map (the
  20-run ceremony waived — real flakes recur and get fixed then); #303 and
  #308 closed as overtaken/spent; #235 re-scoped to the server half; #365
  scheduled (v1.3, Phase-4 family); #261 stays open until its live
  break-and-repair drill runs — deferred, not v1.3 critical path.
