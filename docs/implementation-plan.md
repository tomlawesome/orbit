# Orbit implementation plan

## Source-of-truth boundaries

This file defines delivery order and working policy. It does not repeat live
feature status.

- Product and release requirements: [v1 charter](v1-charter.md).
- Current capability evidence and gaps:
  [engineering baseline](engineering-baseline.md).
- System boundaries and durable decisions:
  [architecture](architecture.md) and [ADRs](adr/README.md).
- Tests, CI and definition of done:
  [quality strategy](quality-strategy.md).
- Deferred product direction: [feature register](feature-register.md).
- Priority, ownership and delivery status: GitHub milestones and issues.

Historical consolidation and handover status files were removed after their
accepted decisions were incorporated here, in the architecture baseline, or in
focused security/operations documents. Git history remains the historical
record.

## Governance

Broad planning and systems decisions are protected Sol Extra High work under
the root `AGENTS.md` and `.github/planning-governance.json`. Bounded
implementation subagents default to Luna Extra High. A different subagent model
requires fresh, explicit user approval before use.

Every implementable issue must define:

- the user or operator outcome;
- measurable acceptance criteria and explicit non-goals;
- security, privacy and authorization considerations;
- tests to write or characterize before implementation;
- migration, compatibility, deployment, backup and documentation impact;
- evidence required before closure.

Work uses short-lived `codex/` branches and small, issue-linked pull requests.
Long-lived consolidation branches are retired after accepted changes reach the
release line.

## Delivery structure

### v1 Engineering Baseline

The initial baseline is issues
[#10](https://github.com/tomlawesome/orbit/issues/10),
[#11](https://github.com/tomlawesome/orbit/issues/11),
[#12](https://github.com/tomlawesome/orbit/issues/12), and
[#13](https://github.com/tomlawesome/orbit/issues/13).

It establishes:

- the focused self-hosted v1 contract;
- an evidence-backed capability and API audit;
- current architecture, trust boundaries and ADRs;
- a risk-based quality and CI strategy;
- issue and pull-request templates;
- protected planning-model governance;
- diagnostic coverage collection;
- a small, risk-ordered GitHub roadmap.

### v1.0 roadmap

The roadmap contains ten outcome-level epics:

1. [identity, sessions, and authorization](https://github.com/tomlawesome/orbit/issues/14);
2. [household and account lifecycle](https://github.com/tomlawesome/orbit/issues/15);
3. [core items, schedules, and reminders](https://github.com/tomlawesome/orbit/issues/16);
4. [secure documents and reviewed intake](https://github.com/tomlawesome/orbit/issues/17);
5. [data integrity, migrations, backup, and recovery](https://github.com/tomlawesome/orbit/issues/18);
6. [administration and observability](https://github.com/tomlawesome/orbit/issues/19);
7. [accessible, responsive, and offline-safe experience](https://github.com/tomlawesome/orbit/issues/20);
8. [CI, supply chain, release, and operator acceptance](https://github.com/tomlawesome/orbit/issues/21);
9. [optional mail and document automation](https://github.com/tomlawesome/orbit/issues/22);
10. [maintainability and bounded module seams](https://github.com/tomlawesome/orbit/issues/23).

Only work close to delivery is decomposed. Later epics are refined when their
acceptance criteria can be based on the current implementation rather than a
speculative backlog.

The completed first decomposed group is
[#24](https://github.com/tomlawesome/orbit/issues/24) through
[#28](https://github.com/tomlawesome/orbit/issues/28). GitHub owns its live
status and closure evidence.

The active decomposed group is:

- [#40 — conflict-safe item transitions and the manual item journey](https://github.com/tomlawesome/orbit/issues/40);
- [#41 — deterministic reminder scheduling and bounded delivery](https://github.com/tomlawesome/orbit/issues/41);
- [#42 — recoverable document purge and the secure document lifecycle](https://github.com/tomlawesome/orbit/issues/42);
- [#43 — optional document-assisted editable item creation](https://github.com/tomlawesome/orbit/issues/43).

The remaining Wave 2 identity evidence stays within
[#14](https://github.com/tomlawesome/orbit/issues/14) because it closes the
existing identity outcome rather than introducing a new delivery slice.

GitHub milestone assignment is administrative metadata rather than a second
status source: issues #10–#13 and this baseline pull request belong to `v1
Engineering Baseline`; v1 roadmap and implementation issues belong to `v1.0`.

## Rolling planning and delegation

Delivery uses a rolling-wave model:

1. Sol Extra High maintains the portfolio-level risk order, dependencies,
   release gates and durable architecture decisions.
2. Only the next two to four implementable issues are made decision-complete.
3. Bounded implementations default to Luna Extra High. Independent issues may
   run concurrently only in isolated worktrees with disjoint file ownership.
4. Sol Extra High reviews architecture and security consequences, then
   integrates protected pull requests sequentially. A later concurrent branch
   rebases onto the accepted earlier result before final validation.
5. The next wave is refined only after the current wave's evidence changes the
   baseline. Terra may perform bounded read-only or mechanical audits, but may
   not replace Sol architecture work or Luna feature implementation.

This avoids both a stale hundred-issue backlog and repeated high-cost planning
inside implementation. Handoffs must name permitted paths, protected paths,
test obligations, hard stop conditions and the evidence required for Sol
review.

## Risk-ordered delivery waves

### Wave 1 — operational data safety

- Completed issue #27 proves fresh migrations, the supported baseline upgrade,
  migration idempotency and failure recording.
- Completed issue #28 proves corrupt, wrong-key, mismatched-object and
  interrupted recovery behaviour.

The architecture is planned jointly under
[ADR-0004](adr/0004-supported-upgrades-and-recoverable-restore.md). The two
implementations were integrated in dependency order: #27 established the
upgrade floor and rollback contract before #28's final recovery validation.
Their accepted pull requests and protected workflow runs are the live closure
evidence in GitHub.

### Wave 2 — core authenticated vertical journeys

The first implementation phase may run three disjoint Luna Extra High tasks in
isolated worktrees:

- #40 owns item state transitions, persistence and the authenticated manual
  item journey;
- #41 owns reminder materialization, claims, leases and provider contracts;
- #42 owns document purge ordering, recovery and the authenticated secure
  document lifecycle.

Sol Extra High integrates the resulting branches sequentially, with #40 first
where shared workspace or browser fixtures overlap. Each later branch rebases
onto the accepted release line and reruns its authoritative checks before
merge.

Issue #43 is planned now but implementation starts only after #40 and #42 are
accepted. Document suggestions extend the manual editor and secure document
lifecycle; they never replace manual entry or persist an item before explicit
submission.

In parallel, issue #14 closes successful atomic session refresh, logout and
OIDC failure-route contracts. Representative Authentik or equivalent
acceptance is then recorded against a digest-pinned preview using sanitized
product/version and outcome evidence only. Production authentication remains
provider-neutral; a provider-specific code path or security-policy change
requires Sol Extra High review before implementation proceeds.

### Wave 3 — lifecycle, administration and operations

- Complete issue #15 retention and purge behaviour after document lifecycle
  evidence exists.
- Complete issue #19 administration, redaction, degraded dependency and
  corrective-action evidence against established failure states.
- Continue issue #21 supply-chain reporting independently, but defer update,
  rollback, operator acceptance and stable-promotion closure until Waves 1 and
  2 are complete.
- Treat issue #23 as a guardrail applied at demonstrated seams, not a
  behaviour-neutral refactor project.

### Wave 4 — experience and release acceptance

- Complete issue #20 against stable authenticated item, document and
  administration journeys, including the explicit offline-support decision.
- Finish representative provider, device, installation, update, recovery and
  supply-chain evidence.
- Publish a semantic release candidate only when all stable-v1 blockers are
  closed, then accept and promote its exact digest.

Issue #22 remains deferred until the manual item and document workflows are
accepted. Optional automation does not block stable v1.

## Pull-request lifecycle

1. Select a ready issue and confirm its acceptance cases.
2. Add a failing or characterization test at the cheapest effective layer.
3. Implement the smallest vertical change.
4. Run static, unit, relevant integration and targeted browser checks.
5. Review the diff for security, data, dependency, migration and operational
   surprises.
6. Open a focused pull request linked to the issue.
7. Merge only after required checks pass and conversations are resolved.
8. Record any required preview or manual evidence before closing the issue.

Previews provide ongoing deployment evidence while v1 is incomplete. Once the
release scope is feature-complete, release candidates follow
[the release policy](releasing.md): test and deploy by immutable digest, merge
the accepted source through protection, and promote without rebuilding.
