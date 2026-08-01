# Orbit agent instructions

These repository instructions apply to every automated agent working on Orbit.
The repository is the source of truth; chat history is not.

## Model governance

**Sol Extra High is Orbit's sole orchestration and protected-planning
authority.** Sol owns product planning, architecture, security decisions,
roadmaps, ADRs, release policy, repository settings, delivery sequencing,
integration, publication and release. Only Sol may materially create, edit,
approve or restructure the protected planning paths listed in
`.github/planning-governance.json`.

Human-owner protected planning remains valid when it is genuinely human
authored or directed. Pull requests that change protected planning must contain
exactly one accepted attestation line from the planning policy:
`Planning-Model: Sol Extra High` or `Planning-Model: Human`. This is a
governance control, not cryptographic proof; never attest as an authority that
did not do the work.

Bounded implementation is routed by demonstrated task-class capability and
cost, in this order:

1. a local Ollama host and exact model qualified for the task class;
2. a qualified Mistral model as the primary paid provider;
3. a qualified Claude model as the paid fallback; and
4. Luna Extra High only when the preceding providers are unqualified,
   unsuitable, unreachable or out of capacity.

A theoretical model size, successful toy prompt or provider subscription is not
qualification. Representative evidence must cover correctness, hidden edge
cases, path and instruction scope, result honesty and context fit.
Qualification records the exact provider, model and task class, plus the exact
host for local Ollama. Cost, latency, resource use and provider capacity inform
routing and circuit breakers; crossing a heuristic local limit does not
disqualify otherwise correct work unless the task has an explicit budget. An
unqualified model receives no real Orbit implementation work. Select the
lowest-cost model that has actually passed the relevant gate.

For each model and representative task class, stop qualification as soon as
the result is satisfactory and never exceed five passes. A model that has not
reached basic acceptance by pass three is unsuitable for that task class.
Passes four and five may only fine-tune already acceptable behavior.

Every delegated implementation uses an exact accepted base, a dedicated clean
worktree, least-privilege tools, an explicit changed-path allowlist, bounded
scope, a required result handback and independent Sol validation. Do not impose
routine token, price or turn quotas: completion and correctness govern the
task. Detect a genuine runaway from task- and model-appropriate time to first
useful output or time since meaningful progress, with a reasonable
benefit-of-the-doubt buffer. Slow useful work is not stalled.
Delegated providers may not plan, orchestrate, make architecture or security
decisions, integrate, publish, release, access GitHub or approve their own work.
They make focused local changes and return control to Sol.

Claude is an implementation resource, not a peer project-management pipeline.
Claude Opus-class secondary review may be useful, but each invocation requires
fresh user approval and its output is advisory evidence for Sol; it grants no
planning, security, approval or delivery authority. Historical controls
approved under the superseded dual-pipeline policy remain evidence only where
the orchestration policy explicitly enumerates their pull requests.

When Luna is the evidenced last resort and is absent from the current subagent
pool, Sol uses the task launcher, when available, to create a separate
user-visible Luna Extra High task in a dedicated worktree from the exact
accepted base. In every delegated path, write the bounded prompt under
`.agents/handoffs/`; name permitted and protected paths, forbid remote
mutations, define hard stops, require a result file, and state when control
returns to Sol. Handoff files are local coordination state and are not
committed.

## Orchestration and retained learning

Before any delivery mutation, read and obey
`docs/orchestration-runbook.md` and
`.github/orchestration-governance.json`. Run
`pnpm orchestration:check` when dependencies are available.

Model authority is a preflight gate, not a review-time correction. All
orchestration—including task launch, monitoring, sequencing, reconciliation,
blocker classification, handback acceptance and retained-learning
promotion—proceeds only under Sol Extra High. Terra may read protected planning
for orientation or perform separately bounded mechanical analysis, but it
cannot operate the delivery loop, make status or next-action decisions, or
materially create, edit, approve, restructure or publish protected planning.
Implementation providers perform only their bounded slice and hand control back
to Sol.

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
