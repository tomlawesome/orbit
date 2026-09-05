# Orbit supply-chain evidence

Orbit treats supply-chain evidence as a publication gate, not as an
informational report produced after an image is released. The binding policy is
`.github/supply-chain-policy.json`; `scripts/supply-chain-policy.mjs` validates
that policy and converts scanner output into bounded review evidence.

## Trusted workflow

Every merge request on GitLab and every push to `preview` performs these
steps. GitLab (`.gitlab-ci.yml`) is the gate since #801; GitHub runs the same
checks on its mirror as a second opinion that blocks nothing.

1. A separate read-only `licence_policy` job walks the whole installed
   dependency tree -- not a pull-request diff -- and checks every package's
   declared licence against `supply-chain/licence-policy.yml`. This replaces
   GitHub's `actions/dependency-review-action`, which ran only on the
   `pull_request` event and stopped running when the mirror flip (#801) left
   GitHub with no pull requests to compare (#815). The vulnerability half of
   what that action covered is unaffected: it was already the
   `supply_chain_source` job below.
2. A read-only job scans the checked-out repository for dependency
   vulnerabilities and secret patterns. Checkout credentials are not
   persisted. The raw secret-scan report is never uploaded and is deleted
   after a sanitized finding record is generated.
3. Fast and PostgreSQL integration checks must pass along with the source
   policy before container validation can advance.
4. CI builds one AMD64 production image, records its configuration identity,
   then scans that local identity for vulnerabilities and generates an SPDX
   2.3 SBOM.
5. The repository policy verifies that the vulnerability report and SBOM name
   the same image that enters Compose, recovery, privacy, browser and
   accessibility tests.
6. Merge requests stop with read-only evidence. Only a push to `preview` or a
   hotfix branch reaches a registry, and only after every preceding gate
   passes.
7. GitLab's `publish_gitlab` job pushes that exact tested image to
   `registry.tomlawson.io` without rebuilding, resolves the registry digest,
   pulls it back, verifies its configuration identity and records the digest
   as `gitlab-tested-image.json`.
8. When the mirror delivers the same commit to GitHub,
   `publish-from-gitlab.yml` waits for that pipeline, checks the record names
   this commit, copies the digest to GHCR with `crane copy` and refuses if the
   copy resolves to anything else. Nothing built on GitHub reaches GHCR.
9. GitHub mints short-lived OIDC provenance and SBOM attestations for the
   copied digest, using the SBOM GitLab produced, and verifies both before
   recording a deployable preview.

The source, exact-image and attestation-verification artifacts are retained for
14 days. They contain public package and image metadata, bounded finding
identifiers and policy decisions. They must not contain secret matches,
private runtime configuration or environment values.

## Policy and exceptions

High and critical dependency or image vulnerabilities block publication.
Every repository secret finding blocks regardless of its scanner severity.
Lower-severity vulnerabilities remain visible in the retained evidence.

Dependency licences are governed separately from the full source and image
scans. `supply-chain/licence-policy.yml` allows only the listed
SPDX-compatible permissive or file-level reciprocal licences, and
`scripts/ci/licence-policy.mjs` (the `licence_policy` job) checks every
package's declared licence against it across the whole installed tree, not
just newly introduced ones. A licence outside the allow-list blocks
automatically. Missing or ambiguous licence metadata blocks the same way:
there is no manual-review pass-through. There are no advisory or package
licence exemptions for source dependencies. Any exemption must be narrow,
justified, owned, time-bounded and linked to a tracking issue. Vulnerabilities
are unaffected by this job; they remain governed by `supply_chain_source`
below.

A vulnerability exception is valid only when it identifies the finding,
package and scope, names an owner, gives a rationale, links a tracking issue
and has not expired. Secret findings have no exception path. The policy
validator fails closed on stale or malformed exceptions. Exceptions do not
change scanner output; they make a narrow, reviewable publication decision for
a known vulnerability.

The `exceptions[]` list currently holds the pinned sidecar findings that had
no upstream fix to pin to on 2026-09-04 (#740): OpenSSL 3.5.7 in the Node and
Postgres images until those tags are rebuilt, and Go standard-library findings
compiled into `gosu`, Tika's `pebble` and the Ollama binary. Each entry names
the installed version it was seen in, so a rebuilt image that is still
vulnerable is blocked afresh, and every entry expires on the same date. #794
tracks retiring them; when they expire the scan goes red until they are
removed or renewed with a reason recorded there.

### Sharp/libvips v1 licence decision

The v1 release comparison against the older `main` branch reports the
platform packages introduced by the `sharp` 0.35.0 update because their
published metadata includes `LGPL-3.0-or-later`. The older branch already
contains the corresponding `sharp` 0.34.5/libvips 1.2.4 package family.
Reverting is not an acceptable resolution: GitHub advisory
`GHSA-f88m-g3jw-g9cj` identifies inherited high-severity libvips
vulnerabilities in `sharp` versions before 0.35.0 and identifies 0.35.0 as
patched.

The exception in `supply-chain/licence-policy.yml` therefore excludes
only the exact `@img` platform-package PURLs for `sharp` 0.35.0 and libvips
1.3.0 from the licence check. It does not add LGPL to the repository-wide
allow-list and does not carry forward to a later package version. Issue
[#107](https://github.com/tomlawesome/orbit/issues/107) owns the evidence and
requires re-review by 2026-10-31. The owner is `tomlawesome`.

`sharp` is Apache-2.0 licensed; its prebuilt platform packages carry the
separately licensed libvips shared library. A distributed Orbit container must
retain the upstream licence and copyright material and must keep the
corresponding libvips source location available so recipients can exercise the
rights granted by the LGPL. The upstream sources and licence texts are
maintained in the
[sharp](https://github.com/lovell/sharp),
[sharp-libvips](https://github.com/lovell/sharp-libvips), and
[libvips](https://github.com/libvips/libvips) repositories. Any change to
static linking, the packaged binaries, or their licence metadata requires a
new review rather than relying on this decision.

The same release comparison could not infer licences for four updated direct
package declarations. Their installed, versioned package manifests were
manually checked on 2026-07-31:

| Package | Version | Declared licence |
| --- | --- | --- |
| `drizzle-orm` | 0.45.2 | Apache-2.0 |
| `eslint-config-next` | 16.2.11 | MIT |
| `next` | 16.2.11 | MIT |
| `nodemailer` | 9.0.3 | MIT-0 |

These declarations are already inside the global allow-list and require no
package exception. Dependency, secret, exact-image vulnerability, SBOM,
provenance and protected-promotion gates remain unchanged.

Validate the current policy locally with:

```text
node scripts/supply-chain-policy.mjs validate
```

The policy inventories every upstream build and runtime container using its
human-readable version tag, the tag's observed multi-platform index digest and
the exact Linux/AMD64 manifest used by Orbit. Repository configuration uses the
tag plus that AMD64 digest, so an upstream tag move cannot change a build,
integration test or deployment. Each entry records source and registry
provenance, licence evidence, file locations, an update owner, resolution date
and review deadline.

The application image is different: it does not have a repository-owned stable
digest until a release is accepted. Compose therefore requires `ORBIT_IMAGE`
explicitly. Pull deployments accept a full `registry/repository@sha256:...`
identity; local build scripts supply a revision-specific local tag for the
image they build from the checked-out source. A `latest` tag may still be
published during an explicitly approved stable promotion, but it is a
convenience pointer rather than deployment or acceptance evidence.

### Resolving a tag is not deploying one

The rule this enforces is that **a deployment runs an immutable digest**. A
mutable tag may therefore be *resolved* to a digest, provided the resolved
digest is what gets recorded and deployed. It may never itself be deployed.

This distinction matters because the earlier expression of the rule — that no
deployment script may name a mutable reference at all — also forbade automating
the resolution, which forced an operator to discover a digest by hand before
installing. Automating that lookup does not weaken the guarantee: what runs is
still an immutable, attested artifact, and the digest is still recorded. What
changes is only who performs the lookup. [ADR-0008](adr/0008-installer-resolved-release-digests.md)
records the decision.

Enforcement follows the property rather than the wording: every assignment of
`ORBIT_IMAGE` in a deployment script must produce either a
`registry/repository@sha256:...` identity or an explicitly local build tag.
Naming a tag in order to resolve it is permitted; assigning one as the
deployment reference is not.

## Updating pinned images

Every pinned image is written down twice: in the file that uses it
(`docker-compose.yml`, `tests/oidc/Dockerfile`, `scripts/test-integration.mjs`)
and in `.github/supply-chain-policy.json`, which records the digest, the index
digest and the date it was resolved. Both have to say the same thing.

Use a focused pull request for image updates:

1. Read the upstream release notes and image-source change history. Confirm
   maintenance status, provenance and licence evidence before accepting a new
   tag or a moved tag.
2. Renovate opens the bump. It rewrites the pin in the file and stops there:
   the policy is a bespoke JSON file it cannot read, so its merge request
   arrives with the two places disagreeing.
3. CI goes red on that merge request, at the step
   `Refuse a pin that drifted between compose and policy`. That is the drift
   check (`node scripts/sidecar-pins.mjs check --offline`) doing its job, not a
   broken build.
4. Run `node scripts/sidecar-pins.mjs sync`. It takes the pin now in the file
   as the truth, re-resolves the tag's index digest from the registry, and
   writes the reference, the index digest and today's date into the policy —
   then rewrites any other file that pins the same image. Review the diff and
   push it to the Renovate branch. Do not update an untracked reference or
   add a temporary mutable fallback.
5. Run `node scripts/supply-chain-policy.mjs validate`, the focused policy
   tests (`pnpm vitest run scripts/sidecar-pins.test.mjs`), static/unit checks
   and Compose configuration validation.
6. Let protected CI pull the pinned identities and repeat PostgreSQL,
   malware-detection, parser-isolation, backup/restore, privacy, browser,
   accessibility, exact-image vulnerability and SBOM gates.
7. Merge only when the protected pull-request checks pass. The trusted branch
   run must then publish and attest the exact application image it tested.

If an upstream registry no longer serves a recorded manifest, the update is a
release blocker; do not silently fall back to the tag.

### When the pin is current but its packages are not

A digest pin is frozen on purpose; the security advisories about what is inside
it are not. So an image can be exactly what its tag points at today and still
be missing a fix its own distribution published weeks ago — which is how the
findings on #740 accumulated.

`Sidecar pin freshness` (`.github/workflows/sidecar-pin-freshness.yml`) runs
weekly and asks all three questions: do the file and the policy agree, has the
tag moved, and does the pinned image itself have package upgrades waiting. When
anything is behind it files, or updates, one open issue titled
`Sidecar pins are behind` holding the full report, and the run goes red.

A moved tag is fixed by re-pinning, and `sidecar-pins.mjs sync` does it. Stale
packages inside a current pin have no such remedy: there is nothing newer to
pin to. Either upstream rebuilds the image, or the finding becomes a named
entry in the policy's `exceptions[]` with an owner, a rationale, a tracking
issue and an expiry date.

**The weekly schedule is not running yet, and this is the manual step it
replaces.** GitHub runs a scheduled workflow from the repository's default
branch, `main`, and `main` stays at v1.2.0 until #547 promotes v1.3. Until that
promotion the workflow file does not exist there, so neither the schedule nor
`Run workflow` will start it. Until then the cadence is a person: **weekly,
whoever is working on Orbit**, run

```bash
node scripts/sidecar-pins.mjs check --packages
```

and act on what it prints. Add `--red` to make it prove it can still fail
before you believe a clean result; add `--only <substring>` to look at one
image without pulling the large ones.

## Tool provenance and ownership

Trivy runs from a reviewed, AMD64 manifest digest recorded in the policy. Orbit
does not execute the Trivy setup or wrapper actions. This is deliberate because
the Trivy ecosystem had a
[published March 2026 supply-chain incident](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23).
The selected release is post-incident, but the executable identity remains
digest-pinned.

GitHub's `actions/attest` action is pinned to the reviewed commit recorded in
the policy. It attaches provenance and the SPDX SBOM to the already pushed
digest; it does not build or transform the image. Orbit maintainers own both
tool updates and the policy review date. Licences, upstream release pages,
versions and immutable identities are recorded beside that ownership.

The licence check runs as `scripts/ci/licence-policy.mjs`, the `licence_policy`
job (#815). It has no third-party action to pin: it reads
`supply-chain/licence-policy.yml` and each installed package's own
`package.json`, both already inside the checkout.

The vulnerability database is intentionally refreshed by the pinned scanner
at run time because vulnerability knowledge changes. Scanner version metadata
and database timestamps are retained with each run so a later review can
identify the evidence set that made the decision.
