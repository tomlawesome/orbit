# ADR-0011: Operator experience as product, single-reviewer governance

**Status:** Accepted
**Date:** 2026-08-11
**Supersedes:** [ADR-0009](0009-capability-routed-implementation.md) and the
multi-model orchestration governance previously defined in `AGENTS.md`,
`.github/planning-governance.json`, and
`.github/orchestration-governance.json`

## Context

Two structural pressures had accumulated.

First, Orbit's installer and operational tooling — installation, configuration,
backup, restore, recovery bundles, and deployment — had grown to roughly the
same order of magnitude as the application itself, implemented in Bash. That
layer holds the project's most safety-critical guarantees: image-digest
provenance, transactional configuration with rollback, fail-closed refusal of
unsafe state, and recoverable restore. It is also deliberate product surface:
the installer experience is intended to convey the thought and care in the
solution. The dedicated `orbit-launcher` project (Go, Bubble Tea) now owns
that interactive experience, superseding the in-repo Bash command centre
(#260, closed); the launcher fetches and drives this repository's
`install.sh`, so the operational engine it consumes is still the Bash layer —
product-grade guarantees implemented in the medium with the weakest testing
and composition capabilities available to the project.

Second, the multi-model orchestration governance — planning authorities,
attestation lines, provider qualification and routing records, orchestration
state and its validators — imposed preflight and review ceremony on every
change. Its enforcement machinery (two validator scripts, their tests, a CI
gate, and three policy documents) cost more to maintain than the risk it
retired, because every change already lands through a pull request reviewed by
the human owner under branch protection.

## Decision

1. **The operator experience is first-class product surface, split into
   presentation and engine.** The separate `orbit-launcher` project (Go,
   Bubble Tea) owns interactive presentation: the full-screen flows, guided
   journeys, and install/update/repair/remove menus. This repository owns the
   operational engine — the guarantees currently implemented in Bash — whose
   observable behaviour is contract, catalogued and preserved across any
   reimplementation. The engine converges on the application's TypeScript
   runtime as a single non-interactive `orbit` administration CLI sharing the
   application's configuration schemas and emitting structured semantic
   events and stable exit codes for the launcher (and plain terminals) to
   render. Guarantees, event vocabulary, and acceptance criteria are the
   portability boundary; interactive presentation code lives in the launcher.
2. **Guarantee parity is proven, not assumed.** An operational acceptance
   harness exercising install, upgrade, backup/restore, wrong-key refusal, and
   interrupted-recovery flows must pin current behaviour before any flow is
   ported. No new operational guarantee is added to the Bash layer once its
   replacement flow is in progress.
3. **Model-orchestration governance is retired.** The contributor model is a
   human owner plus AI assistants working under direction; every change lands
   via a reviewed pull request on a protected branch. Attestation lines,
   model-authority preflight, provider qualification and routing policy, and
   orchestration state files are removed. `AGENTS.md` retains only the working
   model, delivery workflow, and sources of truth.
4. **Security invariants are unchanged and binding:** digest-pinned immutable
   deployment (ADR-0008), file-backed secrets outside container environments,
   fail-closed malware scanning (ADR-0010), per-document envelope encryption,
   transactional configuration with rollback, recoverable restore (ADR-0004),
   and the build-once promotion pipeline (ADR-0002, ADR-0003).

## Consequences

- The phased roadmap in `docs/implementation-plan.md` and its GitHub
  milestones own delivery sequencing; `docs/engineering-baseline.md` rows
  flipping to proven states are the phase exit criteria.
- The planning/orchestration validator scripts, their tests, the CI
  enforcement step, the pull-request attestation section, and the three policy
  JSON documents are deleted. CI lane classification no longer needs patterns
  for them.
- ADR-0007 and ADR-0009 remain in history as superseded records; their
  narrower lesson — bounded delegated tasks with independent review and no
  self-approval — is retained in `AGENTS.md` without enforcement machinery.
- #261's diagnosis-and-repair logic is engine scope in this repository,
  surfaced through the launcher's Repair flow rather than an in-repo TUI.
- Single-reviewer governance concentrates trust in branch protection and owner
  review. This is accepted: it matches how the project actually operates, and
  the removed machinery attested authorship rather than verifying correctness.

## Alternatives considered

- **Keep the governance but slim it.** Rejected: the enforcement machinery
  itself — validators, tests, CI gates, state files — was the recurring cost;
  a slimmer policy with the same machinery retires little of it.
- **Treat the installer as incidental scripting and freeze it.** Rejected: the
  operator experience is a stated product goal, and freezing it in Bash leaves
  the highest-criticality guarantees permanently in the least testable layer.
- **Implement the engine in Go inside `orbit-launcher`.** Rejected: the
  launcher deliberately owns presentation only, and Go is the right choice
  there — a single static binary with no runtime dependency, installed before
  anything else exists. But the engine validates the same configuration
  contract the application consumes at runtime; implementing it in a second
  language would split the single source of truth this decision exists to
  create. The application's Node runtime is already a deployment requirement
  wherever the engine runs.
