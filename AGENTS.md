# Orbit agent instructions

These repository instructions apply to every automated agent working on Orbit,
alongside the global agent instructions.

## Working model

Orbit is maintained by its human owner with AI assistants working under
direction. Architecture and security decisions are recorded in ADRs and
reviewed by the owner; the durable governance decision is
[ADR-0011](docs/adr/0011-operator-experience-as-product.md).

## Delivery workflow

- Start from an issue with a user outcome, acceptance criteria, non-goals,
  security considerations, test plan, operational impact, and closure evidence.
- Write a failing test first for defects and testable new behaviour. Add
  characterization tests before refactors.
- Run fast checks before container and browser checks.
- Do not close an issue until its acceptance evidence is linked.
- Publish previews only after required checks pass on the protected `preview`
  lane. Test immutable image digests, verify the exact preview source through
  `main`, and promote only the accepted digest without rebuilding it.

## Sources of truth

- `docs/v1-charter.md`: supported product and release contract.
- `docs/architecture.md` and `docs/adr/`: current architecture and durable
  decisions.
- `docs/implementation-plan.md`: the phased roadmap.
- The [Orbit Roadmap project board](https://github.com/users/tomlawesome/projects/4)
  is the live delivery-status surface: per-issue Status, Slice, Priority, Risk
  and Delivery lane. GitHub milestones remain the release grouping and are
  mirrored by the board's Slice field (owner decision, issue #502).
- `docs/engineering-baseline.md`: evidence-backed capability and gap audit.
- `docs/quality-strategy.md`: test, CI, and definition-of-done policy.
- `docs/feature-register.md`: detailed product direction and constraints, not
  live delivery status.
- `docs/releasing.md`: release procedure and operator acceptance.
- `SECURITY.md`: supported-version and private vulnerability-reporting
  contract.
