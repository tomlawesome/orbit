# Orbit agent instructions

These repository instructions apply to every automated agent working on Orbit.
The repository is the source of truth; chat history is not.

## Model governance

Orbit recognises two peer agent pipelines with equivalent authority tiers. Each
pipeline declares its tiers in `.github/orchestration-governance.json`, and
authority is derived from those declarations rather than hardcoded, so admitting
a pipeline is a reviewed data change.

| Role | Codex | Claude |
| --- | --- | --- |
| Orchestration and protected planning | Sol Extra High | Claude Opus Extra High |
| Bounded implementation | Luna Extra High | Claude Sonnet Extra High |
| Mechanical analysis | Terra Medium | Claude Sonnet Extra High |

Broad product planning, architecture, security-model, systems-design, roadmap,
ADR, release-policy, and engineering-baseline work is reserved for an
**orchestration tier**: Sol Extra High or Claude Opus Extra High. Only an
orchestration tier may materially create, edit, approve, or restructure the
protected planning files listed in `.github/planning-governance.json`.

Implementation agents and separate implementation tasks use the **implementation
tier** of the active pipeline: Luna Extra High under Codex, Claude Sonnet Extra
High under Claude. A different model may be used only after the user gives
fresh, explicit approval for that invocation. Lower-capability models may read
protected planning and implement bounded issues, tests, migrations, and
feature documentation, but must not edit the protected planning set.

Pull requests that modify protected planning files must contain exactly one
accepted attestation line from `.github/planning-governance.json`:
`Planning-Model: Sol Extra High`, `Planning-Model: Claude Opus Extra High`, or
`Planning-Model: Human` when a human owner authored or directed the change. The
CI check verifies the attestation and protected paths. This is a governance
control, not cryptographic proof of model identity; authors must never make a
false attestation, and must never attest as a pipeline, tier or authority that
did not do the work.

When the active pipeline's implementation tier is unavailable in the current
subagent pool, the orchestration tier must use that pipeline's task launcher,
when available, to create a separate user-visible task on the implementation
tier automatically. Start it in a dedicated worktree from the exact accepted
base, give it the bounded handoff, and let it make focused local commits without
pushing or changing GitHub state. The orchestration tier retains architecture,
security decisions, integration review, protected CI, and delivery sequencing;
it must inspect and integrate the implementation result before publication.

Do not ask the user to switch the current task manually merely because the
implementation tier is absent from the subagent pool. Manual switching is a
fallback only when the separate-task launcher is also unavailable or has failed
with a genuine hard block. In either path, write the bounded prompt under
`.agents/handoffs/`. The prompt must name permitted and protected paths, forbid
unapproved remote mutations, define hard stop conditions, require a result file,
and tell the implementation agent exactly when to hand control back for
orchestration review. Handoff files are local coordination state and are not
committed.

## Cross-pipeline conduct

Both pipelines work in one repository, so provenance and boundaries must stay
unambiguous.

- Branch namespaces are reserved: Codex uses `codex/`, Claude uses `claude/`.
  Never push to the other pipeline's namespace.
- Every pull request identifies the authoring pipeline. Preserve commit
  authorship; never rewrite another pipeline's authorship or attestation.
- Do not force-push, rebase, amend, reopen, close or delete another pipeline's
  branch or pull request. Request the change through an issue or pull-request
  comment and let that pipeline, or the user, act on it.
- Reviewing across pipelines is expected and encouraged. Report findings as
  issues or pull-request review comments, or as a fix branch in your own
  namespace; do not commit a fix onto the reviewed branch.
- When both pipelines hold open work on the same issue or overlapping paths,
  the earlier-opened pull request holds precedence. The later one narrows its
  scope, rebases, or waits, and records that coordination in the issue.
- A handoff between pipelines is explicit. The receiving pipeline confirms the
  issue, accepted base SHA, permitted paths and stop conditions before it
  mutates anything, exactly as for a handoff inside one pipeline.
- Neither pipeline may change the other's authority, tiers, or the protected
  path set on its own. Model-governance changes follow the protected issue and
  pull-request path with a valid attestation.

## Orchestration and retained learning

Before any delivery mutation, read and obey
`docs/orchestration-runbook.md` and
`.github/orchestration-governance.json`. Run
`pnpm orchestration:check` when dependencies are available.

Model authority is a preflight gate, not a review-time correction. All
orchestration—including task launch, monitoring, sequencing, reconciliation,
blocker classification, handback acceptance and retained-learning
promotion—proceeds only under an orchestration tier. A mechanical-analysis tier
may read protected planning for orientation or perform separately bounded
analysis, but it cannot operate the delivery loop, make status or next-action
decisions, or materially create, edit, approve, restructure or publish protected
planning. An implementation tier performs bounded implementation and hands
control back to its orchestration tier.

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
- Publish previews only after required checks pass. Stable release acceptance
  uses a preview from the matching versioned release branch. Test immutable
  image digests and promote only the accepted digest without rebuilding it.
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
- `docs/releasing.md`: release procedure and operator acceptance.
- `SECURITY.md`: supported-version and private vulnerability-reporting
  contract.
