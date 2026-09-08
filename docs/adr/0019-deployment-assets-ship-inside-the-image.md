# ADR-0019: Deployment assets ship inside the image

**Status:** Accepted
**Date:** 2026-09-08
**Relates to:** [ADR-0003](0003-gitflow-preview-and-stable-channels.md)
(immutable digests); [ADR-0016](0016-release-identity-and-installer-era-boundary.md),
whose "every asset comes from the revision stamped into the image" rule this
replaces; issue #890

## Context

`install.sh` pulls the image, resolves its digest, reads the
`org.opencontainers.image.revision` label, and then downloads the eleven
deployment assets (compose files, `.env-orbit.example`, the Tika
configuration, and the seven operator scripts) from
`raw.githubusercontent.com/tomlawesome/orbit/<revision>/` with plain `curl`.
Upgrades take the same path.

On 2026-09-08 the repository's history was rewritten (#825). Every commit id
changed, the images published as `latest` (v1.2.0) and `preview` (v1.3.0
candidate) still named the old ids, GitHub answered 404, and every fresh
install on both channels failed (#890). Existing installs were unaffected
until their next upgrade.

The rewrite was the trigger, not the defect. The defect is that half of what
an install needs lives outside the digest-pinned artifact:

- the assets are keyed by a commit id, so any event that makes that id
  unreachable — a rewrite, a repository move or rename, a private mirror —
  breaks every published image at once;
- they come from a third host over an unauthenticated fetch with no checksum,
  so nothing binds the compose file to the image it configures except the
  hope that the URL still serves the same bytes;
- the installer needs GitHub to be up and unthrottled at install time;
- CI cannot test a merge-request commit without a `curl` shim
  (`scripts/ci/assets-from-tree.sh`, and two more in the acceptance and
  repair harnesses), because the commit is not on GitHub yet.

## Decision

1. **The image carries its own deployment assets.** The Dockerfile copies the
   eleven files, at the same relative paths, to `/opt/orbit/deploy/`. They
   are part of the image digest and therefore of every piece of provenance
   evidence the pipeline already produces for it.
2. **The installer extracts them from the image it just resolved.** After the
   digest and label checks, `install.sh` runs `docker create` on the resolved
   reference and `docker cp` on `/opt/orbit/deploy/`, then removes the
   container. No process runs inside the image for this; the existing checks
   (fixed allowlist, regular non-empty non-symlink files, `bash -n` on
   scripts) are applied to the extracted files exactly as they were to the
   downloaded ones. The `raw.githubusercontent.com` fetch is removed, not kept
   as a fallback: a second source for the same files is the drift this
   decision removes.
3. **An image without `/opt/orbit/deploy/` is refused** with a message saying
   it was built before assets were bundled and is not a supported install
   target. ADR-0016 already put the floor at v1.3.0; v1.3.0 is the first
   release built under this decision, so no supported image is affected.
4. **The launcher-compatibility job tests one generation.** It installs the
   image built by the same pipeline, served from the loopback registry the
   acceptance job already uses, instead of the published `preview` image.
   Pairing a candidate `install.sh` with last week's image could never gate a
   change to the installer/image contract without deadlocking on itself.

## Consequences

- A published image is installable for as long as the registry serves it,
  with no dependency on GitHub, on a branch, or on a commit id.
- The compose file cannot drift from the image it configures: they are the
  same digest.
- The three CI `curl` shims are deleted; the acceptance and repair harnesses
  exercise the real extraction path.
- Images published before this decision (`latest` = v1.2.0, and every
  `preview` before the first build carrying assets) stay broken for fresh
  installs. The fix for `latest` is the next stable release, not a patch to
  the unsupported v1.2 line.
- The bootstrap line (`curl …/main/scripts/install.sh | bash`) still fetches
  the installer itself from GitHub. That is one file, from a branch name, and
  it fails visibly before anything is touched; it is out of scope here.

## Superseded

Keeping the revision fetch as a fallback for older images was considered and
dropped: the only images it would serve are the ones whose revisions no
longer exist, and ADR-0016 already declares them unsupported.

Publishing a v1.2.1 from `main` to repair `latest` without this change was
considered and dropped: it would republish the same fragile path, for a line
ADR-0016 does not support.
