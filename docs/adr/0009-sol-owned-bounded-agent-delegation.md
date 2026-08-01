# ADR-0009: Sol-owned orchestration with bounded agent delegation

**Status:** Accepted
**Date:** 2026-08-01
**Supersedes:** [ADR-0007](0007-dual-pipeline-agent-governance.md)

## Context

ADR-0007 admitted Codex and Claude as peer pipelines with equivalent
orchestration and protected-planning tiers. Subsequent delivery showed that
Claude was useful for implementation and independent findings, but peer
authority made project management, architecture, sequencing, integration and
release ownership ambiguous. The repository owner instead requires one
accountable automated orchestration authority while preserving Claude's useful
implementation capacity and truthful provenance.

The planning gate also returned the first accepted attestation it found. A body
with duplicate or conflicting accepted lines therefore passed despite the prose
claim that exactly one attestation was required.

## Decision

- Sol Extra High is the sole automated authority for orchestration, protected
  planning, architecture, security, delivery sequencing, integration,
  publication, reconciliation and release decisions. A human owner remains an
  explicit protected-planning authority for work they author or direct.
- Claude is the preferred bounded implementation provider. Sol selects Claude
  Haiku for mechanical implementation and Claude Sonnet for substantive bounded
  implementation. Luna Extra High is used only when Claude is unavailable or
  its capacity is exhausted.
- Delegated implementation receives an exact base, path allowlist, tests and
  stop conditions. It cannot edit protected planning, expand scope, receive
  credentials, use Git/GitHub/shell/browser/MCP tools, mutate remote state,
  manage delivery or approve its own work.
- Sol independently reviews and integrates handbacks while preserving truthful
  authorship and provenance. Branch namespaces represent delivery ownership,
  not autonomous peer authority.
- Opus-class Claude review requires fresh task-specific user approval. It is
  advisory evidence only and transfers no approval, integration or release
  authority.
- A protected pull request must contain exactly one standalone accepted
  `Planning-Model:` line for Sol Extra High or a human owner. Missing,
  duplicate, conflicting, unsupported and ambiguous declarations fail.
- ADR-0007 and its control evidence remain in history. Its peer-authority
  control is retired explicitly rather than deleted.

## Consequences

- Delivery has one accountable automated decision-maker while implementation
  capacity can be drawn economically from Claude and, only as fallback, Luna.
- Claude findings and code remain useful inputs, but cannot become policy or
  remote state without independent Sol review and protected CI.
- Historic decisions, authorship and evidence remain auditable; supersession
  changes current authority without erasing the route taken to it.
- Planning-attestation ambiguity fails closed and produces deterministic CI
  evidence.

## Alternatives considered

- **Retain peer pipelines but add more coordination rules:** rejected because
  coordination does not remove ambiguous final authority.
- **Forbid Claude entirely:** rejected because bounded implementation and
  advisory review provide useful independent capacity when kept least
  privileged.
- **Use Luna before Claude:** rejected because the owner requires Claude usage
  to preserve Codex allowance; Luna remains a capacity fallback.
- **Delete ADR-0007 and its controls:** rejected because that would remove
  learning, provenance and traceability rather than record supersession.
