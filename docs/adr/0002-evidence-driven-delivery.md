# ADR-0002: Evidence-driven delivery and immutable promotion

**Status:** Accepted
**Date:** 2026-07-27

## Context

Orbit has meaningful automated checks, but feature status was repeated across
several documents and test count was used as a rough proxy for confidence.
Long-lived branches and large pull requests made it difficult to connect a
requirement to its implementation and release evidence.

## Decision

- GitHub milestones and issues own delivery status.
- Version-controlled charters, architecture, threat models, ADRs, and quality
  strategy own durable requirements and decisions.
- Every implementable issue contains acceptance criteria, non-goals, security,
  a test-first plan, operational impact, and required closure evidence.
- Tests are selected by risk and requirement, not by a target count.
- CI runs fast feedback first, builds one production image, and performs
  integration, browser, security, and operational checks against that image.
- A candidate is published only after its gates pass. Manual acceptance records
  the digest. Stable promotion retags that exact digest without rebuilding.
- Protected planning is authored or materially changed only by Sol Extra High.
  Bounded implementation subagents default to Luna Extra High; a different
  model requires fresh user approval.

## Consequences

- Progress can be audited from requirement through issue, test, pull request,
  candidate, and release.
- Coverage data is diagnostic until a measured baseline supports ratcheting.
- Planning attestations are reviewable policy evidence, not cryptographic proof
  of model identity.
- Pull requests should be smaller, and long-lived consolidation branches should
  be retired after their accepted contents reach the release line.

## Alternatives considered

- **Test count or immediate global coverage threshold:** rejected because it
  rewards low-value tests and can freeze an unmeasured legacy baseline.
- **Documentation-only status:** rejected because duplicated prose becomes
  stale and cannot drive protected delivery workflows.
- **Rebuild on promotion:** rejected because the promoted artifact would not be
  the one manually accepted.
