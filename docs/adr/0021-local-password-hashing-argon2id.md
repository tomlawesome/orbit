# ADR-0021: Local passwords are hashed with Argon2id via `@node-rs/argon2`

**Status:** Proposed (for owner ratification; drafted 2026-09-09 under the
owner's ruling of 2026-08-16 on #259, "Argon2id, at or above OWASP")
**Date:** 2026-09-09
**Relates to:** #259 (local accounts, epic); ADR-0022 (bootstrap proof and
recovery), ADR-0023 (registration, linking, recent authentication);
`docs/plans/m7-local-accounts.md` (the slice plan); `docs/supply-chain.md`
(licence gate and SBOM the dependency must pass)

## Context

Orbit has no password path today. Every account is provisioned from an OIDC
`(issuer, subject)` pair (`src/lib/auth/provision.ts`). M7 adds local
accounts as the baseline identity, so a password hash must be chosen, and
#259 requires that choice to be an ADR before implementation.

The 2026-08-16 plan on #259 recommended scrypt at N=2^16 from `node:crypto`
to avoid a native module. The owner rejected that on 2026-08-16: "Argon2id.
Always the best, not a compromise because it's cheap. The native-module
supply-chain and image-build cost is accepted." The scrypt fallback is
allowed only if the Argon2id dependency proves genuinely unshippable in the
pinned build.

Facts that bound the choice, verified in the tree on 2026-09-09:

- The runtime is Alpine 3.24 (musl) with Node 22.23.2 built from signed
  source in `ai/orbit-base-image` (its `Dockerfile:20-22`). Node's built-in
  `crypto.argon2` exists only from Node 24.7 and is experimental, so it is
  not available to this image.
- Orbit already ships a napi-rs native module with explicit, pinned platform
  packages: `@napi-rs/canvas` plus `@napi-rs/canvas-linux-x64-gnu` and
  `-linux-x64-musl` (`package.json:28-30`, `web/package.json:20-22`). There is
  a precedent for exactly this shape of dependency.
- `pnpm-workspace.yaml` `allowBuilds` names the only packages permitted to
  run install scripts (`esbuild`, `unrs-resolver`). A dependency that needs a
  postinstall compile would have to be added there and would need a
  toolchain in the `deps` build stage.
- `supply-chain/licence-policy.yml` allows MIT, Apache-2.0, BSD-3-Clause,
  ISC, MIT-0, MPL-2.0 and Unlicense for shipped packages; missing licence
  metadata blocks the build.
- The one password-like derivation in the tree, the recovery-bundle
  passphrase (`src/lib/recovery-bundle.ts`), uses synchronous scrypt at
  N=2^17 and is deliberately ~1 s. That is right for a one-shot CLI and wrong
  for a login route: it blocks the event loop.
- The smallest supported host is a 2 GB NAS. Memory-hard hashing under a
  login flood is a real out-of-memory risk there.

## Decision

### 1. Algorithm and library

Argon2id, through **`@node-rs/argon2`** (MIT; napi-rs; prebuilt binaries
delivered as optional platform packages, no install script). Orbit pins the
main package and the two platform packages the image and the CI hosts need,
`@node-rs/argon2-linux-x64-musl` and `@node-rs/argon2-linux-x64-gnu`, exactly
as it pins `@napi-rs/canvas`'s. `allowBuilds` does not change. The package's
licence, provenance and the platform-package pins are added to
`docs/supply-chain.md` beside the canvas entry.

`@node-rs/argon2` is chosen over `argon2` (also MIT) because `argon2` builds
with node-gyp or downloads a prebuild at install time: on musl that means
either a compiler in the build stage or a network fetch inside
`pnpm install --frozen-lockfile`, both of which weaken the reproducible
build ADR-0020 attests.

**Fallback if the native package proves unshippable** (the owner's
condition): `hash-wasm` (MIT, WebAssembly, no native code). It produces the
same PHC-encoded Argon2id string, so switching costs no re-hash and no schema
change; it is two to three times slower, which the parameters below absorb.
scrypt is not the fallback: it would change the algorithm, and the owner's
ruling was about the algorithm.

### 2. Parameters

`m = 65536 KiB (64 MiB), t = 3, p = 1`, 16-byte random salt, 32-byte tag.

This is RFC 9106's second recommended option (the one for memory-constrained
environments) with parallelism reduced to 1, and it is above OWASP's floor of
`m = 19 MiB, t = 2, p = 1`. `p = 1` is deliberate: a single lane makes the
memory accounting of the concurrency gate below exact (one derivation, one
64 MiB arena) and avoids contending with the request threadpool.

The parameters live in one place, `src/lib/auth/password.ts`, as the
**current policy**. The hash column stores the PHC string
(`$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>`), which is self-describing,
so no separate algorithm or version columns exist and every credential
carries the parameters it was made with.

### 3. Upgrade on login

`verifyPassword` returns `{ verified, needsRehash }`. `needsRehash` is true
when the stored PHC parameters are below the current policy in any of `m`,
`t`, `p`, or the algorithm variant is not `argon2id`. On a successful
verification with `needsRehash`, the caller re-hashes the plaintext it
already holds and writes the new string in the same transaction that clears
the failure counter. Raising the policy is therefore a one-line change with
no migration job; lowering it is not a supported operation (a stronger stored
hash never triggers a re-hash).

### 4. The verification gate

Every Argon2id derivation, hashing or verifying, goes through one in-process
gate (`src/lib/auth/verification-gate.ts`): at most **2 concurrent
derivations**, a waiting queue capped at **16**, and a queue wait bound of
**5 s**. A request refused by the gate fails with the same generic
`too_many_attempts` the backoff uses. Worst-case transient memory is
therefore 128 MiB, which a 2 GB host absorbs. ADR-0001 (single instance)
makes an in-process gate coherent; there is no second node to coordinate
with.

### 5. Existence must not leak through time

When a sign-in names an email with no credential row, the route verifies the
supplied password against a fixed **decoy hash** made with the current policy
at startup, so unknown-account and wrong-password attempts cost the same
derivation. The decoy result is discarded; the response is the same generic
`credentials_invalid` either way.

### 6. Input bounds and normalisation

Passwords are 12 to 256 characters, counted in Unicode code points after
NFC normalisation; no composition rules and no forced rotation. The 12 is
the same floor as `MIN_RECOVERY_PASSPHRASE_LENGTH` already in the codebase, so
there is one number to remember. The 256 bounds the Argon2 input. Password
plaintext is never logged, never audited, never returned, and the
`local_credentials` table is excluded from every diagnostic serialisation.

## Consequences

- The image gains one native module and two platform packages, all MIT,
  following the canvas precedent. The SBOM, licence gate and Renovate cover
  them automatically; the base-image repin job is unaffected.
- Per-credential parameters mean the policy can be raised at any release with
  no operator action and no migration: users are upgraded as they sign in.
- The gate turns a login flood into fast `too_many_attempts` refusals instead
  of memory pressure. This is load-bearing on small hardware, not a nicety;
  removing it needs a new ADR.
- The recovery-bundle passphrase derivation stays on scrypt: it is a
  different threat model (offline, one-shot, no event loop to protect) and
  changing it would invalidate existing bundles for no gain.
- When the base image moves to a Node line where `crypto.argon2` is stable,
  a successor ADR may drop the native module. The PHC format makes that a
  code-only change.

## Alternatives rejected

- **scrypt N=2^16 from `node:crypto`** (the 2026-08-16 recommendation): no
  new dependency, but below OWASP's scrypt guidance and rejected by the owner
  as a cost compromise.
- **`argon2` (node-gyp)**: same algorithm and licence; needs a compiler in the
  musl build stage or a network prebuild fetch at install time.
- **Node built-in `crypto.argon2`**: Node 24.7+, experimental; not in the
  pinned Node 22 base image.
- **bcrypt**: 72-byte input truncation and not memory-hard.
- **PBKDF2**: not memory-hard; rejected for the same reason as bcrypt.

## Superseded

- The scrypt recommendation in the 2026-08-16 plan note on #259 is closed by
  the owner's ruling and this record.
- The plan's `scrypt$N=…$salt$hash` column encoding is replaced by the PHC
  string; the "algorithm" column it proposed is unnecessary.
