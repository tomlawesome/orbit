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

Work uses short-lived `codex/` branches created from and normally merged into
protected `develop`. Versioned `release/*` branches move accepted release
source through `main` and back to `develop`; `hotfix/*` branches start from
`main` and merge into both. Long-lived consolidation branches are retired after
their accepted changes reach `develop`.

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
9. [reviewed mail and document ingestion](https://github.com/tomlawesome/orbit/issues/22);
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

### v1.1 roadmap

The `v1.1` milestone contains three outcome-level epics:

1. [document processing observability and visible failure](https://github.com/tomlawesome/orbit/issues/115);
2. [desktop-first navigation and settings](https://github.com/tomlawesome/orbit/issues/116);
3. [prebuilt-container installation as the supported default](https://github.com/tomlawesome/orbit/issues/117).

These epics cite `ORB-FUT-*` feature-register entries rather than `V1-*`
charter requirements, because the v1 charter is the v1 contract and is not
reopened for post-v1 direction.

This roadmap is the single shared plan. Both agent pipelines read and update it;
neither maintains a private plan, because a second plan would become a second
source of truth and diverge.

## Rolling planning and delegation

Delivery uses a rolling-wave model:

1. Sol Extra High maintains the portfolio-level risk order, dependencies,
   release gates and durable architecture decisions.
2. Only the next two to four implementable issues are made decision-complete.
3. Bounded implementations default to the active pipeline's implementation
   tier. Independent issues may run concurrently only in isolated worktrees
   with disjoint file ownership **and** a recorded assessment that a sibling
   landing first requires at most a rebase. While the target branch requires
   up-to-date branches, keep at most two pull requests in flight.
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
accepted. A document is optional for each item, but the document-assisted
workflow is required v1 scope. Suggestions extend the manual editor and secure
document lifecycle; they never replace manual entry or persist an item before
explicit submission.

In parallel, issue #14 closes successful atomic session refresh, logout and
OIDC failure-route contracts. Representative Authentik or equivalent
acceptance is then recorded against a digest-pinned preview using sanitized
product/version and outcome evidence only. Production authentication remains
provider-neutral; a provider-specific code path or security-policy change
requires Sol Extra High review before implementation proceeds.

### Wave 3 — lifecycle, administration and operations

- Complete issue #22 after #43 establishes the shared editable draft and review
  contract. Dedicated-mailbox messages and attachments enter that same private
  flow with authenticated identity, idempotent receipt, hostile-MIME bounds,
  quarantine, bounded retry and explicit user approval. Mail receipt never
  creates, attaches or merges an item automatically. ADR-0005 preserves the
  prototype's essential hidden-until-reviewed behaviour using a private
  user-owned ingestion draft rather than an archived household item. Deliver it
  as sequential vertical slices: shared approval contract; receipt/identity
  foundation; hostile attachment staging; IMAP review journey; then SMTP and
  administration acceptance.
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

- Deliver issue #20 — Accessible, responsive, and offline-safe UX through
  #87 — Authenticated accessibility and responsive UX and #88 — Remove private
  workspace caching. V1 keeps an installable shell and push handling but makes
  private workspace data online-authoritative; it purges legacy preview
  storage and never queues failed changes. Execute page-specific assertions
  only against stable item, document, mailbox and administration journeys.
- Complete issue #21's protected CI evidence for dependency/secret policy,
  SPDX output, exact-image vulnerability scanning, verified digest-bound
  provenance and least-privilege workflow controls. Resolve the time-bounded
  mutable image inventory through issue #80. Installation, update, rollback,
  recovery and promotion acceptance wait for the feature-complete image.
- Prepare the release-acceptance record structure now, but do not claim
  representative provider/device/operator results before those checks run
  against the exact versioned-release preview digest.
- Cut a semantic versioned release branch only when all stable-v1 blockers are
  closed, then accept and promote its exact preview digest.

Issue #22 begins only after the manual item and document-assisted review
contracts are accepted, but its dedicated-mailbox ingestion and review journey
remain required before stable v1.

## v1.1 delivery waves

The critical path is the reported silent-upload defect. Observability is
deliberately delivered before any corrective change, because the cause was a
hypothesis drawn from reading the code rather than a fact established from
evidence. Slices in a later wave assume the earlier wave is accepted.

Each slice records a **concurrency assessment**, because disjoint file
ownership alone is not sufficient grounds to run work in parallel. Disjoint
files prevent merge conflicts; they do not prevent revalidation churn, and they
do not say whether a sibling landing first would invalidate a slice's premises.
Assess each slice as one of:

- **concurrent** — a sibling landing first requires at most a rebase, so the
  work in progress stays valid; or
- **sequenced** — a sibling landing first would change the slice's premises and
  force rework, so it waits for a later wave.

Because the `develop` ruleset requires branches to be up to date, every merge
leaves every other open pull request behind and forces a full revalidation.
Keep at most two pull requests in flight regardless of assessment; concurrency
beyond that costs more in revalidation than it returns.

## Current position

This section is the rolling commentary. It names where delivery actually is, so
the next action is never inferred from memory. Update it whenever a slice
changes state.

- **Current wave:** v1.1 Wave 2, beginning. Wave 1 is complete and reviewed.
- **Next slice:** [#138 — settings and administration as dedicated routes](https://github.com/tomlawesome/orbit/issues/138).
- **In flight:** nothing.
- **Blocked:** nothing.
- **Open question awaiting the repository owner:** whether the installer may
  resolve a release tag to a digest automatically, recorded on
  [#140 — installer-resolved release digests](https://github.com/tomlawesome/orbit/issues/140).
  Work proceeds on the assumption that it may, because the deployed artifact
  stays digest-pinned; if that is wrong, #140 is withdrawn and
  [#143 — non-interactive installer](https://github.com/tomlawesome/orbit/issues/143) changes shape.

### Wave 1 completion review

Wave 1 delivered the diagnostic instrument every later document slice reasons
from, plus two independent improvements. Every slice is closed as completed
with itemised per-criterion evidence, and every delivering merge is trusted on
`develop`.

| Slice | Delivered by | Trusted at |
| --- | --- | --- |
| [#118 — document lifecycle and processor diagnostics](https://github.com/tomlawesome/orbit/issues/118) | #122, #125 | `b7d82d0`, `a931c0c` |
| [#119 — accessible drop zone](https://github.com/tomlawesome/orbit/issues/119) | #129 | `6835666` |
| [#120 — patched esbuild](https://github.com/tomlawesome/orbit/issues/120) | #121 | `64b4bde` |

What Wave 1 deliberately did **not** deliver, so nothing later is assumed done:
documents in a non-available state are still invisible in the item list; the
settings and administration surfaces are unchanged; and nothing in the
installation epic was touched.

Deviations recorded rather than absorbed:

- [#124 — scanner failure attribution](https://github.com/tomlawesome/orbit/pull/124),
  a Wave 2 slice, was merged while all three Wave 1 issues were still open. It
  is trusted on `develop`, but it was delivered out of wave order.
- [#118](https://github.com/tomlawesome/orbit/issues/118) was first reported
  complete while three of its own acceptance criteria were unmet. That is the
  primary evidence behind ORCH-008.
- [#133 — private-storage navigation races](https://github.com/tomlawesome/orbit/issues/133)
  was first fixed without the reproduction its own test-first plan required.
  The proof was added before merge rather than deferred.
- [#132](https://github.com/tomlawesome/orbit/issues/132) cites a later green
  `develop` state rather than an exact-SHA run, because its own merge hit the
  navigation-race flake later fixed by #137.

A process batch agreed with the repository owner ran between Wave 1 and Wave 2:
ORCH-008 acceptance evidence, the ORB-FUT-011 register entry, CI path
filtering, ORCH-009 wave costing, and the navigation-race fix. All are
delivered and trusted.

### Wave 1 — diagnostic instrument and independent improvements

- [#118 — bounded document lifecycle and processor diagnostics](https://github.com/tomlawesome/orbit/issues/118)
  owns `src/lib/logger.ts` and the document server paths. Critical path: it is
  the instrument every later document slice reasons from. **Concurrent** —
  nothing else in this wave reads its output.
- [#119 — accessible drop zone](https://github.com/tomlawesome/orbit/issues/119)
  owns `src/components/document-manager.tsx`. **Concurrent** — presentation
  only, unaffected by server-side diagnostics landing first.
- [#120 — patched esbuild across transitive tooling](https://github.com/tomlawesome/orbit/issues/120)
  owns `pnpm-workspace.yaml`. **Concurrent** — a lockfile change reconciles by
  regeneration, never by rework.

### Wave 2 — corrective and structural change

- [#123 — explicit malware scanner failure attribution](https://github.com/tomlawesome/orbit/issues/123)
  depends on #118, whose records identify where an upload stops. Scanning stays
  fail-closed and the default deployment keeps ClamAV installed and enabled;
  what changes is that the requirement becomes verifiable and its failure
  explicit. **Sequenced** — designing the correction before the diagnostics
  land means designing it from a hypothesis.
- Settings and administration promoted to routes, under
  [#116](https://github.com/tomlawesome/orbit/issues/116). Owns `src/app` route
  segments and `dashboard.tsx`. **Concurrent** with the document work, which
  shares no files with it.
- Supply-chain policy amendment and deploy-compose separation, under
  [#117](https://github.com/tomlawesome/orbit/issues/117). **Concurrent** with
  each other; both **sequenced** before the installer rewrite, which cannot be
  written against a policy and a compose layout that have not settled.

### Wave 3 — dependent experience and deployment

- Account menu exposing settings, administration and sign out. Depends on the
  route promotion, because the menu's destinations must exist first.
  **Sequenced** — building it against dialogs would be discarded work.
- Non-interactive installer resolving a published release digest. Depends on
  both Wave 2 deployment slices. **Sequenced** — its behaviour is defined by
  the amended supply-chain policy and the separated compose layout.

Later waves are refined only after the current wave's evidence changes the
baseline, following the rolling-wave rule above.

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
release scope is feature-complete, [the release policy](releasing.md) requires
a versioned release branch, testing and deployment by immutable digest, merging
the accepted source into both protected `main` and `develop`, and promotion
without rebuilding.
