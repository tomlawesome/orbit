#!/usr/bin/env bash
set -Eeuo pipefail

# Orbit repair mode — safe diagnostic + planning + STAGE-ONE executor
# (issue #261, slice 4).
#
# Supported invocations through this slice:
#   bash scripts/repair.sh --check [--plain]              (slices 1+2: read-only
#                                                           diagnosis)
#   bash scripts/repair.sh --plan  [--plain]               (slice 3: read-only
#                                                           diagnosis, then a
#                                                           proposed, classified
#                                                           repair plan — still
#                                                           zero mutation)
#   bash scripts/repair.sh --execute --safe-only [--plain] (slice 4 stage one:
#                                                           diagnosis + planning,
#                                                           then execution of
#                                                           ONLY the safe/
#                                                           reversible action
#                                                           set)
# `--plain` is tolerated anywhere in the argument list; output is
# unconditionally plain regardless of it. Exactly one of `--check`/`--plan`/
# `--execute` is required. `--safe-only` is accepted only alongside
# `--execute`, and — in this slice — is REQUIRED alongside it: stage two
# (dangerous, credential-rotation actions, approved separately per the
# 2026-08-13 owner decision on issue #261) is not implemented yet, so
# `--execute` without `--safe-only` is refused with a usage error rather than
# silently running only part of a repair. Any other combination, flag, or
# positional argument is a usage error.
#
# This script is deliberately standalone and source-less: it never sources
# install.sh, configure.sh or installer-ui.sh, and it copies only the
# minimal filesystem-recognition CONCEPTS it needs from install.sh
# (is_regular_non_symlink_file / is_real_non_symlink_directory / has_mode /
# managed-file and secrets-directory recognition, Compose project-name
# derivation, and — new this slice — the staged-transaction rollback shape
# `prepare_rollback_area`/`rollback_transaction` establish). Configuration
# syntax/schema/secret readiness is NOT reimplemented here: it is delegated
# to `bash scripts/configure.sh --check` and its output/exit status is
# mapped onto this script's reason classes.
#
# READ-ONLY BY CONSTRUCTION (--check / --plan only)
# --------------------------------------------------
# Under `--check` and `--plan` this script must never write, create, chmod,
# start, stop, or delete anything. It never uses mktemp inside the
# installation directory. Every `docker` invocation is one of: `docker
# inspect`, `docker ps`, `docker volume ls`/`inspect`, `docker compose
# config` — never a command that mutates containers, volumes, or images.
# Each docker read is optional: if the `docker` CLI is unavailable or the
# daemon cannot be reached, the affected checks are reported as
# `class=docker-unavailable` and diagnosis continues with everything else
# that can still be checked read-only. `--execute` (this slice) is the one
# and only invocation that ever mutates anything, and even then only the
# fixed safe action set documented below — see "EXECUTE MODE" further down.
#
# This slice adds exactly two more read-only primitives, both narrowly
# scoped: `docker exec -T <this deployment's orbit-db container> pg_isready`
# and `docker exec -T <same container> psql -c 'SELECT 1'`. Neither mutates
# anything server-side (`pg_isready` opens and immediately closes a
# connection; `SELECT 1` reads no table and touches no data) and both only
# ever target the orbit-db container whose Compose project/service labels
# were already proved to belong to this deployment (the same label proof
# Step 10 uses). This is still within the read-only contract: it is a
# client-side probe of reachability and authentication, not a database
# mutation, a schema inspection, or an application-data query. The
# PostgreSQL password never appears in argv or output — see "Database
# credential handling" below.
#
# Database credential handling
# ------------------------------
# `psql`'s password must never be observable via `ps`, this script's own
# stdout/stderr, or any docker/shell logging. It is passed with
# `docker exec -e PGPASSWORD` (no `=value`): this form makes the Docker CLI
# forward the value from its own inherited process environment rather than
# placing it on the command line, so it never appears in argv. The password
# is read from the `postgres-password` secret file into a `local` shell
# variable scoped to a single function invocation, attached only as a
# same-line prefix assignment on the `docker exec` command itself (so it is
# never `export`ed into the rest of this script's environment), and is
# reset to an empty string immediately after use. `set -x` is never enabled
# anywhere in this script. The captured `psql` output is inspected only
# in-process to classify success/auth-failure/other-failure; it is never
# printed, logged, or included in any finding.
#
# OUTPUT CONTRACT (--check)
# ---------------------------
# One finding per line:
#   finding class=<reason-class> target=<target-class> severity=<info|warn|fail>
# Enums only — stdout never contains a path, a configured value, or a
# secret. A final line always follows:
#   diagnosis result=<healthy|attention|failed> checked=<n> skipped=<n>
# Output is always plain deterministic text: no ANSI, no cursor control,
# regardless of terminal or the (accepted but inert) --plain flag. Findings
# are grouped in a fixed class order (see `class_order` below) so that the
# same on-disk/daemon state always produces byte-identical output.
#
# EXIT CODES (--check)
# ----------------------
#   0  healthy    — no findings at all
#   3  attention  — only warn-severity findings (no fail-severity finding)
#   4  failed     — at least one fail-severity finding
#   2  usage error
#   5  not-an-orbit-installation — the target directory carries no
#      recognizable Orbit installation evidence at all; every other check
#      is skipped because there is nothing safe to reason about.
#
# REASON CLASSES (this slice)
# -----------------------------
#   not-orbit-directory          — no Orbit installation evidence found at all.
#   managed-file-missing         — .env-orbit or docker-compose.yml absent
#                                   (or present as the wrong type).
#   managed-file-symlink         — .env-orbit or docker-compose.yml is a symlink.
#   managed-file-permissions     — .env-orbit exists but is not mode 600.
#   secrets-directory-invalid    — .orbit-secrets missing, symlinked, the
#                                   wrong type, or not mode 700 (any one
#                                   reason collapses to this single class).
#   secret-missing                — a managed secret file is absent or empty.
#   secret-permissions            — a managed secret file is a symlink, the
#                                   wrong type, or not mode 600.
#   configuration-incomplete      — `configure.sh --check` exited non-zero
#                                   with only readiness output on stdout
#                                   (required fields not yet ready).
#   configuration-invalid          — `configure.sh --check` exited non-zero
#                                   and also wrote to stderr (a structural
#                                   problem: unreadable/unsafe .env-orbit or
#                                   a missing .env-orbit.example template).
#   staging-evidence-present       — a leftover `.orbit-install-staging.*`
#                                   directory from an interrupted installer
#                                   transaction (see issue #291 comment on #261).
#   compose-interpolation-failed   — `docker compose config --quiet` failed
#                                   against the managed files.
#   docker-unavailable              — the `docker` CLI/daemon could not be
#                                   used for the affected check(s).
#   container-foreign-owner         — a container carries this deployment's
#                                   Compose project label but not a known
#                                   Orbit service label.
#   volume-retained-without-credentials — the #261 fixed-project collision:
#                                   the retained `orbit-db-data` volume for
#                                   this project exists while the database
#                                   password secret file is missing — the
#                                   SQLSTATE 28P01 precursor, detected
#                                   without ever touching the database.
#   unrelated-resource-present      — a database volume matching Orbit's
#                                   naming pattern exists under a different
#                                   Compose project than this deployment's.
#   database-unreachable            — this deployment's orbit-db container is
#                                   absent/not running, or is running but
#                                   `pg_isready` did not succeed within the
#                                   bounded probe.
#   database-credential-mismatch    — `pg_isready` succeeded (the server is
#                                   accepting connections) but authenticating
#                                   with the managed `postgres-password`
#                                   secret failed with a password/SQLSTATE
#                                   28P01-style error — the motivating
#                                   failure of issue #261.
#   stale-container                 — this deployment's orbit-app container
#                                   is running an image identity that does
#                                   not match `ORBIT_IMAGE` in `.env-orbit`
#                                   (the configuration was updated but the
#                                   container was never recreated).
#   application-unhealthy           — this deployment's orbit-app container
#                                   exists but Docker reports its health
#                                   status as `unhealthy`.
#
# PLAN MODE (--plan) — issue #261 third slice, STILL ZERO MUTATION
# --------------------------------------------------------------------------
# `--plan` runs exactly the same read-only diagnosis as `--check` above (the
# same 19 reason classes, the same optional docker probes, the same
# read-only-by-construction guarantees) and then, instead of printing
# `finding`/`diagnosis` lines, prints a PROPOSED, CLASSIFIED plan derived
# from the findings and exits. It performs no filesystem write, no chmod, no
# docker mutation, and no confirmation prompt — approval and execution are
# slice 4, layered on top of this same read-only diagnosis contract (see
# "EXECUTE MODE" below).
#
# Severity gate — applied BEFORE the action-class mapping below:
#   Only warn- and fail-severity findings are ever planned. An
#   info-severity finding (today: `docker-unavailable`,
#   `unrelated-resource-present`; also any future info-severity class)
#   produces NO plan line at all and is not counted toward `actions` or
#   `manual`. This exists because `--check` itself never lets an
#   info-severity finding make the deployment anything other than
#   `healthy` (see `print_check_lines`'s severity-to-`worst` mapping above)
#   — `--plan` must not contradict that verdict for the identical
#   on-disk/daemon state by treating a purely informational finding as a
#   problem requiring manual intervention. Concretely: a diagnosis
#   containing only info-severity findings (e.g. Docker unavailable,
#   nothing else wrong) yields `plan result=empty actions=0 manual=0` and
#   exit 0 under `--plan`, matching `--check`'s `result=healthy` exit 0 for
#   that same state.
#
# Output contract (--plan):
#   One line per warn/fail-severity finding (see the severity gate above),
#   in the same fixed `class_order`:
#     plan action=<action-class> resolves=<reason-class> mutation=<none|reversible|credential-rotation|service-restart> backup=<required|not-required>
#   A finding with no safe automatic action instead emits:
#     plan action=manual resolves=<reason-class> mutation=none backup=not-required
#   paired with one human-readable line on STDERR naming the exact safe
#   manual step or evidence to collect for that reason class — field names
#   only (e.g. "the target managed file", "the flagged container's
#   labels"), never a path, a configured value, or a secret. A terminal line
#   always follows on stdout:
#     plan result=<empty|ready|manual-required> actions=<n> manual=<n>
#   where `actions` counts emitted automatic-action lines and `manual`
#   counts emitted `action=manual` lines (actions + manual == total
#   PLANNED, i.e. warn/fail-severity, findings — info-severity findings are
#   excluded from this count entirely, not merely uncounted extras).
#   Output is plain deterministic text (no ANSI/cursor control) regardless
#   of `--plain`, and is byte-identical for byte-identical findings, exactly
#   like `--check`.
#
# Exit codes (--plan):
#   0  empty           — no warn/fail-severity findings at all (nothing to
#      plan; matches --check's own `healthy` verdict for the same state,
#      even if info-severity findings such as docker-unavailable exist).
#   3  plan-available   — at least one automatic (non-manual) action was
#      planned, regardless of whether manual-only findings also exist
#      alongside it.
#   4  unplannable-failures-present — one or more warn/fail-severity
#      findings exist but NONE of them has a safe automatic action (every
#      plan line is `action=manual`).
#   2  usage error.
#   5  not-an-orbit-installation — identical trigger/meaning to `--check`;
#      the single `not-orbit-directory` finding is fail-severity, so it
#      still passes the severity gate and is planned as `action=manual`
#      (and its manual-step line still printed) before the forced exit 5,
#      so the same evidence is visible under either mode.
#
# Destructive actions are NEVER planned, in this slice or any later one.
# Deleting a database/document volume or any other data-destroying recovery
# lives outside ordinary repair in a separate exact-target workflow (see
# issue #261's acceptance criteria) — this action-class table below has no
# destructive entry and none will be added to it; an unplannable finding
# always degrades to `action=manual`, never to a guessed destructive fix.
#
# Action-class mapping table (reason class -> action class), and the
# mutation/backup rationale for each action class:
#
#   restore-transaction        <- staging-evidence-present
#     mutation=reversible backup=required. Restoring a recognized prior
#     managed-file transaction overwrites the *current* (possibly still
#     valid) live managed files with the staged prior-good copies, so a
#     fresh backup of the current live state is required before slice 4
#     may perform this overwrite, even though the staging evidence itself
#     already holds the content being restored.
#
#   fix-permissions             <- managed-file-permissions,
#                                   secret-permissions,
#                                   secrets-directory-invalid
#     mutation=reversible backup=not-required. A mode-only change
#     (chmod back to 600/700) never rewrites file content, so there is
#     nothing to lose and nothing to back up; the change is trivially its
#     own inverse.
#
#   regenerate-secret           <- secret-missing, ONLY for a generated
#                                   non-user secret whose regeneration
#                                   cannot invalidate retained encrypted
#                                   state (session-secret, document-kek,
#                                   oidc-client-secret; also
#                                   postgres-password itself when no
#                                   retained database volume is present —
#                                   see the exception immediately below).
#     mutation=reversible backup=not-required. The finding fires only when
#     the secret file is absent/empty, so there is no valid prior secret
#     content to lose or back up.
#
#     EXCEPTION — postgres-password is explicitly EXCLUDED from
#     regenerate-secret whenever a `volume-retained-without-credentials`
#     finding is also present in the same diagnosis (the #261 fixed-project
#     collision: a retained `orbit-db-data` volume still holds the OLD
#     role's password hash). Minting an unrelated new password there would
#     not fix authentication — it would just create a second, still-broken
#     credential. That specific secret-missing finding is instead planned
#     as rotate-database-credential, below, so a retained-volume postgres
#     password is NEVER auto-regenerated.
#
#     NOTE (stage one, this slice): despite being classified
#     mutation=reversible above, regenerate-secret is NOT in stage one's
#     executable safe set — see "EXECUTE MODE" below. The owner's 2026-08-13
#     slice 4 decision names the stage-one safe set explicitly by action
#     class (fix-permissions, restore-transaction, restart-services); that
#     enumerated list, not this table's own mutation=reversible tag, is
#     authoritative for what `--execute --safe-only` may act on. A newly
#     minted secret is live credential material other processes may already
#     be holding open, which is a materially different risk than a mode-only
#     chmod or a container restart, so it stays out of stage one even though
#     it is filesystem-reversible in principle.
#
#   rotate-database-credential  <- database-credential-mismatch,
#                                   volume-retained-without-credentials,
#                                   and (per the exception above)
#                                   secret-missing when target is
#                                   postgres-password AND a retained volume
#                                   is present.
#     mutation=credential-rotation backup=required. This is the #261
#     motivating recovery path: preserve/restore the original password
#     file when available, or rotate the database role to the current
#     generated secret through a verified local connection. A database
#     password is NEVER reset merely because authentication failed. This is
#     issue #261's stage-two action class (per the owner's 2026-08-13
#     decision): its checkpoint-and-typed-word approval model is a separate,
#     later slice — `--execute --safe-only` always reports it as `skipped`,
#     never executes it. See "EXECUTE MODE" below.
#
#   restart-services             <- application-unhealthy, stale-container
#     mutation=service-restart backup=not-required. Revalidating and
#     restarting/recreating the minimum required Orbit service(s) touches
#     running containers, not managed files or secrets, so there is no
#     file-level backup to take.
#
#   rerun-configuration           <- configuration-incomplete,
#                                    configuration-invalid
#     mutation=none backup=not-required. repair.sh never re-implements or
#     drives `configure.sh`; this action class only tells the operator to
#     run `bash scripts/configure.sh` themselves, so no mutation happens as
#     part of repair at all.
#
#   manual                        <- everything else: not-orbit-directory,
#                                    managed-file-missing,
#                                    managed-file-symlink,
#                                    compose-interpolation-failed,
#                                    container-foreign-owner,
#                                    unrelated-resource-present,
#                                    docker-unavailable,
#                                    database-unreachable.
#     mutation=none backup=not-required. Each of these findings lacks a
#     safe automatic action — proving what to fix would require guessing
#     (was a missing managed file ever created? is a foreign-labelled
#     container really unrelated? is a database that refuses connections
#     down for a fixable reason?) — so "cannot safely determine" wins over
#     a guess, per issue #261's design constraints. Every manual-class plan
#     line is paired with one stderr line naming the exact safe manual step
#     or evidence to collect (fields, never values).
#
#     Two entries in this bucket — `unrelated-resource-present` and
#     `docker-unavailable` — are today ALWAYS emitted at info severity by
#     `--check` (see Steps 7-12 above), so the severity gate above removes
#     them before this mapping is ever consulted: they are listed here for
#     classification completeness (what they WOULD map to if a future
#     change ever raised either to warn/fail), not because either produces
#     a `plan action=manual` line under the current diagnosis.
#
# RESERVED CLASSES (explicitly out of scope for this slice — next slice)
# --------------------------------------------------------------------------
#   unsupported-schema, migration-failed, image-identity-mismatch
# This slice still never inspects schema/migration state or a container's
# registry-side image identity (as opposed to the locally pinned
# `ORBIT_IMAGE` value, which stale-container above does check); those
# remain reserved for a later executor slice that can safely pair them with
# repair actions.
#
# EXECUTE MODE (--execute --safe-only) — issue #261 SLICE 4, STAGE ONE
# --------------------------------------------------------------------------
# `--execute --safe-only` runs the identical diagnosis and planning above
# and then EXECUTES only the actions in the fixed stage-one safe set named
# by the owner's 2026-08-13 slice 4 decision:
#
#   fix-permissions       restore-transaction       restart-services
#
# Every other action class the plan can produce (`regenerate-secret`,
# `rotate-database-credential`, `rerun-configuration`, `manual`) is always
# reported and never executed — see "Safe set is a fixed allowlist" below.
# Stage two (`rotate-database-credential`, gated on a passphrase-encrypted
# ORBKEK01 checkpoint and a typed-word confirmation) is a separate,
# not-yet-implemented slice; `--execute` without `--safe-only` is refused
# with a usage error explaining this rather than silently running a partial
# repair.
#
# Safe set is a fixed allowlist, not derived from the plan's own
# mutation=reversible tag
# --------------------------------------------------------------------------
# `regenerate-secret` is classified mutation=reversible in the table above,
# but it is deliberately NOT in stage one's safe set (see the NOTE inside
# that table entry). The three action classes actually executed here are
# exactly the three the owner named; nothing is inferred from the plan's
# own backup=/mutation= columns.
#
# Action implementations
# --------------------------------------------------------------------------
#   fix-permissions      Re-validates the target's current type immediately
#                         before acting (defends against a TOCTOU change
#                         between diagnosis and execution): the managed
#                         environment file and each secret file must still
#                         be a regular, non-symlink file; the secrets
#                         directory must still be a real, non-symlink
#                         directory. If the re-check fails — the target is a
#                         symlink, missing, or the wrong type — this is a
#                         structural problem a chmod cannot safely fix, so
#                         the action is reported `failed` (nothing is
#                         mutated; "cannot safely determine" wins over
#                         guessing, exactly as elsewhere in this script).
#                         Otherwise a single `chmod 600`/`chmod 700` is
#                         applied. No backup is taken (mode-only changes are
#                         their own inverse, matching the plan's own
#                         backup=not-required for this class).
#
#   restore-transaction   Mirrors install.sh's own `prepare_rollback_area`/
#                         `rollback_transaction` shape against the single
#                         leftover `.orbit-install-staging.*` directory
#                         (Step 4's staging-evidence-present finding). The
#                         staging directory and its `rollback` and
#                         `rollback/original` subdirectories must each
#                         re-verify as real, non-symlink, mode-700
#                         directories before anything is touched; a
#                         symlinked parent directory anywhere in a managed
#                         path also refuses the whole action, exactly like
#                         install.sh's own rollback_transaction. Only a
#                         fixed allowlist of managed paths is ever
#                         considered (the same set install.sh's own
#                         `managed_paths` covers: the deployment assets,
#                         `.env-orbit`, and `.orbit-secrets`) — this script
#                         never enumerates the staging directory's own
#                         contents to decide what to touch, so a hostile or
#                         tampered staging directory cannot smuggle in an
#                         unexpected path. For each allowlisted path: if a
#                         backup exists under `rollback/original/<path>`,
#                         the CURRENT live path (if any) is first copied
#                         into this run's private recovery directory (see
#                         below), then replaced with a copy of the staged
#                         backup (content and mode, via `cp -a`, preserving
#                         the staged directory intact in case a later path
#                         in the same action fails). If no backup exists for
#                         that path, it means install.sh's own bookkeeping
#                         recorded that path as absent before the
#                         interrupted transaction began; if it exists live
#                         now, it must have been created by that
#                         interrupted transaction and is removed (after
#                         being backed up into the recovery directory, same
#                         as above). If ANY step fails partway, every path
#                         already touched by this action instance is
#                         restored from the recovery-directory backup taken
#                         moments before it was touched, the whole action is
#                         reported `failed`, and the staging directory is
#                         left in place for a future retry. If every path
#                         succeeds, the staging directory is removed
#                         entirely (mirroring install.sh's own `cleanup`
#                         trap, which always removes its staging directory
#                         once a transaction concludes) and the action is
#                         reported `done`.
#
#   restart-services      Re-resolves the target container immediately
#                         before acting, using the identical Compose
#                         project-label + service-label ownership proof
#                         diagnosis Step 10/12 already use (never trusting
#                         the container identity captured at diagnosis
#                         time), and refuses if zero or more than one
#                         container matches. Both finding classes this
#                         action resolves (`stale-container`,
#                         `application-unhealthy`) only ever fire for this
#                         deployment's orbit-app container (see Step 12), so
#                         both restart the same target; if both findings are
#                         present in one diagnosis, the container is
#                         restarted exactly once and the second `execute`
#                         line reports the same outcome as the first rather
#                         than restarting twice. `docker restart <id>` is
#                         run under a bounded timeout
#                         ($docker_restart_timeout); a nonzero exit or
#                         timeout is reported `failed`. No file backup is
#                         taken or needed: if the restart command itself
#                         never succeeds, nothing has changed to restore; if
#                         it succeeds, that is the intended end state, not a
#                         failure requiring rollback.
#
#   Ordering note: plan lines (and so `execute` lines) are emitted in the
#   fixed `class_order`, not action-class order. `staging-evidence-present`
#   sorts after `managed-file-permissions`/`secret-permissions` in that
#   order, so if both a permissions problem and leftover staging evidence
#   are present in the same diagnosis (an unusual but possible combination),
#   fix-permissions on a managed file can run moments before
#   restore-transaction overwrites that same file's content and mode from
#   the staged backup. This is harmless — restore-transaction's outcome is
#   authoritative for that file's final state either way — but it is a
#   deliberate, documented choice rather than an oversight: this slice does
#   not reorder execution to avoid the redundant intermediate chmod.
#
# Private recovery directory
# --------------------------------------------------------------------------
# `restore-transaction` is the only action class in this slice that needs a
# content-level backup (`backup=required` in the plan). Before it touches
# any path, this script lazily creates one private, mode-0700 recovery
# directory for the whole `--execute` run (`.orbit-repair-recovery.XXXXXX`,
# a sibling naming convention to install.sh's own
# `.orbit-install-staging.XXXXXX`, but with a distinct prefix so it can
# never be mistaken for leftover installer staging evidence by a later
# diagnosis). Every path that action is about to touch is copied into this
# directory first. The directory is removed at the end of the `--execute`
# run regardless of outcome: any failed action has already consumed its own
# backup to self-restore before the action is reported, so nothing is left
# that a later run could need. Its path is never printed — see "Privacy"
# below.
#
# Confirmation model — hybrid approval (owner decision, 2026-08-13)
# --------------------------------------------------------------------------
# When at least one safe-set action is planned, this script decides how to
# gain approval in this fixed priority order:
#
#   1. ORBIT_REPAIR_PROMPTS=machine — regardless of TTY-ness. Emits the
#      #297 machine-prompt line grammar (docs/engine-events.md "Machine
#      prompts (v0)"), extended here with a repair-specific field/kind pair
#      (see "Machine prompts" below), so a launcher driving repair.sh
#      programmatically never needs a second protocol.
#   2. An interactive controlling terminal (`[[ -t 0 ]]`, or the test-only
#      `ORBIT_REPAIR_TTY_INPUT=1` override described below): the proposed
#      safe batch is shown (the same `plan action=... resolves=...
#      mutation=... backup=...` line grammar --plan uses, printed to
#      stdout — these remain enum-only lines, consistent with the rest of
#      this script's stdout discipline) followed by ONE summary
#      confirmation covering the whole safe batch, printed to stderr (it is
#      not an enum) as `Orbit repair: N safe action(s) proposed above.
#      Proceed? [y/N] `, reading exactly one answer line from stdin.
#      Anything other than a bare `y`/`Y` — including a blank Enter, any
#      other text, Ctrl-C (bash's default SIGINT handling terminates the
#      process before any mutation code runs, since confirmation always
#      precedes it), or EOF (Ctrl-D) — declines. A decline leaves the
#      deployment completely unmutated: every planned action, safe or not,
#      is reported `skipped`.
#   3. Neither of the above, i.e. genuinely non-interactive: this is the
#      automation contract, and in this slice `--safe-only` is mandatory
#      alongside `--execute`, so this path is always the `--safe-only`
#      path. No confirmation is shown or required; execution proceeds
#      straight to the `execute` lines below. (A future slice that allows
#      `--execute` without `--safe-only` would need to gate this bypass on
#      the flag explicitly, since a broader action set would no longer be
#      uniformly safe to run unattended — that gate does not exist yet
#      because there is nothing beyond the safe set to gate.)
#
# `ORBIT_REPAIR_TTY_INPUT=1` is a test-only escape hatch, mirroring
# install.sh/configure.sh's own `ORBIT_CONFIGURE_TTY_INPUT` precedent: it
# forces the interactive confirmation path even though the test harness's
# stdin is a pipe rather than a real terminal, so the decline/EOF/accept
# behavior of the human-facing prompt can be exercised without a pty.
#
# Machine prompts (repair --execute)
# --------------------------------------------------------------------------
# Setting `ORBIT_REPAIR_PROMPTS=machine` switches the confirmation above to
# the same line grammar docs/engine-events.md documents for
# `scripts/configure.sh` ("Machine prompts (v0)"): `prompt`, `prompt-accept`,
# `prompt-reject`, `prompt-abort`, `key=value` tokens only. repair.sh adds
# exactly one field/kind pair to that vocabulary, used only by this script:
#
#   prompt field=safe-batch kind=confirm required=true attempt=1
#
# The engine then blocks reading exactly one answer line from stdin. The
# literal single-byte answer `y` accepts (`prompt-accept field=safe-batch`,
# then execution proceeds exactly like an interactively-confirmed batch);
# anything else, including empty input or EOF, aborts
# (`prompt-abort field=safe-batch`) with zero mutation. Unlike
# configure.sh's field-validation prompts, this is a single yes/no decision,
# not a value needing re-collection on a bad answer, so there is no
# `prompt-reject`/retry loop here — `attempt` is always `1`. The plan
# preview (the same `plan ...` lines the interactive human path shows) is
# printed to stdout before the `prompt` line in this mode too.
#
# Output contract (--execute)
# --------------------------------------------------------------------------
# When no confirmation preview is shown (the non-interactive automation
# path — the common case for an unattended caller), stdout is restricted to:
#   execute action=<action-class> resolves=<reason-class> result=<done|failed|skipped>
# one line per planned finding (in the same fixed `class_order` the plan
# uses), followed by a terminal line:
#   execution result=<empty|complete|unactionable|declined|failed> done=<n> failed=<n>
# and then the full post-execution re-diagnosis, in exactly `--check`'s own
# format (`finding class=... target=... severity=...` lines followed by
# `diagnosis result=... checked=... skipped=...`). `done`/`failed` count
# only actions actually attempted (the safe set); `skipped` actions are not
# counted in either. The pre-execution ("before") picture is not printed a
# second time as its own diagnosis block — it is already fully represented
# by the `resolves=<reason-class>` field on every `execute` line, so
# printing it again would be redundant; the explicit "after" picture is the
# full re-diagnosis at the end. When a confirmation preview IS shown
# (interactive or machine-prompt path), the `plan ...` / `prompt ...` lines
# described above are printed first, ahead of this same contract. No path,
# configured value, or secret ever appears in any line, exactly like
# `--check`/`--plan`.
#
# Terminal result values:
#   empty          — the plan itself was empty (nothing to do at all;
#                     matches --plan's own `result=empty`).
#   complete        — at least one safe-set action was attempted and every
#                     attempted safe-set action succeeded (other, non-safe
#                     findings may still exist and were reported `skipped`
#                     alongside).
#   unactionable    — the plan was non-empty but contained zero safe-set
#                     actions (every planned line was `skipped`) — there is
#                     something to fix, but none of it is in stage one's
#                     safe set; re-run `--plan` for the manual guidance, or
#                     wait for the stage-two executor.
#   declined        — a confirmation was shown and declined (or EOF/timed
#                     out via Ctrl-C never reaching the mutation code); zero
#                     mutation occurred.
#   failed          — at least one safe-set action failed (and was
#                     self-restored where applicable).
#
# EXIT CODES (--execute)
# ------------------------
#   0  execution succeeded with nothing left undone in the safe set —
#      terminal result is `empty`, `complete`, or `unactionable` (the
#      latter is not a failure of this tool: it faithfully reports that
#      nothing here was in stage one's scope).
#   1  declined — the confirmation was declined, hit EOF, or was
#      interrupted before any mutation; the deployment is guaranteed
#      unmutated.
#   2  usage error, including `--execute` without `--safe-only`.
#   4  failed — at least one safe-set action failed.
#   5  not-an-orbit-installation — identical trigger/meaning to `--check`/
#      `--plan`: the sole `not-orbit-directory` finding is always reported
#      `execute action=manual resolves=not-orbit-directory result=skipped`
#      (it can never be in the safe set), the terminal line is always
#      `execution result=empty done=0 failed=0`, the (unchanged) state is
#      re-diagnosed, and this exit code is then forced regardless of that
#      terminal line's own result — exactly like `--check`/`--plan`'s own
#      forced-5 precedent.
#
# The exit code always reflects THIS RUN's execution outcome, never the
# post-execution re-diagnosis's own severity (analogous to how `--plan`'s
# exit code reflects planning outcome, not target health): a caller that
# also cares about post-repair health reads the printed re-diagnosis
# `diagnosis result=...` line, the same as it would after running `--check`
# separately.
#
# Privacy
# --------------------------------------------------------------------------
# The private recovery directory's path, the staging directory's path, and
# every path this script touches during execution are never printed, in
# any line, under any mode — the enum-only stdout discipline that governs
# `--check`/`--plan` holds identically under `--execute`.

usage() {
  printf 'Usage: %s (--check|--plan|--execute --safe-only) [--plain]\n' "$0" >&2
  printf 'Orbit repair: --execute requires --safe-only in this slice.\n' >&2
  printf 'Orbit repair: stage two (dangerous, credential-rotation) actions are not yet implemented,\n' >&2
  printf 'Orbit repair: so --execute alone is refused rather than silently running a partial repair.\n' >&2
}

plain_mode=0
safe_only=0
mode=""
for arg in "$@"; do
  case "$arg" in
    --check|--plan|--execute)
      # Exactly one of --check/--plan/--execute is accepted; a second (of
      # any of the three) is a usage error rather than a silent
      # last-flag-wins override.
      [[ -z "$mode" ]] || {
        usage
        exit 2
      }
      mode="${arg#--}"
      ;;
    --plain) plain_mode=1 ;;
    --safe-only) safe_only=1 ;;
    *)
      usage
      exit 2
      ;;
  esac
done
[[ -n "$mode" ]] || {
  usage
  exit 2
}
if [[ "$mode" == execute ]]; then
  [[ "$safe_only" == 1 ]] || {
    usage
    exit 2
  }
elif [[ "$safe_only" == 1 ]]; then
  # --safe-only is only meaningful alongside --execute.
  usage
  exit 2
fi
# plain_mode is accepted for command-line compatibility with install.sh and
# installer-simulation.sh; output is unconditionally plain regardless of it.
: "$plain_mode"

# docs/engine-events.md "Machine prompts (v0)", extended with a
# repair-specific field/kind — see "Machine prompts (repair --execute)"
# above. Opt-in only, checked ahead of TTY-ness, exactly like
# configure.sh's own ORBIT_CONFIGURE_PROMPTS=machine.
machine_prompts=0
if [[ "${ORBIT_REPAIR_PROMPTS:-}" == machine ]]; then
  machine_prompts=1
fi

# Interactive confirmation gate: a real controlling terminal on stdin, or
# the test-only ORBIT_REPAIR_TTY_INPUT=1 escape hatch (mirrors
# ORBIT_CONFIGURE_TTY_INPUT) that lets the test harness exercise the
# human-facing y/N prompt over a plain pipe.
interactive=0
if [[ -t 0 ]] || [[ "${ORBIT_REPAIR_TTY_INPUT:-}" == 1 ]]; then
  interactive=1
fi

# Force cwd to this script's own containing installation directory, exactly
# like configure.sh, so `bash scripts/repair.sh --check`/`--plan`/`--execute`
# is safe regardless of the caller's working directory.
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

readonly environment_file=".env-orbit"
readonly compose_file="docker-compose.yml"
readonly secrets_directory=".orbit-secrets"
readonly database_volume_key="orbit-db-data"
readonly -a secret_names=(session-secret postgres-password document-kek oidc-client-secret)
readonly -a known_orbit_services=(orbit-app orbit-db orbit-clamav orbit-tika orbit-ollama)
readonly total_checks=15
readonly docker_probe_timeout=5s
readonly docker_restart_timeout=30s

# Stage-one safe set (issue #261, owner decision 2026-08-13). See "Safe set
# is a fixed allowlist" above for why this is not derived from the plan's
# own mutation= classification.
readonly -a safe_action_classes=(fix-permissions restore-transaction restart-services)

# Fixed allowlist of paths restore-transaction may ever touch, mirroring
# install.sh's own `managed_paths` (its `deployment_assets` plus
# `$environment_file` and `$secrets_directory`). Restoring never enumerates
# the staging directory's own contents — only these fixed, literal paths
# are ever considered.
readonly -a restore_transaction_paths=(
  docker-compose.yml
  docker-compose.mail.yml
  docker-compose.mail-alias-rotation.yml
  .env-orbit.example
  config/tika-config.xml
  scripts/configure.sh
  scripts/installer-ui.sh
  scripts/configuration.sh
  scripts/backup.sh
  scripts/restore.sh
  .env-orbit
  .orbit-secrets
)

readonly -a class_order=(
  not-orbit-directory
  managed-file-missing
  managed-file-symlink
  managed-file-permissions
  secrets-directory-invalid
  secret-missing
  secret-permissions
  configuration-incomplete
  configuration-invalid
  staging-evidence-present
  compose-interpolation-failed
  docker-unavailable
  container-foreign-owner
  volume-retained-without-credentials
  unrelated-resource-present
  database-unreachable
  database-credential-mismatch
  stale-container
  application-unhealthy
)

# Reason class -> action class for --plan (see the "Action-class mapping
# table" in the header comment above for the full rationale). secret-missing
# is deliberately absent here: its action class depends on which secret is
# missing and, for postgres-password, on whether a retained-volume finding
# is also present — see resolve_secret_missing_action below.
readonly -A action_for_class=(
  [managed-file-permissions]=fix-permissions
  [secrets-directory-invalid]=fix-permissions
  [secret-permissions]=fix-permissions
  [configuration-incomplete]=rerun-configuration
  [configuration-invalid]=rerun-configuration
  [staging-evidence-present]=restore-transaction
  [volume-retained-without-credentials]=rotate-database-credential
  [database-credential-mismatch]=rotate-database-credential
  [stale-container]=restart-services
  [application-unhealthy]=restart-services
  [not-orbit-directory]=manual
  [managed-file-missing]=manual
  [managed-file-symlink]=manual
  [compose-interpolation-failed]=manual
  [container-foreign-owner]=manual
  [docker-unavailable]=manual
  [unrelated-resource-present]=manual
  [database-unreachable]=manual
)

# Action class -> mutation classification for --plan.
readonly -A mutation_for_action=(
  [restore-transaction]=reversible
  [fix-permissions]=reversible
  [regenerate-secret]=reversible
  [rotate-database-credential]=credential-rotation
  [restart-services]=service-restart
  [rerun-configuration]=none
  [manual]=none
)

# Action class -> backup requirement for --plan.
readonly -A backup_for_action=(
  [restore-transaction]=required
  [fix-permissions]=not-required
  [regenerate-secret]=not-required
  [rotate-database-credential]=required
  [restart-services]=not-required
  [rerun-configuration]=not-required
  [manual]=not-required
)

# One human-readable, value-free manual-step line per manual-class reason
# class, printed to stderr alongside its `plan action=manual ...` line.
readonly -A manual_guidance=(
  [not-orbit-directory]="confirm this is really the intended Orbit installation directory before doing anything else here"
  [managed-file-missing]="recreate the missing managed file from your install source; repair never fabricates a managed file's content"
  [managed-file-symlink]="replace the symlinked managed file with a real regular file; repair never follows an unproven symlink"
  [compose-interpolation-failed]="run docker compose config yourself to see the interpolation error, then correct the referenced managed-file field"
  [container-foreign-owner]="inspect the flagged container's labels and confirm its Orbit ownership before anything touches this project"
  [docker-unavailable]="ensure the docker CLI is installed and the daemon is reachable, then re-run diagnosis"
  [unrelated-resource-present]="confirm whether the reported resource under a different Compose project is still needed; it is out of scope for this deployment's repair"
  [database-unreachable]="verify the database container/service is running and reachable, then re-run diagnosis; repair never starts a service to investigate"
)

declare -a findings=()
declare -A secret_status=()
checked=0
diagnosis_early=0

# execute-mode state (unused under --check/--plan).
declare -a plan_entries=()
plan_actions_count=0
plan_manual_count=0
recovery_dir=""
declare -A service_restart_result=()

add_finding() {
  findings+=("$1|$2|$3")
}

is_regular_non_symlink_file() {
  [[ -f "$1" && ! -L "$1" ]]
}

is_real_non_symlink_directory() {
  [[ -d "$1" && ! -L "$1" ]]
}

has_mode() {
  [[ "$(stat -c '%a' -- "$1" 2>/dev/null)" == "$2" ]]
}

read_environment_value() {
  local requested_key="$1" line value="" found=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "${requested_key}="* ]]; then
      value="${line#*=}"
      found=1
    fi
  done < "$environment_file"
  [[ "$found" == 1 ]] || return 1
  printf '%s' "$value"
}

# $1: "early" forces exit 5 (not-an-orbit-installation) regardless of
# finding severity/plan result; anything else derives the exit code from
# --check's worst finding severity or --plan's plan result, per mode.
print_output_and_exit() {
  if [[ "$mode" == plan ]]; then
    print_plan_output_and_exit "$1"
  else
    print_check_output_and_exit "$1"
  fi
}

# Prints the --check line grammar (finding lines + the terminal diagnosis
# line) without exiting, and records the worst severity into $check_worst.
# Used both by --check itself and by --execute's post-execution
# re-diagnosis, which must NOT let this printing decide --execute's own
# exit code (see "EXIT CODES (--execute)" above).
print_check_lines() {
  local class entry fclass ftarget fseverity worst=healthy

  for class in "${class_order[@]}"; do
    for entry in "${findings[@]:-}"; do
      [[ -n "$entry" ]] || continue
      IFS='|' read -r fclass ftarget fseverity <<< "$entry"
      [[ "$fclass" == "$class" ]] || continue
      printf 'finding class=%s target=%s severity=%s\n' "$fclass" "$ftarget" "$fseverity"
      if [[ "$fseverity" == fail ]]; then
        worst=failed
      elif [[ "$fseverity" == warn && "$worst" != failed ]]; then
        worst=attention
      fi
    done
  done

  local skipped=$((total_checks - checked))
  printf 'diagnosis result=%s checked=%s skipped=%s\n' "$worst" "$checked" "$skipped"
  check_worst="$worst"
}

print_check_output_and_exit() {
  local forced_exit="$1"
  print_check_lines

  if [[ "$forced_exit" == early ]]; then
    exit 5
  fi
  case "$check_worst" in
    healthy) exit 0 ;;
    attention) exit 3 ;;
    failed) exit 4 ;;
  esac
}

# secret-missing's action class depends on which secret is missing: every
# generated non-user secret regenerates safely, EXCEPT postgres-password
# when a volume-retained-without-credentials finding is also present in
# this same diagnosis (the #261 fixed-project collision) — that specific
# finding must route to rotate-database-credential instead, so a
# retained-volume postgres password is never auto-regenerated. See the
# "regenerate-secret" / "rotate-database-credential" entries in the
# header's action-class mapping table for the full rationale. Relies on
# bash's dynamic scoping: every caller declares its own local
# `volume_retained_without_credentials` before calling this.
resolve_secret_missing_action() {
  local target="$1"
  if [[ "$target" == postgres-password && "$volume_retained_without_credentials" == 1 ]]; then
    printf 'rotate-database-credential'
  else
    printf 'regenerate-secret'
  fi
}

print_plan_output_and_exit() {
  local forced_exit="$1"
  local class entry fclass ftarget fseverity action
  local actions=0 manual=0 result
  local volume_retained_without_credentials=0

  for entry in "${findings[@]:-}"; do
    [[ -n "$entry" ]] || continue
    IFS='|' read -r fclass ftarget fseverity <<< "$entry"
    [[ "$fclass" == volume-retained-without-credentials ]] && volume_retained_without_credentials=1
  done

  for class in "${class_order[@]}"; do
    for entry in "${findings[@]:-}"; do
      [[ -n "$entry" ]] || continue
      IFS='|' read -r fclass ftarget fseverity <<< "$entry"
      [[ "$fclass" == "$class" ]] || continue
      # Severity gate: an info-severity finding is never planned. --check
      # itself never lets an info-severity finding make the deployment
      # unhealthy, so --plan must not contradict that by treating it as a
      # problem needing manual intervention either; it produces no plan
      # line and is not counted toward actions or manual. See the "Severity
      # gate" paragraph in the PLAN MODE header comment.
      [[ "$fseverity" == info ]] && continue

      if [[ "$fclass" == secret-missing ]]; then
        action="$(resolve_secret_missing_action "$ftarget")"
      else
        action="${action_for_class[$fclass]:-manual}"
      fi

      printf 'plan action=%s resolves=%s mutation=%s backup=%s\n' \
        "$action" "$fclass" "${mutation_for_action[$action]}" "${backup_for_action[$action]}"

      if [[ "$action" == manual ]]; then
        manual=$((manual + 1))
        if [[ -n "${manual_guidance[$fclass]:-}" ]]; then
          printf 'manual step: %s (resolves=%s)\n' "${manual_guidance[$fclass]}" "$fclass" >&2
        fi
      else
        actions=$((actions + 1))
      fi
    done
  done

  if [[ "$actions" -gt 0 ]]; then
    result=ready
  elif [[ "$manual" -gt 0 ]]; then
    result="manual-required"
  else
    result=empty
  fi
  printf 'plan result=%s actions=%s manual=%s\n' "$result" "$actions" "$manual"

  if [[ "$forced_exit" == early ]]; then
    exit 5
  fi
  case "$result" in
    empty) exit 0 ;;
    ready) exit 3 ;;
    manual-required) exit 4 ;;
  esac
}

# Populates $plan_entries with one "action|resolves|target" string per
# warn/fail-severity finding, in the same fixed class_order and using the
# same severity gate / action-class mapping / secret-missing special case
# as print_plan_output_and_exit above (kept as a separate, independent
# implementation rather than refactored to share code, so a change here can
# never alter --plan's own tested output). Only used by --execute, which
# needs each finding's target (never printed by --plan itself) to know
# exactly which file/secret/service an action instance applies to.
compute_plan_entries() {
  local class entry fclass ftarget fseverity action
  local volume_retained_without_credentials=0
  plan_entries=()
  plan_actions_count=0
  plan_manual_count=0

  for entry in "${findings[@]:-}"; do
    [[ -n "$entry" ]] || continue
    IFS='|' read -r fclass ftarget fseverity <<< "$entry"
    [[ "$fclass" == volume-retained-without-credentials ]] && volume_retained_without_credentials=1
  done

  for class in "${class_order[@]}"; do
    for entry in "${findings[@]:-}"; do
      [[ -n "$entry" ]] || continue
      IFS='|' read -r fclass ftarget fseverity <<< "$entry"
      [[ "$fclass" == "$class" ]] || continue
      [[ "$fseverity" == info ]] && continue

      if [[ "$fclass" == secret-missing ]]; then
        action="$(resolve_secret_missing_action "$ftarget")"
      else
        action="${action_for_class[$fclass]:-manual}"
      fi

      plan_entries+=("$action|$fclass|$ftarget")
      if [[ "$action" == manual ]]; then
        plan_manual_count=$((plan_manual_count + 1))
      else
        plan_actions_count=$((plan_actions_count + 1))
      fi
    done
  done
}

is_safe_action() {
  local candidate="$1" known
  for known in "${safe_action_classes[@]}"; do
    [[ "$known" == "$candidate" ]] && return 0
  done
  return 1
}

# The confirmation preview: the same `plan ...` line grammar --plan itself
# prints, derived from the already-computed $plan_entries. Enum-only,
# printed to stdout ahead of the confirmation exchange.
print_plan_preview() {
  local entry action fclass ftarget
  for entry in "${plan_entries[@]:-}"; do
    [[ -n "$entry" ]] || continue
    IFS='|' read -r action fclass ftarget <<< "$entry"
    printf 'plan action=%s resolves=%s mutation=%s backup=%s\n' \
      "$action" "$fclass" "${mutation_for_action[$action]}" "${backup_for_action[$action]}"
  done
}

ensure_recovery_dir() {
  [[ -n "$recovery_dir" ]] && return 0
  recovery_dir="$(mktemp -d "./.orbit-repair-recovery.XXXXXX")" || return 1
  chmod 700 -- "$recovery_dir" || return 1
  return 0
}

cleanup_recovery_dir() {
  [[ -n "$recovery_dir" ]] || return 0
  rm -rf -- "$recovery_dir"
  recovery_dir=""
}

# Removes a target path regardless of type, mirroring install.sh's own
# remove_target_path.
remove_repair_path() {
  local path="$1"
  if [[ -L "$path" || -f "$path" ]]; then
    rm -f -- "$path"
  elif [[ -d "$path" ]]; then
    rm -rf -- "$path"
  elif [[ -e "$path" ]]; then
    rm -f -- "$path"
  fi
}

# --- Step 0: directory recognition -----------------------------------------
#
# Loosely-typed on purpose: unlike install.sh's binary validate_target, this
# looks for ANY fingerprint that this directory is (or was) an Orbit
# installation, so a broken/partial deployment can still be diagnosed in
# detail rather than being refused outright.
#
# Runs the full read-only diagnosis (Steps 0-12), resetting every
# accumulator it owns first so it is safe to call more than once in the
# same process — --execute calls this twice (before and after mutation).
run_diagnosis() {
  diagnosis_early=0
  findings=()
  checked=0
  secret_status=()

  has_signal=0
  [[ -e "$environment_file" || -L "$environment_file" ]] && has_signal=1
  [[ -e "$compose_file" || -L "$compose_file" ]] && has_signal=1
  [[ -e "$secrets_directory" || -L "$secrets_directory" ]] && has_signal=1
  shopt -s nullglob dotglob
  staging_entries=(.orbit-install-staging.*)
  shopt -u nullglob dotglob
  [[ ${#staging_entries[@]} -gt 0 ]] && has_signal=1

  checked=$((checked + 1))
  if [[ "$has_signal" == 0 ]]; then
    add_finding not-orbit-directory directory fail
    diagnosis_early=1
    return 0
  fi

  # --- Step 1: managed files (.env-orbit, docker-compose.yml) ----------------

  managed_file_result=""
  check_managed_file "$environment_file" environment-file 600
  env_status="$managed_file_result"
  check_managed_file "$compose_file" compose-file
  compose_status="$managed_file_result"

  # --- Step 2: secrets directory ----------------------------------------------

  checked=$((checked + 1))
  secrets_status=ok
  if ! is_real_non_symlink_directory "$secrets_directory"; then
    secrets_status=invalid
  elif ! has_mode "$secrets_directory" 700; then
    secrets_status=invalid
  fi
  [[ "$secrets_status" == ok ]] || add_finding secrets-directory-invalid secrets-directory fail

  # --- Step 3: individual managed secret files --------------------------------

  for name in "${secret_names[@]}"; do
    if [[ "$secrets_status" != ok ]]; then
      secret_status["$name"]=unknown
      continue
    fi
    checked=$((checked + 1))
    path="$secrets_directory/$name"
    if [[ -L "$path" ]]; then
      add_finding secret-permissions "$name" fail
      secret_status["$name"]=bad
    elif [[ ! -e "$path" ]]; then
      add_finding secret-missing "$name" warn
      secret_status["$name"]=missing
    elif [[ ! -f "$path" ]]; then
      add_finding secret-permissions "$name" fail
      secret_status["$name"]=bad
    elif [[ ! -s "$path" ]]; then
      add_finding secret-missing "$name" warn
      secret_status["$name"]=missing
    elif ! has_mode "$path" 600; then
      add_finding secret-permissions "$name" fail
      secret_status["$name"]=bad
    else
      secret_status["$name"]=ok
    fi
  done

  # --- Step 4: leftover installer staging evidence (issue #291 comment) ------

  checked=$((checked + 1))
  shopt -s nullglob dotglob
  staging_entries=(.orbit-install-staging.*)
  shopt -u nullglob dotglob
  [[ ${#staging_entries[@]} -gt 0 ]] && add_finding staging-evidence-present staging warn

  # --- Step 5: configuration syntax/schema/secret readiness (delegated) ------
  #
  # configure.sh --check is the single source of truth for configuration
  # readiness (src/lib/config-contract.ts keeps it in parity). This script
  # never re-implements that logic; it only classifies the outcome:
  #   - exit 0                          -> no finding, configuration is ready.
  #   - exit non-zero, nothing on stderr -> configuration-incomplete (required
  #     fields not yet ready; configure.sh's own `fail()` path always writes
  #     to stderr, so a silent non-zero exit means only the readiness report
  #     on stdout was involved).
  #   - exit non-zero with stderr output -> configuration-invalid (a
  #     structural problem such as an unreadable/unsafe .env-orbit or a
  #     missing .env-orbit.example template).
  if is_regular_non_symlink_file scripts/configure.sh; then
    checked=$((checked + 1))
    configure_check_stderr="$(mktemp "${TMPDIR:-/tmp}/orbit-repair-configure-check.XXXXXX")"
    configure_check_status=0
    bash scripts/configure.sh --check >/dev/null 2>"$configure_check_stderr" || configure_check_status=$?
    if [[ "$configure_check_status" != 0 ]]; then
      if [[ -s "$configure_check_stderr" ]]; then
        add_finding configuration-invalid configuration fail
      else
        add_finding configuration-incomplete configuration fail
      fi
    fi
    rm -f -- "$configure_check_stderr"
  fi

  # --- Step 6: Compose project name derivation (read-only) -------------------
  #
  # Mirrors install.sh's derive_compose_project_name precedence, but never
  # fails the run: an unresolvable project name just means the docker-backed
  # checks below are skipped rather than reported as findings.
  project=""
  if [[ "$env_status" == ok ]]; then
    candidate="$(read_environment_value COMPOSE_PROJECT_NAME 2>/dev/null || true)"
    [[ "$candidate" =~ ^[a-z0-9][a-z0-9_-]*$ ]] && project="$candidate"
  fi
  if [[ -z "$project" && -n "${COMPOSE_PROJECT_NAME:-}" ]]; then
    [[ "$COMPOSE_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] && project="$COMPOSE_PROJECT_NAME"
  fi
  if [[ -z "$project" ]]; then
    candidate="$(basename -- "$(pwd -P)" 2>/dev/null || true)"
    candidate="$(printf '%s' "$candidate" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-' 2>/dev/null || true)"
    while [[ "$candidate" == [-_]* ]]; do candidate="${candidate:1}"; done
    [[ -n "$candidate" && "$candidate" =~ ^[a-z0-9][a-z0-9_-]*$ ]] && project="$candidate"
  fi

  # --- Step 7: docker availability gate ---------------------------------------
  #
  # One cheap, allowed, read-only probe (`docker ps -a`) decides whether every
  # docker-backed check below can run at all. Any failure — missing binary,
  # missing `timeout`, unreachable daemon — is treated identically as
  # docker-unavailable for every affected check; this script cannot and does
  # not distinguish the cause.
  docker_available=0
  if command -v docker >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1 &&
    timeout "$docker_probe_timeout" docker ps -a >/dev/null 2>&1; then
    docker_available=1
  fi

  compose_check_eligible=0
  [[ "$env_status" == ok && "$compose_status" == ok && -n "$project" ]] && compose_check_eligible=1
  resource_check_eligible=0
  [[ -n "$project" ]] && resource_check_eligible=1

  # --- Step 8: Compose interpolation ------------------------------------------

  if [[ "$compose_check_eligible" == 1 ]]; then
    if [[ "$docker_available" == 1 ]]; then
      checked=$((checked + 1))
      if ! timeout "$docker_probe_timeout" docker compose --project-name "$project" \
        --env-file "$environment_file" config --quiet >/dev/null 2>&1; then
        add_finding compose-interpolation-failed compose fail
      fi
    else
      add_finding docker-unavailable compose info
    fi
  fi

  # --- Step 9: retained database volume vs. credentials ----------------------

  if [[ "$resource_check_eligible" == 1 ]]; then
    if [[ "$docker_available" == 1 ]]; then
      checked=$((checked + 1))
      volume_list="$(timeout "$docker_probe_timeout" docker volume ls \
        --filter "name=$database_volume_key" --format '{{.Name}}' 2>/dev/null || true)"
      our_volume="${project}_${database_volume_key}"
      found_ours=0
      found_other=0
      while IFS= read -r volume || [[ -n "$volume" ]]; do
        [[ -z "$volume" ]] && continue
        [[ "$volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ && "$volume" =~ (^|_)orbit-db-data$ ]] || continue
        if [[ "$volume" == "$our_volume" ]]; then
          found_ours=1
        else
          found_other=1
        fi
      done <<< "$volume_list"
      [[ "$found_other" == 1 ]] && add_finding unrelated-resource-present database-volume info
      if [[ "$found_ours" == 1 ]]; then
        if [[ "$secrets_status" != ok || "${secret_status[postgres-password]:-missing}" == missing ]]; then
          add_finding volume-retained-without-credentials database-volume fail
        fi
      fi
    else
      add_finding docker-unavailable database-volume info
    fi
  fi

  # --- Step 10: container project-label ownership -----------------------------

  if [[ "$resource_check_eligible" == 1 ]]; then
    if [[ "$docker_available" == 1 ]]; then
      checked=$((checked + 1))
      container_list="$(timeout "$docker_probe_timeout" docker ps -a \
        --filter "label=com.docker.compose.project=$project" \
        --format '{{.ID}}|{{.Label "com.docker.compose.service"}}' 2>/dev/null || true)"
      foreign=0
      while IFS='|' read -r container_id service extra || [[ -n "$container_id" || -n "$service" || -n "$extra" ]]; do
        [[ -z "$container_id" && -z "$service" && -z "$extra" ]] && continue
        [[ -n "$extra" ]] && { foreign=1; continue; }
        [[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || { foreign=1; continue; }
        known=0
        for known_service in "${known_orbit_services[@]}"; do
          [[ "$service" == "$known_service" ]] && { known=1; break; }
        done
        [[ "$known" == 1 ]] || foreign=1
      done <<< "$container_list"
      [[ "$foreign" == 1 ]] && add_finding container-foreign-owner container fail
    else
      add_finding docker-unavailable container info
    fi
  fi

  # --- Step 11: database reachability and credential match --------------------
  #
  # See the "READ-ONLY BY CONSTRUCTION" / "Database credential handling" notes
  # at the top of this file: only `pg_isready` and `psql -c 'SELECT 1'` are
  # ever exec'd, only inside this deployment's own orbit-db container (proved
  # by the same Compose project/service label discipline as Step 10), and the
  # password is never placed in argv, output, or a finding.
  if [[ "$resource_check_eligible" == 1 ]]; then
    if [[ "$docker_available" == 1 ]]; then
      checked=$((checked + 1))
      check_database_reachability
    else
      add_finding docker-unavailable database info
    fi
  fi

  # --- Step 12: application container image identity and health --------------
  #
  # Compares this deployment's running orbit-app container against the
  # locally pinned ORBIT_IMAGE (stale-container) and reads Docker's own
  # computed health status (application-unhealthy, from the HEALTHCHECK baked
  # into the published image). Both reads are `docker inspect` only; neither
  # execs into the container nor touches the registry (that registry-side
  # comparison is the still-reserved image-identity-mismatch class).
  if [[ "$resource_check_eligible" == 1 ]]; then
    if [[ "$docker_available" == 1 ]]; then
      checked=$((checked + 1))
      check_application_container
    else
      add_finding docker-unavailable application info
    fi
  fi
}

# Sets the global $managed_file_result rather than returning via command
# substitution, which would run the finding/checked mutations in a subshell
# and silently discard them.
check_managed_file() {
  local path="$1" target="$2" require_mode="${3:-}"
  checked=$((checked + 1))
  if [[ -L "$path" ]]; then
    add_finding managed-file-symlink "$target" fail
    managed_file_result=symlink
    return
  fi
  if [[ ! -e "$path" || ! -f "$path" ]]; then
    add_finding managed-file-missing "$target" fail
    managed_file_result=missing
    return
  fi
  if [[ -n "$require_mode" ]] && ! has_mode "$path" "$require_mode"; then
    add_finding managed-file-permissions "$target" fail
    managed_file_result=permissions
    return
  fi
  managed_file_result=ok
}

check_database_reachability() {
  local db_ids db_id pg_user=orbit pg_db=orbit candidate
  local pg_password="" psql_output="" psql_status=0

  if [[ "$env_status" == ok ]]; then
    candidate="$(read_environment_value POSTGRES_USER 2>/dev/null || true)"
    [[ "$candidate" =~ ^[A-Za-z0-9_]+$ ]] && pg_user="$candidate"
    candidate="$(read_environment_value POSTGRES_DB 2>/dev/null || true)"
    [[ "$candidate" =~ ^[A-Za-z0-9_]+$ ]] && pg_db="$candidate"
  fi

  db_ids="$(timeout "$docker_probe_timeout" docker ps -a \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=orbit-db" \
    --format '{{.ID}}' 2>/dev/null || true)"
  db_id=""
  if [[ -n "$db_ids" && "$db_ids" != *$'\n'* && "$db_ids" =~ ^[0-9a-f]{12,64}$ ]]; then
    db_id="$db_ids"
  fi

  if [[ -z "$db_id" ]] || ! timeout "$docker_probe_timeout" docker exec -T "$db_id" \
    pg_isready -U "$pg_user" -d "$pg_db" >/dev/null 2>&1; then
    add_finding database-unreachable database fail
    return 0
  fi

  # Without a readable postgres-password secret there is nothing safe to
  # authenticate with; secret-missing/volume-retained-without-credentials
  # already cover that absence, so this check quietly stops here rather
  # than guessing. (Bare `return` would propagate the failing test's exit
  # status as this function's own return value and trip `set -e` at the
  # call site below, so every early exit here is an explicit `return 0`.)
  [[ "${secret_status[postgres-password]:-missing}" == ok ]] || return 0

  pg_password="$(cat -- "$secrets_directory/postgres-password" 2>/dev/null || true)"
  # -h forces a host (TCP) connection so PostgreSQL's password-based
  # authentication is actually exercised; a bare local-socket connection
  # would use "trust" auth inside the official postgres image and could
  # never observe a credential mismatch.
  psql_output="$(PGPASSWORD="$pg_password" timeout "$docker_probe_timeout" \
    docker exec -e PGPASSWORD -T "$db_id" \
    psql -h 127.0.0.1 -U "$pg_user" -d "$pg_db" -c 'SELECT 1' 2>&1)" || psql_status=$?
  pg_password=""
  if [[ "$psql_status" != 0 ]]; then
    if [[ "${psql_output,,}" == *"password authentication failed"* ]]; then
      add_finding database-credential-mismatch database fail
    else
      add_finding database-unreachable database fail
    fi
  fi
  psql_output=""
}

check_application_container() {
  local app_ids app_id pinned_image=""
  local inspect_output="" actual_image="" health_status="" extra=""

  if [[ "$env_status" == ok ]]; then
    pinned_image="$(read_environment_value ORBIT_IMAGE 2>/dev/null || true)"
    [[ "$pinned_image" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]] || pinned_image=""
  fi

  app_ids="$(timeout "$docker_probe_timeout" docker ps -a \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=orbit-app" \
    --format '{{.ID}}' 2>/dev/null || true)"
  app_id=""
  if [[ -n "$app_ids" && "$app_ids" != *$'\n'* && "$app_ids" =~ ^[0-9a-f]{12,64}$ ]]; then
    app_id="$app_ids"
  fi
  # Every early exit below is an explicit `return 0`, never a bare `return`:
  # a bare `return` propagates the preceding failed test's exit status as
  # this function's own return value, which would trip `set -e` at the
  # call site (a bare `check_application_container` statement) below.
  [[ -n "$app_id" ]] || return 0

  inspect_output="$(timeout "$docker_probe_timeout" docker inspect \
    --format '{{.Config.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
    "$app_id" 2>/dev/null || true)"
  [[ "$inspect_output" != *$'\n'* ]] || return 0
  IFS='|' read -r actual_image health_status extra <<< "$inspect_output"
  [[ -z "$extra" ]] || return 0

  if [[ -n "$pinned_image" && -n "$actual_image" && "$actual_image" != "$pinned_image" ]]; then
    add_finding stale-container container warn
  fi
  if [[ "$health_status" == unhealthy ]]; then
    add_finding application-unhealthy application fail
  fi
}

# --- fix-permissions -------------------------------------------------------
#
# Re-validates the target's current type immediately before acting (see
# "Action implementations" above). Returns 0 (chmod applied) or 1 (nothing
# was safe to mutate; the caller reports this as `failed`).
do_fix_permissions() {
  local resolves="$1" target="$2" path mode

  case "$resolves" in
    managed-file-permissions)
      path="$environment_file"
      mode=600
      is_regular_non_symlink_file "$path" || return 1
      ;;
    secrets-directory-invalid)
      path="$secrets_directory"
      mode=700
      is_real_non_symlink_directory "$path" || return 1
      ;;
    secret-permissions)
      path="$secrets_directory/$target"
      mode=600
      is_regular_non_symlink_file "$path" || return 1
      ;;
    *)
      return 1
      ;;
  esac

  chmod "$mode" -- "$path"
}

# --- restore-transaction ----------------------------------------------------
#
# On any failure, every path already touched by this call is restored from
# this run's private recovery directory before returning 1; the staging
# directory is left in place for a future retry. On success, the staging
# directory is removed entirely and 0 is returned. See "Action
# implementations" above for the full rationale.
restore_transaction_self_restore() {
  local -a touched=("$@")
  local index path live_backup_path
  for ((index = ${#touched[@]} - 1; index >= 0; index--)); do
    path="${touched[index]}"
    live_backup_path="$recovery_dir/live/$path"
    remove_repair_path "$path"
    if [[ -e "$live_backup_path" || -L "$live_backup_path" ]]; then
      cp -a -- "$live_backup_path" "$path" 2>/dev/null || true
    fi
  done
}

do_restore_transaction() {
  local -a staging_matches=()
  local -a touched=()
  local staging_root path parent backup_path live_backup_path had_backup have_live

  shopt -s nullglob dotglob
  staging_matches=(.orbit-install-staging.*)
  shopt -u nullglob dotglob
  [[ ${#staging_matches[@]} -eq 1 ]] || return 1
  staging_root="${staging_matches[0]}"

  is_real_non_symlink_directory "$staging_root" || return 1
  is_real_non_symlink_directory "$staging_root/rollback" || return 1
  has_mode "$staging_root/rollback" 700 || return 1
  is_real_non_symlink_directory "$staging_root/rollback/original" || return 1
  has_mode "$staging_root/rollback/original" 700 || return 1

  ensure_recovery_dir || return 1

  for path in "${restore_transaction_paths[@]}"; do
    parent="$(dirname -- "$path")"
    # Never operate on a path through a symlinked parent directory, exactly
    # like install.sh's own rollback_transaction.
    if [[ "$parent" != "." && -L "$parent" ]]; then
      restore_transaction_self_restore "${touched[@]}"
      return 1
    fi

    backup_path="$staging_root/rollback/original/$path"
    had_backup=0
    [[ -e "$backup_path" || -L "$backup_path" ]] && had_backup=1
    if [[ "$had_backup" == 1 && -L "$backup_path" ]]; then
      # A symlinked backup entry is not trustworthy staged content.
      restore_transaction_self_restore "${touched[@]}"
      return 1
    fi

    have_live=0
    [[ -e "$path" || -L "$path" ]] && have_live=1

    # Nothing existed before the interrupted transaction and nothing
    # exists now: no action needed for this path.
    [[ "$have_live" == 0 && "$had_backup" == 0 ]] && continue

    if [[ "$have_live" == 1 ]]; then
      live_backup_path="$recovery_dir/live/$path"
      mkdir -p -- "$(dirname -- "$live_backup_path")" || {
        restore_transaction_self_restore "${touched[@]}"
        return 1
      }
      cp -a -- "$path" "$live_backup_path" || {
        restore_transaction_self_restore "${touched[@]}"
        return 1
      }
    fi
    touched+=("$path")

    if [[ "$have_live" == 1 ]]; then
      remove_repair_path "$path" || {
        restore_transaction_self_restore "${touched[@]}"
        return 1
      }
    fi

    if [[ "$had_backup" == 1 ]]; then
      # cp, not mv: the staged backup stays intact in case a later path in
      # this same action fails and the whole action must self-restore.
      cp -a -- "$backup_path" "$path" || {
        restore_transaction_self_restore "${touched[@]}"
        return 1
      }
    fi
    # had_backup == 0 && have_live == 1: this path did not exist before the
    # interrupted transaction, so it must have been created by it; it has
    # already been removed above, mirroring install.sh's own rollback
    # removal loop.
  done

  rm -rf -- "$staging_root" || return 1
  return 0
}

# --- restart-services --------------------------------------------------------
#
# Both finding classes this action resolves only ever target this
# deployment's orbit-app container (see check_application_container above),
# so the service name is fixed here; $1 is accepted only for call-site
# symmetry with the other do_* functions and documentation purposes.
do_restart_services() {
  local service="orbit-app"
  local container_ids="" container_id=""

  if [[ -n "${service_restart_result[$service]:-}" ]]; then
    [[ "${service_restart_result[$service]}" == "done" ]]
    return $?
  fi

  if [[ -z "$project" || "$docker_available" != 1 ]]; then
    service_restart_result[$service]=failed
    return 1
  fi

  container_ids="$(timeout "$docker_probe_timeout" docker ps -a \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$service" \
    --format '{{.ID}}' 2>/dev/null || true)"
  if [[ -n "$container_ids" && "$container_ids" != *$'\n'* && "$container_ids" =~ ^[0-9a-f]{12,64}$ ]]; then
    container_id="$container_ids"
  fi
  if [[ -z "$container_id" ]]; then
    service_restart_result[$service]=failed
    return 1
  fi

  if timeout "$docker_restart_timeout" docker restart "$container_id" >/dev/null 2>&1; then
    service_restart_result[$service]="done"
    return 0
  fi
  service_restart_result[$service]=failed
  return 1
}

# --- confirmation ------------------------------------------------------------
#
# Returns 0 (proceed) or 1 (declined). See "Confirmation model" and
# "Machine prompts" above for the full priority order and wire grammar.
confirm_safe_batch() {
  local safe_count="$1" answer=""

  if [[ "$machine_prompts" == 1 ]]; then
    print_plan_preview
    printf 'prompt field=safe-batch kind=confirm required=true attempt=1\n'
    if IFS= read -r answer && [[ "$answer" == y ]]; then
      printf 'prompt-accept field=safe-batch\n'
      return 0
    fi
    printf 'prompt-abort field=safe-batch\n'
    return 1
  fi

  if [[ "$interactive" == 1 ]]; then
    print_plan_preview
    printf 'Orbit repair: %d safe action(s) proposed above. Proceed? [y/N] ' "$safe_count" >&2
    if IFS= read -r answer && [[ "$answer" == y || "$answer" == Y ]]; then
      return 0
    fi
    return 1
  fi

  # Non-interactive automation: --safe-only is mandatory alongside --execute
  # in this slice, so reaching here already means this is the automation
  # contract's intended unattended path — proceed without a prompt.
  return 0
}

# --- execute mode driver -----------------------------------------------------

execute_repair() {
  local entry action fclass ftarget status result
  local safe_count=0 done_count=0 failed_count=0 terminal_result=""

  recovery_dir=""
  service_restart_result=()

  run_diagnosis

  if [[ "$diagnosis_early" == 1 ]]; then
    compute_plan_entries
    for entry in "${plan_entries[@]:-}"; do
      [[ -n "$entry" ]] || continue
      IFS='|' read -r action fclass ftarget <<< "$entry"
      printf 'execute action=%s resolves=%s result=skipped\n' "$action" "$fclass"
    done
    printf 'execution result=empty done=0 failed=0\n'
    run_diagnosis
    print_check_lines
    exit 5
  fi

  compute_plan_entries
  for entry in "${plan_entries[@]:-}"; do
    [[ -n "$entry" ]] || continue
    IFS='|' read -r action fclass ftarget <<< "$entry"
    is_safe_action "$action" && safe_count=$((safe_count + 1))
  done

  if [[ "$safe_count" -eq 0 ]]; then
    for entry in "${plan_entries[@]:-}"; do
      [[ -n "$entry" ]] || continue
      IFS='|' read -r action fclass ftarget <<< "$entry"
      printf 'execute action=%s resolves=%s result=skipped\n' "$action" "$fclass"
    done
    if [[ "${#plan_entries[@]}" -eq 0 ]]; then
      terminal_result=empty
    else
      terminal_result=unactionable
    fi
    printf 'execution result=%s done=0 failed=0\n' "$terminal_result"
    run_diagnosis
    print_check_lines
    exit 0
  fi

  if ! confirm_safe_batch "$safe_count"; then
    for entry in "${plan_entries[@]:-}"; do
      [[ -n "$entry" ]] || continue
      IFS='|' read -r action fclass ftarget <<< "$entry"
      printf 'execute action=%s resolves=%s result=skipped\n' "$action" "$fclass"
    done
    printf 'execution result=declined done=0 failed=0\n'
    run_diagnosis
    print_check_lines
    exit 1
  fi

  for entry in "${plan_entries[@]:-}"; do
    [[ -n "$entry" ]] || continue
    IFS='|' read -r action fclass ftarget <<< "$entry"
    if ! is_safe_action "$action"; then
      printf 'execute action=%s resolves=%s result=skipped\n' "$action" "$fclass"
      continue
    fi

    status=0
    case "$action" in
      fix-permissions) do_fix_permissions "$fclass" "$ftarget" || status=$? ;;
      restore-transaction) do_restore_transaction || status=$? ;;
      restart-services) do_restart_services "$fclass" || status=$? ;;
    esac

    if [[ "$status" == 0 ]]; then
      result="done"
      done_count=$((done_count + 1))
    else
      result=failed
      failed_count=$((failed_count + 1))
    fi
    printf 'execute action=%s resolves=%s result=%s\n' "$action" "$fclass" "$result"
  done

  cleanup_recovery_dir

  if [[ "$failed_count" -gt 0 ]]; then
    terminal_result=failed
  else
    terminal_result=complete
  fi
  printf 'execution result=%s done=%s failed=%s\n' "$terminal_result" "$done_count" "$failed_count"

  run_diagnosis
  print_check_lines

  case "$terminal_result" in
    complete) exit 0 ;;
    failed) exit 4 ;;
  esac
}

case "$mode" in
  execute)
    execute_repair
    ;;
  *)
    run_diagnosis
    if [[ "$diagnosis_early" == 1 ]]; then
      print_output_and_exit early
    else
      print_output_and_exit final
    fi
    ;;
esac
