#!/usr/bin/env bash
set -Eeuo pipefail

# Orbit repair mode — safe diagnostic + planning + STAGE-ONE/STAGE-TWO
# executor (issue #261, slice 4/5).
#
# Supported invocations:
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
#   bash scripts/repair.sh --execute --dangerous [--plain] (slice 5 stage two:
#                                                           diagnosis + planning,
#                                                           then — subject to
#                                                           interactive/
#                                                           machine-prompt
#                                                           approval only, see
#                                                           "EXECUTE MODE
#                                                           (--execute
#                                                           --dangerous)" below
#                                                           — execution of the
#                                                           rotate-database-
#                                                           credential action)
#   bash scripts/repair.sh --export-diagnostics [--plain]  (issue #531, ADR-0014
#                                                           decision 10: preview
#                                                           then confirm then
#                                                           write the exact
#                                                           --check/--plan
#                                                           deterministic stream
#                                                           plus one identity
#                                                           line — see "EXPORT
#                                                           MODE
#                                                           (--export-
#                                                           diagnostics)" below)
# `--safe-only` and `--dangerous` may be combined in one `--execute`
# invocation (each batch keeps its own independent approval and outcome); at
# least one of the two is REQUIRED alongside `--execute`, so a bare
# `--execute` is refused with a usage error rather than silently running only
# part of a repair. `--plain` is tolerated anywhere in the argument list;
# output is unconditionally plain regardless of it. Exactly one of
# `--check`/`--plan`/`--execute`/`--export-diagnostics` is required.
# `--safe-only`/`--dangerous` are accepted only alongside `--execute`. Any
# other combination, flag, or positional argument is a usage error.
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
# inspect`, `docker image inspect`, `docker ps`, `docker volume ls`/
# `inspect`, `docker compose config` — never a command that mutates
# containers, volumes, or images.
# Each docker read is optional: if the `docker` CLI is unavailable or the
# daemon cannot be reached, the affected checks are reported as
# `class=docker-unavailable` and diagnosis continues with everything else
# that can still be checked read-only. `--execute` (this slice) is the one
# and only invocation that ever mutates anything, and even then only the
# fixed safe action set documented below — see "EXECUTE MODE" further down.
#
# This slice adds exactly two more read-only primitives, both narrowly
# scoped: `docker exec <this deployment's orbit-db container> pg_isready`
# and `docker exec <same container> psql -c 'SELECT 1'`. Neither mutates
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
#   configuration-migration-interrupted — replaces configuration-invalid/
#                                   configuration-incomplete for this run
#                                   (ADR-0014 decision 7): fires only when
#                                   the live .env-orbit fails validation AND
#                                   configuration.sh's own
#                                   `.env-orbit.orbit-config.rollback` copy
#                                   exists, is a regular non-symlink file
#                                   mode 600, and itself passes the same
#                                   configure.sh --check semantics — a
#                                   deterministically recoverable interrupted
#                                   `configuration.sh --migrate` run.
#   deployment-version-unsupported — .env-orbit is readable but its
#                                   ORBIT_CONFIG_APPLIED_VERSION is absent,
#                                   malformed, or names a published release
#                                   below ADR-0016's supported-install floor
#                                   (v1.3.0). Absence fails closed: every
#                                   supported install writes the key, so a
#                                   readable file without it is the
#                                   signature of a pre-floor or
#                                   hand-assembled deployment. Major
#                                   version 0 (development builds) is
#                                   exempt, and the check is skipped (never
#                                   failed) while a configuration finding
#                                   is present this run — a half-written
#                                   .env-orbit legitimately lacks the key,
#                                   and the restore that repairs it must
#                                   not be refused by it. While this
#                                   finding is present, --execute refuses
#                                   the entire batch — see EXIT CODES
#                                   (--execute).
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
#   document-volume-retained-without-key — ADR-0014 decision 5's second
#                                   retention guard: the retained
#                                   `orbit-documents-data` volume for this
#                                   project exists while document-kek is
#                                   missing. Mirrors
#                                   volume-retained-without-credentials
#                                   exactly (volume-name match plus the local
#                                   absence of the secret file); unlike that
#                                   class there is no rotate equivalent, so
#                                   it plans as manual, never a guessed fix.
#   unrelated-resource-present      — a database or document volume matching
#                                   Orbit's naming pattern exists under a
#                                   different Compose project than this
#                                   deployment's.
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
#   database-schema-mismatch        — the application refused to start because
#                                   the database was migrated by a different
#                                   build. Reported instead of, not as well
#                                   as, application-unhealthy: restarting
#                                   cannot change either side (#437).
#   database-below-floor            — the application refused to start because
#                                   the database predates the supported
#                                   migration floor. Also not restartable.
#   migration-failed                 — the migrator (drizzle) threw applying a
#                                   migration and rolled it back, leaving no
#                                   applied journal row: detected primarily by
#                                   extending the existing #437 app-log
#                                   sentinel scan to also match
#                                   `reason=migration_failed` (works on a
#                                   stopped/crash-looping container), with a
#                                   backstop single fixed-literal `SELECT` of
#                                   the migrator's own outcome bookkeeping row
#                                   over the already-authenticated probe path
#                                   for when logs have rotated or the
#                                   container is gone (issue #528).
#   image-identity-mismatch          — this deployment's orbit-app container's
#                                   actual running image ID does not match the
#                                   locally-present image for the
#                                   digest-pinned `ORBIT_IMAGE` reference —
#                                   distinct from stale-container, which only
#                                   compares the `Config.Image` string (issue
#                                   #528).
#
# PLAN MODE (--plan) — issue #261 third slice, STILL ZERO MUTATION
# --------------------------------------------------------------------------
# `--plan` runs exactly the same read-only diagnosis as `--check` above (the
# same 25 reason classes, the same optional docker probes, the same
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
#     plan action=<action-class> resolves=<reason-class> mutation=<none|reversible|credential-rotation|service-restart> backup=<required|not-required> target=<finding-target> rollback=<recovery-directory|credential-checkpoint|prior-mode|not-required> expect=<enum>
#   The trailing three fields are criterion 6's preview contract (#681):
#   the affected target (the finding's own enum-only target field), the
#   named rollback point (rollback_for_action), and the expected result if
#   the action succeeds (expected_for_action). All enum-only, never a path
#   or a value.
#   A finding with no safe automatic action instead emits:
#     plan action=manual resolves=<reason-class> mutation=none backup=not-required target=<finding-target> rollback=not-required expect=operator-action
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
#   restore-transaction        <- staging-evidence-present,
#                                   configuration-migration-interrupted
#     mutation=reversible backup=required. Restoring a recognized prior
#     managed-file transaction overwrites the *current* (possibly still
#     valid) live managed files with the staged prior-good copies, so a
#     fresh backup of the current live state is required before slice 4
#     may perform this overwrite, even though the staging evidence itself
#     already holds the content being restored. ADR-0014 decision 7 extends
#     this same action class to a second, unrelated boundary —
#     configuration.sh's own `.orbit-config.rollback` copy of .env-orbit —
#     with the identical mutation/backup rationale; see
#     do_restore_configuration_rollback for the implementation.
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
#                                   state (session-secret, oidc-client-secret;
#                                   also postgres-password when no retained
#                                   database volume is present, and
#                                   document-kek when no retained document
#                                   volume is present — see the two
#                                   exceptions immediately below).
#     mutation=reversible backup=not-required. The finding fires only when
#     the secret file is absent/empty, so there is no valid prior secret
#     content to lose or back up.
#
#     EXCEPTION 1 — postgres-password is explicitly EXCLUDED from
#     regenerate-secret whenever a `volume-retained-without-credentials`
#     finding is also present in the same diagnosis (the #261 fixed-project
#     collision: a retained `orbit-db-data` volume still holds the OLD
#     role's password hash). Minting an unrelated new password there would
#     not fix authentication — it would just create a second, still-broken
#     credential. That specific secret-missing finding is instead planned
#     as rotate-database-credential, below, so a retained-volume postgres
#     password is NEVER auto-regenerated.
#
#     EXCEPTION 2 — document-kek is explicitly EXCLUDED from
#     regenerate-secret whenever a `document-volume-retained-without-key`
#     finding is also present (ADR-0014 decision 5's second retention guard):
#     a retained `orbit-documents-data` volume holds documents encrypted
#     under the OLD key, and minting a new one would leave them permanently
#     unreadable. Unlike EXCEPTION 1, there is no rotate equivalent to route
#     to — that specific secret-missing finding is instead planned as
#     `manual`, below the action-class table, so a retained-volume
#     document-kek is NEVER auto-regenerated either.
#
#     NOTE (stage two, since this slice): despite being classified
#     mutation=reversible above, regenerate-secret is NOT in stage one's
#     executable safe set — see "EXECUTE MODE (--execute --safe-only)" below.
#     The owner's 2026-08-13 slice 4 decision names the stage-one safe set
#     explicitly by action class (fix-permissions, restore-transaction,
#     restart-services); that enumerated list, not this table's own
#     mutation=reversible tag, is authoritative for what
#     `--execute --safe-only` may act on. A newly minted secret is live
#     credential material other processes may already be holding open, which
#     is a materially different risk than a mode-only chmod or a container
#     restart, so it stays out of stage one even though it is
#     filesystem-reversible in principle. It IS executed in stage two, behind
#     the same typed-word/never-automatable approval model as
#     rotate-database-credential — see "EXECUTE MODE (--execute
#     --dangerous)" below.
#
#   rotate-database-credential  <- database-credential-mismatch,
#                                   volume-retained-without-credentials,
#                                   and (per the exception above)
#                                   secret-missing when target is
#                                   postgres-password AND a retained volume
#                                   is present.
#     mutation=credential-rotation backup=required. This is the #261
#     motivating recovery path: preserve the original password (in a
#     checkpoint) and then rotate the database role to a freshly generated
#     credential through a verified local connection. A database password is
#     NEVER reset merely because authentication failed WITHOUT first
#     checkpointing whatever credential is currently live. This is issue
#     #261's stage-two action class (per the owner's 2026-08-13 decisions):
#     its checkpoint-and-typed-word approval model is implemented in this
#     slice (5) and only ever runs under `--execute --dangerous`, subject to
#     interactive/machine-prompt approval — see "EXECUTE MODE (--execute
#     --dangerous)" below. `--execute --safe-only` alone (without
#     `--dangerous`) still always reports it as `skipped`, never executes it.
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
# Stage-two dangerous-step iterator (recorded owner intention, 2026-08-13
# comment on issue #261) — RESERVED SHAPE
# --------------------------------------------------------------------------
# Stage two has exactly one dangerous action class today
# (rotate-database-credential, see the action-class table above and
# "EXECUTE MODE (--execute --dangerous)" below), decomposed into an ordered
# sequence of independently callable steps (`rotate_database_credential_steps`
# / `run_dangerous_step`): checkpoint, rotate-credential, update-config,
# restart-services. This is deliberately a STEP ITERATOR, not one monolithic
# function, so that if stage two ever grows a second dangerous action class,
# the operator can be offered either of two execution cadences without this
# shape being restructured: run the approved sequence straight through (the
# only cadence actually wired up in this slice, via
# `run_rotate_database_credential_steps`), or cycle one step at a time with
# an operator pause between each (a future slice would call
# `run_dangerous_step` directly per element with a pause in between, instead
# of the current unconditional loop — no UI for that cadence exists yet, and
# none is built in this slice). Nothing here bakes in the single-action,
# straight-through assumption as the only possible shape.
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
# `rerun-configuration`, `manual`) is always reported and never executed —
# see "Safe set is a fixed allowlist" below. `rotate-database-credential`
# (stage two, gated on a passphrase-encrypted ORBKEK01 checkpoint and a
# typed-word confirmation) is likewise never executed by `--safe-only` alone
# — see "EXECUTE MODE (--execute --dangerous)" below, which is the ONLY way
# it is ever executed. `--execute` with neither `--safe-only` nor
# `--dangerous` is refused with a usage error rather than silently running
# no repair at all.
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
#                         For the resolves=configuration-migration-interrupted
#                         boundary (ADR-0014 decision 7,
#                         do_restore_configuration_rollback), the shape is
#                         narrower because there is no staging tree to walk:
#                         only the single fixed literal path .env-orbit is
#                         ever touched. The `.orbit-config.rollback` copy and
#                         .env-orbit's own parent are re-verified (regular,
#                         non-symlink, mode 600, no symlinked parent) before
#                         anything is touched; the current live .env-orbit
#                         (if any) is copied into this run's private recovery
#                         directory first, then the rollback content is
#                         written to a same-directory temporary file and
#                         `mv`d onto .env-orbit — an atomic same-filesystem
#                         rename, matching configuration.sh's own
#                         migrate_file() write pattern, rather than
#                         remove-then-copy. Any failure self-restores
#                         .env-orbit from the recovery-directory backup and
#                         reports `failed`, leaving the rollback copy in
#                         place for a future retry. On success the rollback
#                         copy is removed and the action is reported `done`.
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
# directory for the whole `--execute` run (`.orbit-repair-recovery.*`,
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
# This section covers the SAFE-BATCH confirmation only (`--safe-only`,
# stage one). The dangerous batch (`--dangerous`, stage two) has its own,
# stricter, never-automatable approval model — see "EXECUTE MODE (--execute
# --dangerous)" below; the two batches are independent (each is offered and
# confirmed on its own, regardless of the other's outcome, when both flags
# are given together).
#
# When at least one safe-set action is planned AND `--safe-only` was given,
# this script decides how to gain approval in this fixed priority order:
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
#      deployment completely unmutated: every planned SAFE-BATCH action is
#      reported `skipped` (a dangerous-class entry present in the same plan
#      is never reported by this safe-batch logic at all — see below).
#   3. Neither of the above, i.e. genuinely non-interactive: this is the
#      automation contract for the safe batch specifically. `--safe-only`
#      being set is what opts into this unattended path; no confirmation is
#      shown or required, and execution proceeds straight to the `execute`
#      lines below. This bypass applies ONLY to the safe batch — it never
#      applies to the dangerous batch (see "EXECUTE MODE (--execute
#      --dangerous)" below), which is refused outright when genuinely
#      non-interactive, regardless of `--dangerous` being set.
#
# `ORBIT_REPAIR_TTY_INPUT=1` is a test-only escape hatch, mirroring
# install.sh/configure.sh's own `ORBIT_CONFIGURE_TTY_INPUT` precedent: it
# forces the interactive confirmation path even though the test harness's
# stdin is a pipe rather than a real terminal, so the decline/EOF/accept
# behavior of the human-facing prompt can be exercised without a pty. It
# applies identically to the dangerous batch's own interactive prompts below.
#
# A plan entry whose action class is `rotate-database-credential` is NEVER
# handled by the safe-batch logic in this section: when `--dangerous` is
# set, it is deferred entirely to the dangerous batch below (never printed
# as `skipped` here, even on an empty plan/safe_count or a decline); when
# `--dangerous` is NOT set, it is printed `skipped` by the safe-batch logic
# exactly as before this slice (unchanged, existing behavior).
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
#   6  refused — a deployment-version-unsupported finding is present
#      (ADR-0016, #681), so the ENTIRE execution is refused before any
#      batch runs: nothing is executed, nothing is mutated, and the run
#      prints `execution result=refused done=0 failed=0
#      reason=deployment-version-unsupported` (plus the matching
#      `dangerous result=refused ...` line when --dangerous was requested)
#      followed by the unchanged diagnosis. This is the same exit code the
#      dangerous batch's own refusal uses — 6 uniformly means "refused,
#      unmutated" whichever gate refused.
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
# every path this script touches during execution are never printed, on
# STDOUT, in any line, under any mode — the enum-only stdout discipline that
# governs `--check`/`--plan` holds identically under `--execute`. The one
# deliberate exception is the dangerous batch's own checkpoint bundle path,
# which is printed as human guidance on STDERR — see "EXECUTE MODE
# (--execute --dangerous)" below.

# ============================================================================
# EXECUTE MODE (--execute --dangerous) — issue #261 SLICE 5, STAGE TWO
# ============================================================================
#
# `--execute --dangerous` runs the identical diagnosis and planning
# `--execute --safe-only` does, and additionally makes the two stage-two
# action classes — `rotate-database-credential` and (#530 slice, ADR-0014
# decision 5) `regenerate-secret` — executable, subject to the approval
# model below. It may be combined with `--safe-only` in the same invocation
# (each batch is independently planned, approved and executed; see
# "Confirmation model" above for how the two batches coexist) or used on its
# own. `rotate-database-credential` resolves database-credential-mismatch,
# volume-retained-without-credentials, and (per the exception in the
# action-class table above) a postgres-password secret-missing finding
# paired with a retained database volume. `regenerate-secret` resolves every
# OTHER secret-missing finding — session-secret, oidc-client-secret, and
# postgres-password/document-kek when their own retained-volume guard is NOT
# present — see that table for the full rationale of both. Every plan entry
# resolving to `rotate-database-credential` is coalesced into ONE execution
# instance (mirroring `restart-services`'s own once-per-run
# `service_restart_result` dedup above): the credential is rotated at most
# once per `--execute` run, and every matching plan entry reports the same
# shared outcome. `regenerate-secret` runs once PER DISTINCT missing-secret
# target (a broken deployment can have more than one secret missing at
# once); see "Step iterator" below for how the two classes are sequenced
# together when a single run's dangerous batch contains both.
#
# Never automatable — this is the entire point of stage two
# --------------------------------------------------------------------------
# There is NO flag, environment variable, or flag combination that lets the
# dangerous batch run unattended. Approval requires either a real
# interactive controlling terminal (or the test-only
# `ORBIT_REPAIR_TTY_INPUT=1` escape hatch) or `ORBIT_REPAIR_PROMPTS=machine`
# (a programmatic caller that answers prompts one line at a time — still an
# explicit, synchronous approval exchange, not a bypass). Under any other
# invocation — no controlling terminal, `ORBIT_REPAIR_PROMPTS` unset/not
# `machine`, including under `--safe-only`'s own non-interactive automation
# bypass described above — the dangerous batch is refused outright with
# `dangerous result=refused ... reason=non-interactive` and exit code 6,
# before any prompt is shown, before the checkpoint step, before anything is
# touched. This is a structural refusal, not a declined confirmation: no
# prompt is ever printed in this path (there is nothing to answer).
#
# Approval model — typed action word (owner decision, 2026-08-13; extended
# to regenerate-secret in the #530 slice, ADR-0014 decision 5)
# --------------------------------------------------------------------------
# Unlike the safe batch's `y`/`Y` confirmation, the dangerous batch requires
# the operator to TYPE THE LITERAL ACTION WORD for the class being confirmed
# — `rotate` for rotate-database-credential, `regenerate` for
# regenerate-secret — a non-standard input specifically so muscle-memory
# Enter, a blank line, or any other text can never fire either. The plan
# preview for the dangerous batch (the same
# `plan action=... resolves=... mutation=... backup=...` line grammar
# --plan uses, on stdout, enum-only, covering every deferred entry
# regardless of class) is printed first. Then, for EACH distinct dangerous
# action class actually present in this run's dangerous batch, in turn
# (rotate-database-credential before regenerate-secret when a single run
# happens to contain both — see confirm_dangerous_action/execute_dangerous_
# batch): the operator confirms that class's own word before this script
# moves to the next one; refusing any one of them refuses the WHOLE
# dangerous batch (nothing has mutated yet either way).
#
#   - Interactively: `Orbit repair: type '<word>' to proceed (anything else
#     cancels): ` is printed to stderr (not an enum) and one answer line is
#     read from stdin. An exact match proceeds; a blank Enter, any other
#     text, or EOF re-prompts, up to 3 attempts total; the 3rd rejected
#     attempt (or an EOF at any attempt) refuses with
#     `dangerous result=refused ... reason=refused-by-operator` and exit 6.
#   - Under `ORBIT_REPAIR_PROMPTS=machine`: the repair-specific
#     `field=action-word kind=typed-word` prompt (see "Machine prompts"
#     below) is emitted instead, with the same exact-word acceptance rule
#     and the same 3-attempt bound (re-emitted, attempt reset to 1, for a
#     second class's own word when a run's dangerous batch spans both).
#
# Passphrase — the checkpoint, in the existing ORBKEK01 format (owner
# decision, 2026-08-13; no new formats)
# --------------------------------------------------------------------------
# Once the typed action word is accepted, and BEFORE any database-touching
# step, this script checkpoints the current `postgres-password` secret (if
# one currently exists as a regular, mode-600 file whose content is a valid
# 64-hex-character secret — the exact format `openssl rand -hex 32`
# generates and `configure.sh`'s own `ensure_secret_file` enforces, matching
# the `document-kek` format the existing ORBKEK01 machinery already targets;
# when no such secret currently exists there is nothing to preserve, and the
# checkpoint step is a documented no-op — see `do_checkpoint_step` — that
# does not itself prompt for a passphrase). The checkpoint is a
# passphrase-encrypted ORBKEK01 envelope (scrypt + AES-256-GCM,
# `scripts/recovery-crypto.mjs`/`src/lib/recovery-bundle.ts`'s `encrypt`,
# issue #296 slice 1) — the exact same format and code path
# `export-recovery-bundle.sh` already uses for the document KEK, reused
# HERE unmodified rather than reimplemented in shell: this script (bash) has
# no crypto primitives of its own and never adds any. Because
# `--entrypoint` overrides the container's normal entrypoint (which would
# otherwise copy secrets into `/run/orbit-secrets`), the source is read from
# the raw Compose secret mount `/run/secrets/orbit-postgres-password` —
# exactly the path `export-recovery-bundle.sh` reads `orbit-document-kek`
# from — via:
#
#   printf '%s' "$checkpoint_passphrase" |
#     docker compose --project-name "$project" --env-file "$environment_file" \
#       run --rm --no-deps -T --entrypoint node orbit-app \
#       /opt/orbit/scripts/recovery-crypto.mjs encrypt \
#       /run/secrets/orbit-postgres-password > "$bundle_path"
#
# The passphrase travels ONLY over that child process's stdin — never its
# argv, never its environment — so it is not observable via `ps` or
# `/proc/<pid>/cmdline`/`/proc/<pid>/environ` for that process or this
# script's own. The passphrase is read into a `local`/script-scoped shell
# variable, is never `export`ed, is erased (reassigned to an empty string)
# immediately after the encrypt-and-verify exchange, and is never written to
# any file, printed, or logged. It is subject to the existing ≥12-character
# rule (`MIN_RECOVERY_PASSPHRASE_LENGTH` in recovery-bundle.ts /
# recovery-crypto.mjs) and is prompted for TWICE (entry + confirmation, both
# with input hidden via bash's `read -s`), matching
# `export-recovery-bundle.sh`'s own passphrase collection exactly.
#
# Checkpoint verification (BEFORE rotation touches anything)
# --------------------------------------------------------------------------
# Immediately after the encrypted bundle is written, this script decrypts it
# straight back (mirroring `import-recovery-bundle.sh`'s own
# bind-mount-and-decrypt pattern: `--volume
# "$repo_dir/$bundle_path:/recovery/postgres-password.enc:ro" --entrypoint
# node orbit-app .../recovery-crypto.mjs decrypt
# /recovery/postgres-password.enc`) using the same passphrase, and compares
# the recovered value byte-for-byte against the original secret content
# (never printed either side of the comparison). Only if that round-trip
# succeeds is the checkpoint considered established. If the bundle cannot be
# created, or verification fails for any reason (wrong passphrase captured
# by a transcription slip, a `docker`/`node` failure, a truncated write),
# the WHOLE dangerous batch is refused — `dangerous result=failed ...
# reason=checkpoint-failed`, exit 4 — and the database is never touched: no
# `ALTER ROLE`, no secret-file write, no restart. This is what "checkpoint
# created and verified BEFORE rotation touches anything" means concretely:
# the ordering is enforced by the step iterator below, where `checkpoint` is
# always the FIRST step and every later step is skipped entirely on its
# failure.
#
# Checkpoint storage — local-only, owner-only, kept until manually deleted
# --------------------------------------------------------------------------
# The bundle is written into a freshly created, mode-0700 directory
# (`.orbit-repair-checkpoint.XXXXXX`, a sibling naming convention to the
# existing `.orbit-repair-recovery.*`/`.orbit-install-staging.XXXXXX`
# prefixes, distinct so it is never mistaken for either by a later
# diagnosis) as a mode-0600 file. Unlike the stage-one private recovery
# directory (`cleanup_recovery_dir`, always removed at the end of every
# `--execute` run), the checkpoint directory is NEVER removed by this
# script — it is local-only, kept until the operator manually deletes it,
# per the owner's explicit "no ad-hoc download hosting from a broken box"
# decision (the recovered app's normal export/download flow is the intended
# way to get a copy off the machine, not this checkpoint). Its path is never
# printed on stdout (the enum-only contract holds); it IS printed as human
# guidance on stderr, both right after a successful checkpoint and again (if
# applicable) inside any later step-failure guidance — see "Any step
# failure" below.
#
# Step iterator: checkpoint -> rotate-credential -> update-config ->
# restart-services -> full re-diagnosis
# --------------------------------------------------------------------------
# See the "Stage-two dangerous-step iterator" note near RESERVED CLASSES
# above for why this is a table of independently callable steps rather than
# one function. The four steps, run straight through in this slice
# (`run_rotate_database_credential_steps`):
#
#   1. checkpoint         See above. The ONLY step that may legitimately be
#                          a no-op (no prior secret to preserve).
#   2. rotate-credential   Generates a fresh 64-hex-character credential
#                          (the same `openssl rand -hex 32` primitive
#                          `configure.sh`'s `generate_hex_secret` uses),
#                          stages it to a FIXED, predictable path
#                          (`$secrets_directory/.repair-staged-postgres-
#                          password`, mode 600) BEFORE touching the
#                          database — so if a later step fails, the new
#                          value is durably recoverable from a known path
#                          rather than lost with a discarded shell
#                          variable — then re-resolves this deployment's
#                          orbit-db container (the same Compose
#                          project/service-label ownership proof Step 10/11
#                          use, never trusting diagnosis-time state) and
#                          issues `ALTER ROLE "<user>" WITH PASSWORD
#                          '<new>'` over a LOCAL-SOCKET connection (no `-h`,
#                          exactly the trust-auth precondition the
#                          "Database credential handling" note above already
#                          documents) — so this step needs no prior
#                          knowledge of whichever password the database
#                          currently expects, which is exactly why it can
#                          repair a credential-mismatch OR a missing-secret
#                          deployment identically. The SQL text — including
#                          the fresh credential — is piped to `psql -f -`
#                          over stdin (`docker exec -i`, never `-c`/argv), so
#                          it is never observable via `ps` or
#                          `/proc/<pid>/cmdline` for either the `docker` or
#                          `psql` process, exactly like the checkpoint
#                          passphrase above; `-v ON_ERROR_STOP=1` is required
#                          alongside `-f` (unlike `-c`, script-mode psql does
#                          not fail its own exit code on a SQL error unless
#                          this is set). Neither the new value nor the ALTER
#                          ROLE statement is ever printed. Both interpolated
#                          values are restricted-charset by prior validation
#                          — `$rotate_pg_user` matches `^[A-Za-z0-9_]+$`
#                          (resolve_rotate_db_identity) and the credential is
#                          hex-only (charset `[0-9a-f]`, generate_hex_secret)
#                          — so building this literal SQL text is
#                          injection-safe regardless of the stdin delivery.
#   3. update-config       Re-verifies the secrets directory is still a
#                          real, non-symlink, mode-700 directory (the same
#                          TOCTOU re-check `fix-permissions` performs), then
#                          `mv`s the staged file from step 2 onto
#                          `$secrets_directory/postgres-password` — a
#                          same-directory rename, essentially always
#                          reliable once step 2 has already succeeded.
#   4. restart-services    Reuses the existing `do_restart_services` action
#                          implementation verbatim (restarts this
#                          deployment's orbit-app container so it picks up
#                          the rotated credential on its next connection).
#   5. full re-diagnosis   Not a "step" in the failure-stops-here sense
#                          above — this is the standard post-execution
#                          `--check`-format re-diagnosis (see "Output
#                          contract" below), which always runs at the very
#                          end of the `--execute` invocation regardless of
#                          how either batch concluded.
#
# regenerate-secret's own step model (#530 slice, ADR-0014 decision 5)
# --------------------------------------------------------------------------
# Simpler than the four-step rotate-database-credential iterator above:
# once approved, `do_regenerate_secret_step` runs once per distinct
# deferred missing-secret target (`run_regenerate_secret_steps`, straight
# through in Step 3's own scan order, stopping at the first failure). No
# checkpoint step exists or is needed — the finding only ever fires when
# the secret file is absent/empty (see backup=not-required's comment on
# backup_for_action), so there is no prior content to preserve. Each
# target's own step re-proves the secrets directory is still real,
# non-symlink, mode 700, and that the target itself is still genuinely
# missing (the same TOCTOU re-check `fix-permissions` performs), then
# writes the new secret exactly like `configure.sh`'s own
# `ensure_secret_file` (scripts/configure.sh:777-802): `mktemp`ped under
# the secrets directory (mode 600 from creation, before any content lands
# in it), content written, mode 600 set again defensively, then an atomic
# same-directory `mv` onto the live secret path — never a different
# discipline invented here. When this run's dangerous batch ALSO contains
# rotate-database-credential, regenerate-secret's targets run AFTER the
# rotate sequence completes successfully (see execute_dangerous_batch),
# never before and never if rotation itself failed.
#
# Any step failure: stop, guidance, stable non-zero exit
# --------------------------------------------------------------------------
# If ANY step in this run's combined ordered sequence fails — any of
# rotate-database-credential's own steps 1-4, or any regenerate-secret
# target's step — every later step, of either class, is never attempted:
# the iterator stops at the first failure. `dangerous_failure_reason` is set
# to `checkpoint-failed` (rotate step 1 only) or `step-failed` (every other
# failure, rotate or regenerate), and recovery guidance is printed to
# stderr: for a post-checkpoint rotate failure, the checkpoint bundle's path
# (decrypt with `docker compose ... run --rm --no-deps -T --entrypoint node
# orbit-app /opt/orbit/scripts/recovery-crypto.mjs decrypt
# <path-inside-container>` after bind-mounting it, exactly as this script
# itself does to verify it) is named so the pre-rotation credential can be
# recovered by hand; if the failure is at or after rotate step 3 (i.e. step
# 2 already staged a new credential), the staged file's fixed path is ALSO
# named, since the database may already be expecting that value. A
# regenerate-secret step failure needs no such guidance — `mktemp` + `mv` is
# all-or-nothing, so a failed target has written nothing recoverable or
# stale to point at. EVERY dangerous-class plan entry deferred to this run
# — including a regenerate-secret target never reached because rotation
# failed first, or vice versa — is then reported
# `execute action=<class> resolves=<reason-class> result=failed`, and the
# run's exit code is 4 — the identical exit code stage one's own `failed`
# terminal result uses, deliberately: `execution`'s exit-code vocabulary
# already means "at least one attempted mutation failed" and stage two does
# not need a second failure exit code, only its own `reason` enum (see
# "Output contract" below) to distinguish which kind of failure it was.
#
# Machine prompts (repair --execute --dangerous)
# --------------------------------------------------------------------------
# `ORBIT_REPAIR_PROMPTS=machine` extends the same #297 line grammar
# (docs/engine-events.md "Machine prompts (v0)") the safe batch already uses,
# adding three more repair-specific field/kind pairs, used only here:
#
#   prompt field=action-word kind=typed-word required=true attempt=<1..3>
#   prompt field=checkpoint-passphrase kind=secret required=true attempt=<1..3>
#   prompt field=checkpoint-passphrase-confirm kind=secret required=true attempt=<1..3>
#
# `action-word` accepts only the exact single-line answer for the class
# currently being confirmed (`rotate` or `regenerate` — see "Approval
# model" above); `reason=mismatch` on any other non-empty answer,
# `reason=empty` on a blank line. `checkpoint-passphrase` accepts any answer
# of at least
# `MIN_RECOVERY_PASSPHRASE_LENGTH` (12) characters; `reason=empty` for a
# blank line, `reason=too-short` otherwise. `checkpoint-passphrase-confirm`
# accepts only an answer identical to the just-accepted
# `checkpoint-passphrase` answer; `reason=mismatch` otherwise. Every field is
# bounded at 3 attempts, exactly like the existing `machine_prompt_collect`
# convention in `configure.sh`: a 3rd rejected answer (or EOF at any
# attempt) emits `prompt-abort field=<field>` instead of a 4th `prompt`, and
# refuses the dangerous batch (`reason=refused-by-operator`, exit 6) rather
# than a 4th prompt. No prompt line for any of these three fields ever
# carries the answer itself — only the fixed `field`/`kind`/`reason`/
# `attempt` vocabulary, exactly like the existing `safe-batch` field.
#
# Output contract (--execute --dangerous)
# --------------------------------------------------------------------------
# The dangerous batch adds exactly one new terminal line, printed once,
# after every `execute action=<rotate-database-credential|regenerate-secret>
# ...` line the dangerous batch itself produced (if any, covering both
# classes when a single run's dangerous batch contains both), and always
# after the safe batch's own `execution result=...` line when both batches
# ran:
#
#   dangerous result=<empty|complete|refused|failed> done=<n> failed=<n> reason=<none|non-interactive|refused-by-operator|checkpoint-failed|step-failed>
#
# `result=empty` (reason=none) — `--dangerous` was given but the plan
# contained no dangerous-class entry of either kind; no prompt is shown.
# `result=complete` (reason=none) — every approved dangerous-class entry's
# own mutation succeeded (the credential rotated, every deferred secret
# regenerated). `result=refused` — the approval gate itself was never fully
# passed for every class present (`reason=non-interactive` or
# `reason=refused-by-operator`); zero mutation occurred. `result=failed` —
# approval was granted but a step failed, of either class (`reason=
# checkpoint-failed` or `reason=step-failed`); see "Any step failure" above.
# Like every other line in this script, no path, configured value, or
# secret ever appears in this line or in any `execute action=... ...` line
# — enums only, exactly like `--check`/`--plan`/`--execute --safe-only`.
#
# EXIT CODES (--execute --dangerous)
# --------------------------------------------------------------------------
#   0  dangerous result is `empty` or `complete` (and, when `--safe-only` was
#      also given, the safe batch's own result is `empty`/`complete`/
#      `unactionable` too — see the existing EXIT CODES (--execute) table
#      above for that batch's own semantics).
#   1  the safe batch (only) was declined — identical meaning to the
#      existing `--safe-only` exit 1, unchanged; only reachable when
#      `--dangerous`'s own result is not itself `failed`.
#   4  a FAILURE occurred in either batch: the safe batch's own `failed`
#      result, OR the dangerous batch's `result=failed` (`reason=
#      checkpoint-failed`/`step-failed`) — a real failure always wins over a
#      mere refusal or decline in the exit code.
#   5  not-an-orbit-installation — identical trigger/meaning to every other
#      mode; forced before either batch is even attempted.
#   6  NEW — the dangerous batch's `result=refused`
#      (`reason=non-interactive`/`refused-by-operator`): the approval gate
#      was never passed, so nothing was mutated, but this is distinct from
#      exit 1 (an explicit, single y/N decline) because the dangerous
#      approval model has no single-shot decline — every refusal here is
#      either a structural non-interactive refusal or an exhausted bounded
#      retry.

# ============================================================================
# EXPORT MODE (--export-diagnostics) — issue #531, ADR-0014 decision 10
# ============================================================================
# Exports diagnostics for support: the exact `--check` line grammar (finding
# lines + the terminal `diagnosis` line) immediately followed by the exact
# `--plan` line grammar (plan lines + the terminal `plan` line) — byte-for-
# byte the same output those two modes would themselves print, produced by
# the same `print_check_lines`/`print_plan_lines` functions rather than a
# third reimplementation of either — plus exactly one further line:
#
#   identity schema_version=<value|unknown> applied_version=<value|unknown> image=<value|unknown>
#
# `schema_version`/`applied_version`/`image` are read directly from the live
# `.env-orbit` (never via `configure.sh`, per decision 2's source-less rule)
# and are ADR-0008 public, already-safe values: the configuration schema
# version, the applied configuration version, and the digest-pinned
# `ORBIT_IMAGE` reference. This is a bounded, deliberate exception to "no
# configured value ever reaches stdout" — exactly these three fields, and
# nothing else, ever. Each value is independently format-validated before
# being trusted (the same bounded patterns `check_application_container`
# already uses for `ORBIT_IMAGE`, mirrored rather than shared per decision 2);
# a missing or malformed value is rendered as the fixed placeholder `unknown`
# — the same convention docs/engine-events.md already uses for an
# unrecognised enum value — never the raw value, and never a shorter line.
# Allowlisting is inherited entirely from `--check`/`--plan`'s own enum-only
# output contract: this mode adds no second redaction layer that could drift
# from it.
#
# Preview, then confirm, then write — in that order, and only in that order.
# The full content above (identical for the terminal preview and the written
# file — assembled once, printed twice) is always printed to stdout first,
# regardless of confirmation channel. Confirmation then follows the same
# machine-prompt/interactive priority `confirm_safe_batch` already uses
# (`field=export-diagnostics kind=confirm`), with one deliberate difference:
# there is no non-interactive automation path. Decision 10 requires the
# content to be "explicitly confirmed before any file is written", so a run
# with no controlling terminal and no `ORBIT_REPAIR_PROMPTS=machine` opt-in
# declines — fail-closed — rather than guessing at consent. Declining (by
# either channel, or by reaching this fail-closed default) writes nothing at
# all: no `mktemp` call is ever made before confirmation succeeds, so a
# decline leaves no temporary file behind either.
#
# The write mirrors the discipline already in this script (see the checkpoint
# bundle and the config-rollback restore above): `mktemp` under the
# installation directory (mode 600 from creation), the full content written,
# mode 600 set again defensively, then an atomic same-directory rename onto a
# second, equally random `mktemp`-derived final name — so a reader can never
# observe a partially-written file at the path this run ultimately reports.
# That path is reported on stderr only, exactly like the checkpoint bundle
# path above — never on stdout. No encryption: these are public values under
# ADR-0008, and `recovery-crypto.mjs`/the recovery-bundle envelope are
# deliberately not reused here for a file that never carries a secret.
#
# EXIT CODES (--export-diagnostics)
# --------------------------------------------------------------------------
#   0  the file was written.
#   1  declined — an explicit interactive/machine-prompt "no", or no
#      confirmation channel was available at all (see above); zero mutation
#      either way.
#   2  usage error.
#   4  failed — the file could not be created/written (e.g. `mktemp`/`mv`
#      failure); zero mutation.
#   5  not-an-orbit-installation — identical trigger/meaning to every other
#      mode; the check/plan content is still printed (matching `--check`/
#      `--plan`'s own early-exit behavior), but no identity line, preview,
#      confirmation, or write is ever attempted.

usage() {
  printf 'Usage: %s (--check|--plan|--execute (--safe-only|--dangerous|--safe-only --dangerous)|--export-diagnostics) [--plain]\n' "$0" >&2
  printf 'Orbit repair: --execute requires --safe-only and/or --dangerous.\n' >&2
  printf 'Orbit repair: --safe-only executes the stage-one safe/reversible action set\n' >&2
  printf 'Orbit repair: (fix-permissions, restore-transaction, restart-services).\n' >&2
  printf 'Orbit repair: --dangerous executes the stage-two rotate-database-credential and\n' >&2
  printf 'Orbit repair: regenerate-secret actions, which always require interactive or\n' >&2
  printf 'Orbit repair: machine-prompt approval — there is no flag that runs either unattended.\n' >&2
  printf 'Orbit repair: --export-diagnostics previews, then requires explicit confirmation for,\n' >&2
  printf 'Orbit repair: writing the exact --check/--plan stream plus one identity line to a file.\n' >&2
}

plain_mode=0
safe_only=0
dangerous=0
mode=""
for arg in "$@"; do
  case "$arg" in
    --check|--plan|--execute|--export-diagnostics)
      # Exactly one of --check/--plan/--execute/--export-diagnostics is
      # accepted; a second (of any of the four) is a usage error rather
      # than a silent last-flag-wins override.
      [[ -z "$mode" ]] || {
        usage
        exit 2
      }
      mode="${arg#--}"
      ;;
    --plain) plain_mode=1 ;;
    --safe-only) safe_only=1 ;;
    --dangerous) dangerous=1 ;;
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
  [[ "$safe_only" == 1 || "$dangerous" == 1 ]] || {
    usage
    exit 2
  }
elif [[ "$safe_only" == 1 || "$dangerous" == 1 ]]; then
  # --safe-only/--dangerous are only meaningful alongside --execute.
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

# EXIT trap (Ctrl-C, SIGTERM, or any other abrupt termination during
# --execute). Unlike install.sh/restore.sh/backup.sh/configure.sh, whose
# trapped `cleanup` performs an actual rollback, this one performs cleanup
# ONLY, never a blind rollback: restore-transaction's authoritative backup
# (staging_root/rollback/original) is left untouched by every one of its own
# failure paths and is never routed through the private recovery directory
# alone (see "Private recovery directory" above), so a rerun of `--execute
# --safe-only`/`--dangerous` — not an automatic action taken here, with no
# visibility into which of several possibly-interrupted commands got how far
# — is always the correct next step. What this trap does:
#   - removes this run's own private recovery directory if one was opened,
#     so an interrupted run never leaves an orphaned mode-700 copy of live
#     secrets behind forever (the same removal cleanup_recovery_dir already
#     performs at the end of every normal run); its path is still never
#     printed, preserving the "Privacy" contract above;
#   - if rotate-database-credential's steps were in flight, prints the same
#     step-failure recovery guidance (checkpoint bundle location, and the
#     staged new-credential path once step 2 has run) the synchronous
#     failure path already prints, so an interrupted run is never silent.
# Defensive `${var:-...}` reads throughout: this trap can fire before any of
# these variables are assigned (e.g. a failure on the very next line), and
# must never itself fail under `set -u`.
cleanup() {
  local exit_status=$?

  if [[ -n "${recovery_dir:-}" ]]; then
    printf 'Orbit repair: interrupted before completion; this run left a private recovery copy in place, now removed. Re-run "repair.sh --plan" to see current state, then "--execute" again if repairs are still needed.\n' >&2
    cleanup_recovery_dir
  fi

  if [[ "${dangerous_batch_in_progress:-0}" == 1 ]]; then
    printf 'Orbit repair: interrupted during the dangerous batch'"'"'s credential rotation.\n' >&2
    if [[ -n "${checkpoint_bundle_path:-}" ]]; then
      printf 'Orbit repair: the pre-rotation credential remains recoverable from the checkpoint at %s\n' \
        "$checkpoint_bundle_path" >&2
      printf 'Orbit repair: (decrypt it with your checkpoint passphrase — see "EXECUTE MODE (--execute --dangerous)" in scripts/repair.sh for the exact command).\n' >&2
    fi
    if [[ -e "${staged_postgres_password_path:-/nonexistent}" ]]; then
      printf 'Orbit repair: a newly rotated credential is already staged at %s;\n' \
        "$staged_postgres_password_path" >&2
      printf 'Orbit repair: move it into place as %s/postgres-password if the database still accepts it.\n' \
        "${secrets_directory:-.orbit-secrets}" >&2
    fi
  fi

  exit "$exit_status"
}

trap cleanup EXIT

readonly environment_file=".env-orbit"
readonly compose_file="docker-compose.yml"
readonly secrets_directory=".orbit-secrets"
# configuration.sh's own rollback_suffix constant (scripts/configuration.sh
# line 9), duplicated here rather than sourced — see the top-of-file
# source-less rule. Only configuration.sh ever creates a file at this
# suffix (migrate_file(), non-transaction path), and only when the
# migration was NOT already running inside install's own transaction.
readonly configuration_rollback_suffix=".orbit-config.rollback"

# ADR-0016's supported-install floor, as comparable components. repair.sh is
# deliberately source-less, so the floor is mirrored here rather than shared
# — the authoritative statement is docs/adr/0016.
readonly supported_floor_major=1
readonly supported_floor_minor=3
readonly supported_floor_patch=0
readonly database_volume_key="orbit-db-data"
# ADR-0014 decision 5's second retention guard (document-kek): mirrors
# database_volume_key exactly, matched the same way against
# `${project}_orbit-documents-data` (see docker-compose.yml's own
# `orbit-documents-data` volume declaration).
readonly document_volume_key="orbit-documents-data"
readonly -a secret_names=(session-secret postgres-password document-kek oidc-client-secret)
readonly -a known_orbit_services=(orbit-app orbit-db orbit-clamav orbit-tika orbit-ollama)
readonly total_checks=18
readonly docker_probe_timeout=5s
readonly docker_restart_timeout=30s
readonly docker_rotate_timeout=30s
readonly docker_checkpoint_timeout=30s
readonly min_recovery_passphrase_length=12
# Fixed path a newly rotated postgres-password is staged to BEFORE the
# database is touched, and rename()d onto the live secret from — see
# "Step iterator" in the header's "EXECUTE MODE (--execute --dangerous)"
# section for why a fixed, predictable path (rather than a random mktemp
# name) is deliberate: it is nameable in step-failure recovery guidance.
readonly staged_postgres_password_path="$secrets_directory/.repair-staged-postgres-password"

# Stage-one safe set (issue #261, owner decision 2026-08-13). See "Safe set
# is a fixed allowlist" above for why this is not derived from the plan's
# own mutation= classification.
readonly -a safe_action_classes=(fix-permissions restore-transaction restart-services)

# Stage-two dangerous set (issue #261, owner decision 2026-08-13; joined by
# regenerate-secret in the #530 slice, ADR-0014 decision 5) — only ever
# executed under `--execute --dangerous`, subject to the typed-word/
# never-automatable approval model. See "EXECUTE MODE (--execute
# --dangerous)" above. Order here is the order confirm_dangerous_batch below
# asks for each class's own typed word (rotate before regenerate) when a
# single run's dangerous batch happens to contain both.
readonly -a dangerous_action_classes=(rotate-database-credential regenerate-secret)

# The step ITERATOR for rotate-database-credential — see the "Stage-two
# dangerous-step iterator" note near RESERVED CLASSES above and "Step
# iterator" in "EXECUTE MODE (--execute --dangerous)" for the full
# rationale. Each name is dispatched through dangerous_step_fn below by
# run_dangerous_step, which is independently callable per step.
readonly -a rotate_database_credential_steps=(checkpoint rotate-credential update-config restart-services)

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
  scripts/repair.sh
  scripts/engine-check.sh
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
  configuration-migration-interrupted
  deployment-version-unsupported
  staging-evidence-present
  compose-interpolation-failed
  docker-unavailable
  container-foreign-owner
  volume-retained-without-credentials
  document-volume-retained-without-key
  unrelated-resource-present
  database-unreachable
  database-credential-mismatch
  stale-container
  image-identity-mismatch
  application-unhealthy
  database-schema-mismatch
  database-below-floor
  migration-failed
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
  # ADR-0014 decision 7: a deterministically recoverable interrupted
  # configuration.sh migration — the live file fails validation AND its
  # `.orbit-config.rollback` copy exists, is a regular non-symlink file, and
  # itself passes validation — reuses the same restore-transaction action as
  # the install-transaction boundary, rather than only telling the operator
  # to re-run configure.sh (rerun-configuration, above).
  [configuration-migration-interrupted]=restore-transaction
  [staging-evidence-present]=restore-transaction
  [volume-retained-without-credentials]=rotate-database-credential
  # ADR-0014 decision 5's second retention guard. Unlike the database case
  # immediately above, there is no rotate equivalent for document-kek — a
  # retained document volume was encrypted under whatever key it already
  # holds, and there is no local-socket-trust operation analogous to
  # `ALTER ROLE` that can re-derive access to it. The honest outcome is
  # manual: an operator decision (restore the original key, or knowingly
  # accept the retained documents are unreadable), never a guess.
  [document-volume-retained-without-key]=manual
  [database-credential-mismatch]=rotate-database-credential
  [stale-container]=restart-services
  [application-unhealthy]=restart-services
  # Both sides of a schema disagreement survive a restart, so restart-services
  # would loop forever (#437). These need an operator decision: attach the
  # matching database, or upgrade from a supported version.
  [database-schema-mismatch]=manual
  [database-below-floor]=manual
  # A failed, rolled-back migration leaves no applied row and no safe
  # automatic remedy: the migrator's own idempotent retry already happens on
  # any restart (issue #528 decision), so repair must not invent a competing
  # path. ADR-0004's recovery point is the operator's actual rollback
  # boundary.
  [migration-failed]=manual
  # A mismatched running image is not restart-services (that would leave the
  # same wrong image running); recreating a container from a different image
  # is outside repair's safe, reversible action set.
  [image-identity-mismatch]=manual
  # ADR-0016: a deployment installed by a release below the supported floor
  # is not a supported repair target. Nothing here is executable — and
  # execute_repair additionally refuses the ENTIRE batch when this finding
  # is present, because running even the safe executors against a pre-floor
  # layout would mutate files this script was never proven against.
  [deployment-version-unsupported]=manual
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

# Action class -> backup requirement for --plan. regenerate-secret's
# backup=not-required is only defensible because it is never planned where
# it could invalidate retained state: the postgres-password/database-volume
# guard (resolve_secret_missing_action) and the document-kek/document-volume
# guard (also resolve_secret_missing_action, ADR-0014 decision 5) are what
# make "no valid prior content exists to lose" true for every finding that
# ever reaches this action. If either guard were ever weakened or removed,
# this field would become wrong at the same moment.
readonly -A backup_for_action=(
  [restore-transaction]=required
  [fix-permissions]=not-required
  [regenerate-secret]=not-required
  [rotate-database-credential]=required
  [restart-services]=not-required
  [rerun-configuration]=not-required
  [manual]=not-required
)

# Action class -> named rollback point for the plan line (criterion 6, #681).
# Enum-only like every other plan field: the name says where the undo lives,
# never a path.
#   recovery-directory     the private mode-700 recovery copy taken before
#                          the action mutates anything (ensure_recovery_dir)
#   credential-checkpoint  the verified checkpoint bundle stage two creates
#                          before rotating (see EXECUTE MODE, stage two)
#   prior-mode             the action is a mode change; the undo is the mode
#                          the file had before
#   not-required           the action leaves nothing to roll back —
#                          regenerate-secret belongs here for the same
#                          reason its backup is not-required (see
#                          backup_for_action's comment above)
readonly -A rollback_for_action=(
  [restore-transaction]=recovery-directory
  [fix-permissions]=prior-mode
  [regenerate-secret]=not-required
  [rotate-database-credential]=credential-checkpoint
  [restart-services]=not-required
  [rerun-configuration]=not-required
  [manual]=not-required
)

# Action class -> expected result for the plan line (criterion 6, #681):
# what the deployment looks like if the action succeeds, as an enum.
readonly -A expected_for_action=(
  [restore-transaction]=files-restored
  [fix-permissions]=permissions-safe
  [regenerate-secret]=secret-recreated
  [rotate-database-credential]=authentication-restored
  [restart-services]=services-healthy
  [rerun-configuration]=configuration-valid
  [manual]=operator-action
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
  # Neither side of a schema disagreement moves on its own (#437): point this
  # build at the database it expects, or point this database at a build that
  # still recognises its migration history. repair never merges or migrates
  # a database on the operator's behalf.
  [database-schema-mismatch]="attach the database this build's migrations expect, or restore this deployment to the build that matches the current database, before starting either again"
  [database-below-floor]="this database predates the oldest migration history this build supports; restore it from a backup made by a supported version, or run that version's upgrade path first, before pointing this build at it"
  # ADR-0004's recovery point is the actual rollback boundary here; repair
  # itself never applies, retries, or reverses a migration.
  [migration-failed]="restore this deployment from the pre-update recovery point captured before the migration ran, per the supported-upgrade recovery contract"
  [image-identity-mismatch]="recreate the flagged container from the locally pinned image so its running image identity matches; repair never recreates a container on the operator's behalf"
  [deployment-version-unsupported]="this deployment was installed by a release below the supported floor (docs/adr/0016); reinstall or upgrade it with a supported release before running repair here"
  [document-volume-retained-without-key]="a document volume is retained for this deployment while document-kek is missing; restore the original key from backup, or knowingly accept the retained documents are unreadable, before creating a new key"
  # Keyed by the reason class (secret-missing), not by target, like every
  # other entry here — but this one only ever fires for one specific target:
  # resolve_secret_missing_action resolves secret-missing to `manual` ONLY
  # for document-kek when document-volume-retained-without-key is also
  # present (mirroring the postgres-password/rotate-database-credential
  # exception, which never reaches `manual` at all). Every other secret-
  # missing finding resolves to regenerate-secret or rotate-database-
  # credential, never manual, so this entry is unambiguous despite the
  # generic key.
  [secret-missing]="the missing document-kek cannot be safely regenerated while a document volume is retained; restore the original key from backup, or knowingly accept the retained documents are unreadable, before creating a new key"
)

declare -a findings=()
declare -A secret_status=()
checked=0
diagnosis_early=0

# issue #528: true once a migration-failed finding has been added by either
# detection channel (the primary app-log sentinel scan, or the SQL backstop
# sequenced after it), so the second channel never adds one for the same run.
# $migration_backstop_* carry the database coordinates from Step 11
# (check_database_reachability) to the backstop, which runs after Step 12's
# sentinel scan; they are set only once the authenticated SELECT 1 probe has
# succeeded, so empty means "no authenticated path — the backstop must skip".
# $app_identity_* are set by check_application_container so Step 13
# (check_image_identity) can tell "no eligible container" from "not yet run".
migration_failed_reported=0
migration_backstop_db_id=""
# The container the authenticated probe drew its credential from, and the
# program it used, so the backstop reuses that identical path (#632).
migration_backstop_reader_id=""
migration_backstop_reader_script=""
migration_backstop_pg_user=""
migration_backstop_pg_db=""
app_identity_container_id=""
app_identity_pinned_image=""

# execute-mode state (unused under --check/--plan).
declare -a plan_entries=()
plan_actions_count=0
plan_manual_count=0
recovery_dir=""
declare -A service_restart_result=()

# dangerous-batch state (--execute --dangerous only; unused otherwise).
# $dangerous_batch_in_progress is read by the EXIT trap (see "cleanup" above
# the argument-parsing block) to know whether an abrupt termination happened
# while rotate-database-credential's steps were in flight.
dangerous_batch_in_progress=0
safe_batch_exit_code=0
dangerous_exit_code=0
dangerous_failure_reason=none
checkpoint_bundle_path=""
checkpoint_passphrase=""
rotate_pg_user=""
rotate_pg_db=""
rotate_db_id=""

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

# --- configuration-migration-interrupted (ADR-0014 decision 7) -------------
#
# repair.sh validates the live .env-orbit by running `bash scripts/
# configure.sh --check` as a subprocess (Step 5 below) rather than
# reimplementing configure.sh's readiness rules. `configure.sh --check-
# rollback` is the identical subprocess pattern pointed at configuration.sh's
# own `.orbit-config.rollback` copy instead: no path is ever passed on the
# command line (configure.sh derives the checked filename itself from its
# own hardcoded `.env-orbit` + rollback-suffix constants, at its own
# conventional cwd — see configure.sh's own top-of-file comment), so this
# never introduces untrusted path input, and every other input
# (.orbit-secrets included) still resolves to the real installation
# directory exactly like plain --check. An earlier revision of this function
# ran a hand-staged copy of configure.sh under $TMPDIR instead; that staging
# area deliberately omitted .orbit-secrets to avoid duplicating secret
# material, which made the isolated check silently unable to pass for the
# file-backed OIDC_CLIENT_SECRET_FILE shape install.sh always produces — the
# class could never fire on a normally-installed deployment. --check-
# rollback avoids the entire problem: there is no second directory, so
# nothing needs to be reproduced in it.
configuration_migration_rollback_recoverable() {
  local rollback_path="${environment_file}${configuration_rollback_suffix}"
  is_regular_non_symlink_file "$rollback_path" || return 1
  has_mode "$rollback_path" 600 || return 1
  is_regular_non_symlink_file scripts/configure.sh || return 1
  local status=0
  bash scripts/configure.sh --check-rollback >/dev/null 2>/dev/null || status=$?
  [[ "$status" == 0 ]]
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
# generated non-user secret regenerates safely, EXCEPT
#   - postgres-password when a volume-retained-without-credentials finding
#     is also present in this same diagnosis (the #261 fixed-project
#     collision) — that specific finding must route to
#     rotate-database-credential instead, so a retained-volume postgres
#     password is never auto-regenerated.
#   - document-kek when a document-volume-retained-without-key finding is
#     also present (ADR-0014 decision 5's second retention guard) — there is
#     no rotate equivalent for a document volume, so the honest outcome is
#     `manual` rather than a guessed fix.
# See the "regenerate-secret" / "rotate-database-credential" entries in the
# header's action-class mapping table for the full rationale. Relies on
# bash's dynamic scoping: every caller declares its own local
# `volume_retained_without_credentials` and `document_volume_retained`
# before calling this.
resolve_secret_missing_action() {
  local target="$1"
  if [[ "$target" == postgres-password && "$volume_retained_without_credentials" == 1 ]]; then
    printf 'rotate-database-credential'
  elif [[ "$target" == document-kek && "$document_volume_retained" == 1 ]]; then
    printf 'manual'
  else
    printf 'regenerate-secret'
  fi
}

# Prints the --plan line grammar (plan lines + the terminal plan line)
# without exiting, and records the plan result into $plan_result. Used both
# by --plan itself and by --export-diagnostics, which must include this
# exact byte-for-byte stream (same function, not a third reimplementation)
# in its exported content — see "EXPORT MODE (--export-diagnostics)" above.
print_plan_lines() {
  local class entry fclass ftarget fseverity action
  local actions=0 manual=0
  local volume_retained_without_credentials=0
  local document_volume_retained=0

  for entry in "${findings[@]:-}"; do
    [[ -n "$entry" ]] || continue
    IFS='|' read -r fclass ftarget fseverity <<< "$entry"
    [[ "$fclass" == volume-retained-without-credentials ]] && volume_retained_without_credentials=1
    [[ "$fclass" == document-volume-retained-without-key ]] && document_volume_retained=1
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

      printf 'plan action=%s resolves=%s mutation=%s backup=%s target=%s rollback=%s expect=%s\n' \
        "$action" "$fclass" "${mutation_for_action[$action]}" "${backup_for_action[$action]}" \
        "$ftarget" "${rollback_for_action[$action]}" "${expected_for_action[$action]}"

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
    plan_result=ready
  elif [[ "$manual" -gt 0 ]]; then
    plan_result="manual-required"
  else
    plan_result=empty
  fi
  printf 'plan result=%s actions=%s manual=%s\n' "$plan_result" "$actions" "$manual"
}

print_plan_output_and_exit() {
  local forced_exit="$1"
  print_plan_lines

  if [[ "$forced_exit" == early ]]; then
    exit 5
  fi
  case "$plan_result" in
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
  local document_volume_retained=0
  plan_entries=()
  plan_actions_count=0
  plan_manual_count=0

  for entry in "${findings[@]:-}"; do
    [[ -n "$entry" ]] || continue
    IFS='|' read -r fclass ftarget fseverity <<< "$entry"
    [[ "$fclass" == volume-retained-without-credentials ]] && volume_retained_without_credentials=1
    [[ "$fclass" == document-volume-retained-without-key ]] && document_volume_retained=1
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

is_dangerous_action() {
  local candidate="$1" known
  for known in "${dangerous_action_classes[@]}"; do
    [[ "$known" == "$candidate" ]] && return 0
  done
  return 1
}

# True only when this plan entry's action is dangerous-class AND
# `--dangerous` was requested — i.e. the safe-batch logic must defer it
# entirely to the dangerous batch rather than reporting it `skipped` itself.
# See "Confirmation model" above for the full rationale.
is_dangerous_deferred() {
  [[ "$dangerous" == 1 ]] && is_dangerous_action "$1"
}

# The confirmation preview: the same `plan ...` line grammar --plan itself
# prints, derived from the already-computed $plan_entries. Enum-only,
# printed to stdout ahead of the confirmation exchange.
print_plan_preview() {
  local entry action fclass ftarget
  for entry in "${plan_entries[@]:-}"; do
    [[ -n "$entry" ]] || continue
    IFS='|' read -r action fclass ftarget <<< "$entry"
    printf 'plan action=%s resolves=%s mutation=%s backup=%s target=%s rollback=%s expect=%s\n' \
      "$action" "$fclass" "${mutation_for_action[$action]}" "${backup_for_action[$action]}" \
      "$ftarget" "${rollback_for_action[$action]}" "${expected_for_action[$action]}"
  done
}

# Same line grammar as print_plan_preview above, but over an explicit list
# of "action|resolves|target" entries rather than the whole of
# $plan_entries — used by the dangerous batch to preview only its own
# (deferred) entries, never the safe batch's.
print_entries_preview() {
  local entry action fclass ftarget
  for entry in "$@"; do
    IFS='|' read -r action fclass ftarget <<< "$entry"
    printf 'plan action=%s resolves=%s mutation=%s backup=%s target=%s rollback=%s expect=%s\n' \
      "$action" "$fclass" "${mutation_for_action[$action]}" "${backup_for_action[$action]}" \
      "$ftarget" "${rollback_for_action[$action]}" "${expected_for_action[$action]}"
  done
}

ensure_recovery_dir() {
  [[ -n "$recovery_dir" ]] && return 0
  # The name is assigned BEFORE the directory exists, never after. The old
  # shape — recovery_dir="$(mktemp -d ...)" — had a window #655 caught on CI:
  # a fatal signal landing while the command substitution is in flight kills
  # this shell after mktemp has created the directory but before the
  # assignment completes, so the EXIT trap finds $recovery_dir empty and the
  # mode-700 copy of live secrets is orphaned. With the name assigned first,
  # every interruption point leaves the trap knowing exactly what to remove:
  # before mkdir there is nothing to remove and `rm -rf` of a missing path is
  # a no-op; from mkdir onwards the directory is removable by name. mkdir
  # itself refuses an existing path (symlinks included), so a predictable
  # name cannot be redirected the way a reused one could; a collision just
  # burns one attempt.
  local attempt
  for attempt in 1 2 3; do
    recovery_dir="./.orbit-repair-recovery.$$.${RANDOM}${RANDOM}"
    mkdir -m 700 -- "$recovery_dir" 2>/dev/null && return 0
  done
  recovery_dir=""
  return 1
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
  #     missing .env-orbit.example template) — UNLESS a recoverable
  #     `.orbit-config.rollback` copy is present (see
  #     configuration_migration_rollback_recoverable above), in which case
  #     configuration-migration-interrupted (ADR-0014 decision 7) replaces
  #     it: exactly one configuration finding is ever recorded per run.
  configuration_finding=0
  if is_regular_non_symlink_file scripts/configure.sh; then
    checked=$((checked + 1))
    configure_check_stderr="$(mktemp "${TMPDIR:-/tmp}/orbit-repair-configure-check.XXXXXX")"
    configure_check_status=0
    bash scripts/configure.sh --check >/dev/null 2>"$configure_check_stderr" || configure_check_status=$?
    configure_check_had_stderr=0
    [[ -s "$configure_check_stderr" ]] && configure_check_had_stderr=1
    rm -f -- "$configure_check_stderr"
    if [[ "$configure_check_status" != 0 ]]; then
      configuration_finding=1
      if configuration_migration_rollback_recoverable; then
        add_finding configuration-migration-interrupted configuration fail
      elif [[ "$configure_check_had_stderr" == 1 ]]; then
        add_finding configuration-invalid configuration fail
      else
        add_finding configuration-incomplete configuration fail
      fi
    fi
  fi

  # --- Step 5b: deployment version vs the supported-install floor (ADR-0016) -
  #
  # ORBIT_CONFIG_APPLIED_VERSION is written by configuration.sh on every
  # supported install, so its absence from a readable .env-orbit is not a
  # gap to shrug at: it is the signature of a deployment installed before
  # the floor existed (a v1.0.0-era install carries no configuration.sh at
  # all), or of a hand-assembled file this script has no business mutating.
  # Both refuse — fail closed. Major version 0 is the development era
  # (working-tree and CI builds stamp v0.0.0) and is exempt: it is not a
  # published release, and ADR-0016's floor is about published releases.
  # When .env-orbit itself is untrustworthy (missing, symlink, wrong mode)
  # this check is skipped rather than failed: those states are findings of
  # their own, fixing them is exactly what repair is for, and the version
  # re-evaluates on the next run once the file can be believed. The same
  # skip applies while a configuration finding is present this run: an
  # interrupted or invalid configuration means the live file's content is
  # not believable either — a half-written .env-orbit legitimately lacks
  # the version key, and refusing here would block the very restore
  # (ADR-0014 decision 7) that makes the file believable again.
  if [[ "$env_status" == ok && "$configuration_finding" == 0 ]]; then
    checked=$((checked + 1))
    applied_version="$(read_environment_value ORBIT_CONFIG_APPLIED_VERSION 2>/dev/null || true)"
    version_supported=0
    if [[ "$applied_version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
      version_major="${BASH_REMATCH[1]}"
      version_minor="${BASH_REMATCH[2]}"
      version_patch="${BASH_REMATCH[3]}"
      if ((version_major == 0)); then
        version_supported=1
      elif ((version_major > supported_floor_major)); then
        version_supported=1
      elif ((version_major == supported_floor_major && version_minor > supported_floor_minor)); then
        version_supported=1
      elif ((version_major == supported_floor_major && version_minor == supported_floor_minor && version_patch >= supported_floor_patch)); then
        version_supported=1
      fi
    fi
    [[ "$version_supported" == 1 ]] || add_finding deployment-version-unsupported deployment fail
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

  # --- Step 9b: retained document volume vs. document-kek (ADR-0014 decision
  # 5's second retention guard) ------------------------------------------------
  #
  # Identical shape to Step 9 immediately above, against
  # $document_volume_key/document-kek instead of
  # $database_volume_key/postgres-password: a volume-name match plus the
  # local absence of the document-kek secret file. Never opens a database
  # connection, never execs into a container, never reads a document or a
  # secret's contents — this is exactly as read-only as Step 9, and exists
  # so a `document-kek` regeneration can never be planned while a document
  # volume encrypted under the OLD (possibly now-unrecoverable) key is still
  # retained — see resolve_secret_missing_action.

  if [[ "$resource_check_eligible" == 1 ]]; then
    if [[ "$docker_available" == 1 ]]; then
      checked=$((checked + 1))
      volume_list="$(timeout "$docker_probe_timeout" docker volume ls \
        --filter "name=$document_volume_key" --format '{{.Name}}' 2>/dev/null || true)"
      our_volume="${project}_${document_volume_key}"
      found_ours=0
      found_other=0
      while IFS= read -r volume || [[ -n "$volume" ]]; do
        [[ -z "$volume" ]] && continue
        [[ "$volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ && "$volume" =~ (^|_)orbit-documents-data$ ]] || continue
        if [[ "$volume" == "$our_volume" ]]; then
          found_ours=1
        else
          found_other=1
        fi
      done <<< "$volume_list"
      [[ "$found_other" == 1 ]] && add_finding unrelated-resource-present document-volume info
      if [[ "$found_ours" == 1 ]]; then
        if [[ "$secrets_status" != ok || "${secret_status[document-kek]:-missing}" == missing ]]; then
          add_finding document-volume-retained-without-key document-volume fail
        fi
      fi
    else
      add_finding docker-unavailable document-volume info
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
  # execs into the container nor touches the registry.
  if [[ "$resource_check_eligible" == 1 ]]; then
    if [[ "$docker_available" == 1 ]]; then
      checked=$((checked + 1))
      check_application_container
    else
      add_finding docker-unavailable application info
    fi
  fi

  # --- migration-failed SQL backstop (issue #528) ----------------------------
  #
  # Deliberately sequenced AFTER Step 12: the bounded app-log sentinel scan
  # inside check_application_container is the PRIMARY migration-failed
  # channel, and this backstop's one fixed-literal SELECT runs only when that
  # scan reported nothing — because the logs rotated the sentinel away, or
  # because the container is gone entirely (check_application_container
  # returns early with no scan at all in that case). Internally guarded to a
  # no-op unless Step 11's authenticated SELECT 1 probe already succeeded
  # ($migration_backstop_* empty otherwise), so it widens nothing on the
  # common path and never runs unauthenticated. Part of Step 11's database
  # check rather than a counted step of its own.
  check_migration_failed_backstop

  # --- Step 13: application container image IDENTITY (issue #528) -----------
  #
  # Distinct from Step 12's stale-container comparison, which only compares
  # the `Config.Image` reference string. This compares content-addressable
  # image IDs: the running container's actual `docker inspect .Image` against
  # `docker image inspect <pinned ORBIT_IMAGE>`'s `.Id` for the
  # already-digest-validated pinned reference — entirely local reads, no
  # registry call. Set by check_application_container above
  # ($app_identity_container_id / $app_identity_pinned_image); only
  # meaningful once that check has run, so this step is always sequenced
  # after it.
  if [[ "$resource_check_eligible" == 1 ]]; then
    if [[ "$docker_available" == 1 ]]; then
      checked=$((checked + 1))
      check_image_identity
    else
      add_finding docker-unavailable image info
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
  local psql_output="" psql_status=0

  if [[ "$env_status" == ok ]]; then
    candidate="$(read_environment_value POSTGRES_USER 2>/dev/null || true)"
    [[ "$candidate" =~ ^[A-Za-z0-9_]+$ ]] && pg_user="$candidate"
    candidate="$(read_environment_value POSTGRES_DB 2>/dev/null || true)"
    [[ "$candidate" =~ ^[A-Za-z0-9_]+$ ]] && pg_db="$candidate"
  fi

  db_ids="$(timeout "$docker_probe_timeout" docker ps -a \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$db_service_host" \
    --format '{{.ID}}' 2>/dev/null || true)"
  db_id=""
  if [[ -n "$db_ids" && "$db_ids" != *$'\n'* && "$db_ids" =~ ^[0-9a-f]{12,64}$ ]]; then
    db_id="$db_ids"
  fi

  if [[ -z "$db_id" ]] || ! timeout "$docker_probe_timeout" docker exec "$db_id" \
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

  # The application container holds the credential under test (#632). Resolve
  # it here rather than depending on check_application_container's ordering:
  # this step must not become sensitive to where it sits in the diagnosis.
  local app_probe_ids app_probe_id=""
  app_probe_ids="$(timeout "$docker_probe_timeout" docker ps -a \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=orbit-app" \
    --format '{{.ID}}' 2>/dev/null || true)"
  if [[ -n "$app_probe_ids" && "$app_probe_ids" != *$'\n'* && "$app_probe_ids" =~ ^[0-9a-f]{12,64}$ ]]; then
    app_probe_id="$app_probe_ids"
  fi
  # Which container the credential comes from, and whether the result may
  # raise a finding. With an application container that can name its own
  # secret file, the credential under test is the one it presents, and a
  # failure IS a credential mismatch. Without one there is no application
  # credential to be wrong -- so the database's own copy is used purely to
  # reach the database for the migration backstop, and never classified.
  local reader_id="$app_probe_id" reader_script="$app_credential_reader"
  local classify_credentials=1
  # shellcheck disable=SC2016  # expanded by the container's shell, not this one
  if [[ -z "$app_probe_id" ]] || ! timeout "$docker_probe_timeout" docker exec "$app_probe_id" \
    sh -c 'f="${POSTGRES_PASSWORD_FILE:-}"; [ -n "$f" ] && [ -r "$f" ]' >/dev/null 2>&1; then
    reader_id="$db_id"
    reader_script="$db_credential_reader"
    classify_credentials=0
  fi

  # The credential crosses from one container to the other as bytes in a pipe.
  # No host process holds it: not argv, not an environment variable, not a
  # shell variable (#610's property, kept). The pipeline's exit status is
  # psql's, which is the one being classified below.
  psql_output="$( { timeout "$docker_probe_timeout" docker exec "$reader_id" \
      sh -c "$reader_script" sh \
    | timeout "$docker_probe_timeout" docker exec -i "$db_id" \
      sh -c "$authenticated_probe" sh "$db_service_host" "$pg_user" "$pg_db"; } 2>&1)" || psql_status=$?
  # The container could not tell us which file holds the password, so there
  # is nothing to authenticate with and nothing to report: no finding, rather
  # than a guess dressed up as one.
  [[ "$psql_status" != "$PROBE_NO_SECRET_STATUS" ]] || { psql_output=""; return 0; }
  # A probe that borrowed the database's own copy proves nothing about the
  # application's credential, so it may record coordinates but never a finding.
  if [[ "$classify_credentials" == 0 && "$psql_status" != 0 ]]; then
    psql_output=""
    return 0
  fi
  if [[ "$psql_status" != 0 ]]; then
    if [[ "${psql_output,,}" == *"password authentication failed"* ]]; then
      add_finding database-credential-mismatch database fail
    else
      add_finding database-unreachable database fail
    fi
  else
    # Authenticated probe succeeded: record the coordinates the
    # migration-failed SQL backstop would need. The backstop itself is
    # deliberately NOT run here — the primary channel is Step 12's app-log
    # sentinel scan, and check_migration_failed_backstop is sequenced after
    # it in run_diagnosis so the SQL only ever runs when that scan
    # found nothing (rotated logs, or the container removed entirely).
    migration_backstop_db_id="$db_id"
    migration_backstop_reader_id="$reader_id"
    migration_backstop_reader_script="$reader_script"
    migration_backstop_pg_user="$pg_user"
    migration_backstop_pg_db="$pg_db"
  fi
  psql_output=""
}

# The two programs the database probes run *inside* the database container,
# and the two properties they are built around (#610).
#
#   1. They connect to the compose service name, never to 127.0.0.1. The
#      official Postgres image ships a pg_hba.conf that trusts loopback
#      outright:
#
#        host all all 127.0.0.1/32  trust
#        host all all all           scram-sha-256
#
#      so a loopback connection is accepted whatever password is supplied,
#      and the probe that exists to detect a wrong password could never
#      detect one. The service name is the same network identity the
#      application uses and lands on the scram-sha-256 rule instead. SCRAM is
#      challenge-response, so the password itself never crosses the wire.
#
#   2. They test the credential the APPLICATION is actually using, read from
#      inside the application container and piped straight into psql inside
#      the database container. No process on the host ever holds it — not in
#      argv, not in an environment variable, and not in a shell variable
#      either; it exists only as bytes in a pipe between two containers.
#
#      Reading it from the DATABASE container instead was wrong, and wrong in
#      both directions (#629, #632). That container's copy is a bind mount of
#      the secret file's inode, frozen at its last start, and Postgres itself
#      stops caring the moment initdb has run — it authenticates from its own
#      catalogue afterwards. So after any replacement of the secret file the
#      database container's copy is neither what Orbit is configured with nor
#      what the database checks against. It reported a successful rotation as
#      failed (#629) and, worse, reported a deployment whose application could
#      not authenticate at all as merely unhealthy (#632).
#
#      The application container's copy is the one that matters, because it is
#      definitionally the credential the running application presents. It is
#      taken from $POSTGRES_PASSWORD_FILE inside that container — the runtime
#      copy container-entrypoint.sh makes, not the mount — so a container that
#      has not restarted is tested on what it is really using, which is the
#      truth this check exists to establish.
#
#      A deployment where that file cannot be read exits PROBE_NO_SECRET_STATUS,
#      which the callers treat as "cannot classify" and report nothing.
#
# The user, database and host are positional arguments, never interpolated
# into the shell text, and both queries stay fixed literals.
# The compose service name of the database: both the label this script
# discovers the container by and the host its probes dial. One name, so
# the two cannot drift apart.
readonly db_service_host="orbit-db"
readonly PROBE_NO_SECRET_STATUS=97
# Run in the APPLICATION container: emits the credential that container is
# actually using, and nothing else. Read-only, no network, no database.
# shellcheck disable=SC2016  # expanded by the container's shell, not this one
readonly app_credential_reader='
  secret_file="${POSTGRES_PASSWORD_FILE:-}"
  [ -n "$secret_file" ] && [ -r "$secret_file" ] || exit 97
  exec cat -- "$secret_file"
'
# Run in the DATABASE container: its own mounted copy of the secret. This is
# NOT a valid source for judging the application's credential (#629, #632) and
# is never used for that. It exists only so the migration-failed backstop can
# still reach the database when there is no application container to borrow a
# credential from -- the case that backstop was written for. A finding is never
# raised from a probe that used it.
# shellcheck disable=SC2016  # expanded by the container's shell, not this one
readonly db_credential_reader='
  secret_file="${POSTGRES_PASSWORD_FILE:-}"
  [ -n "$secret_file" ] && [ -r "$secret_file" ] || exit 97
  exec cat -- "$secret_file"
'
# Run in the DATABASE container, with that credential arriving on stdin. The
# assignment is a command substitution rather than a variable the shell keeps:
# `$(cat)` also strips the secret file's trailing newline, which a password
# must not carry.
# shellcheck disable=SC2016  # expanded by the container's shell, not this one
readonly authenticated_probe='
  PGPASSWORD="$(cat)"
  [ -n "$PGPASSWORD" ] || exit 97
  export PGPASSWORD
  exec psql -h "$1" -U "$2" -d "$3" -c "SELECT 1"
'
# shellcheck disable=SC2016  # expanded by the container's shell, not this one
readonly migration_backstop_probe='
  PGPASSWORD="$(cat)"
  [ -n "$PGPASSWORD" ] || exit 97
  export PGPASSWORD
  exec psql -h "$1" -U "$2" -d "$3" -t -A -F"|" \
    -c "SELECT \"outcome\", \"reason\" FROM \"drizzle\".\"orbit_migration_runs\" ORDER BY \"id\" DESC LIMIT 1"
'

# migration-failed backstop (issue #528 decision, 2026-08-23 comment): the
# SECONDARY channel, called from run_diagnosis after Step 12's app-log
# sentinel scan (the primary channel) and skipping itself whenever that scan
# already reported ($migration_failed_reported). It exists for the two cases
# the scan cannot answer: the sentinel rotated out of the bounded log window,
# or the container removed entirely. Reads its database coordinates from
# $migration_backstop_*, which Step 11 (check_database_reachability) sets
# only once the authenticated SELECT 1 probe has succeeded — so this runs
# strictly over that identical already-authenticated connection path, no new
# docker verb, no new exec target, never unauthenticated. Exactly one
# additional fixed-literal query, byte for byte, zero interpolation: reads
# the migrator's own outcome bookkeeping row (never a journal comparison this
# script would have to interpret). The response is untrusted: bounded to 256
# bytes and accepted only if it matches a strict `[a-z_]{1,32}` enum shape
# for both columns; a missing table, a database error, or any other
# non-matching byte sequence is treated identically — skip, never guess.
check_migration_failed_backstop() {
  local mig_output=""
  local -r mig_pattern='^([a-z_]{1,32})\|([a-z_]{0,32})$'

  [[ "$migration_failed_reported" == 0 ]] || return 0
  [[ -n "$migration_backstop_db_id" ]] || return 0
  [[ -n "$migration_backstop_reader_id" ]] || return 0
  [[ "${secret_status[postgres-password]:-missing}" == ok ]] || return 0

  # Same two containers, same pipe, same credential as the SELECT 1 that
  # already succeeded — no new exec target and no new way to obtain a secret.
  mig_output="$(
    { timeout "$docker_probe_timeout" docker exec "$migration_backstop_reader_id" \
      sh -c "$migration_backstop_reader_script" sh \
    | timeout "$docker_probe_timeout" docker exec -i "$migration_backstop_db_id" \
      sh -c "$migration_backstop_probe" sh "$db_service_host" \
      "$migration_backstop_pg_user" "$migration_backstop_pg_db" \
      2>&1 || true; } | head -c 256
  )"

  [[ "$mig_output" =~ $mig_pattern ]] || return 0
  if [[ "${BASH_REMATCH[1]}" == failed ]]; then
    add_finding migration-failed database fail
    migration_failed_reported=1
  fi
}

check_application_container() {
  local app_ids app_id pinned_image=""
  local inspect_output="" actual_image="" health_status="" extra=""

  if [[ "$env_status" == ok ]]; then
    pinned_image="$(read_environment_value ORBIT_IMAGE 2>/dev/null || true)"
    [[ "$pinned_image" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]] || pinned_image=""
  fi
  # Recorded globally for Step 13 (check_image_identity) regardless of how
  # this function returns below — see its declaration near $findings.
  app_identity_pinned_image="$pinned_image"

  app_ids="$(timeout "$docker_probe_timeout" docker ps -a \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=orbit-app" \
    --format '{{.ID}}' 2>/dev/null || true)"
  app_id=""
  if [[ -n "$app_ids" && "$app_ids" != *$'\n'* && "$app_ids" =~ ^[0-9a-f]{12,64}$ ]]; then
    app_id="$app_ids"
  fi
  app_identity_container_id="$app_id"
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
    # An unhealthy container that refused to start over its database says so in
    # its own operational log. Report that precisely rather than as a generic
    # unhealthy app, because the two have different remedies and only one of
    # them is "restart" (#437). Read-only: docker logs mutates nothing.
    local app_log=""
    app_log="$(timeout "$docker_probe_timeout" docker logs --tail 50 "$app_id" 2>&1 || true)"
    if [[ "$app_log" == *"reason=database_mismatch"* ]]; then
      add_finding database-schema-mismatch application fail
    elif [[ "$app_log" == *"reason=database_below_floor"* ]]; then
      add_finding database-below-floor application fail
    elif [[ "$app_log" == *"reason=migration_failed"* ]]; then
      # issue #528: the migrator's own wrapper (src/instrumentation-node.ts)
      # writes this sentinel before the crash-looping/exited container's
      # process exits, exactly like the two #437 sentinels above — same
      # bounded `docker logs` read, same fixed-token match, no new docker
      # verb. Primary migration-failed detection path: the SQL backstop
      # (check_migration_failed_backstop, for the rotated-logs/no-container
      # cases) runs only after this scan, and skips itself entirely once
      # $migration_failed_reported is set here — so when this sentinel
      # matches, the backstop query is never issued at all.
      if [[ "$migration_failed_reported" == 0 ]]; then
        add_finding migration-failed application fail
        migration_failed_reported=1
      fi
    else
      add_finding application-unhealthy application fail
    fi
  fi
}

# Step 13 (issue #528): compares content-addressable image IDs, distinct from
# Step 12's stale-container comparison (Config.Image reference string only).
# Reads $app_identity_pinned_image / $app_identity_container_id, both set by
# check_application_container above (empty when ORBIT_IMAGE isn't
# digest-pinned, or when no app container was found) — this function never
# re-derives them itself, so it never issues a second `docker ps -a` probe.
# Every early exit is skip-only: an absent pinned image, an absent container,
# a locally-absent pinned image, or any malformed probe output all mean
# "nothing safe to compare", never a guessed mismatch.
check_image_identity() {
  local running_image_id="" pinned_image_id=""
  local -r image_id_pattern='^sha256:[0-9a-f]{64}$'

  [[ -n "$app_identity_pinned_image" && -n "$app_identity_container_id" ]] || return 0

  pinned_image_id="$(timeout "$docker_probe_timeout" docker image inspect \
    --format '{{.Id}}' "$app_identity_pinned_image" 2>/dev/null || true)"
  # The pinned reference's image is not present in this host's local image
  # store (e.g. never pulled, or pruned) — skip, never guess.
  [[ "$pinned_image_id" =~ $image_id_pattern ]] || return 0

  running_image_id="$(timeout "$docker_probe_timeout" docker inspect \
    --format '{{.Image}}' "$app_identity_container_id" 2>/dev/null || true)"
  [[ "$running_image_id" =~ $image_id_pattern ]] || return 0

  [[ "$running_image_id" == "$pinned_image_id" ]] || add_finding image-identity-mismatch image fail
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

  # install.sh writes $staging_root/committed the moment its own transaction
  # commits (immediately before the long image-pull/health-wait phase — see
  # its own comment there). A staging directory bearing that marker was left
  # behind by an install that already succeeded, not an interrupted one, so
  # restoring from it would silently revert a completed update/rotation back
  # to the pre-update files (issue #383 finding 2). Refuse loudly instead of
  # guessing: this is exactly the kind of leftover a human operator must
  # look at, not something this script may ever act on automatically.
  if [[ -e "$staging_root/committed" ]]; then
    printf 'Orbit repair: refusing restore-transaction; %s is marked committed by a completed install.\n' \
      "$staging_root" >&2
    printf 'Orbit repair: this staging directory was left behind after installation already succeeded; restoring from it would revert that update. Remove it manually once you have confirmed the current deployment is correct.\n' >&2
    return 1
  fi

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

# --- restore-transaction (configuration-migration-interrupted boundary) -----
#
# ADR-0014 decision 7: extends restore-transaction to a second, unrelated
# boundary — configuration.sh's own `.orbit-config.rollback` copy — rather
# than adding a new action class. A separate function, not a branch inside
# do_restore_transaction above, because the two boundaries share nothing
# beyond the action-class name: this one restores exactly one fixed literal
# path (never anything enumerated from disk), and configuration.sh's own
# migrate_file() already wrote the rollback content, so there is no staging
# tree to walk.
#
# Discipline mirrors do_restore_transaction exactly: re-verify (TOCTOU-safe)
# immediately before touching anything; refuse a symlinked parent directory
# on either side and a symlinked rollback file; back up the current live
# .env-orbit into this run's private recovery directory before it is
# touched; on any failure report failed, leaving both .env-orbit and the
# rollback copy exactly as they were for a future retry; on full success,
# remove the rollback copy (mirroring do_restore_transaction's own
# staging-directory removal) and report done.
#
# Unlike do_restore_transaction's remove-then-cp replacement, this action
# writes the new content to a same-directory temporary file first and
# renames it onto .env-orbit — an atomic same-filesystem rename, matching
# configuration.sh's own migrate_file() write pattern, so .env-orbit is
# never observably absent or partially written.
do_restore_configuration_rollback() {
  local rollback_path="${environment_file}${configuration_rollback_suffix}"
  local parent staged

  is_regular_non_symlink_file "$rollback_path" || return 1
  has_mode "$rollback_path" 600 || return 1

  parent="$(dirname -- "$environment_file")"
  [[ "$parent" == "." || ! -L "$parent" ]] || return 1
  parent="$(dirname -- "$rollback_path")"
  [[ "$parent" == "." || ! -L "$parent" ]] || return 1

  ensure_recovery_dir || return 1

  if [[ -e "$environment_file" || -L "$environment_file" ]]; then
    mkdir -p -- "$(dirname -- "$recovery_dir/live/$environment_file")" || return 1
    cp -a -- "$environment_file" "$recovery_dir/live/$environment_file" || return 1
  fi

  # No branch below calls restore_transaction_self_restore, deliberately.
  # None of them can have changed .env-orbit: the new content is assembled in
  # a separate temporary file, and the only write to .env-orbit is a
  # same-filesystem rename, which either succeeds or leaves the target
  # exactly as it was. Self-restoring an untouched path is not free — that
  # helper removes the path first and then copies the backup back, swallowing
  # a failure of the copy — so calling it here could delete a file this
  # action never modified. The backup above is still taken: it is the
  # operator's evidence in the one case that does end with .env-orbit
  # changed and the action reporting failed, the rollback-copy removal below.
  staged="$(mktemp "${environment_file}.repair-restore.XXXXXX" 2>/dev/null)" || return 1
  if ! cp -- "$rollback_path" "$staged" 2>/dev/null || ! chmod 600 -- "$staged" 2>/dev/null; then
    rm -f -- "$staged"
    return 1
  fi
  if ! mv -f -- "$staged" "$environment_file" 2>/dev/null; then
    rm -f -- "$staged"
    return 1
  fi

  rm -f -- "$rollback_path" || return 1
  return 0
}

# --- restart-services --------------------------------------------------------
#
# Both finding classes this action resolves only ever target this
# deployment's orbit-app container (see check_application_container above),
# so the service name is fixed here; $1 is accepted only for call-site
# symmetry with the other do_* functions and documentation purposes.
do_restart_services() {
  restart_compose_service orbit-app
}

# Restarts one Compose service of this deployment by container id, memoised
# per service. Split out of do_restart_services so the rotation can also
# restart the database (see do_restart_services_after_rotation, #629);
# do_restart_services keeps its own contract unchanged.
restart_compose_service() {
  local service="$1"
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

# --- stage two: rotate-database-credential (--execute --dangerous) ---------
#
# See "EXECUTE MODE (--execute --dangerous)" in the header for the full
# design rationale this section implements.

# Mirrors configure.sh's own generate_hex_secret exactly (same primitive,
# same fallback, same format check) — repair.sh is deliberately
# standalone/source-less (see the top-of-file header note) so this is a
# same-shape reimplementation, not a shared function.
generate_hex_secret() {
  local secret=""

  if command -v openssl >/dev/null 2>&1; then
    secret="$(openssl rand -hex 32)" || secret=""
  elif [[ -r /dev/urandom ]] && command -v od >/dev/null 2>&1; then
    secret="$(od -An -N32 -tx1 /dev/urandom | tr -d '[:space:]')" || secret=""
  fi

  [[ "$secret" =~ ^[0-9a-fA-F]{64}$ ]] || return 1
  printf '%s' "${secret,,}"
}

# Re-resolves this deployment's orbit-db container id and its configured
# POSTGRES_USER/POSTGRES_DB, exactly like check_database_reachability above
# (deliberately re-implemented rather than shared — see that function's own
# "never trusting diagnosis-time state" precedent for restart-services).
# Sets globals $rotate_pg_user/$rotate_pg_db/$rotate_db_id ($rotate_db_id is
# empty when no single unambiguous container was found).
resolve_rotate_db_identity() {
  local candidate db_ids
  rotate_pg_user=orbit
  rotate_pg_db=orbit
  rotate_db_id=""

  if [[ "$env_status" == ok ]]; then
    candidate="$(read_environment_value POSTGRES_USER 2>/dev/null || true)"
    [[ "$candidate" =~ ^[A-Za-z0-9_]+$ ]] && rotate_pg_user="$candidate"
    candidate="$(read_environment_value POSTGRES_DB 2>/dev/null || true)"
    [[ "$candidate" =~ ^[A-Za-z0-9_]+$ ]] && rotate_pg_db="$candidate"
  fi

  db_ids="$(timeout "$docker_probe_timeout" docker ps -a \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$db_service_host" \
    --format '{{.ID}}' 2>/dev/null || true)"
  if [[ -n "$db_ids" && "$db_ids" != *$'\n'* && "$db_ids" =~ ^[0-9a-f]{12,64}$ ]]; then
    rotate_db_id="$db_ids"
  fi
}

# Invokes the ORBKEK01 CLI (issue #296 slice 1's scripts/recovery-crypto.mjs,
# reused unmodified) inside a one-off orbit-app container, exactly like
# export-recovery-bundle.sh does for the document KEK — see "Passphrase —
# the checkpoint" above for the full rationale, including why the passphrase
# only ever travels over this child's stdin.
checkpoint_encrypt_postgres_password() {
  local out_path="$1"
  printf '%s' "$checkpoint_passphrase" | timeout "$docker_checkpoint_timeout" \
    docker compose --project-name "$project" --env-file "$environment_file" \
    run --rm --no-deps -T --entrypoint node orbit-app \
    /opt/orbit/scripts/recovery-crypto.mjs encrypt /run/secrets/orbit-postgres-password \
    > "$out_path" 2>/dev/null
}

# Mirrors import-recovery-bundle.sh's own bind-mount-and-decrypt pattern.
# Prints the recovered 64-hex-character value on stdout (the caller alone is
# responsible for never printing it onward) or nothing on failure.
checkpoint_decrypt_verify() {
  local bundle_path="$1"
  printf '%s' "$checkpoint_passphrase" | timeout "$docker_checkpoint_timeout" \
    docker compose --project-name "$project" --env-file "$environment_file" \
    run --rm --no-deps -T \
    --volume "$repo_dir/$bundle_path:/recovery/postgres-password.enc:ro" \
    --entrypoint node orbit-app \
    /opt/orbit/scripts/recovery-crypto.mjs decrypt /recovery/postgres-password.enc 2>/dev/null
}

validate_checkpoint_passphrase() {
  [[ "${#1}" -ge "$min_recovery_passphrase_length" ]] && printf '%s' "$1"
}

classify_checkpoint_passphrase_rejection() {
  if [[ -z "$1" ]]; then printf 'empty'; else printf 'too-short'; fi
}

# Collects and confirms the checkpoint passphrase (bounded at 3 attempts per
# field, matching configure.sh's own machine_prompt_collect convention).
# Sets the global $checkpoint_passphrase on success (0); leaves it empty and
# returns 1 on refusal/EOF. Never prints the passphrase itself, in either
# mode.
prompt_checkpoint_passphrase() {
  checkpoint_passphrase=""
  local attempt input value=""

  if [[ "$machine_prompts" == 1 ]]; then
    attempt=1
    while ((attempt <= 3)); do
      printf 'prompt field=checkpoint-passphrase kind=secret required=true attempt=%d\n' "$attempt"
      if ! IFS= read -r input; then
        printf 'prompt-abort field=checkpoint-passphrase\n'
        return 1
      fi
      if value="$(validate_checkpoint_passphrase "$input")"; then
        printf 'prompt-accept field=checkpoint-passphrase\n'
        input=""
        break
      fi
      printf 'prompt-reject field=checkpoint-passphrase reason=%s\n' "$(classify_checkpoint_passphrase_rejection "$input")"
      input=""
      attempt=$((attempt + 1))
      if ((attempt > 3)); then
        printf 'prompt-abort field=checkpoint-passphrase\n'
        return 1
      fi
    done

    attempt=1
    while ((attempt <= 3)); do
      printf 'prompt field=checkpoint-passphrase-confirm kind=secret required=true attempt=%d\n' "$attempt"
      if ! IFS= read -r input; then
        printf 'prompt-abort field=checkpoint-passphrase-confirm\n'
        value=""
        return 1
      fi
      if [[ "$input" == "$value" ]]; then
        printf 'prompt-accept field=checkpoint-passphrase-confirm\n'
        checkpoint_passphrase="$value"
        input=""
        value=""
        return 0
      fi
      printf 'prompt-reject field=checkpoint-passphrase-confirm reason=mismatch\n'
      input=""
      attempt=$((attempt + 1))
      if ((attempt > 3)); then
        printf 'prompt-abort field=checkpoint-passphrase-confirm\n'
        value=""
        return 1
      fi
    done
  fi

  if [[ "$interactive" == 1 ]]; then
    attempt=1
    while ((attempt <= 3)); do
      printf 'Orbit repair: checkpoint passphrase (at least %d characters, input hidden): ' \
        "$min_recovery_passphrase_length" >&2
      if ! IFS= read -r -s input; then
        printf '\n' >&2
        printf 'Orbit repair: no passphrase received; refusing to rotate the database credential.\n' >&2
        return 1
      fi
      printf '\n' >&2
      if value="$(validate_checkpoint_passphrase "$input")"; then
        input=""
        break
      fi
      input=""
      attempt=$((attempt + 1))
      if ((attempt > 3)); then
        printf 'Orbit repair: no valid passphrase received; refusing to rotate the database credential.\n' >&2
        return 1
      fi
      printf 'Orbit repair: passphrase must be at least %d characters; %d attempt(s) remaining.\n' \
        "$min_recovery_passphrase_length" "$((3 - attempt + 1))" >&2
    done

    attempt=1
    while ((attempt <= 3)); do
      printf 'Orbit repair: confirm checkpoint passphrase (input hidden): ' >&2
      if ! IFS= read -r -s input; then
        printf '\n' >&2
        printf 'Orbit repair: no confirmation received; refusing to rotate the database credential.\n' >&2
        value=""
        return 1
      fi
      printf '\n' >&2
      if [[ "$input" == "$value" ]]; then
        checkpoint_passphrase="$input"
        input=""
        value=""
        return 0
      fi
      input=""
      attempt=$((attempt + 1))
      if ((attempt > 3)); then
        printf 'Orbit repair: passphrases did not match; refusing to rotate the database credential.\n' >&2
        value=""
        return 1
      fi
      printf 'Orbit repair: passphrases did not match; %d attempt(s) remaining.\n' "$((3 - attempt + 1))" >&2
    done
  fi

  return 1
}

# Step 1 of the rotate-database-credential iterator. Returns 0 (checkpoint
# step satisfied — either verified-created, or legitimately nothing to
# preserve) or 1 (failed — the caller must stop before any database
# mutation). Sets $checkpoint_bundle_path (relative to $repo_dir) only when
# a bundle was actually created. See "Passphrase — the checkpoint" and
# "Checkpoint verification" above for the full rationale.
do_checkpoint_step() {
  checkpoint_bundle_path=""
  local secret_path="$secrets_directory/postgres-password"
  local original_hex="" recovered_hex="" checkpoint_dir="" bundle_path=""
  local verify_status=0

  if ! is_regular_non_symlink_file "$secret_path" || ! has_mode "$secret_path" 600; then
    printf 'Orbit repair: no existing postgres-password secret to preserve; proceeding without a content checkpoint.\n' >&2
    return 0
  fi
  original_hex="$(tr -d '\r\n' < "$secret_path" 2>/dev/null || true)"
  if [[ ! "$original_hex" =~ ^[0-9a-fA-F]{64}$ ]]; then
    printf 'Orbit repair: the current postgres-password secret is not in the expected format; proceeding without a content checkpoint.\n' >&2
    original_hex=""
    return 0
  fi

  if ! prompt_checkpoint_passphrase; then
    original_hex=""
    return 1
  fi

  checkpoint_dir="$(mktemp -d "./.orbit-repair-checkpoint.XXXXXX")" || {
    checkpoint_passphrase=""
    original_hex=""
    return 1
  }
  chmod 700 -- "$checkpoint_dir" || {
    checkpoint_passphrase=""
    original_hex=""
    rm -rf -- "$checkpoint_dir"
    return 1
  }

  bundle_path="$checkpoint_dir/postgres-password.orbkek"
  if ! checkpoint_encrypt_postgres_password "$bundle_path" || [[ ! -s "$bundle_path" ]]; then
    printf 'Orbit repair: could not create the pre-rotation checkpoint; refusing to rotate the database credential.\n' >&2
    checkpoint_passphrase=""
    original_hex=""
    rm -rf -- "$checkpoint_dir"
    return 1
  fi
  chmod 600 -- "$bundle_path" 2>/dev/null || true

  recovered_hex="$(checkpoint_decrypt_verify "$bundle_path")" || verify_status=$?
  if [[ "$verify_status" != 0 || "$recovered_hex" != "$original_hex" ]]; then
    printf 'Orbit repair: the pre-rotation checkpoint failed verification; refusing to rotate the database credential.\n' >&2
    checkpoint_passphrase=""
    original_hex=""
    recovered_hex=""
    rm -rf -- "$checkpoint_dir"
    return 1
  fi

  checkpoint_passphrase=""
  original_hex=""
  recovered_hex=""
  checkpoint_bundle_path="$bundle_path"
  printf 'Orbit repair: pre-rotation checkpoint created and verified at %s\n' "$checkpoint_dir" >&2
  printf 'Orbit repair: (passphrase-encrypted, ORBKEK01 format; keep the passphrase and this file — Orbit never stores the passphrase — until you have confirmed the rotation succeeded.)\n' >&2
  return 0
}

# Step 2. Generates a fresh credential, stages it to the FIXED
# $staged_postgres_password_path BEFORE touching the database (see "Step
# iterator" above for why), then rotates the database role over a
# local-socket (trust-auth) connection so no prior knowledge of the
# database's current password is ever required.
do_rotate_credential_step() {
  resolve_rotate_db_identity
  [[ -n "$rotate_db_id" ]] || return 1
  is_real_non_symlink_directory "$secrets_directory" || return 1
  has_mode "$secrets_directory" 700 || return 1

  local new_password="" status=0
  new_password="$(generate_hex_secret)" || return 1

  printf '%s\n' "$new_password" > "$staged_postgres_password_path" || {
    new_password=""
    return 1
  }
  chmod 600 -- "$staged_postgres_password_path" || {
    new_password=""
    rm -f -- "$staged_postgres_password_path"
    return 1
  }

  # Delivered over psql's stdin (`-f -`), never as a `-c`/argv value — see
  # "Step iterator" above for the full rationale, including why both
  # interpolated values are injection-safe by prior validation regardless.
  printf 'ALTER ROLE "%s" WITH PASSWORD '"'"'%s'"'"';\n' "$rotate_pg_user" "$new_password" |
    timeout "$docker_rotate_timeout" docker exec -i "$rotate_db_id" \
      psql -v ON_ERROR_STOP=1 -U "$rotate_pg_user" -d "$rotate_pg_db" -f - \
      >/dev/null 2>&1 || status=$?
  new_password=""
  [[ "$status" == 0 ]]
}

# Step 3. Same-directory rename of the staged credential onto the live
# secret — re-verifies the secrets directory immediately before acting,
# exactly like fix-permissions's own TOCTOU re-check.
do_update_config_step() {
  [[ -f "$staged_postgres_password_path" && ! -L "$staged_postgres_password_path" ]] || return 1
  is_real_non_symlink_directory "$secrets_directory" || return 1
  has_mode "$secrets_directory" 700 || return 1
  mv -- "$staged_postgres_password_path" "$secrets_directory/postgres-password"
}

# Step 4 of the rotation, and the reason it is not do_restart_services itself.
#
# update-config lands the new secret with `mktemp` + `mv` (:3113), which is
# what makes a half-written secret impossible -- and which necessarily gives
# the path a NEW inode. A Compose `file:` secret is a bind mount of an inode,
# not of a path, so any container that keeps running across that rename holds
# the old file indefinitely. A plain `docker restart` re-resolves it.
#
# Postgres itself does not care: it read that file once, at initdb, and
# authenticates from its own catalogue thereafter. Repair's credential probe
# does care, because it reads the file through the database container -- so
# without this the rotation would complete correctly and then be diagnosed as
# failed by the very check meant to confirm it (#629).
#
# The database restarts first, so the application comes back against a
# database that has already finished restarting. Both must succeed: a rotation
# that cannot be verified afterwards is not a rotation that can be reported
# done.
do_restart_services_after_rotation() {
  restart_compose_service orbit-db || return 1
  restart_compose_service orbit-app
}

# Step 4 reuses do_restart_services verbatim (it already ignores its own
# unused positional argument, and its target is unconditionally orbit-app —
# see that function above).

declare -A dangerous_step_fn=(
  [checkpoint]=do_checkpoint_step
  [rotate-credential]=do_rotate_credential_step
  [update-config]=do_update_config_step
  [restart-services]=do_restart_services_after_rotation
)

# Independently callable per step — see the "Stage-two dangerous-step
# iterator" note near RESERVED CLASSES above for why this indirection
# (rather than one monolithic function) is deliberate.
#
# restart-services is special-cased here: do_restart_services memoizes its
# result per service (issue #383 finding 1) so that two safe-batch findings
# resolving to the same restart don't restart the container twice in one
# run. But that memo must never survive into the dangerous batch's own
# restart-services step — if the safe batch already restarted orbit-app
# (e.g. for application-unhealthy) before rotate-database-credential's own
# step 4 runs, the memo would make step 4 a silent no-op and the container
# would never pick up the freshly rotated credential. Clearing it right
# before this dispatch guarantees the post-rotation restart always
# executes, regardless of what ran earlier in the same --execute call.
run_dangerous_step() {
  local step="$1" fn
  fn="${dangerous_step_fn[$step]:-}"
  [[ -n "$fn" ]] || return 1
  if [[ "$step" == restart-services ]]; then
    # Both services the rotation restarts (#629), for the same reason: a memo
    # left by anything earlier in this run would make the post-rotation
    # restart a silent no-op, and a container that never restarts keeps the
    # pre-rotation secret file.
    unset 'service_restart_result[orbit-db]'
    unset 'service_restart_result[orbit-app]'
  fi
  "$fn"
}

# The straight-through cadence over $rotate_database_credential_steps — see
# "Step iterator" above. Stops at the first failing step; sets
# $dangerous_failure_reason to checkpoint-failed (step 1) or step-failed
# (steps 2-4) and prints stderr recovery guidance referencing the checkpoint
# (and, once step 2 has run, the staged new-credential path) before
# returning 1.
run_rotate_database_credential_steps() {
  local step
  dangerous_failure_reason=none
  for step in "${rotate_database_credential_steps[@]}"; do
    if ! run_dangerous_step "$step"; then
      if [[ "$step" == checkpoint ]]; then
        dangerous_failure_reason="checkpoint-failed"
      else
        dangerous_failure_reason="step-failed"
        printf "Orbit repair: stage two step '%s' failed.\n" "$step" >&2
        if [[ -n "$checkpoint_bundle_path" ]]; then
          printf 'Orbit repair: the pre-rotation credential remains recoverable from the checkpoint at %s\n' \
            "$checkpoint_bundle_path" >&2
          printf 'Orbit repair: (decrypt it with your checkpoint passphrase — see "EXECUTE MODE (--execute --dangerous)" in scripts/repair.sh for the exact command).\n' >&2
        fi
        if [[ "$step" != rotate-credential && -e "$staged_postgres_password_path" ]]; then
          printf 'Orbit repair: a newly rotated credential is already staged at %s;\n' \
            "$staged_postgres_password_path" >&2
          printf 'Orbit repair: move it into place as %s/postgres-password if the database still accepts it.\n' \
            "$secrets_directory" >&2
        fi
      fi
      return 1
    fi
  done
  return 0
}

# Dangerous-batch step for regenerate-secret: mints a fresh secret for one
# target. Only ever reached for a target whose secret-missing finding
# resolved to regenerate-secret at diagnosis time — never postgres-password
# with a retained database volume, never document-kek with a retained
# document volume (resolve_secret_missing_action and its two EXCEPTIONs in
# the header route those to rotate-database-credential / manual instead).
#
# Ownership re-proof immediately before mutating (ADR-0014 decision 4),
# mirroring fix-permissions' own TOCTOU re-check: the secrets directory must
# still be real/non-symlink/mode 700, and the target must still be
# genuinely missing (absent, or present but empty — exactly Step 3's own
# secret-missing precondition) — this NEVER overwrites a secret that
# appeared in the confirmation gap.
#
# The write itself mirrors configure.sh's ensure_secret_file discipline
# (scripts/configure.sh:777-802) exactly, not a different one invented here:
# staged under the secrets directory via mktemp (which creates the file at
# mode 600 atomically, before any content is written), content written,
# mode 600 set again defensively, then an atomic same-directory rename onto
# the live secret path. No checkpoint step: the finding only ever fires when
# the secret file is absent/empty, so there is no valid prior content to
# preserve — see backup=not-required's own comment on backup_for_action.
do_regenerate_secret_step() {
  local target="$1"
  local path="$secrets_directory/$target"
  local new_secret="" tmp_path=""

  is_real_non_symlink_directory "$secrets_directory" || return 1
  has_mode "$secrets_directory" 700 || return 1
  if [[ -e "$path" ]]; then
    [[ ! -L "$path" && -f "$path" && ! -s "$path" ]] || return 1
  fi

  new_secret="$(generate_hex_secret)" || return 1
  tmp_path="$(mktemp "$secrets_directory/.installing.XXXXXX")" || {
    new_secret=""
    return 1
  }
  printf '%s\n' "$new_secret" > "$tmp_path" || {
    new_secret=""
    rm -f -- "$tmp_path"
    return 1
  }
  chmod 600 -- "$tmp_path" || {
    new_secret=""
    rm -f -- "$tmp_path"
    return 1
  }
  new_secret=""
  mv -- "$tmp_path" "$path"
}

# The straight-through cadence over every deferred regenerate-secret target,
# one do_regenerate_secret_step call per target, in the same order the
# targets were deferred (session-secret, postgres-password, document-kek,
# oidc-client-secret — Step 3's own scan order). Stops at the first failing
# target, exactly like run_rotate_database_credential_steps above (ADR-0014
# decision 8: "the iterator... stops at the first failed step; nothing
# later runs"). No checkpoint bundle to name in failure guidance here —
# unlike rotate-credential, a failed regenerate step has written nothing
# (mktemp + rename is all-or-nothing), so there is no half-applied state to
# recover, only a target that still needs a secret.
run_regenerate_secret_steps() {
  local target
  dangerous_failure_reason=none
  for target in "$@"; do
    if ! do_regenerate_secret_step "$target"; then
      dangerous_failure_reason="step-failed"
      printf "Orbit repair: stage two regenerate-secret step for '%s' failed.\n" "$target" >&2
      printf 'Orbit repair: no new secret material was written for this target; the deployment is unchanged here.\n' >&2
      return 1
    fi
  done
  return 0
}

# Approval gate for stage two: the operator must type the literal action
# word for the class(es) being confirmed — "rotate" for
# rotate-database-credential, "regenerate" for regenerate-secret (ADR-0014
# decision 5; see "Approval model" above and confirm_dangerous_batch below
# for how the two are sequenced when a single run's dangerous batch contains
# both). Bounded at 3 attempts. Returns 0 (typed correctly) or 1 (refused:
# wrong word on the final attempt, empty input, or EOF). The
# non-interactive/non-machine case is never routed here at all — see
# execute_dangerous_batch below.
confirm_dangerous_action() {
  local count="$1" word="$2" attempt answer remaining

  if [[ "$machine_prompts" == 1 ]]; then
    attempt=1
    while ((attempt <= 3)); do
      printf 'prompt field=action-word kind=typed-word required=true attempt=%d\n' "$attempt"
      if ! IFS= read -r answer; then
        printf 'prompt-abort field=action-word\n'
        return 1
      fi
      if [[ "$answer" == "$word" ]]; then
        printf 'prompt-accept field=action-word\n'
        return 0
      fi
      if [[ -z "$answer" ]]; then
        printf 'prompt-reject field=action-word reason=empty\n'
      else
        printf 'prompt-reject field=action-word reason=mismatch\n'
      fi
      attempt=$((attempt + 1))
    done
    printf 'prompt-abort field=action-word\n'
    return 1
  fi

  if [[ "$interactive" == 1 ]]; then
    printf 'Orbit repair: stage two — %d dangerous action(s) proposed above.\n' \
      "$count" >&2
    attempt=1
    while ((attempt <= 3)); do
      printf "Orbit repair: type '%s' to proceed (anything else cancels): " "$word" >&2
      if ! IFS= read -r answer; then
        printf 'Orbit repair: no confirmation received; refusing the dangerous action.\n' >&2
        return 1
      fi
      if [[ "$answer" == "$word" ]]; then
        return 0
      fi
      remaining=$((3 - attempt))
      if [[ "$remaining" -gt 0 ]]; then
        printf 'Orbit repair: confirmation did not match; %d attempt(s) remaining.\n' "$remaining" >&2
      fi
      attempt=$((attempt + 1))
    done
    printf 'Orbit repair: stage two confirmation not received; refusing the dangerous action.\n' >&2
    return 1
  fi

  return 1
}

# Phase 2 of --execute --dangerous. Called unconditionally after the safe
# batch (phase 1) has already run, regardless of that phase's own outcome —
# see "Confirmation model" above. Prints one `execute action=... result=...`
# line per deferred dangerous-class plan entry, then one terminal `dangerous
# result=... done=<n> failed=<n> reason=...` line. Sets $dangerous_exit_code
# for execute_repair to fold into the run's final exit code.
execute_dangerous_batch() {
  local entry action fclass ftarget
  local -a dangerous_entries=()
  dangerous_exit_code=0

  for entry in "${plan_entries[@]:-}"; do
    [[ -n "$entry" ]] || continue
    IFS='|' read -r action fclass ftarget <<< "$entry"
    is_dangerous_action "$action" && dangerous_entries+=("$entry")
  done

  if [[ "${#dangerous_entries[@]}" -eq 0 ]]; then
    printf 'dangerous result=empty done=0 failed=0 reason=none\n'
    return 0
  fi

  # Never automatable: refused outright, no prompt shown, whenever neither a
  # real approval channel is available — see "Never automatable" above.
  if [[ "$machine_prompts" != 1 && "$interactive" != 1 ]]; then
    for entry in "${dangerous_entries[@]}"; do
      IFS='|' read -r action fclass ftarget <<< "$entry"
      printf 'execute action=%s resolves=%s result=skipped\n' "$action" "$fclass"
    done
    printf 'dangerous result=refused done=0 failed=0 reason=non-interactive\n'
    dangerous_exit_code=6
    return 0
  fi

  print_entries_preview "${dangerous_entries[@]}"

  # ADR-0014 decision 5: each dangerous action class keeps its own typed
  # word. When a single run's dangerous batch spans both classes (e.g. a
  # retained database volume alongside an unrelated missing session-secret),
  # each is confirmed in turn, in dangerous_action_classes order — a single
  # yes must never cover both a credential rotation and live secret minting,
  # the same principle the ADR already applies between the safe and
  # dangerous batches (see "Alternatives rejected"). Refusing either word
  # refuses the WHOLE dangerous batch; nothing has mutated yet at this
  # point, for either class.
  local has_rotate=0 has_regenerate=0 rotate_count=0 regenerate_count=0
  local -a regenerate_targets=()
  for entry in "${dangerous_entries[@]}"; do
    IFS='|' read -r action fclass ftarget <<< "$entry"
    if [[ "$action" == rotate-database-credential ]]; then
      has_rotate=1
      rotate_count=$((rotate_count + 1))
    elif [[ "$action" == regenerate-secret ]]; then
      has_regenerate=1
      regenerate_count=$((regenerate_count + 1))
      regenerate_targets+=("$ftarget")
    fi
  done

  local approved=1
  if [[ "$has_rotate" == 1 ]] && ! confirm_dangerous_action "$rotate_count" rotate; then
    approved=0
  fi
  if [[ "$approved" == 1 && "$has_regenerate" == 1 ]] && ! confirm_dangerous_action "$regenerate_count" regenerate; then
    approved=0
  fi

  if [[ "$approved" != 1 ]]; then
    for entry in "${dangerous_entries[@]}"; do
      IFS='|' read -r action fclass ftarget <<< "$entry"
      printf 'execute action=%s resolves=%s result=skipped\n' "$action" "$fclass"
    done
    printf 'dangerous result=refused done=0 failed=0 reason=refused-by-operator\n'
    dangerous_exit_code=6
    return 0
  fi

  # Approved. rotate-database-credential's own entries always share one
  # execution instance and outcome (mirrors do_restart_services's own
  # once-per-run dedup above). regenerate-secret runs once per distinct
  # missing-secret target. Both run straight through as ONE combined ordered
  # sequence — rotate first, then regenerate — stopping at the first
  # failure (ADR-0014 decision 8: "the iterator... stops at the first failed
  # step; nothing later runs"): every dangerous-class entry in this run,
  # including a regenerate-secret target never reached because rotation
  # failed first, reports the SAME shared outcome below, exactly like the
  # existing rotate-only case already does for its own multiple entries.
  # $dangerous_batch_in_progress brackets the whole sequence so the EXIT
  # trap (see "cleanup" above the argument-parsing block) knows whether an
  # abrupt termination happened mid-mutation and owes the operator the same
  # recovery guidance a synchronous step failure already prints.
  local step_status=0
  dangerous_batch_in_progress=1
  if [[ "$has_rotate" == 1 ]]; then
    run_rotate_database_credential_steps || step_status=$?
  fi
  if [[ "$step_status" == 0 && "$has_regenerate" == 1 ]]; then
    run_regenerate_secret_steps "${regenerate_targets[@]}" || step_status=$?
  fi
  dangerous_batch_in_progress=0

  local line_result done_count=0 failed_count=0
  if [[ "$step_status" == 0 ]]; then
    line_result="done"
    done_count="${#dangerous_entries[@]}"
  else
    line_result="failed"
    failed_count="${#dangerous_entries[@]}"
  fi
  for entry in "${dangerous_entries[@]}"; do
    IFS='|' read -r action fclass ftarget <<< "$entry"
    printf 'execute action=%s resolves=%s result=%s\n' "$action" "$fclass" "$line_result"
  done

  if [[ "$line_result" == "done" ]]; then
    printf 'dangerous result=complete done=%d failed=0 reason=none\n' "$done_count"
    dangerous_exit_code=0
  else
    printf 'dangerous result=failed done=0 failed=%d reason=%s\n' "$failed_count" "$dangerous_failure_reason"
    dangerous_exit_code=4
  fi
}

# --- execute mode driver -----------------------------------------------------

# Phase 1 (--safe-only): identical output/behavior to the original slice-4
# stage-one implementation when $dangerous==0 (verified byte-for-byte by the
# existing --execute --safe-only test suite, which never sets --dangerous).
# When $dangerous==1, every dangerous-class plan entry is deferred (see
# is_dangerous_deferred above) instead of being printed `skipped` here — it
# is reported by execute_dangerous_batch (phase 2) instead. Sets
# $safe_batch_exit_code (0/1/4, the same values the old inline `exit`
# statements used) rather than exiting directly, so execute_repair can run
# phase 2 and the final re-diagnosis afterward.
run_safe_batch() {
  local entry action fclass ftarget status result
  local safe_count=0 done_count=0 failed_count=0 terminal_result=""

  if [[ "$safe_only" == 1 ]]; then
    for entry in "${plan_entries[@]:-}"; do
      [[ -n "$entry" ]] || continue
      IFS='|' read -r action fclass ftarget <<< "$entry"
      is_safe_action "$action" && safe_count=$((safe_count + 1))
    done
  fi

  if [[ "$safe_count" -eq 0 ]]; then
    # $reported_count excludes entries deferred to the dangerous batch (see
    # is_dangerous_deferred above): a plan containing ONLY a deferred
    # rotate-database-credential entry must not be mislabeled `unactionable`
    # by the safe batch — phase 2 (execute_dangerous_batch) is about to
    # handle it. This is purely a label/exit-code nuance: $safe_batch_exit_code
    # is 0 either way, and when $dangerous==0 nothing is ever deferred, so
    # $reported_count always equals ${#plan_entries[@]} and this is
    # byte-identical to the original stage-one behavior.
    local reported_count=0
    for entry in "${plan_entries[@]:-}"; do
      [[ -n "$entry" ]] || continue
      IFS='|' read -r action fclass ftarget <<< "$entry"
      is_dangerous_deferred "$action" && continue
      printf 'execute action=%s resolves=%s result=skipped\n' "$action" "$fclass"
      reported_count=$((reported_count + 1))
    done
    if [[ "$reported_count" -eq 0 ]]; then
      terminal_result=empty
    else
      terminal_result=unactionable
    fi
    printf 'execution result=%s done=0 failed=0\n' "$terminal_result"
    safe_batch_exit_code=0
    return 0
  fi

  if ! confirm_safe_batch "$safe_count"; then
    for entry in "${plan_entries[@]:-}"; do
      [[ -n "$entry" ]] || continue
      IFS='|' read -r action fclass ftarget <<< "$entry"
      is_dangerous_deferred "$action" && continue
      printf 'execute action=%s resolves=%s result=skipped\n' "$action" "$fclass"
    done
    printf 'execution result=declined done=0 failed=0\n'
    safe_batch_exit_code=1
    return 0
  fi

  for entry in "${plan_entries[@]:-}"; do
    [[ -n "$entry" ]] || continue
    IFS='|' read -r action fclass ftarget <<< "$entry"
    if ! is_safe_action "$action"; then
      is_dangerous_deferred "$action" && continue
      printf 'execute action=%s resolves=%s result=skipped\n' "$action" "$fclass"
      continue
    fi

    status=0
    case "$action" in
      fix-permissions) do_fix_permissions "$fclass" "$ftarget" || status=$? ;;
      restore-transaction)
        # Two independent boundaries share the restore-transaction action
        # class (ADR-0014 decision 7); $fclass tells them apart. See
        # do_restore_configuration_rollback's own comment for why this is a
        # separate function rather than a branch inside do_restore_transaction.
        if [[ "$fclass" == configuration-migration-interrupted ]]; then
          do_restore_configuration_rollback || status=$?
        else
          do_restore_transaction || status=$?
        fi
        ;;
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

  if [[ "$failed_count" -gt 0 ]]; then
    terminal_result=failed
  else
    terminal_result=complete
  fi
  printf 'execution result=%s done=%s failed=%s\n' "$terminal_result" "$done_count" "$failed_count"
  if [[ "$terminal_result" == failed ]]; then
    safe_batch_exit_code=4
  else
    safe_batch_exit_code=0
  fi
}

execute_repair() {
  local entry action fclass ftarget

  recovery_dir=""
  service_restart_result=()
  checkpoint_bundle_path=""
  safe_batch_exit_code=0
  dangerous_exit_code=0

  run_diagnosis

  if [[ "$diagnosis_early" == 1 ]]; then
    compute_plan_entries
    for entry in "${plan_entries[@]:-}"; do
      [[ -n "$entry" ]] || continue
      IFS='|' read -r action fclass ftarget <<< "$entry"
      is_dangerous_deferred "$action" && continue
      printf 'execute action=%s resolves=%s result=skipped\n' "$action" "$fclass"
    done
    printf 'execution result=empty done=0 failed=0\n'
    if [[ "$dangerous" == 1 ]]; then
      printf 'dangerous result=empty done=0 failed=0 reason=none\n'
    fi
    run_diagnosis
    print_check_lines
    exit 5
  fi

  compute_plan_entries

  # ADR-0016 refusal (criterion 9, #681): an unsupported deployment version
  # refuses the whole execution, not just its own (manual) plan entry.
  # Running even the safe executors against a pre-floor deployment would
  # mutate a layout this script was never proven against, so nothing is
  # allowed to run — mirroring the dangerous batch's own refusal grammar,
  # with the reason carried on the line.
  local version_unsupported=0
  for entry in "${findings[@]:-}"; do
    [[ "$entry" == "deployment-version-unsupported|"* ]] && version_unsupported=1
  done
  if [[ "$version_unsupported" == 1 ]]; then
    printf 'execution result=refused done=0 failed=0 reason=deployment-version-unsupported\n'
    if [[ "$dangerous" == 1 ]]; then
      printf 'dangerous result=refused done=0 failed=0 reason=deployment-version-unsupported\n'
    fi
    print_check_lines
    exit 6
  fi

  run_safe_batch

  if [[ "$dangerous" == 1 ]]; then
    execute_dangerous_batch
  fi

  cleanup_recovery_dir
  run_diagnosis
  print_check_lines

  # Final exit code — see "EXIT CODES (--execute --dangerous)" above for the
  # full precedence table this implements. A real failure (4) in either
  # batch always wins; a dangerous refusal (6) is reported next; a safe-batch
  # decline (1) is preserved when nothing else overrides it; otherwise 0.
  # When $dangerous==0, $dangerous_exit_code stays 0 and this reduces to
  # exactly the original stage-one exit code (0/1/4) — see run_safe_batch's
  # own comment for why its output is unchanged in that case too.
  if [[ "$safe_batch_exit_code" == 4 || "$dangerous_exit_code" == 4 ]]; then
    exit 4
  fi
  if [[ "$dangerous_exit_code" == 6 ]]; then
    exit 6
  fi
  if [[ "$safe_batch_exit_code" == 1 ]]; then
    exit 1
  fi
  exit 0
}

# --- export-diagnostics (issue #531, ADR-0014 decision 10) ------------------
#
# Builds the fixed-format identity line described in "EXPORT MODE
# (--export-diagnostics)" above. Reads directly from the live .env-orbit
# (never via configure.sh — decision 2's source-less rule) and only when
# $env_status == ok, exactly like check_application_container's own
# ORBIT_IMAGE read: an untrustworthy managed file (missing, a symlink, wrong
# mode) means every field falls back to the fixed placeholder rather than
# reading content this script has not already proven safe to read. Each
# field is independently format-validated before being trusted; the
# ORBIT_IMAGE pattern is the exact one check_application_container already
# uses, duplicated here rather than shared across functions for the same
# reason repair.sh duplicates it from configuration.sh's own validators —
# small recognition primitives are mirrored, not linked, by design.
build_identity_line() {
  local schema="unknown" applied="unknown" image="unknown"
  local raw=""

  if [[ "$env_status" == ok ]]; then
    raw="$(read_environment_value ORBIT_CONFIG_SCHEMA_VERSION 2>/dev/null || true)"
    [[ "$raw" =~ ^[0-9]{1,10}$ ]] && schema="$raw"

    raw="$(read_environment_value ORBIT_CONFIG_APPLIED_VERSION 2>/dev/null || true)"
    [[ "$raw" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] && applied="$raw"

    raw="$(read_environment_value ORBIT_IMAGE 2>/dev/null || true)"
    [[ "$raw" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]] && image="$raw"
  fi

  printf 'identity schema_version=%s applied_version=%s image=%s' "$schema" "$applied" "$image"
}

# --- confirmation (--export-diagnostics) -------------------------------------
#
# Returns 0 (proceed) or 1 (declined). Mirrors confirm_safe_batch's machine-
# prompt/interactive priority, with one deliberate difference: there is no
# non-interactive automation path here (contrast run_safe_batch's own
# "reaching here already means unattended is the intended contract" case).
# Decision 10 requires the exported content to be "explicitly confirmed
# before any file is written", so a run with no controlling terminal and no
# ORBIT_REPAIR_PROMPTS=machine opt-in declines rather than guessing at
# consent. The content itself is already on stdout by the time this is
# called (export_diagnostics_repair prints it first); this function only
# ever prints the prompt/answer exchange.
confirm_export_diagnostics() {
  local answer=""

  if [[ "$machine_prompts" == 1 ]]; then
    printf 'prompt field=export-diagnostics kind=confirm required=true attempt=1\n'
    if IFS= read -r answer && [[ "$answer" == y ]]; then
      printf 'prompt-accept field=export-diagnostics\n'
      return 0
    fi
    printf 'prompt-abort field=export-diagnostics\n'
    return 1
  fi

  if [[ "$interactive" == 1 ]]; then
    printf 'Orbit repair: write the diagnostics above to a file? [y/N] ' >&2
    if IFS= read -r answer && [[ "$answer" == y || "$answer" == Y ]]; then
      return 0
    fi
    return 1
  fi

  return 1
}

# Writes $1 (the already-previewed, already-confirmed export content) to a
# freshly created file, mirroring the checkpoint bundle's own discipline:
# mktemp (mode 600 from creation) under the installation directory, content
# written, mode 600 set again defensively, then an atomic same-directory
# rename onto a second, equally random final name — so a reader can never
# observe a partially-written file at the path this run ultimately reports.
# Returns 0 and prints the final path on stderr only (never stdout, matching
# the checkpoint bundle path above) on success; returns 1, with any partial
# temp file removed, on any failure.
write_export_diagnostics() {
  local content="$1" tmp_path="" final_path=""

  tmp_path="$(mktemp "./.orbit-repair-diagnostics.XXXXXX")" || return 1
  chmod 600 -- "$tmp_path" 2>/dev/null || true
  if ! printf '%s\n' "$content" > "$tmp_path" 2>/dev/null; then
    rm -f -- "$tmp_path"
    return 1
  fi
  chmod 600 -- "$tmp_path" 2>/dev/null || true

  final_path="${tmp_path}.txt"
  if ! mv -- "$tmp_path" "$final_path" 2>/dev/null; then
    rm -f -- "$tmp_path"
    return 1
  fi

  printf 'Orbit repair: diagnostics exported to %s\n' "$final_path" >&2
  printf 'Orbit repair: (plain text, mode 600 — no encryption; these are public values under ADR-0008.)\n' >&2
  return 0
}

export_diagnostics_repair() {
  run_diagnosis

  if [[ "$diagnosis_early" == 1 ]]; then
    print_check_lines
    print_plan_lines
    exit 5
  fi

  local export_content=""
  export_content="$(print_check_lines; print_plan_lines; printf '%s\n' "$(build_identity_line)")"

  printf '%s\n' "$export_content"

  if ! confirm_export_diagnostics; then
    exit 1
  fi

  if ! write_export_diagnostics "$export_content"; then
    printf 'Orbit repair: could not write the diagnostics export file.\n' >&2
    exit 4
  fi

  exit 0
}

case "$mode" in
  execute)
    execute_repair
    ;;
  export-diagnostics)
    export_diagnostics_repair
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
