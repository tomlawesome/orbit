# Orbit agent instructions

These repository instructions apply to every automated agent working on Orbit.
The repository is the source of truth; chat history is not.

## Model governance

Broad product planning, architecture, security-model, systems-design, roadmap,
ADR, release-policy, and engineering-baseline work is reserved for **Sol Extra
High**. Only Sol Extra High may materially create, edit, approve, or restructure
the protected planning files listed in `.github/planning-governance.json`.

Implementation agents and separate implementation tasks use **Luna Extra
High** by default. A different model may be used only after the user gives
fresh, explicit approval for that invocation. Lower-capability models may read
protected planning and implement bounded issues, tests, migrations, and
feature documentation, but must not edit the protected planning set.

Pull requests that modify protected planning files must contain the exact
attestation `Planning-Model: Sol Extra High`. The CI check verifies the
attestation and protected paths. This is a governance control, not
cryptographic proof of model identity; authors must never make a false
attestation.

When Luna Extra High is not available in the current subagent pool, Sol must
use the Codex task launcher, when available, to create a separate user-visible
task on Luna Extra High automatically. Start it in a dedicated worktree from
the exact accepted base, give it the bounded handoff, and let it make focused
local commits without pushing or changing GitHub state. Sol retains
architecture, security decisions, integration review, protected CI, and
delivery sequencing; it must inspect and integrate the Luna result before
publication.

Do not ask the user to switch the current task manually merely because Luna is
absent from the subagent pool. Manual switching is a fallback only when the
separate-task launcher is also unavailable or has failed with a genuine hard
block. In either path, write the bounded prompt under `.agents/handoffs/`. The
prompt must name permitted and protected paths, forbid unapproved remote
mutations, define hard stop conditions, require a result file, and tell Luna
exactly when to hand control back for Sol review. Handoff files are local
coordination state and are not committed.

## Orchestration and retained learning

Before any delivery mutation, read and obey
`docs/orchestration-runbook.md` and
`.github/orchestration-governance.json`. Run
`pnpm orchestration:check` when dependencies are available.

Model authority is a preflight gate, not a review-time correction. All
orchestration—including task launch, monitoring, sequencing, reconciliation,
blocker classification, handback acceptance and retained-learning
promotion—proceeds only under Sol Extra High. Terra may read protected
planning for orientation or perform separately bounded mechanical analysis,
but it cannot operate the delivery loop, make status or next-action decisions,
or materially create, edit, approve, restructure or publish protected
planning. Luna performs bounded implementation and hands control back to Sol.

A successful asynchronous task-creation response establishes
`launch_pending`. Omission from a partial, limited, paginated, stale or
differently shaped task list never proves creation failure. Confirm the real
task ID, requested model, worktree and state through a full task listing,
direct task read or bounded task wait before advancing or retrying creation.

Capture operational contradictions as safe local candidate lessons. Durable
controls are recorded in `docs/orchestration-controls.json` only after the
evidence, issue, model-authority, regression-test, protected-PR and CI gates in
the orchestration runbook pass. Automation must never self-adopt product,
architecture, security, model-governance, repository-setting, protected
planning or release-policy changes.

## Delivery workflow

- Start from an issue with a user outcome, acceptance criteria, non-goals,
  security considerations, test plan, operational impact, and closure evidence.
- Use short-lived `codex/` branches and small pull requests. Do not work
  directly on protected branches.
- Write a failing test first for defects and testable new behaviour. Add
  characterization tests before refactors.
- Run fast checks before container and browser checks.
- Do not close an issue until its acceptance evidence is linked.
- Publish previews or release candidates only after required checks pass.
  Reserve release-candidate status for a feature-complete release scope. Test
  immutable image digests and promote only an accepted release-candidate digest
  without rebuilding it.
- Never commit credentials, secrets, private keys, tokens, private documents,
  or real personal data.

## Sources of truth

- `docs/v1-charter.md`: supported product and release contract.
- `docs/architecture.md` and `docs/adr/`: current architecture and durable
  decisions.
- `docs/engineering-baseline.md`: evidence-backed capability and gap audit.
- `docs/quality-strategy.md`: test, CI, and definition-of-done policy.
- GitHub issues and milestones: delivery status and prioritisation.
- `docs/feature-register.md`: detailed product direction and constraints, not
  live delivery status.
