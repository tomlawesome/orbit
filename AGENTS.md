# Orbit agent instructions

These repository instructions apply to every automated agent working on Orbit.
The repository is the source of truth; chat history is not.

## Model governance

Broad product planning, architecture, security-model, systems-design, roadmap,
ADR, release-policy, and engineering-baseline work is reserved for **Sol Extra
High**. Only Sol Extra High may materially create, edit, approve, or restructure
the protected planning files listed in `.github/planning-governance.json`.

Implementation subagents use **Luna Extra High** by default. A different
subagent model may be used only after the user gives fresh, explicit approval
for that invocation. Lower-capability models may read protected planning and
implement bounded issues, tests, migrations, and feature documentation, but
must not edit the protected planning set.

Pull requests that modify protected planning files must contain the exact
attestation `Planning-Model: Sol Extra High`. The CI check verifies the
attestation and protected paths. This is a governance control, not
cryptographic proof of model identity; authors must never make a false
attestation.

When Luna Extra High is not available in the current subagent pool, Sol must
write a bounded local prompt under `.agents/handoffs/` and ask the user to
switch the task manually. The prompt must name permitted and protected paths,
forbid remote mutations, define hard stop conditions, require a result file,
and tell Luna exactly when to hand control back for Sol review. Handoff files
are local coordination state and are not committed.

## Delivery workflow

- Start from an issue with a user outcome, acceptance criteria, non-goals,
  security considerations, test plan, operational impact, and closure evidence.
- Use short-lived `codex/` branches and small pull requests. Do not work
  directly on protected branches.
- Write a failing test first for defects and testable new behaviour. Add
  characterization tests before refactors.
- Run fast checks before container and browser checks.
- Do not close an issue until its acceptance evidence is linked.
- Publish candidates only after required checks pass. Test and promote the
  immutable image digest without rebuilding it.
- Never commit credentials, secrets, private keys, tokens, private documents,
  or real personal data.

## Sources of truth

- `docs/v1-charter.md`: supported product and release contract.
- `docs/architecture.md` and `docs/adr/`: current architecture and durable
  decisions.
- `docs/engineering-baseline.md`: evidence-backed capability and gap audit.
- `docs/quality-strategy.md`: test, CI, and definition-of-done policy.
- GitHub issues and milestones: delivery status and prioritisation.
- `docs/feature-register.md`: deferred product direction only, not status.
