# ADR-0011: Luna-first orchestration with bounded Sol authority

**Status:** Accepted
**Date:** 2026-08-10
**Supersedes:** the orchestration, protected-planning and delegated-authority
parts of [ADR-0009](0009-capability-routed-implementation.md), plus the Sol-only
protected-planning rule in
[ADR-0002](0002-evidence-driven-delivery.md). ADR-0009's evidence-driven
provider qualification and bounded implementation controls remain current.

## Context

ADR-0009 put every delivery-loop decision behind Sol Extra High. That made one
model accountable, but also spent the highest-cost reasoning tier on product
planning, task launch, monitoring, sequencing, handback acceptance, ordinary
review, integration and other repeatable work. The same path-based gate treated
roadmaps, ordinary workflows, operational configuration and routine planning as
if every edit were a protected architecture or governance decision.

The human owner asked to make Luna Extra High the normal orchestration entry
point and to reserve Sol for a much smaller set of decisions. The owner also
defined the ADR lifecycle: Luna may identify, research or draft a decision, Sol
must assess the wider context and provide a decision with feedback, Luna must
respect and report that assessment, and the human makes the final decision.

Sol's assessment is that this split preserves the useful part of ADR-0009—one
accountable delivery coordinator, evidence-based provider routing and
independent validation—without requiring the coordinator to be the most
expensive model. The important boundary is the decision class and its review
evidence, not whether every operational action flows through Sol.

## Decision

- Luna Extra High is Orbit's default accountable orchestrator. Day-to-day work
  flows through Luna.
- Product planning, product scope, roadmaps, task launch, monitoring,
  sequencing, reconciliation, blocker classification, handback acceptance,
  delivery and next-action decisions, provider concurrency, ordinary review,
  integration, publication, release execution and retained-learning promotion
  are not model-restricted. Luna may perform or delegate them to the lowest-
  cost, lowest-effort qualified model that can complete the bounded task without
  rework. A provider may not approve its own implementation.
- Sol Extra High is a bounded specialist only for:
  - an ADR decision or material ADR amendment;
  - high-level architecture for a new feature or a deliberate reconsideration
    of the broad architecture of current work;
  - release-policy decisions, not routine release execution;
  - model-governance decisions;
  - repository-setting decisions;
  - genuinely protected-planning decisions; and
  - a security review explicitly requested by the human owner.
- Each Sol subagent invocation requires fresh, task-specific user approval. A
  provider failure, ordinary review need or implementation difficulty does not
  justify automatic Sol escalation.
- Luna may identify, research, draft or request amendment of an ADR. Sol assesses
  the broader project and architectural context, the proposal's reason,
  alternatives and consequences. Luna must not advance a contradictory ADR and
  must present Sol's decision faithfully. The human owner makes the final
  decision.
- Accurate historical ADRs and retained controls are not rewritten. Changed
  decisions are expressed through an explicit superseding ADR or retirement
  record.
- The protected path set is narrowed to model governance, high-level
  architecture, ADRs, release policy and their enforcement. Product and
  implementation plans, feature registers, ordinary workflows, issue templates,
  Compose files, operational examples and the retained-control ledger do not
  acquire Sol authority merely because of their path.
- The delivery stage formerly called `sol_review` is renamed
  `orchestrator_review`. It denotes independent review by Luna or another
  bounded reviewer that did not implement the work; it does not imply Sol.

## Consequences

- Routine delivery consumes materially less Sol capacity while retaining a
  named accountable coordinator.
- Model selection can match both capability and effort to the bounded action,
  reducing cost without accepting rework as an efficiency strategy.
- Sol decisions become exceptional and auditable by decision class and fresh
  user approval.
- Security standards, protected branches, authoritative CI, negative tests,
  release approvals and human-only destructive or production boundaries remain
  unchanged. Only the model-authority routing changes.
- Existing state using `sol_review` must migrate to `orchestrator_review` before
  validation under the new policy.
- Historical controls that describe the old Sol-only rule remain evidence of
  the policy then in force. They do not silently regain current authority.

## Alternatives considered

- **Keep Sol as the default orchestrator and delegate only implementation:**
  rejected because routine coordination and review were the main avoidable Sol
  cost.
- **Allow any model to coordinate without a default owner:** rejected because
  delivery still benefits from a clear handback, integration and escalation
  point. Luna provides that accountability economically.
- **Make all architecture and security work Sol-only:** rejected because the
  owner reserved only high-level architecture and explicitly requested security
  review. Ordinary implementation must continue to apply secure defaults and
  deterministic checks without triggering Sol automatically.
- **Permit Luna to accept ADRs after drafting them:** rejected because ADRs
  capture broad and durable consequences. Sol supplies the cross-project
  assessment, and the human retains the final decision.
