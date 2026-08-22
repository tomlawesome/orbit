# ADR-0012: The front end leaves React for SvelteKit

**Status:** Accepted
**Date:** 2026-08-15
**Relates to:** [ADR-0011](0011-operator-experience-as-product.md) (operator
experience as product), issues #408, #411

## Context

Orbit's web front end was Next.js and React, and a ratified design — nineteen
mockup iterations, distilled in `design/owner-decisions.md` and
`design/polish-register.md` — was to be implemented on it.

That attempt was reverted in full (#408). The failure was not a lack of skill
or effort, and it is worth stating precisely, because the diagnosis is the
whole reason for this decision.

Builders were told to preserve the existing application and keep its tests
green. Those tests encoded the old copy and the old structure, so the old
markup survived and the new artwork was painted behind it. The ratified
sign-in is three elements; what shipped re-added a tagline, a headline and a
privacy paragraph, and reworded the button. The section list was put back into
the account panel *because* the design omitted it — overruling the design in
order to preserve a working feature.

Underneath the process failure sat a mechanical one. Translating a mockup into
JSX is a **retyping** step: a human or a model reads HTML and CSS and writes
different symbols that are supposed to mean the same thing. Every retyping is
an opportunity to lose a letter-spacing value, a hex code, a word of copy, or
an element. Nothing detects the loss, because nothing is comparing the output
to the design. The design does not die in one decision; it dies in two hundred
small ones.

## Decision

The front end is rebuilt from the ratified mockups on **SvelteKit**, and Next
and React are removed.

The choice of framework follows from one property above all others: **a Svelte
component is HTML with real class attributes and a real stylesheet**. The
mockup's markup and its CSS move across as *files*, not as somebody's retyping
of them. `web/scripts/scaffold-screen.mjs` lifts a mockup's `<style>` block and
`<body>` markup byte for byte into a `.css` file and a `.svelte` file. The
retyping step — the step where the design died — is removed rather than
performed more carefully.

Two supporting decisions make that durable:

- **The design is verified mechanically.** A screen is compared to its own
  mockup pixel by pixel at a declared viewport with animations frozen, and must
  match before it earns a recorded baseline. This is the check that did not
  exist when the previous attempt was reverted: the app was compared only
  against itself, so a screen could be green while missing an entire sky.
- **The old front end is not an input to any decision.** Its markup, its CSS,
  its components and its tests are not the specification and are not consulted.
  The mockup is the specification for the markup — structure, class names, copy
  and controls.

## Consequences

**Accepted costs.**

- Two frameworks coexist until the cut. Next continues to serve the product and
  the 35 API routes while the new front end is built alongside it, unreferenced
  by any Dockerfile, compose file or workflow.
- The cut itself is real work: porting the routes and auth shims off Next,
  deleting it, and re-solving container packaging — `pdfjs-dist` and
  `@napi-rs/canvas` are currently resolved through `.next/standalone` and must
  be re-solved for `adapter-node` output. It reaches the installer and
  `orbit-launcher`, and lands as one clean cut on a branch (#411 phase E).
- Roughly 5,700 lines of React across 34 components are deleted, and the
  capabilities they carried that no mockup draws do not come with them. Those
  are recorded on #410 as a deferred backlog, not a discard pile.
- The React implementation of the design slices (#325, #326, #327) is
  superseded. It was not wasted: it served as the reference for the rebuild.

**What is gained.**

- The design arrives intact and stays intact, enforced by a red build rather
  than by vigilance. Nine screens reproduce their mockups at or near zero
  differing pixels.
- The distance between a design change and its implementation is a file copy.
- Server-rendered markup with no framework runtime on the signed-out surface;
  the sign-in is prerendered static and reaches no database and no session.

**What this does not change.**

The server, the data model, authentication, the workers, the installer and the
engine are untouched by the rebuild. `pnpm test` and `pnpm test:integration`
stay green throughout, and the API surface is kept intact — including routes
nothing calls yet, which are cheap to keep and expensive to reconstruct.

## Alternatives considered

- **Try again on React, more carefully.** Rejected: the failure mode was
  structural, not a lapse in care. Retyping remains retyping, and nothing in
  the toolchain would have detected the next two hundred small losses.
- **Adopt the design as a token layer over the existing components.** This is
  what #408 did. It is what produced a sign-in with a tagline the design had
  removed.
- **Astro, or plain server-rendered templates.** Both can hold the markup
  literally. SvelteKit was preferred for having a first-class client runtime
  for the parts of this design that are genuinely interactive — the chart, the
  galaxy, the flights — without a second framework alongside it.
