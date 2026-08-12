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


## Concepts (captured, not yet product scope)

| ID | Name | Concept | Status |
| --- | --- | --- | --- |
| CON-1 | Belts = documents | A belted planet carries attached documents; clicking the belt opens the document view from the dial | ratified by owner 2026-08-13; in v11 |
| CON-2 | Sub-systems & zoom | Assets (a car, a boiler, a property) as small orbital systems with their own centre; clicking the centre zooms into that asset's own dial | **approved in concept** 2026-08-13; click model = CON-5 |
| CON-3 | Type language | All-circular (owner: everything is a planet): ● service · ◉ concentric = renewal · ◐ terminator = inspection · ○ hollow = suggestion | **approved**, in v12 (diamond/triangle removed) |
| CON-4 | Ambient count | The urgent count lives in the tab title and PWA app badge, never on the sky | **approved** 2026-08-13 |
| CON-5 | Click grammar | Simplified and **approved**: exactly one clickable thing per body — the planet (= approach; zoom for system centres). Everything else lives in the hover callout (documents chip etc.). Belts are passive badges. Touch: first tap = callout, second = approach | **approved**, in v12 |
| CON-6 | Household constellation | Other households live in the backdrop as small dimmed living systems with cartographer annotations (rule under the name, veering to the system); clicking one zooms it to the centre and the previous main recedes | **approved**, canned transition in v12; dimmed status colours for at-a-glance cross-household health |
| CON-7 | Drawers | Bounded status drawer from the left (container states + health checks, enums only — never versions/ports/paths/errors); the key as a list-drawer from the right | in v12 |
| CON-8 | Planet light | Specular highlight facing the sun, soft atmospheres in status colour, inner sheen on suggestions | in v12 |

| CON-9 | Page family personalities | One identity, distinct motion per page: login = approach (streaming stars) · 404 = adrift (still sky, tumbling body, beacon) · maintenance = dormant (ember sun, scaffolding ring) · admin = observatory (instrumented, telemetric) · create = genesis (nebula condenses into a world) · settings-mail = relay (signal rings) | in v13 |
| CON-10 | Mobile dialect | The dial owns the width; callouts/drawers/doc panel become bottom sheets (first tap = sheet, second = approach); households collapse into the other-skies strip | in v13 |

Removal procedure: delete the POL-n blocks from the current mockup/product
code, flip the row to `removed (date, reason)`. Keep the row — the register
is the memory of what was tried.
