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
- Detailed product direction: [feature register](feature-register.md).
- Priority, ownership and delivery status: the
  [Orbit Roadmap project board](https://github.com/users/tomlawesome/projects/4),
  with GitHub milestones as the release grouping mirrored by the board's Slice
  field (owner decision, issue #502).

Historical delivery waves for v1.0–v1.2 were completed under the superseded
plan structure; their evidence lives in the closed GitHub issues, merged pull
requests, and git history of this file. This plan is forward-looking from the
governance change recorded in
[ADR-0011](adr/0011-operator-experience-as-product.md).

## Governance

Orbit is maintained by its human owner with AI assistants working under
direction, as defined in the repository `AGENTS.md` and ADR-0011. Every change
lands through a reviewed pull request on a protected branch.

Every implementable issue must define:

- the user or operator outcome;
- measurable acceptance criteria and explicit non-goals;
- security, privacy and authorization considerations;
- tests to write or characterize before implementation;
- migration, compatibility, deployment, backup and documentation impact;
- evidence required before closure.

Work uses short-lived branches created from and normally merged into protected
`dev`. Release trains merge `dev` into protected `preview`, then move
the accepted exact source through `main`; `hotfix/*` branches start from
`main` and are reconciled into `dev` and `preview`. Because the `dev`
ruleset requires up-to-date branches, keep at most two pull requests in
flight.

## Phased roadmap

Delivery is organised as five phases. Each phase makes the next one cheaper;
GitHub milestones named for the phases group the work, the
[Orbit Roadmap project board](https://github.com/users/tomlawesome/projects/4)
owns live status, and the
[engineering baseline](engineering-baseline.md) rows moving to proven states
are the exit evidence.

### Phase 0 — Decide and delete

Record ADR-0011, reduce `AGENTS.md` to the working model, and remove the
orchestration-governance machinery: validators, tests, the CI gate, the
attestation section of the pull-request template, and the policy state files.
No operational behaviour changes.

### Phase 1 — Operational acceptance harness

Pin current operator-facing behaviour before anything is rewritten. A
container-based harness proves, as executable scenarios with negative cases:
fresh install, recognized upgrade, backup and restore round trip, wrong-key
restore refusal, interrupted-install recovery, and representative migration
from a prior release. The guarantee catalogue extracted from the current
scripts is the scenario specification. The first scenario is hand-built as the
exemplar; the remainder follow its assertion and fixture pattern.

### Phase 2 — The `orbit` administration CLI

Converge the operational tooling on the application's TypeScript runtime, flow
by flow, behind the Phase 1 harness:

1. the shared configuration contract as Zod schemas — one source of truth for
   the application and the CLI;
2. a minimal digest-verified Bash bootstrap whose only job is to fetch and
   hand off to the pinned CLI;
3. ported flows in risk order — configure/check first, install, then
   backup/restore last, when the harness is most mature;
4. a structured machine interface — semantic events on stdout and stable
   exit codes — consumed by the `orbit-launcher` project, which owns all
   interactive presentation and drives the engine in place of raw
   `install.sh`; the repair engine
   ([#261](https://github.com/tomlawesome/orbit/issues/261)) is delivered
   against this interface.

Once a flow's port is in progress, no new operational guarantee is added to
its Bash implementation.

### Phase 3 — Application hotspots and worker evidence

Split the oversized modules along their documented seams with
characterization tests first (`imap-ingestion`, `document-worker`,
`dashboard`); add integration evidence for worker claim, lease, stale-worker
and restart-recovery behaviour; ratchet coverage on layers that gain
scaffolding rather than setting a global percentage target.

### Phase 4 — Experience

Finish the operator and product experience on the consolidated foundation:
complete launcher journeys over the engine's structured events, degraded-mode
diagnostics, upgrade UX, and resumed product feature work.

## Current position

This section is the rolling commentary; update it whenever a slice changes
state.

- **Released train:** v1.2.0 from `main`
  `515c77e1b6fe4b061b6ed4a9fbce2a168e876152`, promoted without rebuilding from
  accepted preview source `49fcd6705f8f4c77ce4b4a6e7b00e7074b0ea2d3` as
  `ghcr.io/tomlawesome/orbit@sha256:35ad7cea14f835b8e5b350faa0fcf711cbf95c517a2bad26f5fe72795a8aeb12`.
- **Active operator-experience track:** the interactive command centre is
  the dedicated `orbit-launcher` project (Go, Bubble Tea), which supersedes
  the closed in-repo command centre
  [#260](https://github.com/tomlawesome/orbit/issues/260) and currently
  fetches and drives this repository's `install.sh`. The engine contract the
  launcher consumes is what Phases 1–2 pin and port; the repair engine
  [#261](https://github.com/tomlawesome/orbit/issues/261) is engine scope
  here, surfaced through the launcher's Repair flow.
- **Phase 0** is delivered by the governance-slimdown pull request that
  introduces this plan revision.
- **Phase 1** starts with the guarantee catalogue and the exemplar harness
  scenario; its issues live in the `Phase 1 — Ops acceptance harness`
  milestone.
- **Deferred portfolio work:**
  [#75](https://github.com/tomlawesome/orbit/issues/75) awaits an explicit
  destination-repository decision.

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

Previews provide ongoing deployment evidence while a release is incomplete.
[The release policy](releasing.md) requires the protected `preview` lane,
testing and deployment by immutable digest, merging the accepted source into
protected `main`, and promotion without rebuilding.
