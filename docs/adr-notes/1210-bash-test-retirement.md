# #1210: retiring the bash configure test suites

#1210 moved every configure flow into the TypeScript engine, so three bash
suites were left testing code that no longer exists. Build note D10 lets a
bash suite be deleted only once every test in it maps to an engine test,
with any gap ported first. The tables below are that mapping. The bash
output the engine is still compared against was captured from `b0ee5929`
into `src/lib/__fixtures__/` (its README says how).

Each row is a bash test title and the engine test that now proves the same
behaviour (`file › test title`), or `retired:` with the reason the
behaviour no longer exists. `open:` marks a behaviour the engine does not
match yet; those rows block the deletion until fixed.

Test files named below, by directory:

- `src/lib/`: `configure-engine.test.ts`, `configure-engine.retired-bash.test.ts`
  (new: ports), `config-contract.parity.test.ts`,
  `configuration-migration.parity.test.ts`, `configuration-migration.port.test.ts`,
  `deploy-lock.test.ts`, `env-orbit-file.test.ts`
- `src/cli/`: `orbit.configure.test.ts` (ports added at the end),
  `orbit.check.test.ts` (new: ports), `configure-sh-terminal.test.ts`
  (new: port), `orbit.configure-tty.test.ts`
- `scripts/`: `configure-engine-delegation.test.mjs`

## scripts/configure.test.mjs

| bash test title | covered by |
|---|---|
| orders its headings as required | configure-engine.retired-bash.test.ts › orders its headings as required |
| keeps the active-assignment surface to the bounded allowlist | configure-engine.retired-bash.test.ts › keeps the active-assignment surface to the bounded allowlist |
| uses HTTPS for every ordinary production URL example | configure-engine.retired-bash.test.ts › uses HTTPS for every ordinary production URL example |
| documents no IMAP_* key: inbound mail is configured on the administration screen (ADR-0017) | configure-engine.retired-bash.test.ts › documents no IMAP_* key: inbound mail is configured on the administration screen (ADR-0017) |
| keeps the deprecated SMTP_URL compatibility form out of the active surface | configure-engine.retired-bash.test.ts › keeps the deprecated SMTP_URL compatibility form out of the active surface |
| honours ORBIT_SECRETS_DIR, writing generated secrets there instead of the default .orbit-secrets (#1151 SF2-F8) | retired: deliberate change, the engine always writes `.orbit-secrets` |
| ignores a stale ambient ORBIT_IMAGE on an existing deployment without the installer's trust marker, printing what it ignored (#1151 O1-S4) | configure-engine.test.ts › an existing deployment keeps its pinned image unless the installer's trust marker says otherwise (configure.sh's persist_orbit_image rule) |
| still seeds ORBIT_IMAGE from the environment on a brand-new deployment, even without the trust marker | orbit.configure.test.ts › persists a valid ORBIT_IMAGE from the environment |
| creates a concise operator environment while leaving reference-only defaults in the example | configure-engine.retired-bash.test.ts › creates a concise operator environment while leaving reference-only defaults in the example |
| persists the %s deployment profile atomically (4 presets) | configure-engine.retired-bash.test.ts › persists the %s deployment profile atomically |
| leaves the environment unchanged when atomic profile staging fails | configure-engine.retired-bash.test.ts › leaves the environment unchanged when atomic profile staging fails |
| rejects missing or hostile local-model identifiers without mutation or disclosure | orbit.configure.test.ts › rejects missing or hostile local-model identifiers without mutation or disclosure |
| updates an existing active ORBIT_IMAGE assignment atomically | configure-engine.retired-bash.test.ts › updates an existing active ORBIT_IMAGE assignment atomically |
| appends ORBIT_IMAGE when no active assignment exists | configure-engine.retired-bash.test.ts › appends ORBIT_IMAGE when no active assignment exists |
| collapses duplicate active ORBIT_IMAGE assignments into one | configure-engine.test.ts › guarantee #7: collapses duplicate active assignments into one, at the first occurrence |
| preserves unrelated comments and operator values byte-for-byte | configure-engine.retired-bash.test.ts › preserves unrelated comments and operator values byte-for-byte |
| preserves an existing file's final newline state around managed updates | configure-engine.retired-bash.test.ts › preserves an existing file's final newline state around managed updates |
| places the canonical OIDC client secret file key in the authentication section | configure-engine.retired-bash.test.ts › places the canonical OIDC client secret file key in the authentication section |
| keeps .env-orbit restricted to owner-only permissions | configure-engine.test.ts › guarantee #5: forces an existing regular file's permissions to 600 |
| never discloses configured values in --check mode, only fixed categories and names | orbit.check.test.ts › never discloses configured values, only fixed categories and names |
| does not treat example placeholders as configured when the real environment file is absent | config-contract.parity.test.ts › no .env-orbit reports every field missing, as bash did |
| treats the historical loopback default and documented example.com placeholders as missing | orbit.check.test.ts › treats the historical loopback default and documented example.com placeholders as missing |
| rejects a callback URL that does not match the derived APP_URL callback | config-contract.parity.test.ts › callback must derive exactly from APP_URL |
| rejects a mutable image tag and whitespace-only client identity | orbit.check.test.ts › rejects a mutable image tag, and fails closed on a whitespace-only client identity (deliberate change: a value the reader refuses fails with `configuration_syntax` instead of a report) |
| exits zero for a complete required configuration with all optional groups untouched | config-contract.parity.test.ts › complete core, no optional groups |
| exits non-zero when an optional group is partially configured even with a complete required set | config-contract.parity.test.ts › partial SMTP group reports missing mail |
| reports imap as app-managed regardless of outbound mail configuration | config-contract.parity.test.ts › complete SMTP group reports ready mail |
| reports direct and file secret conflicts as incomplete without disclosing values | orbit.check.test.ts › reports direct and file secret conflicts as incomplete without disclosing values |
| reports OIDC_CLIENT_SECRET_FILE ready only for the canonical path backed by a non-empty, regular, non-symlink host file | config-contract.parity.test.ts › complete core, no optional groups |
| reports a file-backed OIDC secret as missing when its permissions are too broad | orbit.check.test.ts › reports a file-backed OIDC secret as missing when its permissions are too broad |
| reports OIDC_CLIENT_SECRET_FILE as missing when the configured path is not the canonical runtime path | config-contract.parity.test.ts › non-canonical secret path is not ready |
| reports OIDC_CLIENT_SECRET_FILE as missing when the canonical host file is absent | config-contract.parity.test.ts › missing secret file is not ready |
| reports OIDC_CLIENT_SECRET_FILE as missing when the canonical host file is empty | orbit.check.test.ts › reports OIDC_CLIENT_SECRET_FILE as missing when the canonical host file is empty |
| reports OIDC_CLIENT_SECRET_FILE as missing when the canonical host file is a symlink | orbit.check.test.ts › reports OIDC_CLIENT_SECRET_FILE as missing when the canonical host file is a symlink |
| rejects an unrecognised argument with a concise usage message | configure-engine-delegation.test.mjs › usage errors are exit 2 and never reach docker; orbit.configure.test.ts › exits 2 with a usage message for an unrecognised flag |
| creates a zero-byte, mode-0600 OIDC client secret placeholder when absent | configure-engine.test.ts › guarantee #19: creates a zero-byte, mode-0600 placeholder when absent |
| preserves a valid direct OIDC client secret without creating a conflicting file form | configure-engine.test.ts › guarantee #18: does not create a placeholder when a direct OIDC_CLIENT_SECRET is already active alone |
| preserves an existing OIDC client secret file byte-for-byte on an ordinary run | configure-engine.retired-bash.test.ts › preserves an existing OIDC client secret file byte-for-byte on an ordinary run |
| rejects a symlinked OIDC client secret file on an ordinary run | configure-engine.test.ts › guarantee #19: refuses a symlinked placeholder path |
| --check-rollback › passes on a good rollback copy and resolves .orbit-secrets from the real installation directory (file-backed OIDC secret) | orbit.check.test.ts › passes on a good rollback copy and resolves .orbit-secrets from the real installation directory (file-backed OIDC secret) |
| --check-rollback › fails cleanly, non-zero, without inventing a result, when the rollback copy is missing | config-contract.parity.test.ts › --rollback with no rollback copy reports every field missing, as --check-rollback did |
| --check-rollback › fails when the rollback copy is a symlink | orbit.check.test.ts › fails closed when the rollback copy is a symlink |
| --check-rollback › fails when the rollback copy's permissions are broader than mode 600 | orbit.check.test.ts › fails closed when the rollback copy's permissions are broader than mode 600 |
| --check-rollback › checks only the rollback copy, never the live .env-orbit | orbit.check.test.ts › checks only the rollback copy, never the live .env-orbit |
| --check-rollback › rejects an extra argument the same way --check does | orbit.check.test.ts › rejects an extra argument as a usage error (exit 2), as a plain check does |
| --set-oidc-secret › reads the secret from standard input, persists it atomically with mode 0600, and switches to the canonical file-backed path without printing it | orbit.configure.test.ts › reads a single piped line and writes the canonical secret file plus .env-orbit pointers, never echoing the value; configure-engine.test.ts › guarantee #20-23: writes the secret to the canonical file (mode 0600, no trailing newline) and points .env-orbit at it with an empty direct value |
| --set-oidc-secret › accepts terminal-style input with a trailing newline without persisting the newline | orbit.configure.test.ts › reads a single piped line and writes the canonical secret file plus .env-orbit pointers, never echoing the value |
| --set-oidc-secret › rejects empty standard input without creating an environment file or secret | orbit.configure.test.ts › --set-oidc-secret rejects an empty line on standard input without creating an environment file or secret |
| --set-oidc-secret › rejects EOF without a newline instead of accepting a partial secret | open: the engine accepts the partial line (`readSyncLine` in src/cli/orbit.ts returns it at end of input) and saves it; bash refused |
| --set-oidc-secret › rejects a secret larger than the 65,536-byte bound | configure-engine.test.ts › guarantee #22: refuses a secret exceeding the maximum byte size |
| --set-oidc-secret › applies the 65,536-byte bound to multibyte input rather than character count | configure-engine.retired-bash.test.ts › applies the 65,536-byte bound to multibyte input rather than character count |
| --set-oidc-secret › keeps CRLF line endings on rewritten managed keys, not just on untouched lines | open: the engine's `updateManagedKeys` writes rewritten and inserted lines with LF only, so a CRLF file ends up with mixed endings; bash kept each line's CR |
| --set-oidc-secret › leaves an LF file entirely LF, gaining no stray carriage returns | configure-engine.retired-bash.test.ts › leaves an LF file entirely LF, gaining no stray carriage returns |
| --set-oidc-secret › converges byte-identically when --set-oidc-secret runs twice with the same secret | configure-engine.retired-bash.test.ts › converges byte-identically when --set-oidc-secret runs twice with the same secret |
| --set-oidc-secret › replaces an existing OIDC client secret file and leaves no staging leftovers | configure-engine.retired-bash.test.ts › replaces an existing OIDC client secret file and leaves no staging leftovers |
| --init › derives and atomically writes all four values from a complete environment set without printing them | orbit.configure.test.ts › --init derives and atomically writes all four values and ORBIT_AUTH_OIDC=true from a complete environment set without printing them |
| --init › derives and atomically writes ORBIT_AUTH_OIDC=true alongside a complete environment set (ADR-0023 section 1) | orbit.configure.test.ts › --init derives and atomically writes all four values and ORBIT_AUTH_OIDC=true from a complete environment set without printing them |
| --init › ORBIT_CONFIGURE_AUTH_MODE=local writes only APP_URL and ORBIT_AUTH_OIDC=false, never the OIDC trio | orbit.configure.test.ts › --init with ORBIT_CONFIGURE_AUTH_MODE=local writes only APP_URL and ORBIT_AUTH_OIDC=false, never the OIDC trio |
| --init › switching to local-only preserves an existing OIDC configuration instead of deleting it (ADR-0023 section 1) | orbit.configure.test.ts › --init switching to local-only preserves an existing OIDC configuration instead of deleting it (ADR-0023 section 1) |
| --init › rejects ORBIT_CONFIGURE_AUTH_MODE=local combined with a complete OIDC environment set | orbit.configure.test.ts › --init rejects ORBIT_CONFIGURE_AUTH_MODE=local combined with a complete OIDC environment set |
| --init › rejects an invalid ORBIT_CONFIGURE_AUTH_MODE value without mutation | orbit.configure.test.ts › --init rejects an invalid ORBIT_CONFIGURE_AUTH_MODE value without mutation |
| --init › the interactive mode question defaults to local-only and asks nothing further | orbit.configure-tty.test.ts › defaults to local accounts and asks for APP_URL alone |
| --init › normalizes one harmless trailing slash from the public Orbit origin | configure-engine.test.ts › guarantee #13: derives OIDC_CALLBACK_URL from the normalized APP_URL |
| --init › refuses a partial non-interactive environment input set without mutating the file | orbit.configure.test.ts › refuses a partial ORBIT_CONFIGURE_* triad rather than blending in a missing field |
| --init › refuses non-TTY guided mode when no complete environment input set is supplied | orbit.configure.test.ts › refuses (no crash, no partial write) with no answers, no machine prompts and no terminal; configure-engine-delegation.test.mjs › --init without a terminal or answers does not ask for one and the engine refuses |
| --init › uses the controlling terminal when stdin is occupied by the installer script | configure-sh-terminal.test.ts › uses the controlling terminal when stdin is occupied by the installer script (the bash line-editing keys it also typed are retired with installer-ui.sh's widget) |
| --init › refuses an invalid APP_URL %s (%s) without mutation (10 cases) | configure-engine.retired-bash.test.ts › refuses an invalid APP_URL %s (%s) without mutation |
| --init › refuses an invalid OIDC_ISSUER %s (%s) without mutation (8 cases) | configure-engine.retired-bash.test.ts › refuses an invalid OIDC_ISSUER %s (%s) without mutation |
| --init › collapses duplicate managed keys during a guided write while preserving unrelated lines byte-for-byte | configure-engine.retired-bash.test.ts › collapses duplicate managed keys during a guided write while preserving unrelated lines byte-for-byte |
| --init › removes the guided atomic update file when securing it fails, leaving the original unchanged | configure-engine.retired-bash.test.ts › removes the guided atomic update file when securing it fails, leaving the original unchanged |
| leaves no temporary files behind after success or a later failure | configure-engine.retired-bash.test.ts › leaves no temporary files behind after success or a later failure |
| removes the atomic update file when securing it fails | configure-engine.retired-bash.test.ts › removes the atomic update file when securing it fails |
| refuses to regenerate a missing document-kek on an existing deployment instead of silently replacing it | configure-engine.test.ts › O1-S1: refuses rather than regenerating a document KEK lost from an existing deployment; configure-engine.test.ts › O1-S1: refuses rather than regenerates a missing secret on an existing deployment (isFreshInstall=false) |
| generates all three secrets on the install shape: --init writes .env-orbit, then a bare run in a second process | configure-engine.test.ts › RANGE-F1: generates all three secrets on the install shape (guided init wrote .env-orbit first) |
| still generates secrets normally on a genuinely fresh install (neither .env-orbit nor .orbit-secrets existed before this run) | orbit.configure.test.ts › creates .env-orbit and .orbit-secrets, generating the three secrets and the VAPID pair |
| refuses for postgres-password and generates nothing when only session-secret already exists | configure-engine.retired-bash.test.ts › refuses for postgres-password and generates nothing when only session-secret already exists |
| refuses to replace a missing OIDC client secret file with an empty placeholder when OIDC_CLIENT_SECRET_FILE is already configured | configure-engine.test.ts › O1-S5: refuses rather than writing an empty placeholder when OIDC_CLIENT_SECRET_FILE is already configured and the file is missing |
| refuses a write while another run's deploy lock is held | configure-engine.test.ts › O1-R8: refuses when another writer already holds the deployment lock; deploy-lock.test.ts › refuses with the caller's own error while a fresh lock is held |
| reclaims a stale deploy lock left by a crashed run instead of blocking forever | configure-engine.test.ts › O1-R8: a stale lock (older than the staleness window) is taken over rather than blocking forever; deploy-lock.test.ts › reclaims a lock older than the staleness window |
| releases the lock after each successful update, so later steps in the same run do not see it as held | configure-engine.test.ts › O1-R8: releases the lock after a successful call, so a later call succeeds |
| refuses to generate secrets while another run's deploy lock is held | configure-engine.test.ts › RANGE-R5: refuses while another run holds the deploy lock, before generating any secret |

## scripts/configuration.test.mjs

Deleted in `85debc18`. Every case is a captured case of
`configuration-migration.parity.test.ts › configuration contract port:
every captured configuration.sh case`, named below by case, unless another
file is given.

| bash test title | covered by |
|---|---|
| accepts legacy data without rewriting operator values | migrate: legacy crlf |
| keeps preflight non-mutating and makes migrate the only marker mutation | preflight: legacy file; migrate: legacy with comment; migrate: already current |
| supports installer-transaction migration without an adjacent rollback | migrate: transaction no final newline |
| fills concise managed placeholders in their canonical sections | migrate: placeholders canonical sections |
| preserves comments, CRLF, internal spaces, equals, and no-final-newline | migrate: comments crlf no final newline |
| reports an already-current configuration without rewriting it or creating rollback | migrate: already current |
| rejects malformed, partial, and mismatched provenance metadata without disclosure | preflight: provenance 0 to 3 |
| requires target provenance when standalone migration has no prior provenance | migrate: no target and no provenance |
| classifies every documented example key without values | check: example keys direct; check: example keys file |
| rejects duplicates, unknown keys, interpolation and unsafe modes | check: rejects grammar 0 to 12; check: loose mode |
| accepts a non-leading quote, a backslash, or a `#` not preceded by whitespace (#383) | migrate: accepts value 0 to 5; env-orbit-file.test.ts › accepts a non-leading quote, a backslash, or a `#` not preceded by whitespace |
| rejects invalid or mismatched managed Compose project identity | check: compose project p0 to p4; migrate: project mismatch |
| rejects NUL/control, oversized, directory, and symlink inputs without disclosure | check: rejects grammar 15, 16 and 18; check: directory; check: symlink |
| rolls back an interrupted atomic migration and leaves the original intact | configuration-migration.port.test.ts › restores the original from the rollback copy when the final rename fails, leaving no scratch file (configuration.sh #20) |
| a migration interrupted before it ever touched the file can be retried, not refused forever (#1151 O1-R5) | migrate: leftover identical rollback retried |
| a leftover backup that differs from the current file is still protected, never silently replaced | migrate: leftover different rollback refused |
| refuses a direct secret value set together with its _FILE counterpart, matching the app's own contract (#1151 O1-Q1) | check: secret pair conflict; preflight: secret pair conflict |
| accepts either form of a secret alone, only rejecting the pair | preflight: example keys direct; preflight: example keys file |
| accepts an empty direct placeholder beside a populated _FILE value, matching config-contract.ts's own falsy-string check | preflight: empty direct beside file |
| reports future and gap schema versions with a distinct bounded code | check: schema version 2; check: schema version 0 |
| migrate_file deploy lock › refuses a migration while another run's deploy lock is held, without mutating the file | migrate: lock held |
| migrate_file deploy lock › reclaims a stale deploy lock left by a crashed run instead of blocking forever | migrate: stale lock reclaimed |
| migrate_file deploy lock › releases the lock after a successful migration | migrate: legacy with comment (every case also checks the lock left behind) |
| removes the scratch file when the process is killed while it is tracked | configuration-migration.port.test.ts › leaves no scratch file and no lock behind, and exits with the signal's status |

## scripts/engine-check.test.mjs

Deleted in `85debc18` with `engine-check.sh`, which was a proxy for
`configure.sh --check` with an opt-in Compose one-off.
`configure.sh --check` now runs `orbit check` in a `docker run` (D1).

| bash test title | covered by |
|---|---|
| delegates to `bash scripts/configure.sh --check` byte-for-byte, with no docker on PATH at all | retired: the proxy is gone; the output it passed through is pinned by config-contract.parity.test.ts › config contract parity with configure.sh --check (golden) |
| stays the default proxy even when ORBIT_ENGINE_CHECK is set to something other than "container" | retired: ORBIT_ENGINE_CHECK no longer exists |
| accepts --plain as an inert flag without forwarding it to configure.sh (which has no such flag) | retired: engine-check.sh's own flag |
| rejects an unrecognised flag with a usage error (exit 2) | config-contract.parity.test.ts › an unknown option is a usage error (exit 2), as bash's was; configure-engine-delegation.test.mjs › usage errors are exit 2 and never reach docker |
| invokes docker with exactly the documented argv, and propagates its exit code | retired: the Compose one-off is gone; its replacement argv is pinned by configure-engine-delegation.test.mjs › configure.sh %j |
| bounds the container delegation with timeout, unlike every other Compose call in install.sh before this fix (#1151 O1-R2) | retired: no Compose call is made, so no timeout wrapper |
| refuses (exit 5) when timeout is unavailable | retired: no timeout wrapper |
| propagates a nonzero docker compose exit code unchanged | configure-engine-delegation.test.mjs › the engine's own refusal passes through (exit 1) and its usage error too (exit 2) |
| derives the Compose project name from the current directory's basename when .env-orbit has none | retired: `docker run` needs no Compose project |
| a COMPOSE_PROJECT_NAME set only in the environment (not .env-orbit) is honored | retired: `docker run` needs no Compose project |
| refuses (exit 5) when docker is unavailable | retired: engine-check.sh's exit-5 contract; configure.sh now stops with "Docker is required" (exit 1), which no test covers |
| refuses (exit 5) when .env-orbit is missing | retired: container-mode refusal; the kept default (a report of every field missing, exit 1) is config-contract.parity.test.ts › no .env-orbit reports every field missing, as bash did |
| never places a secret value on the composed docker argv (this script never reads one) | configure-engine-delegation.test.mjs › the OIDC secret arrives on stdin and the answers by -e NAME, never as values in argv |
