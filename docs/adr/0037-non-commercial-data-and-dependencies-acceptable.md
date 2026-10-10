# ADR-0037: Non-commercial data and dependencies are acceptable in Orbit

**Status:** Accepted (owner, 2026-09-15)
**Date:** 2026-10-10 (recorded; the ruling is 2026-09-15)
**Relates to:** the dependencies-and-data skill's licence review (which this
overrides for one question only); [ADR-0025](0025-local-model-extraction.md)
(model extraction); #1374 (slimming `AGENTS.md`, where the ruling used to live)

## Context

The shared licence review asks, before adopting any dependency or dataset, that
its licence be inspected and recorded, and warns that a dependency or dataset
the project does not own may carry obligations that prevent sublicensing it
under commercial terms. That concern assumes the project might one day be
offered commercially.

Orbit's extraction work leans on external datasets and models, and many of the
useful ones are licensed non-commercially (CC BY-NC, CC BY-NC-SA). Reading the
review literally would rule them out, to protect a commercial option the owner
does not want. The owner decided on 2026-09-15: "Non commercial is usable here.
I am happy to ditch the possibility of an orbit commercial license."

## Decision

**Orbit will not be offered commercially, so a non-commercial dataset, model or
dependency may be used.** A CC BY-NC or CC BY-NC-SA source is not refused for
that clause alone.

Everything else in the licence review still applies:

1. **Record the exact licence** of every source adopted, as before.
2. **Share-alike still binds** anything the project redistributes. The project
   is AGPL-3.0-or-later, which makes a share-alike clash likelier than it
   sounds; check it per source.
3. **A source whose licence obliges us to publish or redistribute anything is
   not used at all**, whatever else it offers (owner, 2026-09-15, on collected
   documents: they stay out of the repository; see
   [Extraction method](../extraction-method.md)).

## Consequences

- The "might prevent a commercial licence" test is dropped for Orbit; the
  other licence checks are unchanged.
- If Orbit were ever offered commercially, every non-commercial source adopted
  under this ADR would have to be re-examined; the licence records kept under point 1 are what
  make that possible.

## Alternatives rejected

- **Apply the commercial-readiness test anyway.** Excludes useful sources to
  protect an option the owner has given up.
- **Allow non-commercial sources without recording them.** The licence record
  is what makes a later re-examination possible.
