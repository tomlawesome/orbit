# ADR-0016: The supported-install floor is v1.3.0

**Status:** Accepted
**Date:** 2026-08-30
**Relates to:**
[ADR-0003](0003-gitflow-preview-and-stable-channels.md) (channels and
immutable tags);
[ADR-0004](0004-supported-upgrades-and-recoverable-restore.md), whose upgrade
floor this supersedes; issue #676

## Context

`install.sh` refused `ghcr.io/tomlawesome/orbit:v1.0.0`, the only version tag
an operator could pin (#676). Promotion retags a tested digest and never
rebuilds, so a promoted image keeps the version label its candidate build
wrote, and the v1.0.0-era lane wrote `preview-release-v1.0.0-<run>-<attempt>`
rather than a bare `vX.Y.Z`.

Investigating that refusal against the real published artifact found it was
not one mismatch but three. `v1.0.0`'s entrypoint has no `--banner`, so the
canonical-identity check could never pass for it. And four of the helper
scripts `install.sh` invokes — `configuration.sh`, `installer-ui.sh`,
`repair.sh`, `engine-check.sh` — do not exist at that revision at all, so
repair and backup support for that release could not work in principle,
whatever the label said.

Supporting it would therefore have meant era-branching the installer in three
places, and each branch would have to stay correct for as long as the release
remained supported.

## Decision

1. **The supported-install floor is v1.3.0.** `install.sh`, `repair.sh` and
   the rest of the operator tooling need only work against v1.3.0 and later.
   Releases published before it — `v1.0.0`, and the `v1.2.0` build carried by
   `latest` — are not supported install targets, and no compatibility branch
   is carried for them (owner decision, 2026-08-30).
2. **Backward compatibility is required from v1.3.0 onward.** Once a later
   release exists, installing, repairing and restoring a still-supported
   earlier release must work. Every revision from v1.3.0 carries the full
   helper-script set, so the installer's existing rule — every deployment
   asset comes from the revision stamped into the image it pulled — satisfies
   this without special cases, and keeps a compose file from drifting from
   the image it configures.
3. **A version-tag install binds the tag to the image's embedded version.**
   When `ORBIT_CHANNEL` is a `vX.Y.Z` tag, the image's own
   `org.opencontainers.image.version` must name that same release, or the
   install is refused. A tag can be moved; the label inside a digest cannot,
   so an image merely parked at a version tag is not evidence that it is that
   version. Moving channel tags such as `latest` and `preview` make no such
   claim and are unaffected.

## Consequences

- The installer stays single-path. No label-era branching, no banner
  exception, no split fetch base.
- Pinning a version tag is now a stronger guarantee than before this decision,
  not a weaker one: the previous check accepted any image with a well-formed
  version label, including one that named a different release.
- ADR-0004's upgrade floor — the pre-v1 engineering preview at commit
  `8a8e37e2bbef770de9a203e86a674f70834e2a18` — is superseded for *install*
  and operator tooling by decision 1. ADR-0004's migration, restore and
  recovery contracts are otherwise unchanged.
- Historic tags remain immutable audit evidence (ADR-0003). Nothing is
  relabelled or republished; those artifacts simply are not supported install
  targets.
- Prior-version evidence cannot be gathered until a release after v1.3.0
  exists. The repair-journey harness reports
  `exact-image-prior-version` as `absent` rather than approximating it.

## Superseded

An earlier draft of this ADR made the installer support the v1.0.0 era: it
accepted the historic candidate label form and derived the version from it,
era-gated the canonical-banner check, and split the fetch so helper scripts
came from `main` while era assets came from the image's revision.

That draft was dropped once the supported floor was set at v1.3.0. It is
recorded here because the third part was also **wrong**, and the reason is
worth keeping: `main` tracks the last stable release, so it is by
construction behind `dev`. Pinning helper scripts to `main` broke every
install whose `install.sh` was newer than the last release — CI, `dev`,
`preview` and any developer checkout — because `main` does not yet carry
`installer-ui.sh` or `repair.sh`. Both test harnesses' curl shims serve any
ref from the working tree, so their runs passed regardless; only CI, fetching
over the real network, exposed it.

The lesson that outlives the draft: "the source the operator fetched
`install.sh` from" is not the same thing as the branch `main`, and a harness
that serves every ref from one tree cannot tell the two apart.

## Alternatives considered

- **Support the v1.0.0 era** (the superseded draft): rejected as three
  permanent compatibility branches for a release nobody is required to run.
- **Loosen the semver check until the historic label passes:** rejected — it
  removes the guarantee rather than honouring it (#676's security note).
- **Relabel or republish `v1.0.0`:** rejected — historic tags are immutable
  audit evidence (ADR-0003, `docs/releasing.md`).
