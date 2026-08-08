# ADR-0009: Sol-governed, capability-routed implementation

**Status:** Accepted
**Date:** 2026-08-01
**Supersedes:** [ADR-0007](0007-dual-pipeline-agent-governance.md) and the
implementation-provider selection in
[ADR-0002](0002-evidence-driven-delivery.md)

## Context

ADR-0007 made Claude a peer pipeline with its own orchestration and protected-
planning authority. That solved truthful attestation for Claude-authored work,
but it coupled useful implementation and review capacity to authority over
planning, sequencing and repository governance. Evaluation showed that Claude
can be useful for bounded implementation while its project management and
high-level orchestration should remain under Sol. Human-authored protected
planning already has its own truthful attestation and does not require a second
automated orchestration authority.

Implementation cost also became a material constraint. Local Ollama, Mistral,
Claude and Luna offer different price, capacity and capability profiles, but a
successful toy prompt or nominal model tier does not establish safe repository
performance. Representative Mistral benchmarks, for example, distinguished a
correct Medium 3.5 High implementation from lower profiles that failed
correctness checks. An undersized local token cap interrupted the correct run's
administrative handback; that exposed a wrapper defect, not a model-capability
failure. Local hardware likewise cannot be treated as capable until the exact
host and model pass representative hidden-case tests.

## Decision

- Sol Extra High is Orbit's sole automated orchestration and protected-planning
  authority. Human-owner planning remains separately attestable.
- Delegated implementation is selected by demonstrated task-class capability
  and cost: qualified local Ollama first, qualified Mistral second, qualified
  Claude third, and Luna Extra High only as the evidenced last resort.
- Qualification records the exact provider, model and task class, plus the
  exact host for local Ollama. It covers correctness, hidden edge cases, scope,
  result honesty and context fit. Cost, latency, resource use and capacity are
  routing signals. Routine token, price and turn caps are not imposed. A real
  stall is identified from task- and model-appropriate time to useful output
  or time since meaningful progress, with a benefit-of-the-doubt buffer. Slow
  useful work is not stalled, and resource use does not disqualify otherwise
  correct work unless an explicit task budget requires that outcome.
  Unqualified models receive no real Orbit implementation work.
- Qualification stops early when a model is satisfactory and never exceeds
  five passes for one representative task class. Basic acceptance is required
  by pass three; passes four and five may only fine-tune already acceptable
  behavior.
- Every delegated provider receives only a bounded implementation slice in an
  exact-base isolated worktree with least-privilege tools, path allowlists,
  progress-based runaway monitoring and a required result handback. Sol
  independently reviews, tests, integrates and publishes accepted work.
- Delegated providers have no authority over orchestration, protected planning,
  architecture, security, integration, publication or release and may not
  approve their own work.
- Claude Opus-class secondary review requires fresh user approval for each
  invocation and remains advisory evidence for Sol.
- Historical protected controls approved under ADR-0007 remain valid only for
  the exact pull requests enumerated as legacy evidence in the orchestration
  policy. That exception cannot authorize new Claude planning work.

## Consequences

- Paid Sol capacity is preserved by using cheaper proven implementation
  resources without transferring accountability or decision authority.
- Provider availability or allowance failures produce explicit fallback
  evidence rather than silent model switching or broader credentials.
- Dynamic capability evidence lives in the all-project Codex registry; this
  repository stores stable routing and authority invariants without embedding
  endpoints, credentials, prompts or provider response content.
- The existing `sol_review` state keeps its name and now unambiguously denotes
  Sol review.
- ADR-0007 remains immutable historical context but no longer describes current
  authority.

## Alternatives considered

- **Keep Claude as a peer orchestration pipeline:** rejected because useful
  implementation bandwidth does not require planning or delivery authority.
- **Route only by nominal price:** rejected because repeated work, incorrect
  output and incomplete handbacks can cost more than a higher-priced proven
  model.
- **Use Luna as the permanent default:** rejected because qualified local and
  paid external capacity should preserve Codex allowance when they can meet the
  same quality and security bar.
- **Allow unqualified models on low-risk repository files:** rejected because
  scope compliance and result honesty are themselves qualification criteria;
  synthetic benchmarks provide a safe proving ground.
