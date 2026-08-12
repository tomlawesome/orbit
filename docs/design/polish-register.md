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
| POL-6 | Chart callout | Hover tooltip as a star-chart annotation: title + T±d + cost, thin leader line | queued for v9 (owner item) |
| POL-7 | Restored orbit | Completing an item drifts its body outward with a brief comet trail | queued for v9 |
| POL-8 | The quiet state | Nothing due → centre reads "All quiet. Next approach in Nd." | queued for v9 |
| POL-9 | Command palette | explore-your-world field focuses on ⌘K; matches items and actions | queued for v9 |

Removal procedure: delete the POL-n blocks from the current mockup/product
code, flip the row to `removed (date, reason)`. Keep the row — the register
is the memory of what was tried.
