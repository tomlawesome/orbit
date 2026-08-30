# ADR-0016: Release identity across eras, and the installer's era boundary

**Status:** Accepted
**Date:** 2026-08-30
**Relates to:**
[ADR-0003](0003-gitflow-preview-and-stable-channels.md) (channels and
immutable tags); [ADR-0004](0004-supported-upgrades-and-recoverable-restore.md)
(supported prior versions); issue #676; issue #532's
`exact-image-prior-version` journey

## Context

Promotion retags a tested digest and never rebuilds (`docs/releasing.md`), so
the `org.opencontainers.image.version` label inside a promoted image is
whatever the candidate build wrote. Two eras wrote different things:

- The v1.0.0-era lane labelled candidates `preview-release-vX.Y.Z-<run>-<n>`.
  The published `v1.0.0` — the only version tag an operator can pin today —
  carries that form permanently.
- The current lane calculates the final version before building
  (`scripts/calculate-version.mjs`), labels the candidate with it, and
  verifies label equals calculation at build and again at promotion. Modern
  artifacts therefore already satisfy `install.sh`'s semver gate.

`install.sh:1329` required the label to be a bare `vX.Y.Z`, so it refused
v1.0.0 outright (#676). Fixing the label gate alone is not enough: the
installer also fetched **all** of its assets from the image's stamped
revision, and four of the helper scripts it invokes (`configuration.sh`,
`installer-ui.sh`, `repair.sh`, `engine-check.sh`) do not exist at v1.0.0's
revision — they postdate it. Two different couplings were conflated in one
fetch:

- **Era assets** (compose files, `.env-orbit.example`, `config/tika-config.xml`)
  configure the image that will run. They must match the image's era, which is
  why they come from its stamped revision.
- **Installer helpers** (`configure.sh`, `installer-ui.sh`, `configuration.sh`,
  `backup.sh`, `restore.sh`, `repair.sh`, `engine-check.sh`) are invoked by
  the running `install.sh` with its exact flags. They must match the
  installer, not the image.

## Decision

1. **Version labels are established before promotion.** The current scheme —
   candidate built already carrying its final `vX.Y.Z` label, verified at
   build and promotion — is the standing contract. Promotion continues to
   retag without rebuilding.
2. **`install.sh` accepts exactly the two producer forms** for the version
   label: `vX.Y.Z`, and the historic candidate form
   `preview-release-vX.Y.Z-<run>-<attempt>`, from which it derives the
   semantic version. Anything else is refused, as before.
3. **A version-tag install binds tag to embedded version.** When
   `ORBIT_CHANNEL` is itself a `vX.Y.Z` tag, the derived embedded version
   must equal it, or the install is refused. This is a strictly stronger
   gate than the one it replaces: an arbitrary image parked at a version tag
   is refused unless the label inside its digest names that same release.
   The deployment's recorded version is always the derived semantic version,
   never the raw label.
4. **The canonical-banner identity check applies from the current label
   era.** Candidate-form-labelled artifacts predate `--banner` entirely —
   v1.0.0's entrypoint exits into its startup refusal instead — so for
   exactly that era the installer proceeds on the digest resolution plus the
   revision and version binding, and says so. Modern images must render the
   banner or be refused, unchanged.
5. **The installer fetches by coupling, not by one base.** Era assets come
   from the image's stamped revision (unchanged — a compose file cannot
   drift from the image it configures). Installer helpers come from the same
   source the operator fetched `install.sh` from: `main`, the README's
   bootstrap URL. A prior-version deployment thereby receives the current
   operational scripts — including `repair.sh`, which prior versions predate
   — which is what makes repair and backup/restore support for prior
   versions real rather than aspirational.

## Consequences

- The published v1.0.0 installs by its version tag with today's bootstrap;
  `scripts/test-repair-journeys.sh`'s `exact-image-prior-version` journey
  proves it live against the real artifact, then proves current repair and
  backup/restore against the running prior version.
- Helper scripts and `install.sh` can drift only within the window between
  an operator fetching `install.sh` and it fetching helpers — seconds, from
  the same branch. The previous behaviour pinned helpers to the *image's*
  era instead, which is the wrong coupling and broke every pre-repair-era
  install.
- Historic tags stay immutable audit evidence (ADR-0003); nothing is
  relabelled or republished.
- The unit gate (`scripts/install.test.mjs`, "release identity gate (#676)")
  fails if the label forms and the installer's acceptance ever diverge
  again.

## Alternatives considered

- **Loosen the semver regex until the candidate label passes:** rejected —
  it removes the guarantee instead of honouring it (#676's security note).
- **Relabel or republish v1.0.0:** rejected — historic tags are immutable
  audit evidence (ADR-0003, `docs/releasing.md`).
- **Dispatch to the prior era's own installer:** rejected — v1.0.0's
  `install.sh` predates the standalone bootstrap contract entirely, so the
  one version that needs the path cannot use it.
- **Fetch helpers from the image revision, era assets from `main`:** the
  inverse split; rejected because both couplings end up wrong.
