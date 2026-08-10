# Architecture decision records

ADRs record durable, cross-cutting decisions and their consequences. GitHub
issues track delivery work; ADRs do not contain changing implementation status.

## Governance

- Luna may identify, research or draft an ADR, but Sol Extra High must assess
  the broader context, rationale, alternatives and consequences. Luna must
  respect and present that assessment; the human owner makes the final decision.
- Use the next four-digit number and a short lowercase filename.
- State the context, decision, consequences, alternatives, and supersession
  relationship.
- Do not rewrite accepted history to make an old decision appear current.
  Supersede it with a new ADR.

## Index

- [ADR-0001: Self-hosted single-instance deployment](0001-self-hosted-single-instance.md)
- [ADR-0002: Evidence-driven delivery and immutable promotion](0002-evidence-driven-delivery.md)
- [ADR-0003: Protected preview lane and stable promotion](0003-gitflow-preview-and-stable-channels.md)
- [ADR-0004: Supported upgrades and recoverable restore](0004-supported-upgrades-and-recoverable-restore.md)
- [ADR-0005: Private reviewed ingestion and mailbox staging](0005-reviewed-ingestion-and-mailbox-staging.md)
- [ADR-0006: Online-authoritative private workspace](0006-online-authoritative-private-workspace.md)
- [ADR-0007: Dual-pipeline agent governance](0007-dual-pipeline-agent-governance.md)
- [ADR-0008: Installer-resolved release digests](0008-installer-resolved-release-digests.md)
- [ADR-0009: Sol-governed, capability-routed implementation](0009-capability-routed-implementation.md)
- [ADR-0010: Outage-recoverable document scanning](0010-outage-recoverable-document-scanning.md)
- [ADR-0011: Luna-first orchestration with bounded Sol authority](0011-luna-first-orchestration.md)
