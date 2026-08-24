# Operational script guarantee catalogue

This catalogue is the specification for the Phase 1 operational acceptance
harness and, later, the Phase 2 engine port
([ADR-0011](adr/0011-operator-experience-as-product.md), issue #288). It
records every operator-facing guarantee implemented by the operational
scripts: a one-line statement in operator terms, its `file:line`
citation(s), a category, and a criticality (HIGH = data-loss or security
boundary, MEDIUM = deployment correctness, LOW = UX).

- **Extracted:** 2026-08-11 from `develop`, by directed agents with
  main-thread citation spot-checks. `repair.sh` (issue #261 first slice,
  `--check` only) was added 2026-08-12 following the same convention; the
  #261 second slice (read-only database reachability/credential and
  application container identity/health diagnosis) was added the same day;
  the #261 third slice (`--plan` — a proposed, classified repair plan
  derived from the same findings, still zero mutation) was added the same
  day; the #261 slice 4 stage one (`--execute --safe-only` — execution of
  the fixed safe/reversible action set only: fix-permissions,
  restore-transaction, restart-services; stage two/dangerous actions remain
  unimplemented) was added 2026-08-13.
- **Totals:** 349 guarantees — 196 HIGH, 120 MEDIUM, 33 LOW.
  Install/configuration family: 186 (101 HIGH). Backup/recovery/deploy
  family: 163 (95 HIGH).
- **Maintenance:** a change to an operational script that adds, removes, or
  moves a guarantee must update this catalogue in the same pull request;
  harness scenarios cite entries here. Line numbers drift — treat the
  statement as the contract and the citation as the anchor at extraction
  time.
- **Harness traceability:** acceptance scenarios (for example
  `scripts/test-install-acceptance.sh`) cite the guarantees they assert as
  `Part N / script #entry` in comments beside each assertion, so coverage
  of this catalogue is greppable in both directions.

---

## Part 1 — Install/configuration family

Scripts covered: `install.sh`, `configure.sh`, `configuration.sh`, `installer-ui.sh`, `installer-simulation.sh`, `container-entrypoint.sh` (plus any sourced helper library); `repair.sh` (issue #261, `--check`/`--plan`/`--execute --safe-only`) added 2026-08-12 — first slice (filesystem/secrets/Compose/volume/container-ownership diagnosis), then second slice (read-only database and application-container diagnosis), then third slice (`--plan` — a proposed, classified repair plan derived from the same findings, still zero mutation) the same day; slice 4 stage one (`--execute --safe-only` — executes only the fixed safe/reversible action set: fix-permissions, restore-transaction, restart-services; every other action class is always reported `skipped`, never executed) added 2026-08-13.
Test files (`*.test.mjs`) and other scripts were explicitly excluded from the read.


## installer-ui.sh (shared library — sourced by configure.sh, installer-simulation.sh, and dynamically by install.sh)

1. Only fixed-vocabulary values for phase/component/state/reason/action pass through to operator-visible output; any unrecognised value is rendered as the literal string `unknown` rather than echoed verbatim, preventing arbitrary text (including escape sequences) from reaching the terminal/log stream. — installer-ui.sh:86-110 — category: input-validation — criticality: MEDIUM
2. `installer_ui_elapsed` refuses non-numeric/oversized elapsed values, substituting `0s` instead of printing attacker- or bug-supplied text. — installer-ui.sh:112-120 — category: input-validation — criticality: LOW
3. `installer_ui_emit` requires exactly 5 or 6 positional args, else returns an error code (2) rather than emitting a malformed status line. — installer-ui.sh:122-124 — category: input-validation — criticality: LOW
4. Simulation-mode output is visibly and structurally tagged (`[SIMULATION]` prefix in TTY mode, `simulation=true` field in plain mode) so operators cannot mistake dry-run output for a real deployment action. — installer-ui.sh:138-139,154-156 — category: refusal/fail-closed — criticality: MEDIUM
5. Interactive key reads happen in the caller's own process (not a forked command-substitution subshell) specifically so an INT/TERM/HUP signal delivered mid-read is observed immediately by the caller's trap instead of being swallowed by a child process. — installer-ui.sh:163-168 — category: recovery — criticality: MEDIUM
6. Escape-sequence input (arrow keys, OSC title strings, CSI sequences, bracketed-paste markers) is consumed and classified up to its terminator with a bounded read-loop (max 32/256 iterations), so a malformed or oversized escape sequence cannot monopolise an input widget indefinitely or leak raw control bytes into a typed value. — installer-ui.sh:198-277 — category: input-validation — criticality: MEDIUM
7. Pasted input is capped at the caller-specified maximum length (returns error code 2 if exceeded, checked both mid-stream and at completion) and is rejected outright if it contains an ESC byte or any control character, preventing injected escape sequences/control bytes from reaching a stored secret or config value via paste. — installer-ui.sh:288-315 (esp. 310,313) — category: secret-handling — criticality: HIGH
8. `installer_ui_read_value` (backing both `installer_ui_read_text` and `installer_ui_read_secret`, used for OIDC client secret entry etc.) re-validates on completion that the final value is within the maximum length and contains no ESC byte or control character, rejecting it (status 2) otherwise — a second, authoritative check independent of the incremental paste/keystroke checks. — installer-ui.sh:538-539 — category: secret-handling — criticality: HIGH
9. Menu rendering (`installer_ui_menu_render`/`installer_ui_select`) writes all presentation frames only to the controlling terminal file descriptor, never to stdout, so a caller capturing the selected value via command substitution can never have UI chrome text mixed into the captured identifier. — installer-ui.sh:341-354,356-359,371 — category: provenance/immutability — criticality: MEDIUM
10. Terminal raw-mode (`stty -echo -icanon`) and any prior INT/TERM/HUP trap are always restored on every exit path of `installer_ui_select` and `installer_ui_read_value` (success, error, interrupt, or read failure), so an interrupted install/configure run never leaves the operator's terminal echo-less or unresponsive to Ctrl-C. — installer-ui.sh:379-384,433-436,468-471,533-536 — category: recovery — criticality: MEDIUM
11. TTY (colour/interactive) rendering mode is automatically downgraded to plain mode when stdout is not a terminal, `NO_COLOR` is set, or `TERM=dumb`, and can be forced to plain via `ORBIT_INSTALLER_PLAIN=1` — prevents raw ANSI escape codes from being written to logs, pipes, or non-color terminals. — installer-ui.sh:32-47 — category: input-validation — criticality: LOW
12. `installer_ui_terminal_width` clamps any reported/derived terminal width to the range [20, 240] and falls back to `COLUMNS`/80 if the value is non-numeric, so a bogus `stty size` result cannot produce a malformed or unbounded render width. — installer-ui.sh:317-328 — category: input-validation — criticality: LOW
13. The plain-mode status-line format and its field vocabulary are a documented, versioned machine interface ("engine event stream v0", consumed by orbit-launcher); vocabulary drift without a matching `docs/engine-events.md` update fails CI. — installer-ui.sh:86-110, docs/engine-events.md, scripts/engine-events.test.mjs — category: provenance/immutability — criticality: MEDIUM

## configuration.sh (invoked as a subprocess by configure.sh and install.sh — never sourced)

1. The operator's `.env-orbit` file is parsed as inert text (line-by-line regex), never `source`d or evaluated as shell — a value like `` $(rm -rf) `` or backticks in the file can never execute. — configuration.sh:5-6,112-148 — category: input-validation — criticality: HIGH
2. Refuses to read the configuration file at all unless it is a regular, non-symlink file with exact mode `600`; a symlinked, non-regular, or loosely-permissioned `.env-orbit` fails closed with `configuration_syntax` before any content is parsed. — configuration.sh:106-110,117 — category: permissions/ownership — criticality: HIGH
3. Only keys in a fixed allowlist (`allowed_keys`) are accepted; anything else fails closed as `configuration_unknown_key`, and an explicit `removed_keys` set (currently empty but wired) fails closed as `configuration_removed_key` with a distinct message so an operator can tell "unknown" from "deliberately retired". — configuration.sh:37-41,43-47,130-137 — category: input-validation — criticality: MEDIUM
4. Legacy/deprecated secret key aliases (`OIDC_CLIENT_SECRET`, `SESSION_SECRET`, `DOCUMENT_KEK`, `POSTGRES_PASSWORD`, `VAPID_PRIVATE_KEY`, `SMTP_PASSWORD`, `IMAP_PASSWORD`, `DATABASE_URL`, `SMTP_URL`, and IMAP alias secret/key variants) remain accepted for pre-rotation installs but are classified as `deprecated_supported` rather than `current` in the preflight report, so upgrades don't break while still surfacing the debt. — configuration.sh:31-34,49-56,159-167 — category: secret-handling — criticality: MEDIUM
5. Every value is rejected (fail closed) if it exceeds 4096 bytes, contains any control character (including ESC/DEL/NUL), has leading/trailing whitespace, or contains any of `$ \` " ' # \` — characters that would be ambiguous to a Compose/dotenv-style parser — preventing shell/Compose injection via a crafted value. — configuration.sh:58-77,138 — category: input-validation — criticality: HIGH
6. Any line containing a control character fails the whole parse closed (`configuration_syntax`), and lines must match `^[A-Z][A-Z0-9_]*=.*$` (after skipping blank/comment lines) or the file is rejected outright — no partial/best-effort parsing of malformed lines. — configuration.sh:120-126 — category: input-validation — criticality: MEDIUM
7. Files containing NUL bytes are detected (`cmp` against a NUL-stripped copy) and rejected before line parsing begins, since a dotenv assignment cannot represent NUL. — configuration.sh:118-119 — category: input-validation — criticality: MEDIUM
8. Duplicate assignment of the same key within one file fails closed (`configuration_syntax`) instead of silently taking the first or last value. — configuration.sh:114,127 — category: input-validation — criticality: MEDIUM
9. A file with zero assignments (empty or all-comment) is rejected (`configuration_syntax`) rather than treated as a valid empty configuration. — configuration.sh:149 — category: refusal/fail-closed — criticality: LOW
10. `ORBIT_CONFIG_APPLIED_VERSION` and `ORBIT_CONFIG_APPLIED_DIGEST` must be either both present or both absent (fails closed as `configuration_provenance` on a partial pair) — provenance can't be half-recorded. — configuration.sh:95-98 — category: provenance/immutability — criticality: HIGH
11. When provenance is present, it must be internally consistent and well-formed: `ORBIT_CONFIG_APPLIED_VERSION` matches strict semver, `ORBIT_CONFIG_APPLIED_DIGEST` matches `sha256:<64 hex>`, `ORBIT_IMAGE` must be digest-pinned (`repo@sha256:...`), and the image's own digest suffix must exactly equal the recorded applied digest — refuses drift between the recorded and actual deployed image identity. — configuration.sh:79-90,95-104 — category: provenance/immutability — criticality: HIGH
12. `COMPOSE_PROJECT_NAME`, wherever supplied (parse or migrate target), must match `^[a-z0-9][a-z0-9_-]*$` or the operation fails closed as `configuration_project`. — configuration.sh:91-93,144-146,199-201 — category: input-validation — criticality: MEDIUM
13. Mismatched schema version (present but not exactly the current schema) always fails closed as `configuration_version` — there is no silent auto-upgrade/downgrade path inside the parser itself; migration is a distinct, explicit action. — configuration.sh:150-153 — category: refusal/fail-closed — criticality: MEDIUM
14. `migrate_file` re-validates the source file before mutating it and aborts with the original failure code for anything other than "valid" or "valid-but-unversioned" — refuses to migrate a file that fails basic parsing/provenance checks. — configuration.sh:183-184 — category: refusal/fail-closed — criticality: HIGH
15. Migration targets (`--orbit-image/--applied-version/--applied-digest`) must be supplied all-or-nothing, and are subject to the same immutable-image/semver/digest/digest-match validation as inline provenance — a partial or malformed target set fails closed as `configuration_provenance`. — configuration.sh:186-192 — category: provenance/immutability — criticality: HIGH
16. If no explicit migration target is supplied, the source file must already carry valid schema + applied-version provenance, else migration refuses with `configuration_provenance_required` — migration never invents provenance data. — configuration.sh:194-196 — category: refusal/fail-closed — criticality: HIGH
17. If the file already declares a `COMPOSE_PROJECT_NAME` and a different target project name is supplied, migration refuses with `configuration_project_mismatch` rather than silently renaming the deployment's Compose project (which would orphan existing containers/volumes). — configuration.sh:202-205 — category: refusal/fail-closed — criticality: HIGH
18. Migration is idempotent: if image, version, digest, and project already equal the desired values, `migrate_file` reports "already current" and returns without writing anything. — configuration.sh:212-218 — category: idempotency — criticality: MEDIUM
19. Before mutating, a rollback backup (`<file>.orbit-config.rollback`) is written; if a backup already exists at that path (file or symlink), migration refuses (`configuration_migration`) rather than overwriting a possibly-still-needed prior rollback point. — configuration.sh:229-231 — category: transactional/rollback — criticality: HIGH
20. The rollback backup and the in-progress replacement file are created under `umask 077` and explicitly `chmod 600`, so a secret-bearing config file is never briefly world/group-readable during migration. — configuration.sh:232-234,236-237,265 — category: permissions/ownership — criticality: HIGH
21. The new configuration content is assembled entirely in a `mktemp` temp file and only `mv -f`'d onto the real file after every write and the final `chmod 600` succeed; any write failure deletes the temp file and fails closed without touching the original. — configuration.sh:236-264 — category: transactional/rollback — criticality: HIGH
22. If the final atomic rename itself fails, the temp file is discarded and (outside of `--transaction` mode) the just-taken backup is copied back over the target — migration never leaves the deployment's `.env-orbit` missing or half-written after a failed rename. — configuration.sh:266-270 — category: transactional/rollback — criticality: HIGH
23. Migration preserves the source file's original line-ending convention (LF vs CRLF, detected by presence of `\r`) rather than normalising it. — configuration.sh:238-239 — category: idempotency — criticality: LOW
24. `--transaction` mode (used when an outer caller such as install.sh already owns a rollback point) is only accepted together with `--migrate`; requesting it with any other action fails closed (`configuration_migration`), preventing the flag from being silently ignored. — configuration.sh:293 — category: input-validation — criticality: MEDIUM
25. `parse_file` distinguishes three outcomes for callers: fully valid current schema (0), valid-but-legacy/unversioned data needing migration (2, reported as `safely_migratable ORBIT_CONFIG_SCHEMA_VERSION`), or hard failure (any other exit) — callers (e.g. configure.sh's preflight) can require an explicit migration step rather than silently treating an old file as current. — configuration.sh:150-157,168-174,296-306 — category: provenance/immutability — criticality: MEDIUM

## configure.sh (operator-run `--check`/`--init`/`--set-oidc-secret`/`--set-deployment-profile` entry point; also runs with no args to finish bootstrapping secrets)

1. An `EXIT` trap (`cleanup`) unconditionally restores terminal echo, closes any opened controlling-terminal fd, and deletes any dangling `temporary_file` on every exit path (success, `fail`, or signal) — an interrupted run never leaves the operator's terminal silently echo-less or a stray temp file behind. — configure.sh:47-59 — category: recovery — criticality: MEDIUM
2. `run_configuration_preflight` runs `configuration.sh --preflight` before configure.sh touches anything else; a non-zero preflight result fails closed ("restoring the previous deployment"), and a report of `safely_migratable ORBIT_CONFIG_SCHEMA_VERSION` fails closed as `configuration_migration_required` — configure.sh never proceeds past an invalid or unmigrated schema. — configure.sh:26-34,960 — category: refusal/fail-closed — criticality: HIGH
3. `generate_hex_secret` requires OpenSSL or a readable `/dev/urandom`+`od`; if neither is available it fails closed rather than falling back to a weaker source, and the generated value is re-validated against `^[0-9a-fA-F]{64}$` before being trusted. — configure.sh:99-112 — category: secret-handling — criticality: HIGH
4. `ensure_environment_file` refuses to proceed at all if `.env-orbit.example` is missing (no default template to fall back to). — configure.sh:152-154 — category: refusal/fail-closed — criticality: LOW
5. If `.env-orbit` already exists, it is refused unless it is a regular, non-symlink file, and its permissions are forced to `600` before any further use — directly refuses a symlinked `.env-orbit`. — configure.sh:156-161 — category: permissions/ownership — criticality: HIGH
6. A newly created `.env-orbit` is assembled in a `mktemp` file that is `chmod 600` *before* any content is written, then atomically `mv`'d into place — a fresh environment file is never briefly world-readable or visible half-written. — configure.sh:164-177 — category: permissions/ownership — criticality: HIGH
7. `update_managed_keys` (the single reusable writer for every managed key) rewrites the whole file atomically via `mktemp`+`chmod 600`+`mv`, copies every unmanaged line through byte-for-byte, drops duplicate stale active assignments, and preserves the file's original trailing-newline convention. — configure.sh:199-291 — category: transactional/rollback — criticality: HIGH
8. `update_managed_keys` relocates `OIDC_CLIENT_SECRET_FILE` to its documented position (the commented placeholder, or immediately after `OIDC_CLIENT_SECRET`) instead of leaving it wherever it previously appeared, and guarantees only one active copy survives a rewrite. — configure.sh:227-268 — category: secret-handling — criticality: MEDIUM
9. `persist_orbit_image` refuses to persist `ORBIT_IMAGE` unless it is either the installer-generated local build tag (`orbit-local:<12 hex>`) or a registry reference pinned by digest (`repo@sha256:<64 hex>`) — an unpinned/mutable tag is never written to the deployment's config. — configure.sh:293-300,347-349 — category: provenance/immutability — criticality: HIGH
10. `set_deployment_profile` enforces preset-specific argument shape before writing anything: `standard`/`processing` must be given *no* model, `ai`/`full` must be given a model matching a strict allow-pattern; any mismatch returns failure (exit 2) with nothing persisted. — configure.sh:302-337 — category: input-validation — criticality: MEDIUM
11. Guided-configuration URL validators (`normalize_public_origin`, `validate_oidc_issuer`, `validate_authority`) reject control characters/whitespace, non-`https://` schemes, embedded credentials, query strings, fragments, out-of-range ports, and explicit loopback/`example.com` placeholder hosts — a placeholder or unsafe value can never be accepted as the production `APP_URL`/`OIDC_ISSUER`. — configure.sh:345-451,355-369 — category: input-validation — criticality: MEDIUM
12. `guided_init`'s non-interactive override path (`ORBIT_CONFIGURE_APP_URL`/`_OIDC_ISSUER`/`_OIDC_CLIENT_ID`) requires all three env vars together; supplying only some fails closed instead of silently blending an env value with an interactively prompted one. — configure.sh:501-514 — category: input-validation — criticality: MEDIUM
13. `OIDC_CALLBACK_URL` is always derived as `${normalized_app_url}/api/auth/callback` rather than accepted as independent operator input, so it can never drift out of sync with `APP_URL`. — configure.sh:542 (write) / 876-878 (readiness check) — category: provenance/immutability — criticality: MEDIUM
14. `guided_init` writes nothing to disk until `app_url`, `issuer`, and `client_id` have *all* validated successfully — no partially-valid guided configuration is ever persisted. — configure.sh:529-549 — category: transactional/rollback — criticality: MEDIUM
15. `ensure_secret_file` refuses an existing secret file unless it is a regular non-symlink file *and* its content already matches `^[0-9a-fA-F]{64}$`; a malformed or symlinked existing secret file is never silently accepted or overwritten. — configure.sh:554-567 — category: secret-handling — criticality: HIGH
16. A newly generated secret (session secret, Postgres password, document KEK) is written to a `mktemp`+`chmod 600` temp file under `.orbit-secrets/` and only then atomically moved into place — never briefly exposed at a predictable or loosely-permissioned path. — configure.sh:569-578 — category: secret-handling — criticality: HIGH
17. `ensure_secrets_directory` refuses to use `.orbit-secrets` unless it is a real, non-symlink directory, creating it fresh if absent, and always forces mode `700`. — configure.sh:181-190 — category: permissions/ownership — criticality: HIGH
18. A direct `OIDC_CLIENT_SECRET` value and a file-backed `OIDC_CLIENT_SECRET_FILE` are treated as strictly mutually exclusive: if a direct value is already active with no file-backed form, `ensure_oidc_secret_placeholder` does not create a second, competing secret form. — configure.sh:598-605 — category: secret-handling — criticality: MEDIUM
19. The OIDC secret placeholder path is refused outright if it exists as a symlink or other non-regular file (never silently followed or replaced); a fresh placeholder is created as a 0-byte, atomically-moved, mode-600 file. — configure.sh:598,607-621 — category: secret-handling — criticality: HIGH
20. `set_oidc_secret` reads the client secret exactly once, only from the controlling terminal (echo disabled / hidden-input widget) or stdin — it is never accepted as a CLI argument, so it can never appear in `ps` output or shell history. — configure.sh:623-654 — category: secret-handling — criticality: HIGH
21. The OIDC client secret is never printed, logged, or exported at any point in `set_oidc_secret` (explicit design comment plus code review of the path confirms no echo of `$secret`). — configure.sh:623-628 — category: secret-handling — criticality: HIGH
22. The read secret must be non-empty and must not exceed `maximum_secret_bytes` (65536); an empty or oversized secret fails closed before any file is touched. — configure.sh:655-661 — category: secret-handling — criticality: HIGH
23. The secret is written to a `chmod 600` temp file and atomically moved to the canonical `oidc-client-secret` path; only after that succeeds are the `.env-orbit` pointers updated, and `update_managed_keys` is only ever given an empty direct-value placeholder and the fixed canonical file path — the raw secret is never written into `.env-orbit` itself. — configure.sh:664-682 — category: secret-handling — criticality: HIGH
24. `ensure_vapid_keys` reuses an existing non-empty private-key file as-is (only re-asserting `chmod 600`) instead of regenerating it — rerunning configure.sh does not rotate VAPID keys. — configure.sh:684-689 — category: idempotency — criticality: MEDIUM
25. `ensure_vapid_keys` validates `ORBIT_IMAGE` against the same immutable local-tag/digest-pinned pattern before using it in `docker run`/`docker pull`, refusing to execute an unpinned or arbitrary image reference to generate keys. — configure.sh:693-696 — category: provenance/immutability — criticality: HIGH
26. Generated VAPID keys are only accepted if both the public and private values are non-empty (fails closed otherwise); the private key is written to a `mktemp`+`chmod 600` file and atomically moved into place. — configure.sh:708-715 — category: secret-handling — criticality: HIGH
27. `run_check` refuses to inspect `.env-orbit` for readiness unless it is a regular, non-symlink file with permissions exactly `600` — a symlinked or loosely-permissioned file is refused rather than silently read for the report. — configure.sh:725-735 — category: permissions/ownership — criticality: HIGH
28. `run_check`'s readiness report emits only fixed category words (`ready`/`missing`/`optional`) and variable names — actual configured values, including secrets, are never included in the output (explicit design comment plus reviewed reporting functions). — configure.sh:722-724,789-809 — category: secret-handling — criticality: HIGH
29. `OIDC_CLIENT_SECRET` reports "ready" only for a strict either/or: a direct value with no file-backed value (legacy compatibility), or a file-backed value at exactly the canonical runtime path with the secrets directory verified mode-700 non-symlink and the secret file verified non-empty/regular/non-symlink/mode-600 — any other combination (both set, wrong path, wrong perms, symlink) reports "missing" without disclosing why. — configure.sh:880-895 — category: secret-handling — criticality: HIGH
30. `run_check` marks `APP_URL`/`OIDC_ISSUER` ready only when they pass the same strict https/no-credentials/no-loopback/no-`example.com` validation used during guided configuration — a hand-edited `.env-orbit` with a placeholder or unsafe URL is flagged not-ready. — configure.sh:855-878 — category: input-validation — criticality: MEDIUM
31. `OIDC_CALLBACK_URL` is reported ready only when it exactly equals the callback re-derived from the currently-ready, normalized `APP_URL` — a stale callback URL left over from a changed `APP_URL` is caught rather than silently accepted. — configure.sh:876-878 — category: provenance/immutability — criticality: MEDIUM
32. Each CLI subcommand (`--check`, `--init`, `--set-oidc-secret`, `--set-deployment-profile`) strictly validates its argument count and exits 2 with usage on any deviation instead of guessing intent. — configure.sh:912-956 — category: input-validation — criticality: LOW
33. The default (no-argument) invocation explicitly states "Existing values were preserved" after running `ensure_environment_file` → preflight → `persist_orbit_image` → secrets directory → per-secret ensure/generate → OIDC placeholder → VAPID keys — rerunning configure.sh with no arguments is designed to be idempotent and never rotates/overwrites already-configured secrets. — configure.sh:959-970 — category: idempotency — criticality: MEDIUM
34. `--check-rollback` (issue #529, ADR-0014 decision 7, added for `repair.sh`'s `configuration-migration-interrupted` diagnosis) runs `run_check`'s identical readiness/exit-code/stderr logic — same required-field rules, same enum-only "ready"/"missing"/"optional" output, same never-delegated-to-the-container-engine behavior — against `configuration.sh`'s own rollback copy (`<environment_file>.orbit-config.rollback`) at its fixed conventional location instead of the live file. The checked filename is a single variable (`$checked_environment_file`) set once at startup from the selected mode, never accepted as a command-line path argument or override, so this mode adds no untrusted path input; a nonstandard layout simply cannot be checked, the same fail-safe fallback every other undetectable repair case already has. Every other input — `.orbit-secrets` included — still resolves to the real installation directory exactly as plain `--check` does, and the file-safety gate (regular, non-symlink, mode 600) applies identically; a missing rollback copy fails cleanly and non-zero rather than inventing a result. — configure.sh:7-19,951-962,1254-1270 — category: refusal/fail-closed — criticality: HIGH

## installer-simulation.sh (non-mutating rehearsal of the installer command centre — issue #260)

1. Only the fixed local sibling `installer-ui.sh`, resolved from the simulation script's own directory, is sourced — resolution fails closed if that path is missing or is a symlink; it is never a fetched or caller-supplied path. — installer-simulation.sh:24-31 — category: provenance/immutability — criticality: HIGH
2. The script is structurally side-effect-free: it never invokes Docker/Compose/curl/network/registry/OIDC, never touches a real file or directory outside its own sourcing, never pulls an image or model, and never starts/stops a service — verified by the absence of any such calls in the file; only `installer_ui_*` calls and `printf`/`sleep` appear. — installer-simulation.sh:6-13 (design comment), whole file — category: refusal/fail-closed — criticality: HIGH
3. Text typed into the sample "deployment note" prompt is captured into a local variable and immediately `unset`; text typed into the synthetic hidden-credential prompt is discarded to `/dev/null` — neither is ever written to a file, environment variable, or log, matching the script's explicit "never persists, logs or replays anything typed" guarantee. — installer-simulation.sh:128-133 — category: secret-handling — criticality: HIGH
4. Non-TTY/`--plain` invocation always runs one fixed, deterministic success scenario with no interactive branching, making headless/CI runs fully reproducible. — installer-simulation.sh:57-79 — category: idempotency — criticality: LOW
5. If no controlling terminal is available, the script silently falls back to the deterministic plain path instead of hanging on a blocked read. — installer-simulation.sh:42-48,77-80 — category: refusal/fail-closed — criticality: LOW
6. Every scenario's output is explicitly and repeatedly labelled synthetic (`"Simulation:"`, `"nothing is applied"`, `"No deployment occurred."`) and uses an obviously-fake image digest (`SIMULATED-DIGEST-NOT-REAL`) and a reserved documentation-only origin (`https://simulated.invalid.example`) so rehearsal output can never be mistaken for, or copy-pasted as, a real deployment result. — installer-simulation.sh:71-74,93-94,160-163 — category: refusal/fail-closed — criticality: MEDIUM
7. The "Repair" menu option is explicitly presentation-only in this script (emits a `blocked repair-unavailable` status and states "Nothing was changed") — the simulation can never trigger a real repair action. — installer-simulation.sh:104-110 — category: refusal/fail-closed — criticality: MEDIUM
8. Every abort path (Escape/Ctrl-C from any `installer_ui_select`/`installer_ui_read_text`/`installer_ui_read_secret` call) routes through `cancel()`, which always closes the opened `/dev/tty` file descriptor before exiting — an interrupted simulation never leaks an open terminal fd. — installer-simulation.sh:83-89,93-146 — category: recovery — criticality: LOW

## container-entrypoint.sh (container PID-1 bootstrap: secret staging + privilege drop)

1. Startup refuses to proceed unless the embedded `VERSION`, `REVISION`, and `CHANNEL` files baked into the image exist as regular, non-symlink files. — container-entrypoint.sh:20-28 — category: provenance/immutability — criticality: HIGH
2. Each embedded identity value is format-validated before use: `VERSION` must match strict semver (`v#.#.#`), `REVISION` must be a 40-hex-char git SHA, `CHANNEL` must be exactly `ci`, `preview`, or `dev` — a malformed embedded identity fails container startup closed. — container-entrypoint.sh:33-38 — category: provenance/immutability — criticality: HIGH
3. The secret-staging phase refuses to run unless the process is actually root (`id -u = 0`) — it must be root to `chown`/copy secrets before dropping privileges, and refuses to silently proceed as a lesser user. — container-entrypoint.sh:76-77 — category: permissions/ownership — criticality: HIGH
4. Refuses to proceed if either the Docker secrets source directory (`/run/secrets`) or the private runtime tmpfs destination (`/run/orbit-secrets`) is missing. — container-entrypoint.sh:78-81 — category: refusal/fail-closed — criticality: MEDIUM
5. The runtime secrets tmpfs ownership/permissions are unconditionally forced to `root:orbit` / `0750` before any secret is copied into it. — container-entrypoint.sh:83-84 — category: permissions/ownership — criticality: HIGH
6. Each secret source under `/run/secrets` is refused outright if it is a symlink ("refusing a symbolic-link secret") or any other non-regular file ("refusing a non-regular secret") — a spoofed or redirected host-mounted secret is never followed. — container-entrypoint.sh:89-92 — category: permissions/ownership — criticality: HIGH
7. Secret filenames are restricted to `[A-Za-z0-9._-]` and empty/`.`/`..` names are rejected ("refusing a secret with an unsafe name") before the name is used to build a destination path — prevents path traversal or shell-metacharacter injection via a crafted secret filename. — container-entrypoint.sh:94-99 — category: input-validation — criticality: HIGH
8. A secret's size must resolve to a clean, all-digit value from `wc -c`; any non-numeric/empty result fails startup closed rather than proceeding with an unknown size. — container-entrypoint.sh:101-106 — category: input-validation — criticality: MEDIUM
9. Empty secrets are refused in general; the *only* permitted exception is the exact `orbit-oidc-client-secret` placeholder at size 0, and only while `OIDC_CLIENT_SECRET_FILE` is unset — once that variable selects the file, an empty secret becomes a hard startup failure like any other, so a misconfigured/empty required secret can never silently start the app. — container-entrypoint.sh:107-118 — category: secret-handling — criticality: HIGH
10. Secrets are capped at 65536 bytes; anything larger is refused ("refusing an unexpectedly large secret") rather than copied. — container-entrypoint.sh:119-120 — category: secret-handling — criticality: MEDIUM
11. Each accepted secret is copied into the tmpfs only after removing any prior file at that destination path, then re-owned `orbit:orbit` and locked to mode `0400` — no stale leftover content survives a restart, and the running application user can read but never write or share the copy. — container-entrypoint.sh:122-126 — category: permissions/ownership — criticality: HIGH
12. Startup fails closed ("no Docker secrets were supplied") if zero secrets were found and copied — the container refuses to run fully unconfigured rather than starting silently with no secrets. — container-entrypoint.sh:130-131 — category: refusal/fail-closed — criticality: HIGH
13. The bootstrap process is replaced in-place via `exec su-exec orbit:orbit "$@"` (never forked) so the application — including PID 1 — runs with root privileges fully dropped for its entire lifetime and receives signals (e.g. `SIGTERM` on `docker stop`) directly rather than through an intermediary. — container-entrypoint.sh:133-135 — category: permissions/ownership — criticality: HIGH
14. `--version` and `--banner` are handled as pure, side-effect-free informational early exits before any secret-staging or privilege-drop logic runs. — container-entrypoint.sh:59-67 — category: refusal/fail-closed — criticality: LOW

## install.sh (main installer — largest script, 1556 lines; catalogued in reading passes, part 1 of N)

1. `--simulate` cannot be combined with `--install`/`--update`/`--repair`; any unrecognised flag or stray positional argument exits 2 with usage rather than guessing intent. — install.sh:63-99 — category: input-validation — criticality: LOW
2. `ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS` (must be 1-900) and `ORBIT_INSTALLER_POLL_INTERVAL_SECONDS` (must be 1-9) are strictly format- and range-validated before use; an out-of-range or malformed value exits 2 rather than silently clamping or being passed through to a timeout command. — install.sh:123-133 — category: input-validation — criticality: MEDIUM
3. `ORBIT_CHANNEL`, `ORBIT_REPOSITORY`, and `ORBIT_REGISTRY` operator overrides are each validated against a strict allow-pattern (channel/registry charset, `owner/repo` shape) before being used to build the image reference — an operator-supplied override can't inject an unexpected registry path segment. — install.sh:134-145 — category: input-validation — criticality: MEDIUM
4. `--simulate` dispatches immediately after safe argument parsing and *before* any target inspection, Docker/curl/network call, registry/image/OIDC operation, staging, or file transaction begins, and only ever `exec`s the fixed sibling `installer-simulation.sh` (never a fetched, caller-supplied, or symlinked path) — a `--simulate` invocation is guaranteed inert with respect to the real deployment. — install.sh:104-121 — category: refusal/fail-closed — criticality: HIGH
5. `load_installer_ui` only sources `installer-ui.sh` from the resolved staging directory (the fetched image's recorded source revision) after confirming it is a regular, non-symlink file — never an existing on-disk deployment copy — per an explicit design comment that this ordering prevents sourcing an untrusted local copy before validation. — install.sh:162-176 — category: provenance/immutability — criticality: HIGH
6. `is_preprovisioned_input` (the unattended pre-provisioning contract) requires `.env-orbit` to be exactly mode 600 and a regular non-symlink file, `.orbit-secrets/` to be exactly mode 700 and a real non-symlink directory containing *only* non-empty, mode-600, regular non-symlink files, with the target directory containing *exactly* those two entries and nothing else, and an OIDC client secret file that is itself non-empty — a loosely-permissioned, symlinked, or extraneous-file pre-provisioned target is rejected outright rather than partially trusted. — install.sh:282-304 — category: permissions/ownership — criticality: HIGH
7. `validate_target` refuses to install into a non-empty directory unless it is either a recognized existing Orbit deployment (regular `.env-orbit` + regular `docker-compose.yml` + real `.orbit-secrets/` directory, all non-symlinks) or passes the strict pre-provisioned-input contract above; any other non-empty directory fails closed with "Refusing to install here" before any pull or download happens. — install.sh:410-429 — category: refusal/fail-closed — criticality: HIGH
8. `rollback_transaction` never follows a symlinked parent directory when removing a newly-created path or restoring a backed-up path during rollback — configuration is treated as untrusted input "even though it was fetched from the image's recorded source revision," and rollback refuses (reporting an error, not silently skipping) rather than deleting/writing through an attacker-redirected parent. — install.sh:318-363 — category: transactional/rollback — criticality: HIGH
9. Rollback restores every backed-up path via a same-filesystem `mv` from a `cp -a` backup (preserving content, permissions, and directory-entry structure exactly, not just the files the installer's own logic is aware of) rather than reconstructing state field-by-field. — install.sh:342-344,353-363 — category: transactional/rollback — criticality: HIGH
10. Rollback only removes directories that this specific invocation created (tracked in `created_directories`); pre-existing directories are left alone even if they end up empty after restoration, so a failed install never deletes an operator's pre-existing (even if now-empty) directory structure. — install.sh:365-383 — category: transactional/rollback — criticality: MEDIUM
11. The `EXIT` trap (`cleanup`) rolls back an uncommitted file transaction and removes the staging directory on every exit path; if rollback itself fails partway, cleanup deliberately preserves the staging directory and reports its path instead of deleting potential recovery evidence, and exits non-zero to make the incomplete rollback visible rather than silently swallowing it. — install.sh:388-408 — category: recovery — criticality: HIGH
12. `derive_compose_project_name` requires the Compose project name — whether read from an existing `.env-orbit`, supplied via `COMPOSE_PROJECT_NAME`, or derived from the working-directory name — to match `^[a-z0-9][a-z0-9_-]*$`, and if both a configured file value and an explicitly requested value are present they must match exactly, or the installer refuses to start Compose at all. — install.sh:431-462 — category: input-validation — criticality: HIGH
13. `volume_belongs_to_deployment` proves ownership of a pre-existing database volume with multiple independent checks before trusting it: exact Compose project/volume-name label match, exactly one `orbit-db` container attached to the volume in that project, exactly one `orbit-app` container in that project, and that container's image must be digest-pinned and match the expected (previously recorded) image exactly — any ambiguity, extra container, mismatched image, or malformed `docker` output is treated as "not proven" (fails closed) rather than assumed safe. — install.sh:464-520 — category: provenance/immutability — criticality: HIGH
14. All `docker` command output consumed for volume/container identity checks is bounds-checked (length caps, single-line/no-embedded-newline checks, strict field regexes) before being trusted, guarding against a compromised or unexpected Docker daemon response being parsed as valid identity data. — install.sh:474-519,538-546 — category: input-validation — criticality: MEDIUM
15. `verify_database_volume_safety` refuses to proceed if an existing Orbit database volume is found but the target was otherwise empty (no recognizable prior deployment) — an empty-looking target directory is never allowed to silently attach to somebody else's pre-existing database volume. — install.sh:552-554 — category: refusal/fail-closed — criticality: HIGH
16. If more than one candidate database volume matching the naming pattern is found, the installer refuses to proceed until exactly one recognized deployment can be proven — it never guesses which volume to use. — install.sh:555-556 — category: refusal/fail-closed — criticality: HIGH
17. Once a database volume has been verified once in a run, subsequent checks (`database_volume_checked`) re-verify that the *same* single volume name still exists (`docker volume ls` returns exactly that one name) — refusing to proceed if the recognized volume disappeared or another appeared mid-run (a TOCTOU guard). — install.sh:526-533 — category: refusal/fail-closed — criticality: HIGH
18. Attaching to a pre-existing, verified database volume additionally requires the preserved `postgres-password` secret file to exist as a regular non-symlink file at exactly mode 600, or the installer refuses to start Compose — an existing database is never brought up with a missing/altered credential file. — install.sh:574-577 — category: secret-handling — criticality: HIGH
19. `verify_database_password_preserved` fails closed if the live `postgres-password` secret content or its mode-600 permission differs from the pre-transaction backup at any point — the installer refuses to proceed if this critical secret changed underneath it during the run. — install.sh:588-595 — category: secret-handling — criticality: HIGH
20. For the `ai`/`full` profiles, downloading the selected local model is always a separate, explicitly-confirmed step from merely saving the model choice ("Save the model choice without downloading it now" is the presented default) — a large model download is never triggered as a side effect of profile selection. — install.sh:740-767 — category: refusal/fail-closed — criticality: MEDIUM
21. The resolved `install` action requires an empty/safely-pre-provisioned target or fails ("use Update for a recognized deployment"); the resolved `update` action requires a non-empty, recognized existing deployment or fails ("Update requires a recognized existing Orbit deployment") — install can never silently overwrite an existing deployment, and update can never silently bootstrap a fresh one. — install.sh:800-812 — category: refusal/fail-closed — criticality: HIGH
22. The `repair` action is explicitly unavailable in this installer version: it emits a `blocked repair-unavailable` status and states "No deployment files or services were changed" before returning — it never attempts a partial/best-effort repair. — install.sh:813-818 — category: refusal/fail-closed — criticality: MEDIUM
23. `current_deployment_profile` requires the existing `COMPOSE_PROFILES`/`TIKA_URL`/`OLLAMA_MODEL` triple to exactly match one of exactly four known-good combinations (standard/processing/ai/full); any other combination is treated as unsupported/ambiguous, and `resolve_installer_action` fails closed ("unsupported or ambiguous") rather than guessing which profile is active. — install.sh:632-660,826-829 — category: refusal/fail-closed — criticality: MEDIUM
24. In a non-interactive context (no controlling terminal) with required configuration fields still missing, `prepare_configuration` refuses to proceed and prints explicit remediation guidance (`print_noninteractive_configuration_guidance`) rather than attempting to guess, auto-fill, or silently skip required secrets/URLs. — install.sh:879-885,993-996 — category: refusal/fail-closed — criticality: HIGH
25. The OIDC discovery HTTP request is pinned to `--proto '=https' --proto-redir '=https' --tlsv1.2`, with a 5s connect / 10s total timeout and a `--max-filesize` cap — plaintext HTTP and protocol-downgrade-on-redirect are both structurally impossible, and both time and response size are bounded. — install.sh:899-905 — category: input-validation — criticality: HIGH
26. The downloaded OIDC discovery document is only trusted after independently confirming (defense in depth beyond curl's own `--max-filesize`) that it landed as a regular, non-symlink file, forcing its permissions to 600, and re-checking its on-disk size against the same byte cap. — install.sh:919-925 — category: input-validation — criticality: MEDIUM
27. The OIDC discovery JSON itself (issuer match, required `https://` endpoints, no embedded credentials/fragment — enforced by the embedded `oidc_discovery_parser`) is parsed inside a throwaway container run with `--network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 1001:1001 --pids-limit 64 --memory 64m --cpus 0.5` using the pinned Orbit image's own Node — untrusted remote JSON from the OIDC provider is never parsed by the installer's own host bash/Node process. — install.sh:23-47,887-944 — category: input-validation — criticality: HIGH
28. After every `configure.sh` invocation, `prepare_configuration` re-verifies that `.env-orbit` is still a regular non-symlink file and `.orbit-secrets` is still a real non-symlink directory before continuing — even the installer's own trusted configuration step is re-validated rather than assumed correct. — install.sh:956-959,972-975 — category: permissions/ownership — criticality: HIGH
29. `run_configuration_migration` invokes the migration only with the already digest-verified resolved image reference and derived project name, and accepts only two known-good output strings ("already current…" / "migrated from schema…"); any other output — including a plausible-looking but unexpected result — is treated as failure and fails closed ("restoring the previous deployment"). — install.sh:1010-1029 — category: provenance/immutability — criticality: HIGH
30. The guided-install configuration path (`stage_guided_install_configuration`) only activates when the target has *no* pre-existing `.env-orbit`/`.orbit-secrets`, not even as symlinks — it can never overwrite or relocate operator-provided pre-provisioned input. — install.sh:1031-1036 — category: refusal/fail-closed — criticality: MEDIUM
31. Every step of guided-install configuration runs against the staged copy under `staging_dir`, and every failure message in that path explicitly states "the target remains unchanged" — a cancelled or invalid guided configuration during a fresh install never partially mutates the real target directory. — install.sh:1031-1077 (esp. 1042,1044,1046,1052,1056,1060,1062) — category: transactional/rollback — criticality: HIGH
32. Guided-install configuration requires an explicit final "apply" confirmation on a review menu before being considered staged/committable; choosing "cancel" aborts with nothing applied. — install.sh:1064-1077 — category: refusal/fail-closed — criticality: MEDIUM
33. Every health probe (database/application/ClamAV) runs under `timeout --signal=TERM --kill-after=1s 5s` via `bounded_compose_probe` — a hung `docker compose exec` during health checking can never block the installer indefinitely; it is force-killed within a bounded window. — install.sh:1079-1097 — category: refusal/fail-closed — criticality: MEDIUM
34. `probe_application_health` treats the app as healthy only if the embedded Node probe (own 3s `AbortSignal` timeout) receives an HTTP 200 with a JSON body whose `status` is exactly `"ready"` and `service` is exactly `"orbit"` — any other status code, malformed JSON, or unexpected body shape is treated as unhealthy rather than any 2xx being "good enough". — install.sh:48-55,1091-1093 — category: input-validation — criticality: MEDIUM
35. `wait_for_component_health` polls each health probe against a wall-clock deadline (`readiness_timeout_seconds` from install start) independent of the per-probe `timeout` guard — the outer wait loop itself is bounded and always returns failure once the deadline passes, rather than looping indefinitely if a probe keeps returning quickly-but-falsely. — install.sh:1107-1123 — category: refusal/fail-closed — criticality: MEDIUM
36. `prepare_service_images` pulls the Tika image only for the `processing`/`full` profiles and the Ollama image only for the `ai`/`full` profiles, explicitly emitting a `skipped` status for the others — optional-service images for services the operator didn't select are never pulled. — install.sh:1125-1162 — category: refusal/fail-closed — criticality: LOW
37. If `compose up` fails on a genuinely fresh install (`target_was_empty`), the installer runs `compose down --remove-orphans` before failing, so a failed first-time startup doesn't leave orphaned partial containers behind; this cleanup is deliberately *not* run on an `update`, so a failed update never tears down an existing working deployment's containers. — install.sh:1168-1173 — category: recovery — criticality: MEDIUM
38. When the application health probe fails, the installer distinguishes "running but not yet ready" (`health-timeout`) from "process exited before reporting ready" (`application-startup`) via a separate `exec -T orbit-app true` liveness check, and explicitly avoids claiming an unproven specific cause in the failure message. — install.sh:1180-1185 — category: refusal/fail-closed — criticality: MEDIUM
39. A confirmed Ollama model pull only executes after the Ollama service itself has already been verified healthy — a model download is never attempted against a not-yet-verified service. — install.sh:1203-1218 — category: refusal/fail-closed — criticality: LOW
40. Host preflight requires `docker`, Docker Compose v2, `curl`, and GNU `timeout` to all be present before any image pull or asset fetch begins — fails closed immediately with a clear tool-specific message rather than failing partway through with a confusing downstream error. — install.sh:1260-1263 — category: refusal/fail-closed — criticality: MEDIUM
41. The requested channel tag is resolved to an immutable digest via `docker image inspect`'s `RepoDigests`, and only an entry that both matches the expected repository prefix and validates against a strict `@sha256:<64 hex>` pattern is accepted — the moving channel tag itself is never what gets recorded or deployed. — install.sh:1267-1288 — category: provenance/immutability — criticality: HIGH
42. The source revision used to fetch deployment assets is read from the resolved image's own `org.opencontainers.image.revision` OCI label and validated as a 40-hex git SHA — deployment assets (compose files, scripts) are always fetched from the exact revision that produced the running image, never from a moving branch, so the Compose configuration can never drift from the image it configures. — install.sh:1290-1297,1313 — category: provenance/immutability — criticality: HIGH
43. The image's semantic version is likewise read from its own `org.opencontainers.image.version` OCI label and validated against strict semver before being trusted or recorded as `ORBIT_CONFIG_APPLIED_VERSION`. — install.sh:1299-1303 — category: provenance/immutability — criticality: HIGH
44. Before any deployment asset is fetched or written, the installer requires the resolved image's own `container-entrypoint.sh --banner` to actually run successfully in a real container — a digest that pulls but can't execute its own entrypoint is rejected up front. — install.sh:1306-1310 — category: refusal/fail-closed — criticality: MEDIUM
45. Only a fixed, hardcoded allowlist of deployment assets (`deployment_assets`) is ever fetched from the remote revision; each fetched file must land as a non-empty, regular, non-symlink file, and every fetched *script* additionally must pass `bash -n` before it is later sourced or executed. — install.sh:1313-1332,1405-1418 — category: provenance/immutability — criticality: HIGH
46. `preflight_final_paths` refuses to proceed if any existing final destination — `.env-orbit`, `.orbit-secrets`, any asset's parent directory, or any individual deployment asset itself — currently exists as anything other than its expected safe type (regular file / real directory, always non-symlink) — checked before any backup or mutation begins. — install.sh:1345-1370 — category: permissions/ownership — criticality: HIGH
47. `prepare_rollback_area` creates the rollback staging area and its `original/` backup subdirectory at mode 700 and backs up every currently-existing managed path with `cp -a` (preserving exact content, permissions, and structure) before any of those paths is touched — nothing in the real target is mutated until a complete backup exists. — install.sh:1372-1393 — category: transactional/rollback — criticality: HIGH
48. Every deployment asset is fetched into a private, mode-700 staging directory and fully validated (non-symlink, regular, non-empty, and — for scripts — `bash -n`-clean) before anything in the real target directory is touched — a fetch or validation failure at this stage can never mutate an existing deployment. — install.sh:1395-1421 — category: transactional/rollback — criticality: HIGH
49. The file transaction only begins (`file_transaction_active=1`) after both `preflight_final_paths` (destination-safety) and `prepare_rollback_area` (backup) have completed — no target directory is created and no rollback tracking starts until every final destination has already been proven safe and backed up. — install.sh:1435-1439 — category: transactional/rollback — criticality: HIGH
50. For an existing `.env-orbit`, a `configuration.sh --preflight` check and a full `--migrate --transaction` run both happen before any fetched asset is installed or `configure.sh` runs — legacy/invalid configuration is caught and migrated (or the whole run fails closed) at the earliest point, and is still fully covered by the outer file-transaction rollback. — install.sh:1441-1448 — category: transactional/rollback — criticality: HIGH
51. Every deployment asset directory and asset file is re-checked for the same safe-type invariants (real directory / regular non-symlink file) a second time immediately before being created/overwritten — not just during the earlier preflight — catching a TOCTOU change that occurred between preflight and write. — install.sh:1450-1474 — category: refusal/fail-closed — criticality: HIGH
52. Guided-configuration output (`.env-orbit`, `.orbit-secrets`) staged during a fresh install is moved into place with `mv` (same-filesystem atomic rename), never copied — no partially-written configuration or secrets directory can ever be observed at the final path. — install.sh:1460-1465 — category: transactional/rollback — criticality: HIGH
53. The resolved image digest is written into `.env-orbit`'s `ORBIT_IMAGE` as the fully-qualified digest reference; the moving channel tag is explicitly never persisted here, and this write is a deliberate defense-in-depth repetition of the same value `configure.sh` already persisted from the environment. — install.sh:1501-1536 — category: provenance/immutability — criticality: HIGH
54. The final `ORBIT_IMAGE` rewrite is staged into a `mktemp` file (mode 600) under `staging_dir` and only `mv`'d over `.env-orbit` after the entire rewritten content has been successfully produced — `.env-orbit` is never edited in place with a risk of partial content on a mid-write failure. — install.sh:1505-1535 — category: transactional/rollback — criticality: HIGH
55. `docker compose config --quiet` must succeed — validating the fully composed configuration — before any service is started or the transaction is committed; invalid Compose configuration is caught and fails closed pre-commit. — install.sh:1539-1541 — category: refusal/fail-closed — criticality: HIGH
56. The file transaction is marked committed (`file_transaction_committed=1`) only after OIDC discovery, configuration migration, and `compose config --quiet` have all already succeeded; any failure before this point triggers the `EXIT`-trap rollback of every file change made so far, and only once committed do image pulls and service startup (steps outside the file-rollback mechanism's scope) begin. — install.sh:1479-1550 — category: transactional/rollback — criticality: HIGH

## repair.sh (read-only diagnosis + planning entry point — issue #261; `--check`/`--plan`, no executor yet)

1. Every `docker` invocation is limited to `docker ps`, `docker volume ls`, `docker compose config`, `docker inspect`, `docker image inspect` (#528, a local image-store read that runs nothing), and narrowly-scoped `docker exec` client probes (`pg_isready`, `psql -c 'SELECT 1'`, and — #528, guarantee 38 — one fixed-literal outcome-row `SELECT`) issued only against this deployment's own orbit-db container — never a command that creates, starts, stops, or deletes a container/volume/image, and never SQL beyond those two byte-for-byte fixed literals — and the script never writes, creates, chmods, or deletes anything inside the installation directory (its only `mktemp` use is a caller-side capture of `configure.sh --check`'s stderr under `$TMPDIR`, immediately removed). — repair.sh:20-44,364-377 — category: refusal/fail-closed — criticality: HIGH
2. Directory recognition is deliberately loose (any one of `.env-orbit`, `docker-compose.yml`, `.orbit-secrets`, or leftover `.orbit-install-staging.*` evidence, of any file type) rather than install.sh's strict binary check; if none of those fingerprints exist at all, diagnosis reports `not-orbit-directory` and exits 5 without attempting any further check, so it never reasons about an unrelated directory's contents. — repair.sh:276-295 — category: refusal/fail-closed — criticality: MEDIUM
3. Configuration syntax/schema/secret readiness is never reimplemented: it is delegated entirely to `bash scripts/configure.sh --check` as an independent subprocess, and only its exit status plus whether it wrote to stderr is used to classify `configuration-incomplete` (readiness output only) vs `configuration-invalid` (a structural `fail()`). — repair.sh:351-377 — category: provenance/immutability — criticality: MEDIUM
4. Stdout is restricted to a fixed enum vocabulary (`finding class=<reason-class> target=<target-class> severity=<info|warn|fail>` and a final `diagnosis result=... checked=... skipped=...` line) — no path, configured value, or secret is ever interpolated into a finding line. — repair.sh:32-137,245-273 — category: secret-handling — criticality: HIGH
5. Findings are printed in a fixed `class_order`, not check-execution order, so the same on-disk/daemon state always produces byte-identical output regardless of which check happened to run first or which secret file was found broken first. — repair.sh:189-208,245-258 — category: idempotency — criticality: LOW
6. Every docker-backed check is gated by one cheap, bounded probe (`timeout 5s docker ps -a`); any failure of the `docker` CLI, `timeout`, or the daemon is treated identically as `docker-unavailable` for every affected check (now including the database and application container checks), so a missing or unreachable Docker installation degrades diagnosis instead of hanging or crashing it. — repair.sh:426-443 — category: refusal/fail-closed — criticality: MEDIUM
7. The `volume-retained-without-credentials` finding (the #261 fixed-project collision / SQLSTATE 28P01 precursor) is derived purely from a retained volume name match (`${project}_orbit-db-data`) and the local absence of the `postgres-password` secret file — it never opens a database connection, execs into a container, or reads/prints the secret's contents. — repair.sh:431-459 — category: secret-handling — criticality: HIGH
8. `container-foreign-owner` only fires for a container carrying this deployment's own Compose project label without a known Orbit service label (`orbit-app`/`orbit-db`/`orbit-clamav`/`orbit-tika`/`orbit-ollama`); a container labelled as a recognized Orbit service is never reported as foreign. — repair.sh:138,461-484 — category: input-validation — criticality: MEDIUM
9. `checked`/`skipped` in the final summary line are derived by subtracting from one fixed constant (`total_checks=17`, extended from 13 by the second slice's two database/application checks, from 15 by #528's image-identity check, and from 16 by #530's document-volume-retention check) rather than incrementing two independent counters, so a check that could not run for any reason (docker unavailable, secrets directory invalid, project name unresolved) is guaranteed to be counted exactly once, never double-counted or dropped. — repair.sh:186,263 — category: idempotency — criticality: LOW
10. `--check` and the accepted-but-inert `--plain` flag (in either order) are the only accepted arguments; any other flag or positional argument exits 2 with a usage message before touching the filesystem or Docker at all. — repair.sh:150-172 — category: input-validation — criticality: LOW
11. Compose project-name derivation is read-only and never aborts the run: it mirrors install.sh's `derive_compose_project_name` precedence (configured `.env-orbit` value, then `$COMPOSE_PROJECT_NAME`, then a sanitized working-directory basename), but an unresolved name simply skips the docker-backed checks rather than failing diagnosis. — repair.sh:406-425 — category: refusal/fail-closed — criticality: LOW
12. A symlinked managed file, secrets directory, or secret file is classified under its own distinct reason class (`managed-file-symlink` / folded into `secrets-directory-invalid` / folded into `secret-permissions`) checked before existence, so a symlinked managed path is never silently treated as merely "missing." — repair.sh:275-294,315-342 — category: permissions/ownership — criticality: HIGH
13. The script is source-less by construction: it never sources `install.sh`, `configure.sh`, or `installer-ui.sh` — the only cross-script interaction is invoking `bash scripts/configure.sh --check` as an independent subprocess, so a change to those scripts' internal state can never leak into repair.sh's own execution environment. — repair.sh:11-18 — category: provenance/immutability — criticality: MEDIUM
14. Database reachability/credential diagnosis execs only read-only client commands (`pg_isready`, `psql -c 'SELECT 1'`, and — only ever after that authenticated probe has already succeeded — #528's single fixed-literal outcome-row `SELECT`, guarantee 38) into this deployment's own orbit-db container, proved by the same Compose project/service label discipline as `container-foreign-owner`; it distinguishes a container that is absent or not yet accepting connections (`database-unreachable`) from a proven password/SQLSTATE-28P01-style authentication failure (`database-credential-mismatch`, the motivating failure of #261) from a clean pass (no finding) — never a fourth, guessed outcome. — repair.sh:513-569 — category: refusal/fail-closed — criticality: HIGH
15. The PostgreSQL password is forwarded to `psql` with `docker exec -e PGPASSWORD` (no `=value` on the command line), which makes the Docker CLI take the value from its own inherited process environment instead of argv; it is read into a single `local` variable scoped to one function call, attached only as a same-line prefix assignment on the `docker exec` invocation (never `export`ed into the rest of the script), and reset to an empty string immediately after use — it never appears in argv, a finding, or any script output, even when the captured `psql` error text itself would have disclosed it. — repair.sh:45-59,520-568 — category: secret-handling — criticality: HIGH
16. `stale-container` only compares this deployment's running orbit-app container's image against a syntactically digest-pinned `ORBIT_IMAGE` value (`repo@sha256:<64 hex>`, the same pattern install.sh itself requires); a non-digest-pinned, missing, or unreadable `ORBIT_IMAGE` silently skips the comparison rather than guessing at drift. — repair.sh:588-616 — category: provenance/immutability — criticality: MEDIUM
17. `application-unhealthy` fires only when Docker's own computed health status for this deployment's orbit-app container is exactly `unhealthy` (sourced from the image's built-in `HEALTHCHECK`, never a SQL/application-level probe run by this script) — a container still `starting`, one with no healthcheck configured, or one that does not exist yet is never reported as unhealthy. — repair.sh:582-621 — category: input-validation — criticality: MEDIUM

**#261 third slice — `--plan` (still zero mutation)**

18. `--check` and `--plan` are mutually exclusive: exactly one is required, and supplying both (in either order) or neither exits 2 with a usage message before any diagnosis runs, exactly like an unrecognised flag — `--plan` never silently falls back to `--check` behavior or vice versa. — repair.sh:292-322 — category: refusal/fail-closed — criticality: MEDIUM
19. `--plan` maps every one of the 25 `--check` reason classes through one fixed, exhaustive `action_for_class` table to one of six safe automatic action classes (`restore-transaction`, `fix-permissions`, `regenerate-secret`, `rotate-database-credential`, `restart-services`, `rerun-configuration`) or to `manual` — the table has no destructive entry, and issue #261 requires that none ever be added: destructive recovery (e.g. deleting a database/document volume) is explicitly out of scope for ordinary repair and lives in a separate exact-target workflow. — repair.sh:366-411 — category: refusal/fail-closed — criticality: HIGH
20. A missing `postgres-password` secret is planned as `regenerate-secret` only when no `volume-retained-without-credentials` finding accompanies it in the same diagnosis; when a database volume is retained, that same finding is instead planned as `rotate-database-credential` (never `regenerate-secret`), so repair is never planned to mint an unrelated new database password against data still encrypted/authenticated under the old one — the #261 fixed-project collision. — repair.sh:503-511 — category: secret-handling — criticality: HIGH
21. Every `rotate-database-credential` plan line unconditionally carries `backup=required`, which is how the plan encodes — ahead of any executor — that slice 4 must create and validate a private database checkpoint before ever touching the role; a database password is never planned to be reset merely because authentication failed. — repair.sh:388-410,512-557 — category: transactional/rollback — criticality: HIGH
22. Every `action=manual` plan line is paired with exactly one human-readable line on stderr, drawn from a fixed per-reason-class `manual_guidance` table naming only field-level concepts (e.g. "the flagged container's labels") — never a path, configured value, or secret — so an operator always learns the exact safe manual step even when repair itself cannot act. — repair.sh:411-421,540-546 — category: secret-handling — criticality: HIGH
23. `--plan`'s exit code is derived from whether at least one automatic (non-manual) action was planned among the warn/fail-severity findings (3, regardless of any manual findings alongside it) versus warn/fail-severity findings existing with zero automatic actions (4) — never from finding severity beyond the pass/fail severity gate itself (guarantee 25) — so `echo $?` alone tells an automated caller whether unattended remediation is even on the table before any confirmation prompt exists. — repair.sh:548-566 — category: refusal/fail-closed — criticality: MEDIUM
24. `--plan` stdout is restricted to the same enum-only vocabulary discipline as `--check` (`plan action=<action-class> resolves=<reason-class> mutation=<...> backup=<...>` plus a `plan result=... actions=... manual=...` terminal line), grouped by the same fixed `class_order`, so `--plan` output is byte-identical for byte-identical findings and never interpolates a path, configured value, or secret — every `--check` read-only/no-ANSI/determinism guarantee above holds identically under `--plan`. — repair.sh:512-566 — category: secret-handling — criticality: HIGH
25. An info-severity finding (`docker-unavailable`, `unrelated-resource-present`) is excluded from `--plan` entirely — before the action-class mapping is even consulted — producing no `plan` line and counting toward neither `actions` nor `manual`; a diagnosis containing only info-severity findings therefore yields `plan result=empty actions=0 manual=0` and exit 0, identical to `--check`'s own `result=healthy` exit 0 for that same on-disk/daemon state, so the two modes never render contradictory verdicts (e.g. `--check` "healthy" against `--plan` "unplannable-failures-present") for one unchanged deployment. — repair.sh:524-531 — category: refusal/fail-closed — criticality: MEDIUM

**Slice 4 stage one — `--execute --safe-only` (issue #261, owner decision 2026-08-13)**

26. `--execute` is refused with a usage error (exit 2) unless `--safe-only` is also present (and vice versa, `--safe-only` is refused without `--execute`); the usage message names stage two explicitly rather than silently running a partial repair, so an operator or automated caller can never end up unattended-executing something narrower than they asked for without being told why. — repair.sh:628-670 — category: refusal/fail-closed — criticality: MEDIUM
27. The stage-one safe set actually executed is a fixed three-item allowlist (`fix-permissions`, `restore-transaction`, `restart-services`) named directly from the owner's decision, not derived from the plan's own `mutation=reversible` tag — `regenerate-secret` is classified reversible in the plan but is never executed here, since minting new live secret material is a materially different risk than a mode-only chmod or a container restart; every action outside the allowlist is always reported `execute action=<class> resolves=<reason-class> result=skipped`, never attempted. — repair.sh:713-713,1037-1043,1719-1725 — category: secret-handling — criticality: HIGH
28. `fix-permissions` re-validates the target's exact current type (regular non-symlink file, or real non-symlink directory) immediately before its single `chmod` call, defending against a TOCTOU change between diagnosis and execution; a symlink or wrong-type target is reported `failed` with zero mutation rather than chmod'd through, since a mode-only fix cannot safely repair a structural type mismatch. — repair.sh:1461-1493 — category: permissions/ownership — criticality: HIGH
29. For the staging-evidence-present boundary (the install-transaction leftover; see guarantee 42 for the unrelated configuration-migration-interrupted boundary this same action class also covers), `restore-transaction` only ever considers a fixed, literal allowlist of paths (mirroring install.sh's own `managed_paths`) — it never enumerates the leftover staging directory's own contents to decide what to touch, so a hostile or tampered `.orbit-install-staging.*` directory can never smuggle in an unexpected path to overwrite. — repair.sh:720-733,1508-1524 — category: refusal/fail-closed — criticality: HIGH
30. For that same staging-evidence-present boundary, `restore-transaction` refuses to act on any path reached through a symlinked parent directory, exactly like install.sh's own `rollback_transaction`, and refuses a symlinked staging backup entry outright — an unproven symlink is never followed on either side of the restore. — repair.sh:1526-1543 — category: permissions/ownership — criticality: HIGH
31. Before `restore-transaction` mutates any path under that boundary, the path's current live state is copied into this run's private, mode-0700 recovery directory; if any later path in the same action fails, every path already touched by that action instance is restored from that backup before the action is reported `failed`, and the leftover staging directory is left in place for a future retry — only on full success is the staging directory removed. — repair.sh:1058-1072,1495-1590 — category: transactional/rollback — criticality: HIGH
32. `restart-services` re-resolves its target container via the identical Compose project-label/service-label ownership proof diagnosis itself uses, immediately before restarting — never trusting the container identity captured at diagnosis time — and restarts a given service at most once per `--execute` run even when two findings (`stale-container` and `application-unhealthy`) both resolve to it, memoizing the outcome for the second `execute` line rather than restarting twice. — repair.sh:1596-1633 — category: refusal/fail-closed — criticality: MEDIUM
33. Approval for the safe batch follows a fixed priority (machine-prompt mode, then an interactive controlling terminal, then non-interactive automation — reachable only because `--safe-only` is mandatory this slice) and gates all execution: a decline, EOF, or Ctrl-C at the confirmation step is guaranteed to precede any mutation code, so every planned action — safe or not — is reported `skipped` and the deployment is left provably unmutated. — repair.sh:1634-1663,1710-1716 — category: refusal/fail-closed — criticality: HIGH
34. Machine-prompt mode (`ORBIT_REPAIR_PROMPTS=machine`) reuses the exact #297 line grammar (`prompt`/`prompt-accept`/`prompt-abort`, `key=value` tokens only) documented for `configure.sh` in docs/engine-events.md, extended with exactly one repair-specific field/kind pair (`field=safe-batch kind=confirm`) so a launcher driving repair.sh programmatically never needs a second protocol; only the literal single-byte answer `y` accepts. — repair.sh:1634-1650 — category: provenance/immutability — criticality: MEDIUM
35. `--execute` stdout carries the same enum-only discipline as `--check`/`--plan` — `execute action=<action-class> resolves=<reason-class> result=<done|failed|skipped>` lines, a terminal `execution result=<empty|complete|unactionable|declined|failed> done=<n> failed=<n>` line, then the full post-execution re-diagnosis in `--check`'s own line grammar — and never interpolates a path, configured value, or secret, exactly like the read-only modes. — repair.sh:1665-1755 — category: secret-handling — criticality: HIGH
36. `--execute`'s process exit code always reflects this run's own execution outcome (0 empty/complete/unactionable, 1 declined, 4 failed, 2 usage error, 5 forced not-an-orbit-installation) and never the post-execution re-diagnosis's own severity — analogous to how `--plan`'s exit code reflects planning outcome rather than target health — so a caller that also cares about post-repair health reads the printed re-diagnosis `diagnosis result=...` line instead of inferring it from `$?`. — repair.sh:1676-1758 — category: refusal/fail-closed — criticality: MEDIUM
37. The private recovery directory's path is never printed under any mode, and it is unconditionally removed at the end of every `--execute` run regardless of outcome — a failed action has already consumed its own backup to self-restore before being reported, so nothing that could still need it survives past the run. — repair.sh:1058-1072,1749 — category: secret-handling — criticality: MEDIUM

**#528 delta slice — migration and identity diagnosis (owner decision, 2026-08-23)**

38. `migration-failed` is never derived by comparing migration journals (drizzle rolls a failed migration back leaving no journal row, so a comparison cannot distinguish "ran and failed" from "never ran"): it reads the migrator's own published verdict, primarily via the same bounded `docker logs` sentinel scan as the #437 classes (fixed-token match on `reason=migration_failed`, works on a stopped or crash-looping container), with a backstop that is sequenced strictly after that scan and skips itself whenever the scan already reported — so the SQL only ever runs in the cases the scan cannot answer (sentinel rotated out of the bounded log window, or container removed), and only after the authenticated `SELECT 1` probe has succeeded — exactly one fixed-literal query, `SELECT "outcome", "reason" FROM "drizzle"."orbit_migration_runs" ORDER BY "id" DESC LIMIT 1`, byte for byte with zero interpolation — whose response is treated as hostile: bounded to 256 bytes and accepted only when it matches `^([a-z_]{1,32})\|([a-z_]{0,32})$`; a missing table, database error, or any other byte sequence is a silent skip, never a guess, and at most one `migration-failed` finding is emitted however many channels report it. — repair.sh:1886,1982-1992,2012-2035,2074-2098 — category: refusal/fail-closed — criticality: HIGH
39. `image-identity-mismatch` compares content-addressable image IDs — the running orbit-app container's `docker inspect` `.Image` against `docker image inspect` `.Id` for the digest-pinned `ORBIT_IMAGE` reference — entirely from the local image store, never a registry call; a non-digest-pinned `ORBIT_IMAGE`, an absent container, a pinned image not present locally, or malformed probe output each skip the comparison outright, so the class only ever fires on two well-formed, locally-proven IDs that differ. — repair.sh:2105-2131 — category: provenance/immutability — criticality: HIGH
40. Both #528 classes plan as `action=manual` with fixed field-level guidance: `migration-failed` directs the operator to the pre-update recovery point (ADR-0004 owns that rollback boundary — repair never applies, retries, or reverses a migration, since the migrator's own idempotent retry already happens on any restart), and `image-identity-mismatch` never restarts or recreates a container on the operator's behalf. — repair.sh:1226-1240,1285-1290 — category: refusal/fail-closed — criticality: HIGH

**#529 delta slice — configuration-migration-interrupted recovery (ADR-0014 decision 7)**

41. `configuration-migration-interrupted` fires only when the live `.env-orbit` fails `configure.sh --check` AND `.env-orbit.orbit-config.rollback` exists, is a regular non-symlink file at mode 600, and itself passes `configure.sh --check-rollback` — the identical readiness/exit-code/stderr logic `--check` uses, run by `configure.sh` itself against its own conventional rollback location (see the `configure.sh` section's own `--check-rollback` guarantee), never a hand-staged copy. It replaces, never adds to, the plain `configuration-invalid`/`configuration-incomplete` finding for that run, so at most one configuration finding is ever reported; any other outcome (missing, symlink, wrong mode, or a failing check) leaves diagnosis exactly as it was before this class existed. An earlier revision of this function ran `configure.sh` against a hand-staged `$TMPDIR` copy that deliberately omitted `.orbit-secrets`, which made the class unable to fire on the file-backed `OIDC_CLIENT_SECRET_FILE` shape every real `install.sh` deployment produces; `--check-rollback` removes that gap and the unregistered-temp-directory risk it carried. — repair.sh:1415-1443,1814-1821 — category: refusal/fail-closed — criticality: HIGH
42. The configuration-migration-interrupted boundary reuses `restore-transaction` rather than adding a new action class (ADR-0014 decision 5's allowlist is unchanged). `do_restore_configuration_rollback` re-verifies the rollback copy immediately before touching anything and refuses a symlinked parent directory on either side or a symlinked rollback file; backs up the live `.env-orbit` into this run's private recovery directory before it is touched; writes the restored content to a same-directory temporary file and `mv`s it onto `.env-orbit` — an atomic same-filesystem rename preserving mode 600, matching `configuration.sh`'s own `migrate_file()` write pattern, rather than install.sh-style remove-then-copy; and on any failure self-restores `.env-orbit` from that backup and leaves the rollback copy in place for a future retry, removing it only on full success. — repair.sh:2427-2464 — category: transactional/rollback — criticality: HIGH

**#530 delta slice — the document-kek retention guard (ADR-0014 decision 5, part 1: the missing half of the two ratified guards)**

43. `document-volume-retained-without-key` is derived purely from a retained volume name match (`${project}_orbit-documents-data`) and the local absence of the `document-kek` secret file, exactly mirroring `volume-retained-without-credentials`'s own derivation (guarantee 7) — it never opens a connection, execs into a container, or reads a document or a secret's contents. `total_checks` moves from 16 to 17 to count it, and the same subtract-from-one-constant arithmetic (guarantee 9) still counts every check exactly once. — repair.sh:1976-2013 — category: secret-handling — criticality: HIGH
44. `document-kek` is planned `action=manual`, never `regenerate-secret`, whenever `document-volume-retained-without-key` is present in the same diagnosis — unlike the database case (guarantee 20) there is no rotate equivalent to route to, so `resolve_secret_missing_action` returns `manual` rather than guessing; each manual line is paired with its own fixed field-level stderr guidance line, same discipline as guarantee 22. — repair.sh:1543-1571 — category: secret-handling — criticality: HIGH
45. The two retention guards never cross-wire: a retained database volume alone never produces `document-volume-retained-without-key`, and a retained document volume alone never routes `postgres-password` away from `regenerate-secret` (or vice versa) — each guard's own local, dynamically-scoped flag (`volume_retained_without_credentials` / `document_volume_retained`) is computed independently from its own finding class. — repair.sh:1560-1567,1632-1641 — category: refusal/fail-closed — criticality: MEDIUM

---

## Summary

Status: COMPLETE for the six originally-catalogued scripts (`install.sh`, `configure.sh`, `configuration.sh`, `installer-ui.sh`, `installer-simulation.sh`, `container-entrypoint.sh`); `repair.sh` was added separately for its issue #261 first slice (`--check` only), extended in the same file for the #261 second slice (read-only database/application diagnosis), extended again for the #261 third slice (`--plan`, still zero mutation), and extended again for the #261 slice 4 stage one (`--execute --safe-only` — the fixed safe/reversible action set only; stage two remains unimplemented). No `*.test.mjs` or other scripts were read.

**Guarantee count by script**

| Script | Guarantees |
|---|---:|
| install.sh | 56 |
| configure.sh | 33 |
| configuration.sh | 25 |
| container-entrypoint.sh | 14 |
| installer-ui.sh | 12 |
| repair.sh | 37 |
| installer-simulation.sh | 8 |
| **Total** | **185** |

**Guarantee count by category × criticality**

| Category | HIGH | MEDIUM | LOW | Total |
|---|---:|---:|---:|---:|
| refusal/fail-closed | 20 | 23 | 7 | 50 |
| input-validation | 6 | 20 | 7 | 33 |
| secret-handling | 25 | 5 | 0 | 30 |
| provenance/immutability | 16 | 9 | 0 | 25 |
| transactional/rollback | 16 | 2 | 0 | 18 |
| permissions/ownership | 17 | 0 | 0 | 17 |
| recovery | 1 | 4 | 1 | 6 |
| idempotency | 0 | 3 | 4 | 7 |
| **Total** | **101** | **66** | **19** | **186** |

**Guarantees duplicated across scripts (up to 10, both citations)**

1. Refuses a symlinked or non-regular `.env-orbit` before trusting it — configuration.sh:106-110 (`check_file_safety`) and configure.sh:156-161 (`ensure_environment_file`); also re-enforced at install.sh:1348-1351 (`preflight_final_paths`).
2. Refuses a symlinked or non-directory `.orbit-secrets` before trusting it — configure.sh:181-190 (`ensure_secrets_directory`) and install.sh:1352-1355 (`preflight_final_paths`); also install.sh:287 (`is_preprovisioned_input`).
3. `.env-orbit` must be exactly mode `600` before its contents are trusted for a check — configuration.sh:108-109 (`check_file_safety`) and configure.sh:732-733 (`run_check`).
4. Digest-pinned immutable image reference pattern `^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$` enforced independently in multiple scripts — configuration.sh:87-89 (`is_valid_immutable_image`) and install.sh:1287 (channel-to-digest resolution); also configure.sh:347-349 and install.sh:516,559,694.
5. Compose project name must match `^[a-z0-9][a-z0-9_-]*$` — configuration.sh:91-93 (`is_valid_compose_project_name`) and install.sh:435,443,458 (`derive_compose_project_name`).
6. Applied/image version must match strict semver `^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$` — configuration.sh:79-81 (`is_valid_applied_version`) and install.sh:1302 (image version label check); also container-entrypoint.sh:33-34 (embedded VERSION check).
7. Digest must match `^sha256:[0-9a-f]{64}$` — configuration.sh:83-85 (`is_valid_applied_digest`) and install.sh:1304 (`applied_digest` derivation from the resolved reference).
8. `installer-ui.sh` is only ever sourced from a fixed sibling path after confirming it is a regular, non-symlink file — configure.sh:16-19, installer-simulation.sh:24-31, and install.sh:162-176 (`load_installer_ui`, the strictest of the three: also requires the caller's prior `bash -n` check).
9. A secret must be non-empty or the operation fails closed — configure.sh:554-567 (`ensure_secret_file`, requires valid 64-hex content) and container-entrypoint.sh:107-118 (`refusing an empty secret`, re-enforced at container-startup time as an independent layer).
10. The "Repair" action is explicitly blocked/unavailable and performs no partial action — installer-simulation.sh:104-110 (rehearsal) and install.sh:813-818 / 1252-1257 (real installer, both the interactive and explicit-flag code paths).


---

## Part 2 — Backup, recovery and deploy family

Scope: `backup.sh`, `restore.sh`, `export-recovery-bundle.sh`, `import-recovery-bundle.sh`,
`recovery-crypto.mjs`, `build-container.sh`, `deploy-container.sh`, `update-and-start.sh`,
`generate-vapid.mjs`. No shared helper library is sourced by any of these scripts (each is
self-contained); `recovery-crypto.mjs` is invoked as a one-off `node` entrypoint inside the
`orbit-app` container rather than sourced.

All citations are `file.sh:line` against `/home/codex/projects/orbit/scripts/<file>`.

---

## backup.sh

1. Refuses to run without Docker, Docker Compose v2, OpenSSL, sha256sum, tar, or the env file present.
   `backup.sh:34-41` — category: input-validation / refusal — criticality: MEDIUM
2. Document KEK must be a regular file and must NOT be a symlink, or the run fails.
   `backup.sh:44-45` — category: secret-handling / refusal — criticality: HIGH
3. Document KEK content must be exactly 32 bytes of hex (64 hex chars) or the run fails.
   `backup.sh:46-47` — category: input-validation / secret-handling — criticality: HIGH
4. The document KEK is never passed as a CLI argument, env var, stdout, or host temp file — only as a mounted file path read inside the app container.
   `backup.sh:52-56` (comment + `write_hmac`) — category: secret-handling — criticality: HIGH
5. HMAC output is format-checked (base64, 43 chars + `=`) before being trusted/used.
   `backup.sh:57-58` — category: input-validation — criticality: MEDIUM
6. Document KEK fingerprint output is format-checked as 64 lowercase hex chars before use.
   `backup.sh:65` — category: input-validation — criticality: MEDIUM
7. Bundle manifest authentication (HMAC) is verified byte-for-byte (`cmp --silent`) against a freshly recomputed HMAC before a bundle is accepted as valid.
   `backup.sh:69-74` — category: provenance/immutability — criticality: HIGH
8. Document archive entries are allow-listed by exact path shape (`objects/xx/yy/<hash>.bin`, `staging/<hash>.bin`, and the directory scaffolding only); any other path fails validation — blocks path traversal / arbitrary file injection via the document tar.
   `backup.sh:77-96` — category: input-validation — criticality: HIGH
9. Object files inside the document archive must live under the 4-hex-char prefix directory matching the first 4 hex chars of their own content-hash filename, or validation fails.
   `backup.sh:90-93` — category: provenance/immutability — criticality: MEDIUM
10. Document archive is rejected if it contains any non-regular/non-directory entry (symlink, hardlink, device, etc.).
    `backup.sh:97-99` — category: input-validation / refusal — criticality: HIGH
11. A bundle to be verified must be a regular, non-symlink file.
    `backup.sh:104` — category: input-validation — criticality: HIGH
12. Bundle-level tar is rejected if it contains any non-regular-file entry (link/special file) before extraction.
    `backup.sh:111-112` — category: input-validation / refusal — criticality: HIGH
13. Bundle must contain exactly the five expected members (`checksums.sha256`, `database.dump`, `documents.tar.enc`, `manifest`, `manifest.hmac`) — no more, no fewer — or it is rejected.
    `backup.sh:113-115` — category: input-validation — criticality: MEDIUM
14. Bundle `format_version` must match the script's supported version (`1`) or the bundle is rejected as unsupported.
    `backup.sh:118-119` — category: provenance/immutability — criticality: MEDIUM
15. Bundle is rejected if its recorded `document_kek_sha256` fingerprint doesn't match the fingerprint of the operator's current document KEK ("wrong key" refusal).
    `backup.sh:120-121` — category: secret-handling / refusal — criticality: HIGH
16. Manifest + checksums are HMAC-authenticated as a unit before trusting checksum contents.
    `backup.sh:122-123` — category: provenance/immutability — criticality: HIGH
17. Every listed file's SHA-256 checksum is verified (`sha256sum --check --status`) before the bundle is accepted.
    `backup.sh:124-125` — category: provenance/immutability — criticality: HIGH
18. The embedded PostgreSQL dump is validated as a well-formed `pg_restore`-listable dump before the bundle is accepted.
    `backup.sh:126-127` — category: input-validation — criticality: MEDIUM
19. Encrypted document archive must successfully decrypt with the current document KEK (AES-256-CBC, PBKDF2-SHA256, 600000 iterations) as part of validation.
    `backup.sh:128-130` — category: secret-handling / recovery — criticality: HIGH
20. Decrypted document archive is re-validated against the same path allow-list/type checks before the whole bundle is declared valid.
    `backup.sh:131` — category: input-validation — criticality: HIGH
21. Backup directory is created (if needed) with mode 700 and all bundle work happens under `umask 077` — backups (which contain encrypted document data + DB dump) are not world/group readable.
    `backup.sh:136-138` — category: permissions/ownership — criticality: HIGH
22. `orbit-app` is stopped before the DB dump and document archive are taken, guaranteeing a cross-resource point-in-time consistent backup (no writer activity mid-backup).
    `backup.sh:145-148` — category: transactional/rollback — criticality: HIGH
23. An `EXIT` trap always attempts to restart `orbit-app` (`compose start orbit-app || true`) if the script stopped it, regardless of success/failure path, so the app is not left down.
    `backup.sh:22-28,181` — category: transactional/rollback — criticality: HIGH
24. An empty `pg_dump` output causes an explicit failure instead of silently producing a hollow backup.
    `backup.sh:152` — category: input-validation / refusal — criticality: HIGH
25. Freshly produced DB dump is immediately validated via `pg_restore --list` before proceeding.
    `backup.sh:153` — category: provenance/immutability — criticality: MEDIUM
26. Freshly produced document archive is validated against the path/type allow-list before it is encrypted.
    `backup.sh:154-155` — category: input-validation — criticality: MEDIUM
27. Documents are always encrypted at rest with AES-256-CBC + PBKDF2-SHA256 (600000 iterations) before being written into the bundle.
    `backup.sh:156-157` — category: secret-handling — criticality: HIGH
28. Plaintext document archive is deleted from disk immediately after encryption (`rm -f`), preventing an unencrypted copy of documents from lingering.
    `backup.sh:158` — category: secret-handling — criticality: HIGH
29. Manifest records only the document KEK's SHA-256 fingerprint, never the key itself.
    `backup.sh:166` — category: secret-handling — criticality: MEDIUM
30. Manifest + checksums are HMAC-signed with the document KEK before being packaged, giving the bundle tamper-evidence.
    `backup.sh:169-170` — category: provenance/immutability — criticality: HIGH
31. Completed bundle tar is validated (`tar -tf`) before being treated as the deliverable.
    `backup.sh:172` — category: input-validation — criticality: MEDIUM
32. Final bundle is written via a `.installing` temp name and moved into place with `mv --no-clobber`, giving an atomic publish and refusing to silently overwrite an existing same-named backup.
    `backup.sh:139-140,173-175` — category: transactional/rollback / idempotency — criticality: HIGH
33. `temporary_path` is cleared only after a successful move, so the `EXIT` cleanup trap never deletes a successfully published backup, but does clean up any half-built one.
    `backup.sh:175,22-24` — category: transactional/rollback — criticality: MEDIUM
34. `orbit-app` is explicitly restarted at the end of a successful backup (independent of the trap).
    `backup.sh:176-177` — category: transactional/rollback — criticality: HIGH
35. `--verify` mode requires exactly one bundle-path argument; any other argument shape fails with usage text (fail-closed CLI parsing).
    `backup.sh:185-192` — category: input-validation — criticality: LOW

---

## export-recovery-bundle.sh

1. Source bundle argument is required and must be an existing, regular, non-symlink file, or usage fails.
   `export-recovery-bundle.sh:28-29` — category: input-validation — criticality: MEDIUM
2. Requires sha256sum, tar, docker, and the env file to be present before doing anything.
   `export-recovery-bundle.sh:30-33` — category: input-validation — criticality: MEDIUM
3. Document KEK file must be a regular, non-symlink file or export refuses to run.
   `export-recovery-bundle.sh:34` — category: secret-handling / refusal — criticality: HIGH
4. The source backup bundle must pass full `backup.sh --verify` (format, HMAC, checksums, KEK-fingerprint match, decryptability, archive-shape checks) before a recovery bundle is produced from it — a corrupt/tampered/wrong-key backup cannot be exported.
   `export-recovery-bundle.sh:35` — category: provenance/immutability / refusal — criticality: HIGH
5. Recovery passphrase is read from the controlling TTY (`/dev/tty`) in normal operation, requiring an interactive terminal (test mode allows stdin injection only under `ORBIT_RECOVERY_TEST_MODE`).
   `export-recovery-bundle.sh:19-26` — category: secret-handling — criticality: MEDIUM
6. Recovery passphrase must be at least 12 characters or export refuses to proceed.
   `export-recovery-bundle.sh:38` — category: input-validation / secret-handling — criticality: MEDIUM
7. Recovery passphrase requires a matching confirmation entry before proceeding (typo protection for a passphrase that gates future disaster recovery).
   `export-recovery-bundle.sh:39-45` — category: input-validation — criticality: MEDIUM
8. Passphrase confirmation variable is `unset` immediately after comparison rather than lingering in shell memory.
   `export-recovery-bundle.sh:46` — category: secret-handling — criticality: LOW
9. Recovery bundle work directory is created under the backup directory with mode 700 and `umask 077`, so recovery material (encrypted KEK, backup copy) is not world/group readable.
   `export-recovery-bundle.sh:48-50` — category: permissions/ownership — criticality: HIGH
10. The document KEK-encrypting passphrase is piped to the container over stdin only — never as a CLI argument or environment variable.
    `export-recovery-bundle.sh:56-59` — category: secret-handling — criticality: HIGH
11. `recovery_passphrase` shell variable is `unset` immediately after use.
    `export-recovery-bundle.sh:60` — category: secret-handling — criticality: MEDIUM
12. The encrypted document-KEK envelope is checked for the `ORBKEK01` magic header before being trusted as a valid authenticated envelope.
    `export-recovery-bundle.sh:61-62` — category: input-validation / provenance — criticality: HIGH
13. Checksums (SHA-256) are recorded for both the embedded backup copy and the encrypted KEK envelope.
    `export-recovery-bundle.sh:63` — category: provenance/immutability — criticality: MEDIUM
14. Manifest declares `format_version` and the exact key-encryption algorithm string (`aes-256-gcm-scrypt-n131072-r8-p1`) used to wrap the KEK.
    `export-recovery-bundle.sh:64` — category: provenance/immutability — criticality: MEDIUM
15. Final recovery bundle is written via a `.installing` temp name and published atomically with `mv --no-clobber`, never overwriting an existing same-named recovery bundle.
    `export-recovery-bundle.sh:65-69` — category: transactional/rollback / idempotency — criticality: HIGH
16. `EXIT` trap removes the temp working directory and any half-written bundle on any failure path.
    `export-recovery-bundle.sh:12-17` — category: transactional/rollback — criticality: MEDIUM

---

## import-recovery-bundle.sh

1. Recovery bundle argument required, must be an existing, regular, non-symlink file.
   `import-recovery-bundle.sh:44-45` — category: input-validation — criticality: MEDIUM
2. Requires sha256sum, tar, docker, and the env file present before proceeding.
   `import-recovery-bundle.sh:46-49` — category: input-validation — criticality: MEDIUM
3. Secrets directory must be a regular directory (not a symlink) before any key material is touched.
   `import-recovery-bundle.sh:50` — category: secret-handling / permissions-ownership — criticality: HIGH
4. Refuses to start a new recovery import if a prior restore journal file exists — operator must run `restore.sh --recover` first, preventing compounding/overlapping failed recoveries.
   `import-recovery-bundle.sh:51-52` — category: refusal / recovery — criticality: HIGH
5. Recovery bundle's tar listing is validated as readable before any extraction is attempted.
   `import-recovery-bundle.sh:55-56` — category: input-validation — criticality: MEDIUM
6. Recovery bundle is rejected outright if it contains any non-regular-file entry (symlink/special file).
   `import-recovery-bundle.sh:58-60` — category: input-validation / refusal — criticality: HIGH
7. Recovery bundle must contain exactly the four expected members (`checksums.sha256`, `document-kek.enc`, `manifest`, `orbit-backup.tar`) — no more, no fewer.
   `import-recovery-bundle.sh:61-63` — category: input-validation — criticality: MEDIUM
8. Manifest `format_version` must equal `1` or the bundle is rejected as unsupported.
   `import-recovery-bundle.sh:67-68` — category: provenance/immutability — criticality: MEDIUM
9. All bundle member checksums (SHA-256) are verified before any member is trusted/used.
   `import-recovery-bundle.sh:69-71` — category: provenance/immutability — criticality: HIGH
10. Recovery passphrase must be at least 12 characters.
    `import-recovery-bundle.sh:74` — category: input-validation / secret-handling — criticality: MEDIUM
11. Encrypted KEK envelope is chmod 600 immediately once staged in the temp directory.
    `import-recovery-bundle.sh:75` — category: permissions/ownership — criticality: MEDIUM
12. Passphrase is piped to the decrypt subprocess over stdin only — never a CLI argument or env var — and decryption failure produces an explicit fail rather than silently continuing.
    `import-recovery-bundle.sh:76-81` — category: secret-handling / refusal — criticality: HIGH
13. `recovery_passphrase` variable is `unset` immediately after use.
    `import-recovery-bundle.sh:82` — category: secret-handling — criticality: MEDIUM
14. Decrypted KEK is format-validated as 64 hex characters before being accepted as a usable key ("wrong passphrase decrypted garbage" protection).
    `import-recovery-bundle.sh:83-84` — category: input-validation / secret-handling — criticality: HIGH
15. `recovered_kek` shell variable is `unset` right after its format check.
    `import-recovery-bundle.sh:85` — category: secret-handling — criticality: LOW
16. Decrypted document-KEK file on disk is chmod 600.
    `import-recovery-bundle.sh:86` — category: permissions/ownership — criticality: MEDIUM
17. A destructive key replacement + restore requires the operator to type the literal phrase `IMPORT RECOVERY` interactively (or via stdin in test mode) before anything is changed.
    `import-recovery-bundle.sh:88-94` — category: refusal / input-validation — criticality: HIGH
18. Live document KEK must be a regular, non-symlink file before it is replaced.
    `import-recovery-bundle.sh:95` — category: secret-handling / input-validation — criticality: HIGH
19. `orbit-app` is stopped before the document KEK is swapped, avoiding writes under a mismatched key.
    `import-recovery-bundle.sh:96-97` — category: transactional/rollback — criticality: HIGH
20. Previous document KEK is moved aside (not deleted) before the recovered key replaces it, preserving a rollback path.
    `import-recovery-bundle.sh:98-101` — category: transactional/rollback — criticality: HIGH
21. Inner `restore.sh` is invoked with `ORBIT_RESTORE_ROLLBACK_KEK_FILE` pointing at the preserved previous KEK, so a failed inner restore can roll the key back automatically.
    `import-recovery-bundle.sh:103-105` — category: transactional/rollback — criticality: HIGH
22. On inner-restore success: previous KEK file is deleted, temp state is fully cleaned, the `EXIT` trap is disarmed (`trap - EXIT`), and success is reported explicitly.
    `import-recovery-bundle.sh:106-113` — category: transactional/rollback / idempotency — criticality: MEDIUM
23. On inner-restore failure that left durable restore-journal evidence, the script refuses to auto-clean or auto-rollback the key — it marks `unfinished_restore` and instructs the operator to run `restore.sh --recover`, preserving forensic/recovery state instead of guessing.
    `import-recovery-bundle.sh:114-119` — category: refusal / recovery — criticality: HIGH
24. On inner-restore failure with no journal evidence, the previous document key is automatically restored (via the `EXIT` cleanup trap) so the deployment is left in its prior working state.
    `import-recovery-bundle.sh:24-27,120` — category: transactional/rollback — criticality: HIGH
25. `cleanup()` trap special-cases `unfinished_restore`: it does NOT restart the app or touch the KEK, only prints guidance to keep Orbit stopped — avoiding making an ambiguous failure state worse.
    `import-recovery-bundle.sh:21-23` — category: refusal / recovery — criticality: HIGH
26. `cleanup()` trap restarts `orbit-app` whenever it was stopped, on every exit path that isn't the unfinished-restore case.
    `import-recovery-bundle.sh:24-30` — category: transactional/rollback — criticality: HIGH
27. Temp working directory is always removed on exit (unless already cleared after full success), preventing leftover decrypted key/backup material from lingering on disk.
    `import-recovery-bundle.sh:31` — category: secret-handling — criticality: MEDIUM

---

## recovery-crypto.mjs (helper)

Invoked as a one-off `node` entrypoint inside the `orbit-app` container by `backup.sh`,
`export-recovery-bundle.sh`, `import-recovery-bundle.sh`, and `restore.sh`. It is the single
place that touches raw key material, so its guarantees back-stop the callers above.

1. Passphrase length (>=12 chars) is enforced inside the crypto tool itself, independent of caller checks — defense in depth if a caller regresses.
   `recovery-crypto.mjs:29-33` — category: input-validation / secret-handling — criticality: HIGH
2. `encrypt` refuses any input that is not exactly a 32-byte hex document key.
   `recovery-crypto.mjs:39-42` — category: input-validation — criticality: HIGH
3. Every encryption uses a fresh random 16-byte salt and 12-byte IV (never reused) with AES-256-GCM keyed via scrypt (N=131072, r=8, p=1).
   `recovery-crypto.mjs:13-18,44-51` — category: secret-handling — criticality: HIGH
4. Ciphertext is bound (AAD) to the `ORBKEK01` format magic, so envelopes can't be replayed/misinterpreted under a different format.
   `recovery-crypto.mjs:49` — category: provenance/immutability — criticality: MEDIUM
5. Derived key and plaintext buffers are explicitly zeroed (`fill(0)`) after use during encryption.
   `recovery-crypto.mjs:52-55` — category: secret-handling — criticality: MEDIUM
6. `decrypt` rejects any envelope that is too short or doesn't start with the `ORBKEK01` magic, before attempting any cryptographic operation.
   `recovery-crypto.mjs:59-62` — category: input-validation / provenance — criticality: HIGH
7. Decryption is authenticated (AES-256-GCM tag check); a wrong passphrase or tampered ciphertext throws and is reported only as a generic "passphrase verification failed", not a detailed crypto error.
   `recovery-crypto.mjs:69-80` — category: secret-handling / refusal — criticality: HIGH
8. Decrypted plaintext must itself be a valid 64-hex-char key or it is rejected (and zeroed before the failure path) — catches passphrase-derived garbage that happens not to hit an auth-tag failure.
   `recovery-crypto.mjs:74-77` — category: input-validation / secret-handling — criticality: HIGH
9. Derived key buffer is zeroed after decryption regardless of outcome (`finally`).
   `recovery-crypto.mjs:82` — category: secret-handling — criticality: MEDIUM
10. CLI requires one of exactly `encrypt|decrypt|hmac|fingerprint` plus an input path, else usage failure.
    `recovery-crypto.mjs:86-89` — category: input-validation — criticality: LOW
11. `hmac`/`fingerprint` operations require the key file to be exactly 64 hex chars, else refuse as "the key file is invalid".
    `recovery-crypto.mjs:92-93` — category: input-validation / secret-handling — criticality: HIGH
12. HMAC authentication uses a key-separated sub-key (`HMAC-SHA256(document_kek, "orbit-backup-authentication-v1")`) rather than the raw document KEK — the encryption key and the authentication key are cryptographically distinct.
    `recovery-crypto.mjs:98-102` — category: secret-handling — criticality: HIGH
13. Derived authentication sub-key buffer is zeroed immediately after use.
    `recovery-crypto.mjs:104` — category: secret-handling — criticality: MEDIUM
14. Raw KEK buffer is zeroed after both `hmac` and `fingerprint` operations complete.
    `recovery-crypto.mjs:111` — category: secret-handling — criticality: MEDIUM
15. `fingerprint` returns `sha256(key)` hex only — lets operators/scripts verify key identity without ever exposing/transmitting the key itself.
    `recovery-crypto.mjs:107` — category: secret-handling — criticality: MEDIUM
16. Output buffer for `encrypt`/`decrypt` is zeroed immediately after being written to stdout.
    `recovery-crypto.mjs:120` — category: secret-handling — criticality: MEDIUM

---

## restore.sh

The most complex script in the family: journaled, checkpointed restore with automatic rollback
and a separate `--recover` manual-recovery mode for crash safety.

**Preflight / tooling / bundle validation**

1. Requires docker, compose v2, openssl, sha256sum, tar, find, stat, sync, curl, and the env file present before any state is touched.
   `restore.sh:40-51` — category: input-validation — criticality: MEDIUM
2. Document KEK must be a regular, non-symlink file containing exactly 64 hex chars, checked before restore proceeds.
   `restore.sh:53-58` — category: secret-handling — criticality: HIGH
3. Bundle manifest is HMAC-authenticated (recomputed and `cmp`'d) before any of its contents are trusted — same mechanism as `backup.sh`.
   `restore.sh:60-87` — category: provenance/immutability — criticality: HIGH — *(duplicate of backup.sh:69-74/122-123)*
4. Document archive entries are allow-listed by exact path shape and rejected if any entry is a link/special file — identical protection to `backup.sh`'s archive validator.
   `restore.sh:89-114` — category: input-validation — criticality: HIGH — *(duplicate of backup.sh:77-99)*
5. Recovery bundle must contain exactly the five expected members and no link/special-file entries, checked before extraction.
   `restore.sh:116-128` — category: input-validation — criticality: HIGH — *(duplicate of backup.sh:111-115)*
6. Bundle path must be a regular, non-symlink file; format version, document-KEK fingerprint match, checksum verification, `pg_restore --list` validity, and successful decryption with the live KEK are all required before the bundle is accepted — the full validation chain from `backup.sh --verify` is re-run inline.
   `restore.sh:130-158` — category: provenance/immutability / secret-handling — criticality: HIGH — *(duplicate of backup.sh:104-131)*

**Private staging (preflight correspondence check)**

7. The entire bundle (DB dump + documents) is restored into a *private* staging database and a private staging directory — never touching live state — before capacity/confirmation/cutover proceeds.
   `restore.sh:334-353` — category: transactional/rollback — criticality: HIGH
8. Staged database dump is applied with `pg_restore --single-transaction --exit-on-error`, so a bad dump cannot partially apply.
   `restore.sh:178-185,345` — category: transactional/rollback — criticality: HIGH
9. `validate_correspondence` cross-checks every document/attachment/staging-object DB row against the actual on-disk blob (existence, non-symlink, exact byte size, no duplicate storage-key reuse, no orphaned on-disk objects) and refuses the restore if any in-flight ("transient") document lifecycle rows exist that a point-in-time backup can't safely represent.
   `restore.sh:205-332` — category: recovery / input-validation — criticality: HIGH
10. Staging database is always dropped once the preflight correspondence check finishes.
    `restore.sh:351-352` — category: idempotency — criticality: LOW

**Capacity preflight**

11. Restore refuses to proceed unless there is provably enough free space in the backup directory, the temp filesystem, *and* the live document volume to hold the working set, checkpoint, current data, and staged tree simultaneously (with fixed headroom reserves) — prevents a restore from running out of disk mid-cutover.
    `restore.sh:355-397` — category: refusal / input-validation — criticality: HIGH
12. Every size measurement used in the capacity arithmetic is validated as purely numeric before being trusted (defends against a corrupted/hostile `du`/`df`/`psql` response silently becoming `0` or a shell-injection vector).
    `restore.sh:361-394` — category: input-validation — criticality: MEDIUM

**Checkpoint (rollback safety net)**

13. Checkpoint SHA-256 digests of the database dump, document archive, and document KEK are computed and recorded before the checkpoint is trusted.
    `restore.sh:399-413` — category: provenance/immutability — criticality: HIGH
14. Checkpoint artifacts and the checkpoint directory are explicitly `sync`ed (with `-d` data-sync, falling back to full `sync`) to durable storage before the checkpoint is considered safe to reference from the journal.
    `restore.sh:415-428,561-562` — category: provenance/immutability — criticality: HIGH
15. Journal writes refuse to proceed if the journal path is itself a symlink.
    `restore.sh:471` — category: refusal / secret-handling — criticality: HIGH
16. Journal write requires that all three checkpoint digests are already valid 64-hex values — a journal can never be written pointing at an unverified checkpoint.
    `restore.sh:472-475` — category: provenance/immutability — criticality: HIGH
17. Journal is written via temp-file-then-fsync-then-atomic-rename-then-fsync-directory, and on a late failure the previous journal (backed up first) is restored rather than left corrupt — the crash-recovery journal itself is crash-safe.
    `restore.sh:467-506` — category: transactional/rollback / provenance — criticality: HIGH
18. Only a validated (regular, non-symlink, 64-hex) key is ever copied into the checkpoint, and it is written chmod 600.
    `restore.sh:508-514` — category: secret-handling — criticality: HIGH
19. `orbit-app` is stopped before the checkpoint's DB dump and document archive are captured, giving the rollback point itself point-in-time consistency.
    `restore.sh:525-528` — category: transactional/rollback — criticality: HIGH
20. An empty checkpoint database dump is explicitly rejected rather than silently accepted as a valid rollback target.
    `restore.sh:534` — category: refusal — criticality: HIGH
21. Checkpoint document archive is validated against the same path/type allow-list as any other document archive.
    `restore.sh:541` — category: input-validation — criticality: HIGH
22. The checkpoint is self-verified end-to-end — dump restored into a private stage DB, documents extracted, and full `validate_correspondence` run against the checkpoint itself — before it is ever marked usable; a checkpoint that merely "looked" successful is not trusted as a rollback target.
    `restore.sh:544-556` — category: recovery / provenance — criticality: HIGH
23. `checkpoint_verified` (the flag that governs all later rollback/cleanup behavior) is only set true after digests are computed, artifacts are durably synced, and the journal is durably written — establishes a strict ordering for the "point of no return."
    `restore.sh:559-565` — category: transactional/rollback — criticality: HIGH

**Cutover**

24. Document replacement removes the entire existing document tree and extracts the new tree in one container invocation, with a `documents_replaced` flag set beforehand so cleanup logic always knows this step was attempted.
    `restore.sh:568-576` — category: transactional/rollback — criticality: HIGH
25. Live database replacement uses `pg_restore --single-transaction --clean --if-exists --exit-on-error`, an atomic all-or-nothing swap of live DB content.
    `restore.sh:578-583` — category: transactional/rollback — criticality: HIGH
26. After restore, scan jobs left in an inconsistent lease state are automatically requeued (if attempts remain) or marked failed (if attempts are exhausted) instead of being left permanently stuck.
    `restore.sh:585-589` — category: recovery — criticality: MEDIUM
27. Checkpoint/recovered document KEK is re-validated (format) immediately before being installed as the live key file, and installed chmod 600.
    `restore.sh:596-600` — category: secret-handling — criticality: HIGH
28. After cutover, `validate_active_correspondence` re-runs the full DB<->document correspondence check against the now-live database and container, and the restore is not declared complete if it fails.
    `restore.sh:613-656,927` — category: recovery / input-validation — criticality: HIGH
29. After restart, the script polls the app's health endpoint for up to 45 seconds and fails rather than declaring the restore complete just because the container started.
    `restore.sh:738-750` — category: refusal / recovery — criticality: HIGH
30. `rollback_checkpoint()` — triggered on any cutover failure — restores DB, documents, and key from the verified durable checkpoint and re-runs the same correspondence + health checks as a fresh restore, holding rollback to the identical integrity bar as forward restore.
    `restore.sh:752-770` — category: transactional/rollback — criticality: HIGH

**`--recover` manual-recovery mode**

31. `--recover` requires the journal file to exist, be a non-symlink, and have file mode exactly `600`, or it refuses to proceed.
    `restore.sh:772-776` — category: refusal / permissions-ownership — criticality: HIGH
32. Journal's `restore_id` and `state` fields are strictly format/enum validated before being trusted.
    `restore.sh:777-781` — category: input-validation — criticality: HIGH
33. Journal's checkpoint digests are format-validated, and the checkpoint directory plus all three artifact files must exist as regular, non-symlink files, or recovery refuses.
    `restore.sh:785-795` — category: input-validation / refusal — criticality: HIGH
34. Recovery re-verifies checkpoint digest integrity and key validity from scratch before trusting the checkpoint at all (does not rely on the journal's claims alone).
    `restore.sh:802-805` — category: provenance/immutability — criticality: HIGH
35. Recovery re-runs the full checkpoint self-verification (private stage DB + extracted docs + correspondence check) before applying it.
    `restore.sh:806-820` — category: recovery / provenance — criticality: HIGH
36. If checkpoint application or the post-recovery health check fails, `--recover` fails closed — Orbit is left stopped and the checkpoint preserved for another manual attempt, rather than looping or guessing.
    `restore.sh:821-825` — category: refusal / recovery — criticality: HIGH
37. Journal and checkpoint are deleted only after `completed=true` is set, i.e., only once recovery is fully confirmed successful.
    `restore.sh:826-830` — category: transactional/rollback — criticality: MEDIUM

**Global `EXIT` trap / top-level guards**

38. If a checkpoint was verified but the restore did not complete, and the failure happened mid-manual-recovery, the trap stops the app and durably records a `rollback-failed` journal entry instead of attempting further automated changes — hands off to `--recover` rather than guessing.
    `restore.sh:833-841` — category: refusal / recovery — criticality: HIGH
39. Otherwise the trap attempts automatic `rollback_checkpoint()`; if that itself fails, it again writes a `rollback-failed` journal entry and stops the app rather than leaving state ambiguous.
    `restore.sh:842-846` — category: transactional/rollback — criticality: HIGH
40. Journal and checkpoint directory are removed only when the automatic rollback fully succeeds.
    `restore.sh:847-850` — category: idempotency — criticality: MEDIUM
41. Any leftover staging database is always dropped during cleanup, and the temp working directory (containing staged plaintext DB dump/documents) is always removed on exit.
    `restore.sh:854,858` — category: secret-handling / idempotency — criticality: MEDIUM
42. An unverified checkpoint directory is removed on cleanup (unless in `--recover` mode), preventing orphaned partial checkpoints from accumulating on disk.
    `restore.sh:855-857` — category: idempotency — criticality: LOW
43. `--recover` mode and a positional backup-file argument are mutually exclusive; unrecognized arguments fail usage.
    `restore.sh:864-883,892` — category: input-validation — criticality: LOW
44. Both the backup directory and the restore-evidence directory must not be symlinks, checked before any restore state is written.
    `restore.sh:886,889` — category: refusal / secret-handling — criticality: HIGH
45. A new restore refuses to start if an unfinished-restore journal already exists — operator must run `--recover` first.
    `restore.sh:898` — category: refusal / recovery — criticality: HIGH — *(duplicate concept to import-recovery-bundle.sh:51-52)*
46. Destructive restore requires explicit operator opt-in: interactive confirmation by typing the literal `RESTORE`, or for unattended automation, **both** `--yes` and `ORBIT_NONINTERACTIVE_RESTORE=true` must be set — a single flag alone is not sufficient to run destructively unattended.
    `restore.sh:903-910` — category: refusal / input-validation — criticality: HIGH
47. Restore proceeds through strictly ordered, durably journaled phases (`checkpointed` → `documents-replaced` → `database-restored`), each phase's journal write is a required gate before the next step runs.
    `restore.sh:912-926` — category: transactional/rollback — criticality: HIGH
48. Restore is marked `completed` — and the journal/checkpoint purged — only after documents are replaced, the database is restored, scan leases are reset, active correspondence validates, and the health check passes; any single failure short-circuits into rollback instead.
    `restore.sh:930-933` — category: transactional/rollback — criticality: HIGH

---

## build-container.sh

1. Accepts at most one argument, and it must be exactly `--no-pull`, or the script refuses with usage text.
   `build-container.sh:10-13` — category: input-validation — criticality: LOW
2. Requires `.env-orbit` to exist, pointing the operator to `configure.sh` if missing, before attempting a build.
   `build-container.sh:15-18` — category: input-validation / refusal — criticality: MEDIUM
3. Requires docker, Node.js, and Docker Compose v2 before proceeding.
   `build-container.sh:19-30` — category: input-validation — criticality: MEDIUM
4. Built image is tagged with the short (12-char) git commit hash of `HEAD`, tying every local image to an exact, unambiguous source commit.
   `build-container.sh:31` — category: provenance/immutability — criticality: MEDIUM
5. `ORBIT_REVISION` is recorded as the full git `HEAD` SHA, and `ORBIT_VERSION`/`ORBIT_CHANNEL` (fixed to `preview`) are computed/set for the build — every local build carries traceable version metadata.
   `build-container.sh:32-34` — category: provenance/immutability — criticality: MEDIUM
6. Base images are pulled fresh by default (`--pull`); only an explicit `--no-pull` opts out, so accidental stale-base-image builds require a deliberate flag.
   `build-container.sh:8,14,40-44` — category: provenance/immutability — criticality: LOW

---

## deploy-container.sh

1. Mode argument is restricted to exactly `--pull` or `--build`; anything else fails with usage text.
   `deploy-container.sh:16-17` — category: input-validation — criticality: LOW
2. Requires `.env-orbit`, docker, and Docker Compose v2 present before doing anything.
   `deploy-container.sh:18-21` — category: input-validation — criticality: MEDIUM
3. In `--pull` mode, `ORBIT_IMAGE` must resolve to a fully-qualified, immutable registry digest reference (`name@sha256:<64-hex>`) — a mutable tag (e.g. `latest`) is refused, so pull-based deploys are always pinned to an exact image.
   `deploy-container.sh:23-29` — category: provenance/immutability — criticality: HIGH
4. `configure.sh` is re-run before deploying, so the live configuration always reflects current settings at deploy time.
   `deploy-container.sh:32` — category: deployment-correctness — criticality: MEDIUM
5. The new/updated application (and dependency) images are fully pulled or built before any currently running deployment is touched — image acquisition happens before cutover.
   `deploy-container.sh:38-45` — category: transactional/rollback — criticality: MEDIUM
6. If this is an update to an already-running deployment (not a first deploy), a full `backup.sh` recovery point is taken automatically before startup, since migrations run automatically on app boot.
   `deploy-container.sh:47-53` — category: recovery — criticality: HIGH
7. Deployment is only declared successful if `compose up --wait --wait-timeout 180` reports healthy within 180 seconds; otherwise the script fails explicitly and prints `compose ps` diagnostics rather than assuming success because containers started.
   `deploy-container.sh:55-57` — category: refusal / recovery — criticality: HIGH
8. On an unhealthy deploy, if a pre-deploy backup was taken, the operator is shown the exact backup path and the precise `restore.sh` command to recover from a bad migration/deploy.
   `deploy-container.sh:58-61` — category: recovery — criticality: HIGH

---

## update-and-start.sh

1. Always operates from the repository root regardless of the caller's working directory.
   `update-and-start.sh:4-6` — category: input-validation — criticality: LOW
2. Requires `git` to be present before doing anything.
   `update-and-start.sh:8` — category: input-validation — criticality: LOW
3. Updates via `git pull --ff-only` — refuses to perform a merge/rebase if local and remote history have diverged, instead of silently creating a merge commit or discarding state.
   `update-and-start.sh:10` — category: refusal / provenance-immutability — criticality: HIGH
4. Delegates to `deploy-container.sh --build`, inheriting all of that script's guarantees (immutable image tagging, pre-update backup, health-gated cutover).
   `update-and-start.sh:11` — category: deployment-correctness — criticality: MEDIUM

---

## generate-vapid.mjs

1. Generates a fresh P-256 (`prime256v1`) ECDH key pair on every invocation — no hardcoded or reused key material, satisfying the VAPID/web-push key-type requirement.
   `generate-vapid.mjs:6-7` — category: secret-handling — criticality: MEDIUM
2. Uses only Node's built-in `crypto` module rather than the `web-push` package, keeping the standalone Orbit image's runtime dependency/supply-chain surface smaller.
   `generate-vapid.mjs:1,3-5` — category: provenance/immutability — criticality: LOW
3. Public and private keys are emitted as unpadded base64url, the encoding VAPID/web-push clients expect.
   `generate-vapid.mjs:9-10` — category: input-validation — criticality: LOW

---

## Summary

**Total guarantees catalogued: 163**

### Counts by criticality

| Criticality | Count |
|---|---|
| HIGH | 95 |
| MEDIUM | 54 |
| LOW | 14 |
| **Total** | **163** |

### Counts by category

An entry may belong to more than one category (e.g. "secret-handling / refusal"), so the
category tag counts below sum to more than 163. `deployment-correctness` is a category used
only for `build-container.sh`/`deploy-container.sh`/`update-and-start.sh` items that are
about correct deployment behavior rather than data-loss/security boundaries; it falls outside
the original 8-category taxonomy and is called out separately.

| Category | Tag count |
|---|---|
| input-validation | 55 |
| secret-handling | 42 |
| refusal / fail-closed | 29 |
| provenance/immutability | 30 |
| transactional/rollback | 26 |
| recovery | 16 |
| idempotency | 7 |
| permissions/ownership | 6 |
| deployment-correctness (extra) | 2 |

### Counts by script

| Script | Guarantee count |
|---|---|
| backup.sh | 35 |
| export-recovery-bundle.sh | 16 |
| import-recovery-bundle.sh | 27 |
| recovery-crypto.mjs | 16 |
| restore.sh | 48 |
| build-container.sh | 6 |
| deploy-container.sh | 8 |
| update-and-start.sh | 4 |
| generate-vapid.mjs | 3 |

### Guarantees duplicated across scripts (up to 10, both citations)

1. Document KEK must be a regular, non-symlink file.
   `backup.sh:44-45` and `restore.sh:53-54` (also `export-recovery-bundle.sh:34`, `import-recovery-bundle.sh:95`)
2. Document KEK content must be exactly 64 hex characters (32 bytes).
   `backup.sh:46-47` and `restore.sh:56-57`
3. Bundle manifest + checksums are HMAC-recomputed and byte-compared before any bundle content is trusted.
   `backup.sh:69-74,122-123` and `restore.sh:81-87,144-145`
4. Document archive entries are allow-listed by exact path shape (`objects/xx/yy/<hash>.bin`, `staging/<hash>.bin`) and rejected if any entry is a link/special file.
   `backup.sh:77-99` and `restore.sh:89-114`
5. Bundle must contain exactly the five expected members and no link/special-file tar entries.
   `backup.sh:111-115` and `restore.sh:116-128`
6. Full bundle validation chain — format version match, document-KEK fingerprint match, per-file checksum verification, `pg_restore --list` sanity check, and successful decryption + archive re-validation — gates acceptance of any bundle.
   `backup.sh:104-131` and `restore.sh:130-158`
7. A new destructive operation refuses to start while an unfinished-restore journal exists; operator must run `restore.sh --recover` first.
   `restore.sh:898` and `import-recovery-bundle.sh:51-52`
8. Working/backup directories that will hold key material or backups are created with mode 700 under `umask 077`.
   `backup.sh:136-138` and `export-recovery-bundle.sh:48-50`
9. Final published artifact is written via a `.installing`/temp name and atomically published with `mv --no-clobber`, never overwriting an existing file.
   `backup.sh:139-140,173-175` and `export-recovery-bundle.sh:65-69`
10. Document-KEK fingerprint (SHA-256 of the key) is computed and format-validated, then compared against the bundle's recorded fingerprint to refuse bundles encrypted with a different key.
    `backup.sh:61-67,120-121` and `restore.sh:71-79,142-143`

</content>
