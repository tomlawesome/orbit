# ADR-0008: Installer-resolved release digests

**Status:** Accepted
**Date:** 2026-07-31

Supersedes the "no implicit `latest` deployment default" position recorded in
[ADR-0002](0002-evidence-driven-delivery.md) and `docs/supply-chain.md`, in the
narrow respect described below. It does not supersede digest-pinned deployment,
attestation, or exact-digest promotion.

## Context

Installation should be a single pasteable command that works in every
environment. The existing installer cannot be that: it clones the whole source
repository, requires Git, and blocks on an interactive prompt read from
`/dev/tty`, which fails under CI, non-TTY SSH and cloud-init. Choosing the
prebuilt path additionally requires the operator to discover a
`registry/repository@sha256:...` digest by hand before installing.

The obstacle to automating that lookup was the supply-chain rule, expressed as:
no deployment script may name a mutable image reference. It was enforced by a
test asserting that `install.sh` contains no `:latest` reference and does
contain the string directing an operator to set an exact digest.

That expression is broader than the property it protects. The guarantee that
matters is that **a deployment runs an immutable, attested artifact**. Naming a
tag in order to resolve it to a digest does not weaken that guarantee; the
resolved digest is still what is recorded and deployed. What the rule actually
prevented was automating a lookup a human was expected to perform manually.

## Decision

- A mutable tag **may be resolved** to a digest by a deployment script.
- A mutable tag **may never be deployed**. Every assignment of `ORBIT_IMAGE`
  must produce a `registry/repository@sha256:...` identity or an explicitly
  local build tag.
- An indirect assignment is permitted only where the script proves the digest
  format before the value becomes the deployment reference.
- Enforcement follows the property rather than a literal string, so the rule
  survives a rewrite of the installer.
- Nothing else relaxes: images are still scanned, attested by digest, and
  promoted by exact digest without rebuilding. `latest` remains a convenience
  pointer, never deployment or acceptance evidence.

## Consequences

- Installation can become a single non-interactive command that pins the
  resolved digest into the environment file, which is what
  [issue #143](https://github.com/tomlawesome/orbit/issues/143) delivers.
- The recorded deployment reference is still an immutable digest, so existing
  evidence, rollback and promotion procedures are unchanged.
- The rule is now expressed as policy data and enforced by a property test with
  explicit negative cases, so widening it again would require deleting a test
  that names the behaviour it forbids.
- An operator who prefers to supply a digest by hand may still do so; automated
  resolution is a default, not a requirement.
- The resolution step becomes a supply-chain surface of its own: it must fail
  closed if the registry returns anything that is not a digest, rather than
  falling back to deploying the tag.

## Alternatives considered

- **Leave the rule as written and require a manual digest:** rejected because
  it makes the stated goal — one pasteable command that works everywhere —
  unreachable, for a guarantee the amendment preserves anyway.
- **Allow deploying a mutable tag when the operator opts in:** rejected. It
  removes the property that a deployment is reproducible and attestable, which
  is the whole point of digest pinning, and an opt-in becomes a default in
  practice.
- **Resolve the digest in CI and bake it into the installer:** rejected because
  the installer would then pin a release chosen at CI time rather than at
  install time, and would go stale silently between releases.
- **Keep the literal-string test alongside the property test:** rejected
  because the literal string describes an implementation that is being
  replaced; retaining it would fail the moment the installer is rewritten,
  without expressing anything the property test does not.
