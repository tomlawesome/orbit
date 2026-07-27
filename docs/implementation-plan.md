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

Only the first two risk areas are decomposed at baseline. Later epics are
refined when they are close enough to delivery for acceptance criteria to be
real rather than speculative.

The ready implementation queue is deliberately limited to:

- [PostgreSQL service/API integration harness](https://github.com/tomlawesome/orbit/issues/24);
- [critical API authorization matrix](https://github.com/tomlawesome/orbit/issues/25);
- [account disable, session and ownership invariants](https://github.com/tomlawesome/orbit/issues/26);
- [fresh and baseline-upgrade migration tests](https://github.com/tomlawesome/orbit/issues/27);
- [negative backup/restore recovery paths](https://github.com/tomlawesome/orbit/issues/28).

GitHub milestone assignment is administrative metadata rather than a second
status source: issues #10–#13 and this baseline pull request belong to `v1
Engineering Baseline`; issues #14–#28 belong to `v1.0`.

## Risk-ordered execution

1. **Prove persistent authorization boundaries.** Add the PostgreSQL-backed
   service/API harness and negative role/household matrix.
2. **Prove data evolution and recovery.** Test fresh and representative upgrade
   migrations, then corrupt/wrong-key/interrupted restore cases.
3. **Prove the core vertical journeys.** Add authenticated browser coverage for
   items, schedules and secure documents against the production image.
4. **Make CI test the publishable identity.** Build once, exercise that exact
   image, then attach supply-chain evidence and publish its digest.
5. **Prove operations and providers.** Cover safe administrator actions,
   notification contracts, degraded dependencies, installation, update and
   rollback.
6. **Complete experience acceptance.** Authenticated accessibility, responsive
   layouts, text scaling, themes and an explicit offline-support decision.
7. **Evaluate optional automation.** Only after the manual workflow is accepted,
   decide which IMAP, parsing, duplicate and semantic-extraction capabilities
   should graduate from experimental status.

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
