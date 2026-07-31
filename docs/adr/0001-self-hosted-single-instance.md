# ADR-0001: Self-hosted single-instance deployment

**Status:** Accepted
**Date:** 2026-07-27

## Context

Orbit needs a professional deployment that a household can operate without a
custom service fleet. The existing application combines UI, authenticated API,
migrations, and workers in one Next.js container and uses standard PostgreSQL,
private file storage, and replaceable provider adapters.

Designing stable v1 simultaneously for managed multi-tenant SaaS would add
tenant routing, fleet operations, billing-grade isolation, distributed
storage, and horizontal coordination before the core household workflow is
proven.

## Decision

Stable v1 supports one self-hosted Orbit instance with multiple authenticated
users and households:

- one Orbit application container;
- one PostgreSQL 17 service;
- one private encrypted local document volume;
- an external OIDC provider;
- isolated ClamAV when scanning is enabled;
- optional, replaceable Tika, IMAP, SMTP, Web Push, and local-model services.

Server-side household authorization remains mandatory even though the
deployment is single-instance. Optional providers may degrade only their own
capability. Orbit does not require the Docker socket.

## Consequences

- Installation, update, backup, restore, and diagnostics can target one
  documented topology.
- The application keeps replaceable boundaries around identity, storage,
  scanning, parsing, mail, and model providers.
- Horizontal scaling, object storage, fleet management, and managed SaaS are
  deferred. They require new ADRs and threat-model changes.
- A later hosted service must not assume this ADR already proves tenant-grade
  isolation or distributed worker safety.

## Alternatives considered

- **Managed SaaS now:** rejected because it materially expands security and
  operational scope before v1 value is proven.
- **Multiple custom application services:** rejected because current
  responsibilities can remain modular inside one maintainable deployment.
- **Embedded database:** rejected because PostgreSQL already supplies the
  transactions, constraints, and coordination required by the product.
