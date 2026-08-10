# Orbit agent instructions

These repository instructions apply to every automated agent working on Orbit.
The repository is the source of truth; chat history is not.

## Model governance

**Luna Extra High is Orbit's default accountable orchestrator.** Day-to-day
delivery flows through Luna. Product planning, product scope, roadmaps, task
launch, monitoring, sequencing, reconciliation, blocker classification,
handback acceptance, delivery and next-action decisions, provider concurrency,
ordinary review, integration, publication, release execution and retained-
learning promotion are not reserved to Sol. Luna may perform or delegate those
actions to the lowest-cost, lowest-effort qualified model that can complete the
bounded task without rework. A delegated provider never approves its own work.

Sol Extra High is a bounded specialist, not the orchestrator. Sol is reserved
only for:

- a security review explicitly requested by the human owner;
- high-level architecture for a new feature or deliberate reconsideration of
  the broad architecture of current work;
- an ADR decision or material ADR amendment;
- release-policy decisions, not routine release execution;
- model-governance decisions;
- repository-setting decisions; and
- genuinely protected-planning decisions for the narrow paths in
  `.github/planning-governance.json`.

Do not invoke a Sol subagent automatically. Each invocation requires fresh,
task-specific user approval and a bounded request identifying the reserved
decision class. Routine provider unavailability, implementation difficulty or
ordinary review is never a reason to escalate to Sol.

Luna may identify, research or draft an ADR and may request an amendment. Sol
must assess the broader architectural and project context, why Luna proposes
the decision, alternatives and consequences, then return a bounded decision
and feedback. Luna must respect that assessment, must not advance a
contradictory ADR and must present Sol's reasoning faithfully to the human
owner. The human owner makes the final decision. Do not rewrite accurate ADR
history; supersede a changed decision with a new ADR.

Human-owner protected planning remains valid when it is genuinely human
authored or directed. Pull requests that change protected planning must contain
exactly one accepted attestation line from the planning policy:
`Planning-Model: Sol Extra High` or `Planning-Model: Human`. This is a
governance control, not cryptographic proof; never attest as an authority that
did not do the work.

For `low-risk-implementation` and `donkey-work` task classes, Luna Extra High
is the first OpenAI implementation model. When Ollama, Mistral and Claude are
unavailable, record each provider in order with the `unavailable` fallback
reason and route the bounded task to Luna. Routine implementation must never
escalate to Sol because those providers are unavailable.

Other bounded implementation prefers the cheapest qualified idle capacity, in
this cost order:

1. a local Ollama host and exact model qualified for the task class;
2. a qualified Mistral model as the primary paid provider;
3. a qualified Claude model as the paid fallback; and
4. Luna Extra High as the last-resort implementation provider.

This is a cost preference, not a strict serialization gate. A higher-cost
qualified provider may implement a second independent ready issue while a
cheaper provider is already occupied when Luna records a material throughput
benefit, satisfied dependencies, exact disjoint path ownership and at most
rebase-and-revalidation reconciliation. The projected total must remain within
the repository cap of two in-flight pull requests. Do not use concurrency to
escalate the same task, duplicate work or bypass the least-cost qualified model
within one task. Unqualified, unsuitable, unreachable or exhausted providers
remain ordinary fallback reasons.

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
scope, a required result handback and independent orchestrator validation. Do
not impose routine token, price or turn quotas: completion and correctness
govern the task. Detect a genuine runaway from task- and model-appropriate time
to first useful output or time since meaningful progress, with a reasonable
benefit-of-the-doubt buffer. Slow useful work is not stalled. Delegated models
may perform bounded routine-delivery actions, but they may not assume a Sol-
reserved decision or approve their own implementation. Control returns to
Luna.

When provider concurrency is used, the task state records the occupied cheaper
provider and its independent issue, task identity, qualification evidence and
allowed paths; the selected issue and allowed paths; dependency state; sibling
landing impact; expected throughput benefit; and projected in-flight pull
requests. Overlapping paths, premise-changing siblings, unbounded
reconciliation, duplicated issues, authority expansion or a projected third
pull request require sequencing instead.

Claude is an implementation resource, not the accountable orchestration
pipeline. Luna may delegate bounded routine-delivery work to it. Claude
Opus-class secondary review may be useful, but each invocation requires fresh
user approval and its output is advisory evidence for Luna; it grants no Sol-
reserved decision or self-approval authority. Historical controls
approved under the superseded dual-pipeline policy remain evidence only where
the orchestration policy explicitly enumerates their pull requests.

For low-risk implementation, Luna uses the task launcher, when available, to
create a separate user-visible Luna Extra High task after recording the
unavailable-provider evidence. For other task classes, Luna remains the
evidenced last resort. In every delegated path, write the bounded prompt under
`.agents/handoffs/`; name permitted and protected paths, forbid remote
mutations, define hard stops, require a result file, and state when control
returns to Luna. Handoff files are local coordination state and are not
committed.

## Orchestration and retained learning

Before any delivery mutation, read and obey
`docs/orchestration-runbook.md` and
`.github/orchestration-governance.json`. Run
`pnpm orchestration:check` when dependencies are available.

Luna owns the accountable delivery loop and may delegate bounded routine
actions without transferring accountability. Model authority is a preflight
gate only for the reserved decision classes above. A Luna-led task pauses for a
Sol decision only when the work actually crosses one of those boundaries and
the required fresh user approval exists. Deterministic checks, protected
branches, authoritative CI and human approval boundaries remain the acceptance
mechanism.

A successful asynchronous task-creation response establishes
`launch_pending`. Omission from a partial, limited, paginated, stale or
differently shaped task list never proves creation failure. Confirm the real
task ID, requested model, worktree and state through a full task listing,
direct task read or bounded task wait before advancing or retrying creation.

Capture operational contradictions as safe local candidate lessons. Durable
controls are recorded in `docs/orchestration-controls.json` only after the
evidence, issue, model-authority, regression-test, protected-PR and CI gates in
the orchestration runbook pass. Automation must never self-adopt a Sol-reserved
decision. Product planning, product scope and roadmaps may be maintained by any
model, subject to ordinary review and repository checks.

## Delivery workflow

- Start from an issue with a user outcome, acceptance criteria, non-goals,
  security considerations, test plan, operational impact, and closure evidence.
- Use short-lived `codex/` branches and small pull requests. Do not work
  directly on protected branches.
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
- `docs/engineering-baseline.md`: evidence-backed capability and gap audit.
- `docs/quality-strategy.md`: test, CI, and definition-of-done policy.
- GitHub issues and milestones: delivery status and prioritisation.
- `docs/feature-register.md`: detailed product direction and constraints, not
  live delivery status.
- `docs/releasing.md`: release procedure and operator acceptance.
- `SECURITY.md`: supported-version and private vulnerability-reporting
  contract.
