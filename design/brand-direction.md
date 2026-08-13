# Orbit brand and web UI direction

**Status:** Proposal for owner review (issue #307). Nothing here is
implemented; the mockups beside this document are the deliverable to argue
with.

## The idea

Orbit's founding purpose: every household runs on tasks that orbit it
through the year — the boiler service, the insurance renewal, the MOT, the
warranty cliff. They circle whether or not anyone watches. Orbit pulls them
into one calm view and keeps them on track.

The identity takes that literally: **the year is the orbit.** One ring,
twelve months, and the household's obligations as small bodies moving around
it. A task's due date is its perihelion — its closest approach. The same
object is the logo, the dashboard's centre, and the explanation of what the
product does. Nothing else in the interface needs to shout, because the
central metaphor is doing the communicating.

Inherited from the orbit-launcher design work (v2–v5), as themes rather than
specifics: the deep-space stillness ("the universe holds still — you
drift"), continuity ("you never leave the ship" — no jarring context
switches), and the lesson recorded in its own archive: the orbital-system
*embellishments* did not survive contact with reality. The web UI takes the
palette, the calm, and the restraint — not the starfield.

## Principles

1. **One calm surface.** A single content column, one top bar, no sidebar.
   Every screen answers "what needs me next?" before anything else.
2. **The ring is the only ornament.** Glow, motion, and decoration budget is
   spent on the year-ring alone; everything else is quiet panels and type.
3. **Position first, colour second.** Urgency is encoded by position on the
   ring and order in the list; status colours reinforce, always with a text
   label — never colour alone.
4. **Mono is memory.** Dates, amounts, and identifiers set in the mono stack
   as a deliberate echo of the launcher heritage; prose never is.
5. **Semi-automation reads as suggestions, not actions.** Anything Orbit
   inferred (recurrence, document suggestions) is visually a *proposal* —
   dashed border, explicit accept — matching the product's review-first
   security posture.

## Palette

Dark is the identity theme; light is a derived theme, not an inversion.

| Token | Value | Role |
| --- | --- | --- |
| `bg` | `#05070d` | page depth |
| `bg-panel` | `#0b0f1a` | cards, surfaces |
| `border` | `#1c2434` / `#151b28` | hairlines |
| `text` | `#e7e9ee` | primary ink |
| `text-muted` | `#7c8699` | secondary ink |
| `text-faint` | `#4a5468` | tertiary ink |
| `accent` | `#7dd3fc` | identity, interactive, "upcoming" |
| `ok` | `#4ade80` | on track |
| `warm` | `#f0b429` | due soon |
| `overdue` | `#f87171` | overdue |

Status set validated (dataviz six-checks, dark surface `#0b0f1a`): CVD
separation, normal-vision floor, chroma, and contrast all pass. The
lightness-band check flags these as brighter than a categorical series
should be — deliberate: they are identity-inherited *status* colours, always
paired with position and a text label, never a categorical series. The old
orange `#fb923c` tier is retired: it was inseparable from amber for
deuteranopic readers (ΔE 4.8).

Typography: `Inter` (system-ui fallback) for interface prose;
`JetBrains Mono` (`ui-monospace` fallback) for dates, amounts, identifiers.

## The mark

Three concepts in `mockups-brand.html`; the recommendation is **A, the
year-ring**: a thin ring of twelve month ticks, one task-body glowing at
perihelion. It is the product thesis drawn as a glyph, survives 16px as
ring-plus-dot, works single-colour, and the dashboard hero is literally the
logo at full size — brand and interface are the same object. Concept B
(orbital O wordmark) supplies the wordmark treatment; C (refined current
arcs) is the conservative fallback preserving today's mark's gesture.

The current three-arc, three-colour mark (`public/orbit-mark.svg`) reads
playful and bright — a different product than the launcher's night-sky
calm. The two surfaces should feel like one system the moment an operator
moves from installing to using.

## Application

`mockups-web.html` shows the system: Due Next (the home), an item detail,
and the quiet chrome. Layout rules the mockups encode: 1100px content
column; 8px spacing grid; panels are `bg-panel` with `border` hairlines and
12px radius; stat tiles are hero-number form (no sparkline noise); the list
is the authority and the ring is its map — both always visible on desktop,
ring collapses to a strip on mobile.

## What this is not

No feature changes; no light-theme finalisation (derived later from the
same tokens); no replacement of the five in-app colourways yet — the
disposition of the appearance system belongs to the #308 review. If the
direction is approved, implementation follows the #307 plan: tokens first,
then page-by-page slices behind existing e2e coverage.
