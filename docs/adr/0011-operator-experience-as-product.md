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
solution, and the in-progress installer command centre (#260) and repair
engine (#261) extend that intent. Product-grade ambitions were being built in
the medium with the weakest testing, composition, and interactive-UI
capabilities available to the project.

Second, the multi-model orchestration governance — planning authorities,
attestation lines, provider qualification and routing records, orchestration
state and its validators — imposed preflight and review ceremony on every
change. Its enforcement machinery (two validator scripts, their tests, a CI
gate, and three policy documents) cost more to maintain than the risk it
retired, because every change already lands through a pull request reviewed by
the human owner under branch protection.

## Decision

1. **The installer and operator experience is first-class product surface.**
   Its observable guarantees are contract, catalogued and preserved across any
   reimplementation. The implementation will converge on the same TypeScript
   runtime as the application: a single `orbit` administration CLI sharing the
   application's configuration schemas, with a real terminal UI, and with Bash
   reduced to a minimal digest-verified bootstrap. The semantic-event and
   command-routing seam established by #260 is the portability boundary: event
   vocabulary, guarantees, and acceptance criteria survive the runtime port;
   presentation code is expected to be rewritten.
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
- **Rewrite operational tooling in Go or Rust for single-binary deployment.**
  Rejected for now: a second toolchain reintroduces the split the decision
  removes; the application's Node runtime is already a deployment requirement.
