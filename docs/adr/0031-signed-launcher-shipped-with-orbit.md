# ADR-0031: The launcher is built from a pinned tag, signed with the image as one manifest, and shipped with each Orbit release

**Status:** Accepted (owner decisions 2026-09-24; design details proposed)
**Date:** 2026-09-24
**Relates to:** #1107 (this decision); #1075 (owner-started countersignature);
ADR-0020 (validation evidence); ADR-0008 (installer-resolved digests);
ADR-0016 (supported-install floor); `docs/releasing.md`

## Context

A user's first command today is `curl … install.sh | bash` or the launcher's
`get-orbit-launcher.sh`. Neither is signed. The launcher checks its download
against a `checksums.txt` from the same release — whoever can swap the binary
can swap the checksums — and then fetches `install.sh` from Orbit's `main`
branch, which pulls the image by a moving tag with no signature check.
Meanwhile the image carries two signatures (ADR-0020's key-based attestation
and #1075's keyless countersignature) that nothing on a user's machine reads.

The owner decided (issue #1107, "Decided"): orbit-launcher stays its own
project; Orbit builds a pinned, tagged launcher in its own pipeline, signs it
with the image's two signatures and ships the pair; the launcher's own release
lane is not the trusted path; the install script always verifies the key-based
signature with `openssl` against a key built into it, verifies the keyless one
too when `cosign` is present, and refuses to run anything on failure.

This ADR settles the details those decisions leave open.

## Decision

### Amendment (owner, 2026-09-24, #1107 option 21a)

`publish-from-gitlab.yml` runs automatically on every push to `preview` or a
`hotfix/*` branch, with no human in the loop. Giving it `contents: write` so
it could replace the launcher/manifest assets on a rolling `preview`
prerelease (§5, §6 below) meant an automatic workflow could change what
appears on the releases page. The owner decided that must not be possible:
only a human-started workflow may write there.

So `publish-from-gitlab.yml` goes back to `contents: read` and drops the
launcher-asset download, verification and upload steps, and the rolling
`preview` prerelease. It still copies the tested image digest to GHCR; that
never needed write access to releases. A preview install now needs a
verified release manifest handed to `install.sh` directly via
`ORBIT_RELEASE_MANIFEST`; the one-line `get-orbit.sh`/`install.sh` self-fetch
only ever resolves a stable release (`latest` or a `vX.Y.Z` pin) and refuses
`ORBIT_CHANNEL=preview` with a plain message pointing at that hand-over path.
`release-on-tag.yml` (triggered by pushing a tag) and `countersign.yml`
(owner-started) are unaffected: they already ran on human action and keep
their existing `contents: write`.

Rejected: **21b, fold the countersignature upload into `release-on-tag.yml`.**
`release-on-tag.yml` runs on the tag push alone, so folding
`countersign.yml`'s bundle upload into it would make the second signature
either automatic (no human decision that the release is ready to
countersign) or force a manual upload step into every release regardless.
Keeping `countersign.yml` separate and owner-started avoids both.

The sections below describe the design as first proposed and partly
superseded by this amendment; §5's "Preview" bullet and §6's `preview`
handling no longer apply as written.

### 1. One signed release manifest binds everything

Each `preview`/`hotfix/*` pipeline writes `orbit-release-manifest.json`
listing: schema URL, version, channel, Orbit commit, image repository and
digest, the launcher pin (tag, commit), and the sha256 of every shipped file
— the two launcher archives, `install.sh` and `get-orbit.sh`. It is the one
statement "this launcher goes with this image", so it is what gets signed,
not the files one by one. Per-file signatures would prove each file is ours
without proving they belong together, which is the property the pairing
exists for.

The ADR-0020 attestation stays as the publication gate for the image. The
manifest is the consumer-facing companion: it lets a user verify GitLab's
signature over the image digest without read access to
`registry.tomlawson.io`, which `docs/releasing.md` notes the attestation
needs.

### 2. Pin: `launcher/pin.json`, manual bump, compat job uses it

- `launcher/pin.json` holds `{ "tag": "vX.Y.Z", "commit": "<40 hex>" }`.
  Tag alone is movable; commit alone is unreadable. The build refuses if the
  checked-out tag does not resolve to that commit.
- Bumped by hand with `scripts/bump-launcher-pin.sh <tag>`, which resolves
  and writes the commit. Renovate is not used: it cannot fill the commit
  field, and a Renovate MR that fails CI until someone finishes it is noise.
- Compatibility is enforced by the existing `launcher_install_compat` job,
  which stops defaulting `LAUNCHER_REF` to `dev` and instead tests the
  archive `build_launcher` produced from the pin, against the image the same
  pipeline built. A pin that does not work with this Orbit fails the
  pipeline before anything is signed.

### 3. Build: `build_launcher`, GitHub mirror, verified by commit, two platforms

- New job `build_launcher` (stage `acceptance`, runs on every ref the compat
  job runs on). It clones `https://github.com/tomlawesome/orbit-launcher.git`
  as the compat job does today, checks out `pin.tag`, and refuses unless
  `git rev-parse HEAD` equals `pin.commit`. The commit check is what makes
  the source trustworthy, so the public mirror is fine and needs no token or
  job-token allowlist change; GitLab (`ai/orbit-launcher`) stays the source
  of truth for development.
- Builds `linux/amd64` and `linux/arm64` — what the launcher's goreleaser
  config already targets — with the Go version from the launcher's `go.mod`,
  `CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -buildid= -X …release.Version=<tag> -X …release.Revision=<commit>"`,
  and packs each binary as `orbit-launcher_linux_<arch>.tar.gz` (the
  launcher's own archive name, so nothing downstream changes). Artifacts
  kept 90 days, like `record_image`'s.
- `record_image` (which already records the digest) also writes the
  manifest, taking the archive sha256s from `build_launcher`'s artifact and
  hashing `scripts/install.sh` and `scripts/get-orbit.sh` from its own
  checkout.

### 4. Signing: `cosign sign-blob` with the fenced key, openssl-checkable, no tlog

- `sign_evidence` gains a second step after the attestation: it refuses if
  the manifest's `imageDigest` differs from `gitlab-tested-image.json`, then
  runs `cosign sign-blob --key … --tlog-upload=false --use-signing-config=false --output-signature orbit-release-manifest.json.sig`.
  cosign's key-based blob signature is the base64 of a DER-encoded ECDSA
  signature over the file's SHA-256, which is exactly what
  `openssl dgst -sha256 -verify cosign.pub -signature <(base64 -d sig) manifest`
  checks with the committed P-256 key. Same key, same no-transparency-log
  stance as the attestation.
- `publish_channel` verifies the manifest signature **both** ways —
  `cosign verify-blob --key cosign.pub --insecure-ignore-tlog` and the
  `openssl` command above — before it creates the channel tag. That makes
  the openssl compatibility a fact the pipeline proves on every preview, not
  an assumption; if a cosign upgrade ever changes the output format, the
  pipeline fails closed and the fallback is to sign with
  `openssl dgst -sha256 -sign` on the signing runner instead.
- `countersign.yml` extends the same manifest: after countersigning the
  image digest it downloads the manifest and `.sig` from the release assets,
  verifies with `cosign.pub`, refuses if the manifest's digest is not the
  digest it just signed, then `cosign sign-blob --bundle orbit-release-manifest.json.sigstore.json`
  keyless and uploads the bundle to the release (needs `contents: write`).
  Stable releases only, as the owner ruled for the image.

### 5. Publication: GitHub release assets, both channels, nothing rebuilt

Users need plain HTTPS URLs, which a GHCR OCI artifact cannot give them
without extra tools, so the launcher archives, manifest, `.sig`, `install.sh`
and `get-orbit.sh` are **GitHub release assets** on Orbit's releases:

- **Preview: not published automatically (amended, see above).**
  `publish-from-gitlab.yml` only copies the tested image digest to GHCR; it
  does not hold `contents: write` and does not touch the launcher, manifest
  or any release. A preview install passes an already-verified manifest to
  `install.sh` via `ORBIT_RELEASE_MANIFEST` instead.
- **Stable:** `release-on-tag.yml` locates the GitLab pipeline for the tag's
  commit (`scripts/ci/gitlab-await-tested-image.sh` already does this
  lookup), downloads the same artifacts, verifies the `.sig`, and attaches
  them to the release it creates. `main` and `preview` are the same commit
  at promotion, so these are the bytes that were tested and signed; nothing
  is rebuilt and no GitLab job publishes.
- The countersignature bundle arrives later, from `countersign.yml`, on
  stable releases only.

### 6. First-run script: `scripts/get-orbit.sh`

New, small (target under 150 lines, POSIX tools plus `openssl`), fetched by
`curl -fsSL https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/get-orbit.sh | bash`.
`install.sh` is not extended into this role: it is 1,800 lines, is what the
launcher runs, and must stay readable on its own.

Order of operations:

1. Detect `linux/{amd64,arm64}`; refuse anything else. Channel from
   `ORBIT_CHANNEL` (`latest` → `releases/latest/download/…`, the default),
   or `ORBIT_VERSION=vX.Y.Z` for a pin. Stable only (amended, see above):
   `ORBIT_CHANNEL=preview` refuses with a plain message pointing at
   `ORBIT_RELEASE_MANIFEST` for a preview install instead of fetching
   anything.
2. Download the manifest and `.sig`. Verify with `openssl dgst -sha256
   -verify` against the key embedded in the script. Failure or absence:
   delete what was downloaded, print which check failed, exit 1.
3. If `cosign` is on `PATH`: download the `.sigstore.json` bundle and run
   `cosign verify-blob --bundle … --certificate-identity-regexp '^https://github.com/tomlawesome/orbit/' --certificate-oidc-issuer https://token.actions.githubusercontent.com`
   (the identity `countersign.yml` checks its own work against). Since the
   self-fetch path is stable-only, a missing or failing bundle always
   refuses. If `cosign` is absent: one line saying only the key-based check
   ran and how to install cosign.
4. Download the archive and `install.sh`; compare sha256s to the manifest;
   refuse on mismatch.
5. Unpack to `${XDG_CACHE_HOME:-~/.cache}/orbit/<version>/` and `exec` the
   launcher with `ORBIT_LAUNCHER_INSTALL_SCRIPT_PATH` pointing at the
   verified `install.sh` and `ORBIT_RELEASE_MANIFEST` at the verified
   manifest.

`install.sh` then pins the image to the manifest's digest: it pulls
`repository@digest` rather than a tag and refuses if the registry returns
anything else. Run on its own (no manifest passed), it fetches and verifies
the manifest for its channel itself with the same embedded key, so the plain
`install.sh | bash` path is also signature-checked and the `latest` tag
becomes a lookup, never the identity (ADR-0008 already says this of tags).
Its self-fetch is stable-only too (amended, see above): `ORBIT_CHANNEL=preview`
refuses before fetching anything, with the same guidance to pass
`ORBIT_RELEASE_MANIFEST` instead. When `cosign` is present it also runs
`cosign verify` on the digest with the identity above, refusing on stable
when it fails; this part of `install.sh` is unchanged by the amendment,
since a manifest handed over via `ORBIT_RELEASE_MANIFEST` can still name
`ORBIT_CHANNEL=preview`.

**Bootstrap, stated plainly.** `get-orbit.sh` itself arrives unsigned over
HTTPS. That protects against a network attacker altering it in transit. It
does **not** protect against whoever can write to `main` on the GitHub
mirror, who could serve a script with a different embedded key that accepts
their manifest. Everything after step 2 is only as good as that key. A
careful user can: (a) read the script before running it — it is short by
design; (b) compare the embedded key with `cosign.pub` at the release tag
and with the fingerprint published in `docs/releasing.md`; (c) fetch the
script from a tag (`…/orbit/vX.Y.Z/scripts/get-orbit.sh`) rather than
`main`, and check its sha256 against the one the release manifest lists.
None of that closes the loop fully — a fully trusted first download needs a
key the user already holds — and the docs say so rather than implying
otherwise.

### 7. Key handling

- The embedded key in `get-orbit.sh` and `install.sh` is the PEM in
  `cosign.pub`, byte for byte. A test (`scripts/get-orbit.test.mjs`) fails if
  either drifts from `cosign.pub`; `publish_channel`'s openssl check proves
  the committed key verifies the real signature on every preview.
- Rotation (already described in `docs/releasing.md`) additionally means:
  the scripts on `main` verify only releases signed after the rotation.
  `latest` and `preview` always are; a user pinning an older
  `ORBIT_VERSION` must fetch `get-orbit.sh` from that version's tag. One key
  at a time; no key list.

### 8. orbit-launcher's `get-orbit-launcher.sh`

Stays, for developers only: by default it prints that users should run
Orbit's `get-orbit.sh` and exits non-zero; `ORBIT_LAUNCHER_DEVELOPER=1`
restores today's behaviour. Its README points at Orbit's script. These, and
the `ORBIT_LAUNCHER_INSTALL_SCRIPT_PATH` variable in §6, are changes in the
orbit-launcher project and need their own issue there; nothing in Orbit
makes them.

## Consequences

- Trust chain for a user: HTTPS → `get-orbit.sh` (embedded key) → signed
  manifest → launcher, `install.sh`, image digest. Two signatures on stable
  when `cosign` is present; one, GitLab's, always.
- A launcher pin bump is an ordinary MR gated by `launcher_install_compat`.
- Release assets appear on GitHub within minutes of `promote_stable`; the
  countersign bundle when the owner runs `countersign.yml`. Until then a
  `cosign` user installing stable is refused — intended, and why
  `docs/releasing.md` says to countersign straight after promoting.
- Three GitHub workflows gain a GitLab artifact download and a `.sig`
  verification; all use the read token they already hold.
- Launcher changes (§6 step 5, §8) block the end-to-end path; the launcher
  keeps working via the old route until they land.

## Alternatives rejected

- **Merge the launcher source into Orbit.** Ruled out by the owner.
- **Per-file `sign-blob` signatures.** Do not bind launcher to image.
- **GHCR OCI artifact for the launcher.** Needs `oras`/`crane` on the user's
  machine; contradicts "no extra tools".
- **Build on promotion.** Violates "nothing is rebuilt on promotion"
  (ADR-0002, ADR-0020); the bytes tested must be the bytes shipped.
- **Renovate for the pin.** Cannot fill the commit; produces half-done MRs.

## Open questions for the owner

- orbit-launcher has no stable `vX.Y.Z` tag yet (only `preview-latest`).
  The first pin needs one: run the launcher's `promote.yml` once, or accept
  pinning a `preview-*` tag plus commit until then?
- The orbit-launcher changes in §6/§8 are cross-project; who files and
  delivers them?

## Implementation slices

Each is one commit, in order; files named.

1. `launcher/pin.json`; `scripts/bump-launcher-pin.sh` (resolves tag →
   commit via `git ls-remote`, refuses non-`v*` tags); `scripts/bump-launcher-pin.test.mjs`.
   Pin value awaits the owner's answer above.
2. `.gitlab-ci.yml`: `build_launcher` job (clone, checkout, commit check,
   two builds, two tarballs, 90-day artifacts); `launcher_install_compat`
   consumes its artifact and drops `LAUNCHER_REF: dev`.
3. `scripts/ci/write-release-manifest.sh` (+ `.test.mjs`) called from
   `record_image`; manifest schema as §1; validated field shapes as
   `gitlab-record-tested-image.sh` does.
4. `scripts/ci/sign-release-manifest.sh` (+ `.test.mjs`, stubbing cosign
   like `scripts/attest-tested-image.test.mjs`): digest cross-check, then
   `sign-blob`; wired into `sign_evidence`, artifact `.sig` 90 days.
5. `scripts/ci/verify-release-manifest.sh` (+ `.test.mjs`): cosign **and**
   openssl verification, shared by every consumer below; called from
   `publish_channel` before tagging.
6. `scripts/get-orbit.sh` (+ `scripts/get-orbit.test.mjs`: key equals
   `cosign.pub`, refusal on bad sig, bad sha, unsupported arch, `preview`
   without bundle continues, `latest` without bundle refuses when a fake
   `cosign` is on PATH).
7. `scripts/install.sh`: accept `ORBIT_RELEASE_MANIFEST`; otherwise fetch
   and verify the manifest for `channel`; pull by digest; optional
   `cosign verify`; embedded key covered by the test in slice 6.
8. `.github/workflows/publish-from-gitlab.yml`: download launcher artifacts
   + manifest + `.sig`, verify (slice 5 script), replace assets on the
   `preview` prerelease.
9. `.github/workflows/release-on-tag.yml`: same download and verify,
   attach assets to the new release; `contents: write` already present.
10. `.github/workflows/countersign.yml`: manifest bundle step (§4),
    `contents: write`.
11. Docs: `docs/releasing.md` (manifest, assets, rotation note, key
    fingerprint), `docs/installer-guarantees.md` (what is and is not
    checked, bootstrap caveat), `README.md` (new first command); ADR index
    already updated with this ADR.
12. Owner-run end-to-end on a throwaway tag, as #1075 requires; then the
    orbit-launcher issue for §6/§8 is delivered and the old
    `get-orbit-launcher.sh` route is retired for users.
