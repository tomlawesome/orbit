# Design polish register

Every polish behaviour in the mockups (and later the product) is a named,
individually-removable unit. In mockup code each is delimited by
`/* POL-n: name */ ... /* /POL-n */` blocks (CSS and JS) and
`data-polish="POL-n"` attributes (markup), so removing one is deleting its
blocks — nothing else touches it. Status changes are recorded here, never
silently.

| ID | Name | What it does | Status |
| --- | --- | --- | --- |
| POL-1 | Arrival | Mark glyph expands into the dial on first load; once per session; reduced-motion skips | queued for v9 |
| POL-2 | Perihelion ping | Faint radar-ripple per breath once a body crosses T−7d | queued for v9 |
| POL-3 | Current-month glow | The present month's label reads a shade brighter | queued for v9 |
| POL-4 | Bidirectional highlight | Hover a manifest row ↔ its dial body lights up | queued for v9 |
| POL-5 | Constellations | Hovering a section header draws its bodies' constellation lines | queued for v9 |
| POL-6 | Chart callout | Glass-backed, 13.5px, quadrant-aware placement so the leader never crosses the cluster | revised in v10 |
| POL-7 | Restored orbit | Completing an item drifts its body outward with a brief comet trail | queued for v9 |
| POL-8 | The quiet state | Rewritten in v10: no words — danger fades, sun warms, stars thicken and twinkle, slow meteors | in v10 |
| POL-9 | Command palette | explore-your-world field focuses on ⌘K; matches items and actions | queued for v9 |

| POL-10 | Storm state | Heavy load un-calms the sky: faster turbulent drift, deepened danger well, pulsing threshold, cooled sun | added in v10 |
| POL-11 | Constant drift | The home starfield never sits still: two depth layers on slow ease-in-out alternate drifts (210s/130s) with slight vertical component — the sense of floating in space, behind the chart; reduced-motion stills it | in v17 |
| POL-12 | Drawers retract on scroll | Scrolling down animates every open drawer (left/right/top) back to its closed edge; scrolling up leaves them alone | in v17 |
| POL-13 | The light stack | Craft standard for atmosphere pages (login, maintenance, 404s): every bright body is layered (core + blurred halos), edges are noise-displaced (feTurbulence + feDisplacementMap), whole-frame film grain, several slow animations on distinct periods so nothing beats in sync, depth via differential blur, vignette | in v17 |


## Concepts (captured, not yet product scope)

| ID | Name | Concept | Status |
| --- | --- | --- | --- |
| CON-1 | Belts = documents | A belted planet carries attached documents; clicking the belt opens the document view from the dial | ratified by owner 2026-08-13; in v11 |
| CON-2 | Sub-systems & zoom | Assets (a car, a boiler, a property) as small orbital systems with their own centre; clicking the centre zooms into that asset's own dial | **approved in concept** 2026-08-13; click model = CON-5 |
| CON-3 | Type language | All-circular (owner: everything is a planet): ● service · ◉ concentric = renewal · ◐ terminator = inspection · ○ hollow = suggestion | **approved**, in v12 (diamond/triangle removed) |
| CON-4 | Ambient count | The urgent count lives in the tab title and PWA app badge, never on the sky | **approved** 2026-08-13 |
| CON-5 | Click grammar | Simplified and **approved**: exactly one clickable thing per body — the planet (= approach; zoom for system centres). Everything else lives in the hover callout (documents chip etc.). Belts are passive badges. Touch: first tap = callout, second = approach | **approved**, in v12 |
| CON-6 | Household constellation | Other households live in the backdrop as small dimmed living systems with cartographer annotations (rule under the name, veering to the system); clicking one FLIES THE VIEWPORT to it — parallax camera, world slides opposite, target grows (v14 rework per owner) | **approved**; dimmed status colours for at-a-glance cross-household health |
| CON-7 | Drawers | Bounded status drawer from the left with edge words as the system (v15): left handle always present — status (green) / degraded (amber) / offline (red); right handle reads key; both ride their drawers; the key orb is retired | in v15 |
| CON-8 | Planet light | Specular highlight facing the sun, soft atmospheres in status colour, inner sheen on suggestions | in v12 |

| CON-9 | Page family personalities | One identity, distinct motion per page: login = first light (v16): the dawn breaks once on load, horizon at the floor, travelling rim shimmer, the name alone as hero — no strapline by owner decision · 404 = the derelict (giant charted numerals behind; home burns warm at centre; derelict always passes behind; v15) · maintenance = the corona, properly (v16): blended straight/wavy/fine crowns at three speeds, message inside the disc in the display face, living background · admin = observatory (instrumented, telemetric) · create = genesis (nebula condenses into a world) · settings-mail = relay (signal rings) | in v13 |
| CON-10 | Mobile dialect | The dial owns the width; callouts/drawers/doc panel become bottom sheets (first tap = sheet, second = approach); households collapse into the other-skies strip | in v13 |

| CON-11 | The strapline | "your year, in orbit" — for surfaces that want words (README, launcher splash, brand sheet); the login carries none: the hero is the name | **approved** 2026-08-13 |

| CON-12 | The north star | Creation lives in the sky: one star at top centre, slightly brighter with a four-point glint; hover names it (create); click slides a full-width top drawer down (entry types as circular chips, a document drop-target, link to the full form). The star is the drawer's handle and rides the slide — the fourth edge word. Drag a file onto the star = straight into the document flow | in v17, per owner direction 2026-08-11 |
| CON-13 | The fixed galaxy | Households are permanent coordinates in a shared map (product cap: a user belongs to at most 5). You never see your own constellation — you're inside it. Flying moves the CAMERA: the starfield streams with parallax (each household owns an absolute sky offset, so flights animate between truths and never snap), the destination holds its bearing and grows, and after arrival the departed home appears on the reverse bearing. Backdrops clamp to the visible sky along true bearings, dim with distance, and relax apart when narrow viewports fold bearings together | in v17; supersedes the v14/15 swap behaviour per owner: "it's a constellation in a galaxy with its own place" |
| CON-14 | 404, three ways | Owner wants all three built to choose from: (1) gravity well — the black hole is the 0, lensed arch, Doppler disc, spaghettified inner 4, infalling page debris; (2) conjunction — the 0 is a ring planet, the 4s orbit off-axis and tumble, aligning legibly every 20s, line: "Not in this world…"; (3) uncharted — past the survey limit the digits are a constellation labelled in the chart's own grammar, with a plotted course home. Option: ship one, rotate the others as easter eggs | all three in v17; decision pending |
| CON-15 | Totality | Maintenance is a total eclipse: the corona only a black sun can show (physics justifies the awe), eclipse-dark sky with daytime stars and a 360° horizon sunset, the moon's transit doubles as the progress bar, and service returning is the diamond-ring flash flooding the page with light. Copy is three words: "maintenance — back soon" | in v17; replaces the v16 bright-sun corona |
| CON-16 | Status colour truth | degraded gets its own orange token (--degraded), clearly hotter than the gold accent so it never reads as normal; the key handle wears plain ink; the right-edge handle keeps its type clear of overlay scrollbars | in v17 |

Removal procedure: delete the POL-n blocks from the current mockup/product
code, flip the row to `removed (date, reason)`. Keep the row — the register
is the memory of what was tried.
