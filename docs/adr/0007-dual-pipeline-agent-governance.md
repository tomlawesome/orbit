# ADR-0007: Dual-pipeline agent governance

**Status:** Superseded by [ADR-0009](0009-sol-owned-bounded-agent-delegation.md)
**Date:** 2026-07-31

## Context

Orbit's agent governance was written around a single agent pipeline.
`.github/orchestration-governance.json` named only the Codex tiers, and
`scripts/check-orchestration-governance.mjs` asserted single-model equality for
orchestration, protected planning and implementation. `.github/planning-governance.json`
accepted exactly one attestation string, `Planning-Model: Sol Extra High`.

Two problems followed. A second pipeline could not be admitted without editing
validator source, so pipeline membership was code rather than reviewed policy
data. And because the attestation was a single hardcoded model name, there was
no truthful attestation available to a Claude pipeline or to a human owner
authoring protected planning directly — the only way to pass the gate was to
attest as a model that had not done the work, which `AGENTS.md` forbids.

A Claude review of the authenticated sign-in flow found and fixed an
exploitable open redirect (issue #110), demonstrating value in a second
pipeline whose findings are independent of the first. Admitting that pipeline
required governance to express more than one authority.

## Decision

- Orbit recognises two peer agent pipelines, Codex and Claude, with equivalent
  authority tiers: an orchestration tier that also owns protected planning, an
  implementation tier, and a mechanical-analysis tier.
- Codex maps to Sol Extra High, Luna Extra High and Terra Medium. Claude maps
  to Claude Opus Extra High and Claude Sonnet Extra High, with Sonnet serving
  both the implementation and mechanical-analysis roles.
- Pipelines and their tiers are declared as data in
  `.github/orchestration-governance.json`. Role authority is derived from those
  declarations, and authority may never name a model outside the declared
  roster. Admitting a pipeline is therefore a reviewed data change, not a
  validator edit.
- The planning-governance gate accepts one attestation per authority, plus an
  explicit `Planning-Model: Human` value for protected planning a human owner
  authored or directed.
- Protected control adoption is approved by any protected-planning authority or
  by the human owner, rather than by one named model.
- Cross-pipeline conduct is defined in `AGENTS.md`: reserved branch namespaces,
  mandatory pipeline attribution, non-interference with another pipeline's
  branches and pull requests, encouraged cross-pipeline review, precedence for
  the earlier-opened pull request on shared work, and explicit handoffs.

## Consequences

- Authority remains explicit and validated; it is widened by reviewed policy
  data, never by an unlisted model appearing at runtime.
- Every protected-planning change has a truthful attestation available,
  including changes a human owner makes directly. The prohibition on false
  attestation becomes enforceable rather than unsatisfiable.
- Findings from one pipeline can be reviewed and delivered by the other without
  ambiguity about who authored what.
- The `sol_review` delivery stage keeps its identifier for state-machine
  compatibility while denoting orchestration review by whichever pipeline is
  active.
- This ADR was drafted by Claude under human direction and attested
  `Planning-Model: Human`, since the policy decisions it records were the
  owner's. Subsequent Claude-authored protected planning attests as
  `Planning-Model: Claude Opus Extra High`.

## Alternatives considered

- **Keep a single pipeline and forbid Claude from protected planning:**
  rejected because it leaves the human-authorship gap unsolved and discards
  independent review value, while the owner's intent was explicit parity.
- **Delete the exclusivity assertions outright:** rejected because authority
  could then silently widen to any model name with nothing validating it. The
  assertions carried real intent that roster derivation preserves.
- **A flat allowlist of permitted model names:** rejected because it loses the
  tier relationship, so nothing would prevent an implementation tier being
  granted orchestration authority.
- **Renaming the `sol_review` stage to a pipeline-neutral identifier:**
  rejected for this change because it breaks the persisted state machine and
  example state for a cosmetic gain; it can be superseded later if warranted.
