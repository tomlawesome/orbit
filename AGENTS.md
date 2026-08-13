# Orbit agent instructions

These repository instructions apply to every automated agent working on Orbit.
The repository is the source of truth; chat history is not.

## Working model

Orbit is maintained by its human owner with AI assistants working under
direction. Assistants make focused changes on short-lived branches and hand
control back for human review. No assistant approves or merges its own work,
changes repository or branch-protection settings, publishes releases, or
rewrites accepted history. Architecture and security decisions are recorded in
ADRs and reviewed by the owner; the durable governance decision is
[ADR-0011](docs/adr/0011-operator-experience-as-product.md).

## Delivery workflow

- Start from an issue with a user outcome, acceptance criteria, non-goals,
  security considerations, test plan, operational impact, and closure evidence.
- Use short-lived branches and small pull requests. Do not work directly on
  protected branches.
- Write a failing test first for defects and testable new behaviour. Add
  characterization tests before refactors.
- Run fast checks before container and browser checks.
- Do not close an issue until its acceptance evidence is linked.
- Publish previews only after required checks pass on the protected `preview`
  lane. Test immutable image digests, verify the exact preview source through
  `main`, and promote only the accepted digest without rebuilding it.
- Never commit credentials, secrets, private keys, tokens, private documents,
  or real personal data.

## Sources of truth

- `docs/v1-charter.md`: supported product and release contract.
- `docs/architecture.md` and `docs/adr/`: current architecture and durable
  decisions.
- `docs/implementation-plan.md`: the phased roadmap; GitHub milestones and
  issues own live delivery status.
- `docs/engineering-baseline.md`: evidence-backed capability and gap audit.
- `docs/quality-strategy.md`: test, CI, and definition-of-done policy.
- `docs/feature-register.md`: detailed product direction and constraints, not
  live delivery status.
- `docs/releasing.md`: release procedure and operator acceptance.
- `SECURITY.md`: supported-version and private vulnerability-reporting
  contract.
