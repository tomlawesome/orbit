#!/usr/bin/env bash
set -Eeuo pipefail

# Orbit installer: the bootstrap shell around the install engine (#1212).
#
# Deploys a published, digest-pinned image. It does not clone the
# repository: a deployment needs compose assets and a published image, not
# source or tests. Building from source is a separate developer workflow;
# see the README.
#
# Three phases, two owners (#1212 build note F1). This script does what
# touches Docker or the network before an image exists: tool checks, the
# release manifest and its signatures, the pull, the image's labels and
# banner, and the Docker facts the engine needs (gather_host_facts). It then
# runs the install engine once, from the image it has just verified, as a
# disposable `docker run --rm` one-off with the deployment directory
# mounted (run_engine). The engine (src/lib/install-orchestrator.ts) does
# everything between: target validation, the install/update menu and the
# profile wizard on the terminal passed through to it, database-volume
# safety, the deployment assets out of its own image, guided configuration,
# the configuration migration, OIDC discovery, and the file transaction,
# which it commits or rolls back. The engine never touches Docker (#295):
# what Docker must do afterwards comes back in its outcome file, and this
# script starts Compose, waits for readiness and prints the completion
# screen. Nothing here writes a deployment file, with one exception: a fresh
# install that fails after the engine's commit is rolled back (#1456,
# rollback_fresh_install), which puts this folder's own files back from the
# copy taken before the engine ran.
#
# Environment (besides the settings read below):
#   ORBIT_LAUNCHER_CONFIG_TREE  set by orbit-launcher to an empty directory it
#     created, mode 0700 and owned by the running user. On any exit whose
#     event reason is configuration-failure the engine copies
#     scripts/configure.sh, scripts/installer-ui.sh and .env-orbit.example,
#     from its own image, and .orbit-image, the resolved digest reference on
#     one line, into it before rolling back, owner-only (0600/0700), all or
#     nothing. It writes nothing, and says so in one stderr line, if the
#     directory is missing, not a directory, a symlink, not mode 0700, not
#     empty or not owned by the current user (#1225, docs/engine-events.md).
#     The launcher may leave .env-orbit and .orbit-secrets/ there for the
#     engine to take in as its configuration (#1519), which "empty" allows.
#     This script only mounts the directory into the engine.

readonly repository="${ORBIT_REPOSITORY:-tomlawesome/orbit}"
readonly registry="${ORBIT_REGISTRY:-ghcr.io}"
readonly channel="${ORBIT_CHANNEL:-latest}"
readonly environment_file=".env-orbit"
readonly launcher_config_tree="${ORBIT_LAUNCHER_CONFIG_TREE:-}"
readonly database_volume_key="orbit-db-data"
# Every named volume docker-compose.yml declares that `compose up` can
# create. A failed fresh start removes, by exact name, only those this
# attempt created (#1151, #1207, #1455).
readonly -a deployment_volume_keys=(orbit-db-data orbit-documents-data orbit-clamav-data orbit-ollama-data)
# Docker's own words in a failure are bounded to this many characters (#1455).
readonly docker_output_bound=500
readonly image_repository="${registry}/${repository}"
# ADR-0031 #7: byte-identical to cosign.pub (scripts/get-orbit.test.mjs also
# checks this, and the copy embedded in scripts/get-orbit.sh, against the
# same file). Rotation: docs/releasing.md.
readonly embedded_public_key='-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEz/p19d5ZrSimfOQ80OCeSG8s32dm
k91OtCbfzOoGPhJnnXIynC5JDfyBoZiS59rCFb2hSiERGWQmLH1i8XV4nQ==
-----END PUBLIC KEY-----'
# The identity countersign.yml signs the image and the release manifest
# bundle under (ADR-0031 #4, #7; .github/workflows/countersign.yml).
readonly countersign_identity_regexp='^https://github.com/tomlawesome/orbit/'
readonly countersign_oidc_issuer='https://token.actions.githubusercontent.com'
# Test-only: overrides where the release manifest is fetched from when
# ORBIT_RELEASE_MANIFEST is not set. Never for user environments.
readonly release_manifest_base_url="${ORBIT_INSTALL_TEST_MANIFEST_BASE_URL:-https://github.com/tomlawesome/orbit}"
readonly installer_process_started_at="$SECONDS"
# The run's start time in UTC, which names its backup folder (snapshot_fresh_target).
run_stamp="$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null)" || run_stamp=""
readonly run_stamp
# Where the engine one-off sees what this script hands it (run_engine).
readonly engine_cli="/opt/orbit/cli/orbit.js"
readonly engine_mount="/orbit-deploy"
readonly engine_result_mount="/orbit-install-result"
readonly engine_launcher_tree_mount="/orbit-launcher-config-tree"
readonly app_readiness_probe='fetch("http://127.0.0.1:3000/api/health", { cache: "no-store", signal: AbortSignal.timeout(3000) })
  .then(async (response) => {
    let body;
    try { body = await response.json(); } catch { process.exit(1); }
    process.exit(response.status === 200 && body !== null && typeof body === "object" &&
      body.status === "ready" && body.service === "orbit" ? 0 : 1);
  })
  .catch(() => process.exit(1));'
readonly tika_readiness_probe='fetch("http://orbit-tika:9998/version", { cache: "no-store", signal: AbortSignal.timeout(3000) })
  .then((response) => process.exit(response.status === 200 ? 0 : 1))
  .catch(() => process.exit(1));'

plain_mode=0
simulate_mode=0
requested_action=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --plain)
      plain_mode=1
      shift
      ;;
    --simulate)
      simulate_mode=1
      shift
      ;;
    --install|--update|--repair)
      [[ -z "$requested_action" ]] || {
        printf 'Usage: %s [--plain] [--install|--update|--repair] | [--plain] --simulate\n' "$0" >&2
        exit 2
      }
      requested_action="${1#--}"
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      printf 'Usage: %s [--plain] [--install|--update|--repair] | [--plain] --simulate\n' "$0" >&2
      exit 2
      ;;
  esac
done
[[ $# -eq 0 ]] || {
  printf 'Usage: %s [--plain] [--install|--update|--repair] | [--plain] --simulate\n' "$0" >&2
  exit 2
}
if [[ "$simulate_mode" == 1 && -n "$requested_action" ]]; then
  printf 'Usage: %s [--plain] [--install|--update|--repair] | [--plain] --simulate\n' "$0" >&2
  printf 'Orbit installer: --simulate cannot be combined with --install, --update or --repair.\n' >&2
  exit 2
fi
if [[ "$plain_mode" == 1 ]]; then
  export ORBIT_INSTALLER_PLAIN=1
fi

# Simulation dispatches immediately after safe argument parsing and before
# any target, deployment-environment, Docker/curl/timeout, registry/image/
# OIDC, staging or transaction step. It only ever invokes the fixed sibling
# simulation script (never a fetched, caller-supplied or symlinked path),
# which in turn may only source the fixed sibling installer-ui.sh.
if [[ "$simulate_mode" == 1 ]]; then
  installer_script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd -P)" ||
    { printf 'Orbit installer: could not resolve the installer script directory for simulation.\n' >&2; exit 1; }
  simulation_script="$installer_script_dir/installer-simulation.sh"
  simulation_ui_script="$installer_script_dir/installer-ui.sh"
  [[ -f "$simulation_script" && ! -L "$simulation_script" ]] ||
    { printf 'Orbit installer: the simulation helper is missing or unsafe.\n' >&2; exit 1; }
  [[ -f "$simulation_ui_script" && ! -L "$simulation_ui_script" ]] ||
    { printf 'Orbit installer: the simulation UI helper is missing or unsafe.\n' >&2; exit 1; }
  simulate_args=()
  [[ "$plain_mode" == 1 ]] && simulate_args+=(--plain)
  exec bash "$simulation_script" "${simulate_args[@]}"
fi

readiness_timeout_seconds="${ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS:-180}"
readiness_poll_seconds="${ORBIT_INSTALLER_POLL_INTERVAL_SECONDS:-2}"
if [[ ! "$readiness_timeout_seconds" =~ ^[1-9][0-9]{0,2}$ ]] ||
  ((10#$readiness_timeout_seconds > 900)); then
  printf 'Orbit installer: ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS must be between 1 and 900.\n' >&2
  exit 2
fi
if [[ ! "$readiness_poll_seconds" =~ ^[1-9]$ ]]; then
  printf 'Orbit installer: ORBIT_INSTALLER_POLL_INTERVAL_SECONDS must be between 1 and 9.\n' >&2
  exit 2
fi
# The bound on `compose up` (#1518; docs/engine-events.md publishes it).
compose_up_timeout_seconds="${ORBIT_INSTALLER_COMPOSE_UP_TIMEOUT_SECONDS:-300}"
if [[ ! "$compose_up_timeout_seconds" =~ ^[1-9][0-9]{0,2}$ ]] ||
  ((10#$compose_up_timeout_seconds > 900)); then
  printf 'Orbit installer: ORBIT_INSTALLER_COMPOSE_UP_TIMEOUT_SECONDS must be between 1 and 900.\n' >&2
  exit 2
fi
[[ "$channel" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || {
  printf 'Orbit installer: ORBIT_CHANNEL is invalid.\n' >&2
  exit 2
}
[[ "$repository" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]] || {
  printf 'Orbit installer: ORBIT_REPOSITORY is invalid.\n' >&2
  exit 2
}
[[ "$registry" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?$ ]] || {
  printf 'Orbit installer: ORBIT_REGISTRY is invalid.\n' >&2
  exit 2
}
# ADR-0031 #7: preview is for testing, not for trusting -- a missing
# countersignature is tolerated only there; every other channel (latest, or
# a pinned version tag) is treated as stable.
if [[ "$channel" == "preview" ]]; then
  readonly release_manifest_stable=0
else
  readonly release_manifest_stable=1
fi

release_manifest_work_dir=""
engine_work_dir=""
cosign_usable=0
compose_project_name=""
installer_ui_loaded=0
installer_ui_phase=host
installer_ui_component=host
installer_failure_reason=""
installer_failure_action=""
selected_profile=""
model_pull_requested=0
target_was_empty=0
declare -a pending_ui_events=()
installer_failure_detail=""
declare -a installer_failure_notes=()
declare -a optional_notes=()
container_state=unknown
container_summary=""
container_exit_code=""
# The fresh-install rollback (#1456): an all-or-nothing install with a start
# record and rollback. The record is a copy of this folder's own entries,
# taken before the engine runs into orbit-install-backups/<stamp>/originals
# inside the folder, and the list of this project's volumes that already
# existed before `compose up`. Nothing is kept anywhere else, and nothing
# between runs.
backup_root=""
# Set when this run made orbit-install-backups, so only this run removes it.
backup_root_created=0
# This run's dated folder, once made: orbit-install-backups/<stamp>.
backup_dir=""
rollback_snapshot_taken=0
# Set when the folder could not be put back: the copy of the originals stays.
rollback_keep_originals=0
rollback_armed=0
compose_started=0
declare -a rollback_original_entries=()
# The relative paths the engine journals, before its first write, as ones it
# may create (read_engine_journal): with the staging directory, the lock and
# the scratch names, only these are removed outright by a rollback. Anything
# else new may be the person's, saved while the engine ran, and is moved
# aside, never deleted.
declare -a rollback_engine_entries=()
# Set when anything of the folder's was moved out (moved/, or engine/ with no
# journal), and which.
rollback_moved=0
rollback_moved_aside=0
rollback_kept_unrecorded=0
declare -a rollback_preexisting_volumes=()
# What the rollback could not do, one sentence each, and the lines saying
# where moved files are kept.
declare -a rollback_obstacles=()
declare -a rollback_report=()
rollback_down_failed=0
# This attempt's volumes when `down` failed (the stop command removes them),
# and those a successful `down` could not remove.
declare -a rollback_down_volumes=()
declare -a rollback_failed_volumes=()
rollback_folder_failed=0
rollback_restore_named=0
# The kinds of obstacle a failed folder rollback met, each with its own
# closing line: an original that could not be put back (its live paths), an
# engine entry that could not be removed or moved, and nothing moved because
# the dated folder could not be made. The volumes could not be listed.
declare -a rollback_restore_failed_paths=()
rollback_entry_failed=0
rollback_nothing_moved=0
rollback_volumes_unlisted=0
# The rollback's shared Docker deadline (a SECONDS value; empty outside the
# rollback), and whether a Docker call ran out of it.
rollback_docker_deadline=""
rollback_docker_timed_out=0
rollback_interrupted=0
# Set by read_engine_journal only when the engine left a journal it accepted.
rollback_journal_present=0
# The walk's pass (plan or apply), what it found, and the claim on one entry.
rollback_walk=apply
rollback_needs_backup=0
rollback_claim=none
# The one command the person may need, offered as the recovery command: the
# stop command when `down` failed, or the volume removal.
rollback_recovery_command=""
rollback_stop_command=""
# complete or incomplete once rollback_fresh_install has run, and the
# terminal event's action then.
rollback_outcome=""
rollback_action=""
# The optional phase (#1456 ruling, note 40394): once the database and the
# application are ready the rollback is disarmed, and an interrupt only ends
# the optional waits.
optional_window=0
optional_interrupted=0
interruptible_pid=""
# An update after the commit rolls forward (#1518): nothing is undone and no
# step is cut part-way. rolling_forward is set once the engine has committed
# an update; an interrupt from then on only records its exit status here
# (130, 143 or 129), the step under way ends (at once, if it only waits or
# pulls), and fail() ends the run as that step's failure.
rolling_forward=0
stop_status=""
container_restarts=""
declare -A restarts_before=()

# installer-ui.sh renders this script's own phases (build note F6). It is
# sourced only from the deployment the engine has just committed, which the
# engine copied out of the verified image at the asset's checked mode, and
# only after bash -n: never from a deployment copy before the engine has
# replaced it. Until then events are queued, and replayed here, exactly as
# before; a failure before this point prints them as plain lines.
load_installer_ui() {
  local candidate="scripts/installer-ui.sh"

  is_regular_non_symlink_file "$candidate" || return 1
  bash -n "$candidate" 2>/dev/null || return 1
  # shellcheck source=/dev/null
  source "$candidate"
  declare -F installer_ui_init >/dev/null || return 1
  declare -F installer_ui_emit >/dev/null || return 1
  declare -F installer_ui_resume_clock >/dev/null || return 1
  if [[ "$plain_mode" == 1 ]]; then
    installer_ui_init --plain
  else
    installer_ui_init
  fi
  installer_ui_resume_clock "$installer_process_started_at" || return 1
  installer_ui_loaded=1
  local pending phase component state reason action elapsed
  for pending in "${pending_ui_events[@]}"; do
    IFS='|' read -r phase component state reason action elapsed <<< "$pending"
    installer_ui_emit "$phase" "$component" "$state" "$reason" "$action" "$elapsed"
  done
  pending_ui_events=()
}

installer_ui_event() {
  if [[ "$installer_ui_loaded" == 1 ]]; then
    # Reporting never stops the install: a launcher that went away (a closed
    # pipe) must not leave a committed install half-started (#1456).
    installer_ui_emit "$@" 2>/dev/null || true
  else
    pending_ui_events+=("$1|$2|$3|$4|$5|$((SECONDS - installer_process_started_at))")
  fi
}

flush_pending_ui_events() {
  local pending phase component state reason action elapsed
  for pending in "${pending_ui_events[@]}"; do
    IFS='|' read -r phase component state reason action elapsed <<< "$pending"
    printf 'phase=%s component=%s state=%s reason=%s action=%s elapsed=%ss\n' \
      "$phase" "$component" "$state" "$reason" "$action" "$elapsed"
  done
  pending_ui_events=()
}

default_failure_reason() {
  case "${installer_ui_phase:-host}" in
    host) printf 'docker-host' ;;
    identity|assets|preparation) printf 'image-registry' ;;
    configuration|compose) printf 'configuration-failure' ;;
    oidc) printf 'provider-unavailable' ;;
    database) printf 'database-auth-migration' ;;
    application) printf 'health-timeout' ;;
    optional) printf 'optional-unavailable' ;;
    *) printf 'failure' ;;
  esac
}

default_failure_action() {
  case "${installer_ui_phase:-host}" in
    database|application|optional) printf 'repair' ;;
    *) printf 'retry' ;;
  esac
}

fail() {
  local reason action phase component elapsed
  reason="${installer_failure_reason:-$(default_failure_reason)}"
  action="${installer_failure_action:-$(default_failure_action)}"
  phase="${installer_ui_phase:-host}"
  component="${installer_ui_component:-host}"
  # An update stopped after the commit (#1518) ends as a failure of the step
  # it stopped in, whatever that step then said: nothing is undone, and the
  # next step is a retry while the running services are unchanged (the image
  # pulls), Repair once Compose has begun starting them. Docker's words from
  # a stopped command are not the cause, so they are not shown.
  if [[ -n "$stop_status" ]]; then
    reason=failure
    installer_failure_detail=""
    installer_failure_notes=()
    if [[ "$compose_started" == 1 ]]; then
      action=repair
      set -- "The update was stopped after its files were committed, while Orbit's services were being started or checked; nothing was undone. Run Repair."
    else
      action=retry
      set -- "The update was stopped after its files were committed, before Orbit's services were changed; nothing was undone. Run the update again."
    fi
  fi
  # A fresh install that fails after the commit is undone before the
  # terminal event, so the event can say whether a retry can work (#1456).
  # A complete rollback leaves nothing to repair, so the next step is a
  # retry once the cause named here is fixed; so does one that put the
  # folder back but left something in Docker, once the one command has run.
  # A folder that could not be put back needs the person first: `abort`.
  if [[ "$rollback_armed" == 1 ]]; then
    # A second signal must not cut the rollback short: caught from before
    # the disarm, and remembered for the exit status.
    trap 'rollback_interrupted=130' INT; trap 'rollback_interrupted=143' TERM; trap 'rollback_interrupted=129' HUP
    rollback_armed=0
    rollback_fresh_install || true
  fi
  case "$rollback_outcome" in
    complete) action=retry ;;
    incomplete) action="$rollback_action" ;;
  esac
  # Everything below only reports: a launcher that has gone away (a closed
  # pipe) must not stop the exit, and the rollback above has already run.
  emit_terminal_failure "$phase" "$component" "$reason" "$action"
  # Docker's own words come before the message: the launcher shows the last
  # few stderr lines, so the message and what to do next stay in view.
  if [[ -n "$installer_failure_detail" ]]; then
    printf 'Orbit installer: Docker said: %s\n' "$installer_failure_detail" >&2 || true
  fi
  local note
  for note in "${installer_failure_notes[@]}"; do
    printf 'Orbit installer: %s\n' "$note" >&2 || true
  done
  printf 'Orbit installer: %s\n' "$*" >&2 || true
  case "$rollback_outcome" in
    complete)
      print_rollback_report
      printf 'Orbit installer: This install was rolled back: the folder is as it was before%s,%s and the containers and volumes it created are removed. Fix the cause, then install again.\n' \
        "$(rollback_unit_clause)" "$(rollback_moved_clause)" >&2 || true
      ;;
    incomplete) print_rollback_obstacles ;;
    *)
      if [[ "$action" == repair ]]; then
        printf 'Orbit installer: next action is the bounded Repair path; no deletion or credential reset is recommended.\n' >&2 || true
      fi
      ;;
  esac
  # An interrupt during the rollback ends the run with that signal's status,
  # as does an update's stop.
  ((rollback_interrupted == 0)) || exit "$rollback_interrupted"
  [[ -z "$stop_status" ]] || exit "$stop_status"
  exit 1
}

# emit_terminal_failure <phase> <component> <reason> <action>
#
# The one terminal `failed` event, through installer-ui.sh once it is loaded
# and as a plain line (after any queued events) before. When the person has a
# command to run, a plain stream carries it on the line just before, as
# `recovery-command: <command>`, and the event ends ` recovery=command`
# (docs/engine-events.md, "Recovery command"): a launcher shows it in a copy
# box instead of matching it in the stderr prose. Never fails.
emit_terminal_failure() {
  local elapsed="$((SECONDS - installer_process_started_at))" recovery=""
  [[ -z "$rollback_recovery_command" ]] || recovery="command"
  if [[ "$installer_ui_loaded" == 1 ]]; then
    # shellcheck disable=SC2154 # set by installer-ui.sh
    if [[ -n "$recovery" && "$installer_ui_mode" == plain ]]; then
      printf 'recovery-command: %s\n' "$rollback_recovery_command" 2>/dev/null || true
      # shellcheck disable=SC2034 # read by installer_ui_emit
      installer_ui_recovery="command"
    fi
    installer_ui_emit "$1" "$2" failed "$3" "$4" "$elapsed" 2>/dev/null || true
  else
    flush_pending_ui_events 2>/dev/null || true
    [[ -z "$recovery" ]] || printf 'recovery-command: %s\n' "$rollback_recovery_command" 2>/dev/null || true
    printf 'phase=%s component=%s state=failed reason=%s action=%s elapsed=%ss%s\n' \
      "$1" "$2" "$3" "$4" "$elapsed" "${recovery:+ recovery=$recovery}" 2>/dev/null || true
  fi
}

fail_with() {
  installer_failure_reason="$1"
  installer_failure_action="$2"
  shift 2
  fail "$@"
}

compose() {
  docker compose --project-name "$compose_project_name" --env-file "$environment_file" "$@"
}

is_regular_non_symlink_file() {
  [[ -f "$1" && ! -L "$1" ]]
}

has_controlling_terminal() {
  local terminal_fd=""
  if ! { exec {terminal_fd}<>/dev/tty; } 2>/dev/null; then
    return 1
  fi
  exec {terminal_fd}>&-
}

read_environment_value() {
  local requested_key="$1" line value="" found=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "${requested_key}="* ]]; then
      # The engine writes CRLF lines into a CRLF file; drop the CR.
      value="${line#*=}"
      value="${value%$'\r'}"
      found=1
    fi
  done < "$environment_file"
  [[ "$found" == 1 ]] || return 1
  printf '%s' "$value"
}

cleanup() {
  local exit_status=$? exit_status_name=""

  # A signal's trap runs inside whatever command it interrupted, with that
  # command's redirections still applied -- a health probe's >/dev/null, say
  # -- so report on the streams the script started with.
  if [[ -n "$original_stdout_fd" && -n "$original_stderr_fd" ]]; then
    exec 1>&"$original_stdout_fd" 2>&"$original_stderr_fd" || true
  fi

  # Any other way a fresh install ends early after the commit -- an
  # interrupt (the INT/TERM/HUP traps below turn each into a non-zero exit),
  # an unexpected command failure, a launcher that went away -- is rolled
  # back too, first, and then reported with the one terminal `failed` event.
  if [[ "$rollback_armed" == 1 && "$exit_status" != 0 ]]; then
    trap 'rollback_interrupted=130' INT; trap 'rollback_interrupted=143' TERM; trap 'rollback_interrupted=129' HUP
    rollback_armed=0
    ((exit_status < 128)) || exit_status_name="interrupted"
    if rollback_fresh_install; then
      emit_terminal_failure "${installer_ui_phase:-host}" "${installer_ui_component:-host}" failure retry
      print_rollback_report
      printf 'Orbit installer: The install stopped before it finished (%s), and was rolled back: the folder is as it was before%s,%s and the containers and volumes it created are removed. You can install again.\n' \
        "${exit_status_name:-exit status ${exit_status}}" "$(rollback_unit_clause)" "$(rollback_moved_clause)" >&2 || true
    else
      emit_terminal_failure "${installer_ui_phase:-host}" "${installer_ui_component:-host}" failure "$rollback_action"
      printf 'Orbit installer: The install stopped before it finished (%s).\n' "${exit_status_name:-exit status ${exit_status}}" >&2 || true
      print_rollback_obstacles
    fi
  fi
  # A copy kept because the folder could not be put back is the user's only
  # copy of their original files; print_rollback_obstacles named it.
  # Otherwise the copy goes, with the emptied folders (any exit: a success,
  # a refusal, an engine that rolled itself back).
  if [[ "$rollback_keep_originals" != 1 ]]; then
    release_rollback_copies || exit_status=1
  fi
  if [[ -n "$engine_work_dir" ]] && ! rm -rf -- "$engine_work_dir"; then
    printf 'Orbit installer: could not remove a temporary directory: %s.\n' "$engine_work_dir" >&2 || true
    exit_status=1
  fi
  if [[ -n "$release_manifest_work_dir" ]] && ! rm -rf -- "$release_manifest_work_dir"; then
    printf 'Orbit installer: could not remove a temporary directory: %s.\n' "$release_manifest_work_dir" >&2 || true
    exit_status=1
  fi

  exit "$exit_status"
}

original_stdout_fd=""
original_stderr_fd=""
exec {original_stdout_fd}>&1 {original_stderr_fd}>&2 || true
trap cleanup EXIT
# An untrapped INT/TERM/HUP ends bash with $? still 0 in the EXIT trap, so
# cleanup could not tell an interrupt from success: each becomes a non-zero
# exit instead (128 + the signal's number). installer-ui.sh saves and
# restores these around its prompts. A launcher that went away closes our
# pipes: writing to them must fail as a write, not kill the script before
# the rollback.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap '' PIPE

# manifest_field <manifest-path> <literal-key>
#
# Extracts a string field from the release manifest (ADR-0031 #1's fixed
# schema, written by scripts/ci/write-release-manifest.sh) by literal key
# match, not a general JSON parser: safe here because write-release-manifest.sh
# always writes one field per line, every key this script reads ("digest") is
# unique in that schema, and every value read back is validated against its
# own pattern before use.
manifest_field() {
  grep -F "\"$2\":" "$1" 2> /dev/null | sed -n 's/.*: *"\([^"]*\)".*/\1/p' | head -n1
}

# check_cosign_usable
#
# A `cosign` on PATH that cannot even answer `cosign version` is treated the
# same as no cosign at all: ADR-0031 only ever asks "is cosign present", and
# a broken binary on PATH is not meaningfully different from an absent one
# for that question.
check_cosign_usable() {
  command -v cosign > /dev/null 2>&1 && cosign version > /dev/null 2>&1
}

# self_fetch_release_manifest
#
# ADR-0031 #7: when install.sh runs on its own -- no manifest handed over by
# get-orbit.sh or the launcher via ORBIT_RELEASE_MANIFEST -- it fetches and
# verifies the manifest for its own channel with the same embedded key, so
# the plain `install.sh | bash` path is also signature-checked and a moving
# tag becomes a lookup, never the identity (ADR-0008).
#
# Only the stable channel shapes get-orbit.sh itself understands -- latest,
# a vX.Y.Z pin -- have a known release-assets location. Preview is refused
# here: a preview install needs a verified release manifest passed in via
# ORBIT_RELEASE_MANIFEST instead. Any other ORBIT_CHANNEL has no self-fetch
# home either; pass ORBIT_RELEASE_MANIFEST instead.
#
# Prints the verified manifest's path on success.
self_fetch_release_manifest() {
  local asset_base key_file manifest_json manifest_sig der_file bundle
  local version_pin_pattern='^v[0-9]+\.[0-9]+\.[0-9]+$'

  if [[ "$channel" == "latest" ]]; then
    asset_base="${release_manifest_base_url}/releases/latest/download"
  elif [[ "$channel" == "preview" ]]; then
    fail "The self-fetch path only installs stable releases (ORBIT_CHANNEL=latest, the default, or a vX.Y.Z pin). A preview install needs a verified release manifest passed in via ORBIT_RELEASE_MANIFEST; see docs/releasing.md."
  elif [[ "$channel" =~ $version_pin_pattern ]]; then
    asset_base="${release_manifest_base_url}/releases/download/${channel}"
  else
    fail "ORBIT_CHANNEL (${channel}) has no known release-manifest location to fetch on its own; set ORBIT_RELEASE_MANIFEST to an already-verified manifest for this channel instead."
  fi

  # The release manifest is the one thing this script still fetches over
  # curl; OIDC discovery moved into the engine (#1212 F5).
  command -v curl >/dev/null 2>&1 || fail "curl is required to fetch the release manifest."

  release_manifest_work_dir="$(mktemp -d "${TMPDIR:-/tmp}/orbit-install-manifest.XXXXXX")" ||
    fail "Could not create a private temporary directory for the release manifest."

  key_file="$release_manifest_work_dir/trusted.pub"
  if [[ -n "${ORBIT_INSTALL_TEST_PUBLIC_KEY_FILE:-}" ]]; then
    [[ "${ORBIT_INSTALL_TEST_ALLOW_KEY_OVERRIDE:-}" == "1" ]] ||
      fail "ORBIT_INSTALL_TEST_PUBLIC_KEY_FILE is set without ORBIT_INSTALL_TEST_ALLOW_KEY_OVERRIDE=1; refusing to swap the trust anchor."
    cp "$ORBIT_INSTALL_TEST_PUBLIC_KEY_FILE" "$key_file"
  else
    printf '%s\n' "$embedded_public_key" > "$key_file"
  fi

  manifest_json="$release_manifest_work_dir/orbit-release-manifest.json"
  manifest_sig="$release_manifest_work_dir/orbit-release-manifest.json.sig"
  curl --silent --show-error --fail --location --connect-timeout 5 --max-time 60 \
    -o "$manifest_json" "${asset_base}/orbit-release-manifest.json" ||
    fail "Could not download the release manifest for channel ${channel}."
  curl --silent --show-error --fail --location --connect-timeout 5 --max-time 60 \
    -o "$manifest_sig" "${asset_base}/orbit-release-manifest.json.sig" ||
    fail "Could not download the release manifest's signature for channel ${channel}."

  der_file="$release_manifest_work_dir/manifest.sig.der"
  if ! base64 -d < "$manifest_sig" > "$der_file" 2>/dev/null || [[ ! -s "$der_file" ]]; then
    fail "The release manifest's signature is not valid base64; refusing an unverifiable manifest."
  fi
  openssl dgst -sha256 -verify "$key_file" -signature "$der_file" "$manifest_json" > /dev/null 2>&1 ||
    fail "Could not verify the release manifest's signature against the trusted key."

  if [[ "$cosign_usable" == 1 ]]; then
    bundle="$release_manifest_work_dir/orbit-release-manifest.json.sigstore.json"
    if curl --silent --show-error --fail --location --connect-timeout 5 --max-time 60 \
      -o "$bundle" "${asset_base}/orbit-release-manifest.json.sigstore.json" 2> /dev/null; then
      cosign verify-blob \
        --bundle "$bundle" \
        --certificate-identity-regexp "$countersign_identity_regexp" \
        --certificate-oidc-issuer "$countersign_oidc_issuer" \
        "$manifest_json" > /dev/null 2>&1 ||
        fail "cosign could not verify the release manifest's countersignature bundle."
    else
      # self_fetch_release_manifest only ever runs for a stable channel
      # (preview is refused above), so a missing bundle always refuses here.
      fail "No countersignature bundle for this release yet; refusing on channel ${channel}."
    fi
  fi

  # A validly signed manifest for a different release must not stand in for
  # the version asked for: an older signed release is still signed.
  if [[ "$channel" =~ $version_pin_pattern ]]; then
    local manifest_version
    # The manifest records the image label, `vX.Y.Z`.
    manifest_version="$(grep -F '"version":' "$manifest_json" | sed -n 's/.*: *"\([^"]*\)".*/\1/p' | head -n1)"
    [[ "$manifest_version" == "$channel" ]] ||
      fail "Asked for ${channel} but the signed release manifest is for ${manifest_version}; refusing."
  fi

  # Set the global directly rather than printing it for a caller to capture
  # via $(...): command substitution runs this whole function in a subshell,
  # so release_manifest_work_dir above would only ever be set in that
  # subshell and cleanup() in the parent shell would never see it -- leaking
  # orbit-install-manifest.* on every self-fetch run (#1151 #1201).
  release_manifest_path="$manifest_json"
}

# --- the engine's Docker facts (build note F3) ------------------------------

# One fact for the engine: the output of a docker call, base64-encoded byte
# for byte as $(...) captured it (so building JSON here needs no escaping),
# or null when the call failed. The engine applies every bound and pattern
# to the decoded text itself (src/lib/host-facts.ts); a gap fails closed.
encoded_fact() {
  local output
  if output="$("$@" 2>/dev/null)"; then
    printf '"%s"' "$(printf '%s' "$output" | base64 | tr -d '\n')"
  else
    printf 'null'
  fi
}

base64_string() {
  printf '"%s"' "$(printf '%s' "$1" | base64 | tr -d '\n')"
}

# gather_host_facts
#
# Runs the docker calls the engine's volume-safety check needs, with the
# argv src/lib/database-volume-safety.ts documents for each, and leaves the
# JSON in ORBIT_INSTALL_HOST_FACTS. Every Orbit database volume on the host
# is described -- its labels, the containers attached to it, the containers
# of the project its labels name and the image of each orbit-app among them
# -- because which of them matters is the engine's decision (#1239, #1261),
# not this script's.
# The facts are JSON, not shell words: their quotes are data for the
# engine's parser.
# shellcheck disable=SC2089,SC2090
gather_host_facts() {
  local volume_list="" volume labels project container_id service
  local volumes_json="" projects_json="" images_json="" volume_list_json
  local -a volume_names=() project_names=() app_containers=()
  local -A project_seen=() container_seen=()

  if volume_list="$(docker volume ls --filter "name=${database_volume_key}" --format '{{.Name}}' 2>/dev/null)"; then
    volume_list_json="$(base64_string "$volume_list")"
    while IFS= read -r volume || [[ -n "$volume" ]]; do
      [[ "$volume" == *"$database_volume_key" ]] || continue
      [[ "$volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || continue
      volume_names+=("$volume")
    done <<< "$volume_list"
  else
    volume_list_json=null
  fi
  ((${#volume_names[@]} <= 256)) ||
    fail "Could not verify the existing Orbit database volume; refusing to start Compose."

  for volume in "${volume_names[@]}"; do
    [[ -z "$volumes_json" ]] || volumes_json+=","
    volumes_json+="{\"name\":$(base64_string "$volume")"
    project=""
    if labels="$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}' "$volume" 2>/dev/null)"; then
      volumes_json+=",\"labels\":$(base64_string "$labels")"
      project="${labels%%|*}"
    else
      volumes_json+=",\"labels\":null"
    fi
    volumes_json+=",\"containers\":$(encoded_fact docker ps -a --filter "volume=$volume" --format '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}')}"
    if [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ && -z "${project_seen[$project]:-}" ]]; then
      project_seen["$project"]=1
      project_names+=("$project")
    fi
  done

  for project in "${project_names[@]}"; do
    local containers=""
    [[ -z "$projects_json" ]] || projects_json+=","
    if containers="$(docker ps -a --filter "label=com.docker.compose.project=$project" \
      --format '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}' 2>/dev/null)"; then
      projects_json+="{\"name\":$(base64_string "$project"),\"containers\":$(base64_string "$containers")}"
      while IFS='|' read -r container_id _ service _ || [[ -n "$container_id" ]]; do
        [[ "$service" == orbit-app && "$container_id" =~ ^[0-9a-f]{12,64}$ && -z "${container_seen[$container_id]:-}" ]] || continue
        container_seen["$container_id"]=1
        app_containers+=("$container_id")
      done <<< "$containers"
    else
      projects_json+="{\"name\":$(base64_string "$project"),\"containers\":null}"
    fi
  done

  for container_id in "${app_containers[@]}"; do
    [[ -z "$images_json" ]] || images_json+=","
    images_json+="{\"container\":$(base64_string "$container_id"),\"image\":$(encoded_fact docker inspect --format '{{.Config.Image}}' "$container_id")}"
  done

  local cosign_json=false
  [[ "$cosign_usable" == 1 ]] && cosign_json=true
  ORBIT_INSTALL_HOST_FACTS="{\"targetBasename\":$(base64_string "$(basename -- "$target_dir")")"
  ORBIT_INSTALL_HOST_FACTS+=",\"cosignUsable\":${cosign_json},\"imageVersion\":\"${image_version}\""
  ORBIT_INSTALL_HOST_FACTS+=",\"imageRevision\":\"${revision}\",\"appliedDigest\":\"${applied_digest}\""
  ORBIT_INSTALL_HOST_FACTS+=",\"volumeList\":${volume_list_json}"
  ORBIT_INSTALL_HOST_FACTS+=",\"volumes\":[${volumes_json}],\"projects\":[${projects_json}],\"images\":[${images_json}]}"
  export ORBIT_INSTALL_HOST_FACTS
}

# --- the engine one-off ------------------------------------------------------

# Files the engine writes on the host belong to the operator (#1210 D5).
engine_host_identity() {
  local security_options
  # Fail closed: a guessed "not rootless" hands the files to a uid the
  # operator cannot reach.
  security_options="$(docker info --format '{{.SecurityOptions}}' 2>/dev/null)" ||
    fail "Could not tell whether Docker is rootless, so refusing to guess who should own the deployment files. Check that 'docker info' works, then rerun."
  if [[ "$security_options" == *rootless* ]]; then
    host_uid=0
    host_gid=0
  else
    host_uid="$(id -u)"
    host_gid="$(id -g)"
  fi
}

# run_engine
#
# One `docker run --rm` of the verified image's engine (#1210 D1's shape,
# #1212 F1): the deployment directory mounted read-write at /orbit-deploy, a
# private directory for the outcome file, the launcher's directory when it
# gave one. Unlike configure.sh's one-offs it keeps the default network:
# OIDC discovery runs in here, against the same network the application
# will use (F5). `--init` makes the engine an ordinary child of a minimal
# init, so a signal reaches it as a signal. A terminal is passed through
# (D3) when there is one; machine prompts read stdin; otherwise stdin is
# closed, so a piped `curl | bash` never feeds the rest of this script to
# the engine. Sets engine_status.
run_engine() {
  local -a docker_args=(run --rm --init)
  local action="${requested_action:-auto}" tree reason=""
  local input=none

  engine_work_dir="$(mktemp -d "${TMPDIR:-/tmp}/orbit-install-engine.XXXXXX")" ||
    fail "Could not create a private temporary directory for the install engine."
  chmod 700 "$engine_work_dir" || fail "Could not restrict the install engine's temporary directory."

  if [[ "${ORBIT_CONFIGURE_PROMPTS:-}" == machine ]]; then
    input=pipe
    docker_args+=(-i -e ORBIT_INSTALL_INTERACTIVE=1)
  elif has_controlling_terminal; then
    input=terminal
    docker_args+=(-i -t -e ORBIT_INSTALL_INTERACTIVE=1)
  fi
  [[ "$plain_mode" == 1 ]] && docker_args+=(-e ORBIT_INSTALLER_PLAIN=1)
  [[ -n "${COMPOSE_PROJECT_NAME:-}" ]] && docker_args+=(-e COMPOSE_PROJECT_NAME)

  if [[ -n "$launcher_config_tree" ]]; then
    tree="$launcher_config_tree"
    while [[ "$tree" == */ && "$tree" != / ]]; do
      tree="${tree%/}"
    done
    if [[ -L "$tree" ]]; then
      reason="it is a symlink"
    elif [[ ! -e "$tree" ]]; then
      reason="it does not exist"
    elif [[ ! -d "$tree" ]]; then
      reason="it is not a directory"
    elif [[ "$tree" == *:* ]] || ! tree="$(cd -- "$tree" 2>/dev/null && pwd -P)"; then
      reason="it could not be entered"
    fi
    if [[ -n "$reason" ]]; then
      docker_args+=(-e "ORBIT_LAUNCHER_CONFIG_TREE_UNAVAILABLE=${reason}")
    else
      docker_args+=(-v "${tree}:${engine_launcher_tree_mount}:rw" -e "ORBIT_LAUNCHER_CONFIG_TREE=${engine_launcher_tree_mount}")
    fi
  fi

  # ORBIT_HOST_DEPLOY_DIR makes paths the engine prints host paths, as
  # backup.sh does.
  docker_args+=(
    -e ORBIT_HOST_UID="$host_uid"
    -e ORBIT_HOST_GID="$host_gid"
    -e ORBIT_HOST_DEPLOY_DIR="$target_dir"
    -e ORBIT_IMAGE="$resolved_reference"
    -e ORBIT_CHANNEL="$channel"
    -e ORBIT_INSTALLER_ELAPSED="$((SECONDS - installer_process_started_at))"
    -e ORBIT_INSTALL_HOST_FACTS
    -e ORBIT_INSTALL_PROFILE
    -e ORBIT_CONFIGURE_PROMPTS
    -e ORBIT_CONFIGURE_APP_URL
    -e ORBIT_CONFIGURE_OIDC_ISSUER
    -e ORBIT_CONFIGURE_OIDC_CLIENT_ID
    -e ORBIT_CONFIGURE_AUTH_MODE
    -v "${target_dir}:${engine_mount}:rw"
    -v "${engine_work_dir}:${engine_result_mount}:rw"
    --entrypoint node
    "$resolved_reference" "$engine_cli" install --action "$action"
    --dir "$engine_mount" --outcome "${engine_result_mount}/outcome"
  )

  engine_status=0
  case "$input" in
    terminal)
      if [[ -t 0 ]]; then
        docker "${docker_args[@]}" || engine_status=$?
      else
        docker "${docker_args[@]}" </dev/tty || engine_status=$?
      fi
      ;;
    pipe) docker "${docker_args[@]}" || engine_status=$? ;;
    *) docker "${docker_args[@]}" </dev/null || engine_status=$? ;;
  esac
}

# read_engine_outcome
#
# Reads the engine's key=value outcome file into engine_outcome[...]: only
# known keys, each value checked against its own pattern, the file a
# regular one. Returns 1 when there is no usable outcome.
declare -A engine_outcome=()
read_engine_outcome() {
  local file="${engine_work_dir}/outcome" line key value
  engine_outcome=()
  is_regular_non_symlink_file "$file" || return 1
  [[ "$(stat -c '%s' -- "$file" 2>/dev/null)" -le 8192 ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$line" == *=* ]] || return 1
    case "$key" in
      status) [[ "$value" =~ ^(ok|failed|stopped|repair)$ ]] || return 1 ;;
      fresh|model-pull) [[ "$value" =~ ^[01]$ ]] || return 1 ;;
      profile) [[ "$value" =~ ^(standard|processing|ai|full)$ ]] || return 1 ;;
      database-volume) [[ -z "$value" || "$value" =~ ^[a-z0-9][a-z0-9_-]*_orbit-db-data$ ]] || return 1 ;;
      phase|component|reason|action) [[ "$value" =~ ^[a-z][a-z-]{0,63}$ ]] || return 1 ;;
      message) [[ "$value" != *[[:cntrl:]]* && ${#value} -le 4096 ]] || return 1 ;;
      *) return 1 ;;
    esac
    engine_outcome["$key"]="$value"
  done < "$file"
  [[ -n "${engine_outcome[status]:-}" ]]
}

bounded_compose_probe() {
  # stdin is closed on purpose (#836): `timeout` runs the command in its own
  # process group, a background one when the installer has a terminal (the
  # launcher gives it one), and `compose exec` keeps stdin attached even with
  # -T. Its first read of the terminal would stop it with SIGTTIN, TERM cannot
  # wake a stopped process, and every probe would fail at the bound.
  if [[ "${optional_window:-0}" == 1 || "${rolling_forward:-0}" == 1 ]]; then
    run_interruptibly timeout --signal=TERM --kill-after=1s 5s \
      docker compose --project-name "$compose_project_name" --env-file "$environment_file" "$@" </dev/null
    return
  fi
  timeout --signal=TERM --kill-after=1s 5s \
    docker compose --project-name "$compose_project_name" --env-file "$environment_file" "$@" </dev/null
}

# stopping: an interrupt has asked the run to end (the optional phase's, or
# an update's after the commit).
stopping() {
  [[ "$optional_interrupted" == 1 || -n "$stop_status" ]]
}

# stop_point: between two steps of an update after the commit, a stop that
# came during the last one ends the run here, as a failure of the step
# about to begin (fail(), #1518).
stop_point() {
  [[ -z "$stop_status" ]] || fail "stopped"
}

# run_interruptibly <program> <argument>...
#
# In the optional phase, and on an update after the commit: runs the
# program as a background child and waits for it, so a trapped INT/TERM/HUP
# returns at once (bash runs a trap only
# after a foreground child ends), then kills the child itself -- it may not
# have had the signal: `timeout` puts itself in its own process group, and
# the signal may have been sent to this script alone. Returns 130 when
# interrupted.
run_interruptibly() {
  local status=0 tries
  "$@" &
  interruptible_pid=$!
  while :; do
    # A signal that landed before `wait` began is seen here, not after the
    # child ends by itself.
    if ! stopping; then
      if wait "$interruptible_pid"; then status=0; else status=$?; fi
    fi
    if stopping; then
      kill -TERM "$interruptible_pid" 2>/dev/null || true
      for ((tries = 0; tries < 30; tries++)); do
        kill -0 "$interruptible_pid" 2>/dev/null || break
        sleep 0.1
      done
      kill -KILL "$interruptible_pid" 2>/dev/null || true
      wait "$interruptible_pid" 2>/dev/null || true
      status=130
      break
    fi
    kill -0 "$interruptible_pid" 2>/dev/null || break
  done
  interruptible_pid=""
  return "$status"
}

probe_database_health() {
  # These variables expand inside the database container, not in the installer.
  # shellcheck disable=SC2016
  bounded_compose_probe exec -T orbit-db sh -ec \
    'exec pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1
}

probe_application_health() {
  bounded_compose_probe exec -T orbit-app node -e "$app_readiness_probe" >/dev/null 2>&1
}

probe_clamav_health() {
  bounded_compose_probe exec -T orbit-clamav clamdscan --ping 1 >/dev/null 2>&1
}

probe_tika_health() {
  bounded_compose_probe exec -T orbit-app node -e "$tika_readiness_probe" >/dev/null 2>&1
}

probe_ollama_health() {
  bounded_compose_probe exec -T orbit-ollama ollama list >/dev/null 2>&1
}

wait_for_component_health() {
  local phase="$1" component="$2" reason="$3" probe="$4"
  local deadline=$((SECONDS + 10#$readiness_timeout_seconds)) remaining pause
  while true; do
    ! stopping || return 1
    if "$probe"; then
      installer_ui_event "$phase" "$component" healthy "$reason" health
      return 0
    fi
    ! stopping || return 1
    installer_ui_event "$phase" "$component" waiting "$reason" wait
    remaining=$((deadline - SECONDS))
    ((remaining > 0)) || return 1
    pause=$((10#$readiness_poll_seconds))
    ((pause <= remaining)) || pause="$remaining"
    if [[ "$optional_window" == 1 || "$rolling_forward" == 1 ]]; then
      run_interruptibly sleep "$pause" || ! stopping || return 1
    else
      sleep "$pause"
    fi
    ((SECONDS < deadline)) || return 1
  done
}

# --- Docker's own words in a failure (#1455) ---------------------------------

# docker_reporting <command>...
#
# Runs a Docker command with its output captured in memory and bounded --
# not in a file: a full disk is one of the reasons it fails -- and, when it
# fails, keeps Docker's own words for fail() to show. pipefail keeps the
# command's own status.
#
# On an update after the commit (#1518) it runs as a background child
# (run_interruptibly), so a stop ends it at once rather than after it; the
# excerpt comes back through a pipe, still in memory. A stopped command's
# words are not kept: the stop, not Docker, is the cause. (The launcher's
# stop and a Ctrl-C reach the whole group, Docker's client included; a
# signal to this script alone ends the wait, and the pull it leaves running
# changes nothing that runs.)
docker_reporting() {
  local output status=0 words_fd
  if [[ "$rolling_forward" != 1 ]]; then
    if output="$("$@" 2>&1 | tail -c 16384)"; then
      return 0
    fi
    installer_failure_detail="$(printf '%s' "$output" | docker_output_excerpt)"
    return 1
  fi
  # A pipe open at both ends: the child writes the excerpt (at most
  # docker_output_bound characters, well inside a pipe's buffer) and a NUL,
  # and has ended before it is read, so the read never waits.
  exec {words_fd}<> <(:)
  run_interruptibly docker_reporting_child "$words_fd" "$@" || status=$?
  if ((status != 0)) && ! stopping; then
    IFS= read -r -d '' -t 1 -u "$words_fd" installer_failure_detail || true
  fi
  exec {words_fd}>&-
  ((status == 0))
}

# docker_reporting_child <fd> <command>...: docker_reporting's background
# half. pipefail keeps the command's own status.
docker_reporting_child() {
  local fd="$1" status=0
  shift
  "$@" 2>&1 | docker_output_excerpt >&"$fd" || status=$?
  printf '\0' >&"$fd"
  return "$status"
}

# docker_reporting_whole <bound-seconds> <command>...
#
# docker_reporting for the one step that is never cut part-way, `compose up`
# (#1518): an update stopped half-way through it is left with only some
# containers restarted. `timeout` runs the command in a process group of its
# own, so neither the launcher's stop (a signal to the installer's whole
# group) nor a terminal Ctrl-C reaches it, and the capture around it ignores
# INT, TERM and HUP, so its words are still read. bash runs the trap once it
# has ended. The bound is published (docs/engine-events.md): the launcher's
# grace for a stop after the commit is the bound plus a margin. stdin is
# closed, as for the probes (#836): a background group that reads the
# terminal is stopped.
docker_reporting_whole() {
  local bound="$1" output status=0
  shift
  if output="$(trap '' INT TERM HUP
    timeout --signal=TERM --kill-after=10s "${bound}s" "$@" </dev/null 2>&1 | tail -c 16384)"; then
    return 0
  else
    status=$?
  fi
  installer_failure_detail="$(printf '%s' "$output" | docker_output_excerpt)"
  if ((status == 124 || status == 137)); then
    installer_failure_notes+=("Docker Compose did not finish within ${bound} s, so it was stopped.")
  fi
  return 1
}

# docker_output_excerpt < docker-output
#
# Docker's output as one line a terminal and the launcher can show safely:
# escape sequences, bytes that are not valid UTF-8 (a raw 8-bit C1 such as
# 0x9b, when iconv is there), C0 and UTF-8-encoded C1 controls, and the
# bidirectional overrides U+202A-202E and U+2066-2069 removed (Docker's text
# is untrusted, held to the same no-control-characters rule as the engine's
# message in read_engine_outcome), only the lines that
# report a failure kept (Compose's progress lines dropped; the last line
# when none reads as an error), joined with " | ", and only the last
# docker_output_bound characters kept: the launcher wraps the last six
# stderr lines, and a long excerpt pushes its failure menu off the screen
# (#1485). Pipes only, no temporary file: the disk may be
# what is full.
docker_output_excerpt() {
  local esc=$'\033' joined
  joined="$(tail -c 16384 |
    LC_ALL=C sed -E "s|${esc}\\[[0-9;?]*[ -/]*[@-~]||g" |
    LC_ALL=C tr '\r\t' '\n ' |
    { if command -v iconv >/dev/null 2>&1; then iconv -c -f UTF-8 -t UTF-8 2>/dev/null || true; else cat; fi; } |
    LC_ALL=C sed $'s/\xc2[\x80-\x9f]//g; s/\xe2\x80[\xaa-\xae]//g; s/\xe2\x81[\xa6-\xa9]//g' |
    LC_ALL=C tr -d '\000-\010\013-\037\177' |
    LC_ALL=C awk '
      { gsub(/^ +| +$/, "") }
      length($0) == 0 { next }
      { last = $0 }
      /^(Network|Volume|Container|Image|Service) .* (Creating|Created|Recreate|Recreated|Starting|Started|Stopping|Stopped|Removing|Removed|Waiting|Healthy|Running|Exited|Pulling|Pulled|Building|Built|Skipped)$/ { next }
      tolower($0) ~ /error|fail|denied|refused|cannot|unable|no space|not found|invalid|timed out|timeout/ {
        printf "%s%s", separator, $0; separator = " | "; kept = 1
      }
      END { if (!kept && length(last) > 0) printf "%s", last }')" || joined=""
  if ((${#joined} > docker_output_bound)); then
    joined="...${joined: -$((docker_output_bound - 3))}"
  fi
  printf '%s' "$joined"
}

# --- the fresh-install rollback (#1456) --------------------------------------
#
# All-or-nothing install with a start record and rollback: a write-ahead
# journal with compensating undo, and quarantine instead of deletion. A fresh
# install -- an empty folder, or one holding only the pre-provisioned
# .env-orbit and .orbit-secrets (guarantee #6) -- that fails after the
# engine's commit puts the folder back as it found it and removes what it
# created in Docker: containers first, while docker-compose.yml still exists,
# then volumes by exact name. Before its first write the engine journals
# every path it may create; the rollback removes exactly those, and moves
# anything else new aside into orbit-install-backups/<stamp>/ inside the
# folder, never deleting it. Nothing is kept between runs: a rollback that
# cannot finish says what is left, and the next run starts from what it finds
# in the folder. The engine's own file transaction cannot do this part: it
# ends at its commit, before Compose runs, and removes its backup then (#56).
# An update is never rolled back.

# backup_root_is_sane
#
# orbit-install-backups is the installer's own folder by contract: a real
# directory of that name is ignored by everything that decides whether a
# folder is fresh, and nothing in it is ever read, run, moved or deleted. A
# symlink (dangling or not) or a file of that name is not usable.
backup_root_is_sane() {
  [[ ! -L "$backup_root" ]] && { [[ ! -e "$backup_root" ]] || [[ -d "$backup_root" ]]; }
}

# backup_dir_refused <required|optional> <reason>
#
# A dated folder that could not be made: a root this run made is removed
# again; with `required` the install is refused before anything changed,
# saying which cause applied and what to do, since each needs a different
# fix before a retry can work.
backup_dir_refused() {
  if [[ "$backup_root_created" == 1 ]] && rmdir -- "$backup_root" 2>/dev/null; then
    backup_root_created=0
  fi
  [[ "$1" == required ]] || return 1
  installer_ui_phase=host
  installer_ui_component=host
  fail_with failure abort "Could not make a backup folder under $(printf '%q' "$backup_root"): $2 Nothing was changed."
}

# prepare_backup_dir <required|optional>
#
# Makes this run's dated folder, backup_dir: orbit-install-backups/<stamp>,
# the stamp the run's UTC start time, `-2`..`-9` appended when that name
# exists. Each is an atomic `mkdir` (never `mkdir -p`), so an existing name is
# never reused or emptied. The root is made 0700 or, when it exists, accepted
# only as a real directory owned by the current user, and made 0700: it may
# hold secrets moved aside. With `required` a folder that cannot be made
# refuses the install before anything is changed; with `optional` (a
# rollback with a file to move) it returns 1.
prepare_backup_dir() {
  local mode="$1" suffix
  if [[ ! "$run_stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
    backup_dir_refused "$mode" "the clock could not be read to date it. Check that the date command works, then try again."
    return 1
  fi
  if ! backup_root_is_sane; then
    backup_dir_refused "$mode" "it is a link or a file, not a folder. Rename or remove it, then try again."
    return 1
  fi
  if [[ -d "$backup_root" ]]; then
    if [[ ! -O "$backup_root" ]] || ! chmod 700 -- "$backup_root"; then
      backup_dir_refused "$mode" "it is owned by another user or cannot be made private (0700) by this user. Change its owner to this user (chown), or rename or remove it, then try again."
      return 1
    fi
  elif mkdir -m 700 -- "$backup_root"; then
    backup_root_created=1
  else
    backup_dir_refused "$mode" "could not create it. Check that the install folder is writable by this user and has free space, then try again."
    return 1
  fi
  for suffix in "" -2 -3 -4 -5 -6 -7 -8 -9; do
    if mkdir -m 700 -- "${backup_root}/${run_stamp}${suffix}" 2>/dev/null; then
      backup_dir="${backup_root}/${run_stamp}${suffix}"
      return 0
    fi
    # Only a name that already exists moves on to the next suffix; any other
    # failure would fail the same way for every suffix.
    if [[ ! -e "${backup_root}/${run_stamp}${suffix}" && ! -L "${backup_root}/${run_stamp}${suffix}" ]]; then
      backup_dir_refused "$mode" "could not create a dated folder in it. Check that it is writable by this user and has free space, then try again."
      return 1
    fi
  done
  backup_dir_refused "$mode" "all nine dated names for this second ($run_stamp to $run_stamp-9) are already taken. Remove old dated folders you no longer need from it, then try again."
  return 1
}

# snapshot_fresh_target
#
# The start record for the files: before the engine runs, a candidate fresh
# folder's own entries are copied with `cp -a` (content, modes and structure,
# as the engine's rollback/original backup does, #9 #47) into
# orbit-install-backups/<stamp>/originals/ inside the folder, never under the
# home, state or temporary directory. Any other folder is an update or a
# refusal, and gets no start record.
snapshot_fresh_target() {
  local saved_options name
  local -a entries=() originals=()
  saved_options="$(shopt -p nullglob dotglob)" || true
  shopt -s nullglob dotglob
  entries=(*)
  eval "$saved_options"
  for name in "${entries[@]}"; do
    case "$name" in
      .env-orbit | .orbit-secrets) originals+=("$name") ;;
      orbit-install-backups) ;;
      *) return 0 ;;
    esac
  done
  backup_root="${target_dir}/orbit-install-backups"
  if ! backup_root_is_sane; then
    installer_ui_phase=host
    installer_ui_component=host
    fail_with failure abort "$(printf '%q' "$backup_root") is not a folder: the installer keeps its backups under that name and cannot use a file or a link there. Rename it, then install again. Nothing was changed."
  fi
  # An empty folder has nothing to copy: its record is the empty list, and
  # its backup folder is made only when a rollback has a file to move aside.
  # Armed from here like any fresh folder.
  if ((${#originals[@]} == 0)); then
    rollback_snapshot_taken=1
    rollback_armed=1
    return 0
  fi
  prepare_backup_dir required
  for name in "${originals[@]}"; do
    # Recorded before the copy, so a copy that dies part-way is removed too.
    rollback_original_entries+=("$name")
    if ! { [[ -d "${backup_dir}/originals" ]] || mkdir -m 700 -- "${backup_dir}/originals"; } ||
      ! cp -a -- "$name" "${backup_dir}/originals/${name}"; then
      rm -rf -- "${backup_dir:?}/originals" || true
      release_rollback_copies || true
      backup_dir=""
      rollback_original_entries=()
      installer_ui_phase=host
      installer_ui_component=host
      fail_with failure abort "Could not copy this folder's files to put it back if the install fails; nothing was changed. Check that you can read everything in this folder and that there is space for a copy in it, then install again."
    fi
  done
  rollback_snapshot_taken=1
  # Armed from here, not from the engine's outcome: an interrupt while the
  # engine runs may land after its commit. Putting the copy back over a
  # folder the engine never changed leaves it as it was.
  rollback_armed=1
}

# list_deployment_volumes <array-name>
#
# This project's own volumes that exist now, by exact name; returns 1 when
# Docker cannot say.
list_deployment_volumes() {
  local -n found_volumes="$1"
  local listing key name status=0
  found_volumes=()
  listing="$(bounded_docker 5 volume ls --filter "name=${compose_project_name}_orbit-" --format '{{.Name}}' 2>/dev/null)" || status=$?
  if ((status != 0)); then
    # The substitution's subshell cannot set the flag here, so set it again.
    note_rollback_docker_timeout "$status"
    return 1
  fi
  for key in "${deployment_volume_keys[@]}"; do
    name="${compose_project_name}_${key}"
    if [[ $'\n'"$listing"$'\n' == *$'\n'"$name"$'\n'* ]]; then
      found_volumes+=("$name")
    fi
  done
}

# created_deployment_volumes <array-name>
#
# The volumes this attempt created: there now, not there before `compose up`.
created_deployment_volumes() {
  local -n created_volumes="$1"
  local -a current=()
  local name before
  created_volumes=()
  list_deployment_volumes current || return 1
  for name in "${current[@]}"; do
    for before in "${rollback_preexisting_volumes[@]}"; do
      [[ "$name" != "$before" ]] || continue 2
    done
    created_volumes+=("$name")
  done
}

# shell_words <word>...
#
# A command line for the user to paste: every word shell-quoted, so a
# folder or project name can never become shell syntax.
shell_words() {
  local line
  printf -v line '%q ' "$@"
  printf '%s' "${line% }"
}

# bounded_docker <seconds> <docker-argument>...
#
# One Docker call that a hung daemon cannot hold past its bound (plus a
# second for the KILL); the timeout's exit 124 is a failure like any other.
# Bash runs a trapped signal only after its foreground child ends, and
# `timeout` runs in its own process group, out of reach of a terminal's
# Ctrl-C, so the bound is also the longest a trapped interrupt waits.
# stdin is closed for the reason given at bounded_compose_probe.
# Inside the rollback the bound is also trimmed to the time left on
# rollback_docker_deadline (deadline propagation: min(own cap, time left)),
# and with none left Docker is not run at all; either way of running out
# sets rollback_docker_timed_out so the report can name the cause.
bounded_docker() {
  local seconds="$1" left status=0
  shift
  if [[ -n "$rollback_docker_deadline" ]]; then
    left=$((rollback_docker_deadline - SECONDS))
    if ((left <= 0)); then
      rollback_docker_timed_out=1
      return 124
    fi
    ((seconds <= left)) || seconds="$left"
  fi
  timeout --signal=TERM --kill-after=1s "${seconds}s" docker "$@" </dev/null || status=$?
  note_rollback_docker_timeout "$status"
  return "$status"
}

# note_rollback_docker_timeout <status>
#
# Inside the rollback, a bounded Docker call that ran out of time: 124 when
# the TERM ended it, 137 when it ignored the TERM and the KILL did.
note_rollback_docker_timeout() {
  [[ -n "$rollback_docker_deadline" ]] || return 0
  [[ "$1" != 124 && "$1" != 137 ]] || rollback_docker_timed_out=1
}

# rollback_docker
#
# This attempt's volumes listed, then the containers down while
# docker-compose.yml is still in place, then each listed volume removed by
# its exact name -- never a wildcard, a prune or `down --volumes`, which
# would take a volume that predates this attempt. Only after `compose up`
# was tried: nothing earlier creates a container or a volume. Returns 1
# when something could not be removed.
rollback_docker() {
  local name
  local -a created=()
  [[ "$compose_started" == 1 ]] || return 0
  # Listed before `down`, the step most likely to hang, so a failed `down`
  # still knows which volumes the stop command must remove. The volumes
  # exist once `compose up` ran, so this list is already complete. Each
  # call's cap (listing 5 s, down 6 s, each removal 5 s) fits inside the
  # 8 s deadline rollback_fresh_install sets, which they all share.
  if ! created_deployment_volumes created; then
    # A daemon that cannot list in 5 s will not stop the containers in the
    # time left; the printed stop command does that later.
    rollback_volumes_unlisted=1
    rollback_down_failed=1
    return 1
  fi
  # The containers are being removed, so a short stop loses nothing: 2 s
  # to stop, the rest of the 6 s to kill and remove them and the network.
  if ! bounded_docker 6 compose --project-name "$compose_project_name" --env-file "$environment_file" \
    down --remove-orphans --timeout 2 >/dev/null 2>&1; then
    # The containers may still be running and using the volumes, so the
    # volumes are left: the one stop command removes them once the
    # containers are gone.
    rollback_down_failed=1
    rollback_down_volumes=("${created[@]}")
    return 1
  fi
  for name in "${created[@]}"; do
    bounded_docker 5 volume rm -- "$name" >/dev/null 2>&1 || rollback_failed_volumes+=("$name")
  done
  ((${#rollback_failed_volumes[@]} == 0))
}

# read_engine_journal
#
# Fills rollback_engine_entries from the engine's journal, `written` beside
# its outcome: one relative path per line, a directory the engine owns whole
# with a trailing slash. It crosses from the image to the host, so it is used
# only when it is a small regular file whose every line is a plain relative
# path with no `.` or `..` component, and every claim matches what stands in
# the folder: a file claimed where a directory is, or the reverse, is an
# older engine's journal of top-level names. Otherwise (or an image that
# writes none) it is not trusted, and every new entry but the scratch names
# is moved aside. Never fails.
read_engine_journal() {
  local file line size component path
  local path_pattern='^[A-Za-z0-9._-]{1,255}(/[A-Za-z0-9._-]{1,255})*/?$'
  local -a names=() components=()
  rollback_engine_entries=()
  rollback_journal_present=0
  [[ -n "$engine_work_dir" ]] || return 0
  file="${engine_work_dir}/written"
  is_regular_non_symlink_file "$file" || return 0
  size="$(wc -c < "$file" 2>/dev/null)" || return 0
  size="${size//[[:space:]]/}"
  if [[ ! "$size" =~ ^[0-9]+$ ]] || ((size > 8192)); then
    return 0
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ $path_pattern ]] || return 0
    IFS=/ read -r -a components <<< "${line%/}"
    for component in "${components[@]}"; do
      [[ "$component" != . && "$component" != .. ]] || return 0
    done
    names+=("$line")
  done < "$file" || return 0
  for line in "${names[@]}"; do
    path="${target_dir}/${line%/}"
    if [[ "$line" == */ ]]; then
      if [[ -L "$path" ]] || { [[ -e "$path" ]] && [[ ! -d "$path" ]]; }; then
        return 0
      fi
    elif [[ -d "$path" && ! -L "$path" ]]; then
      return 0
    fi
  done
  rollback_engine_entries=("${names[@]}")
  rollback_journal_present=1
}

rollback_moved_clause() {
  [[ "$rollback_moved" != 1 ]] || printf ' apart from the files moved out and named above,'
}

# The same, inside a sentence that goes on after it.
rollback_moved_phrase() {
  [[ "$rollback_moved" != 1 ]] || printf ', apart from the files moved out and named above'
}

# The unit rule, in the closing line, which is the one a launcher showing the
# last few lines still has.
rollback_unit_clause() {
  ((${#rollback_original_entries[@]} == 0)) ||
    printf ' (.env-orbit and .orbit-secrets put back as a unit: anything changed in or added to them while the install ran was replaced)'
}

# rollback_obstacle <format> <path>
#
# One sentence naming what the rollback could not do, the path shell-quoted.
rollback_obstacle() {
  local sentence
  # shellcheck disable=SC2059 # the formats are this script's own
  printf -v sentence "$1" "$(printf '%q' "$2")"
  rollback_obstacles+=("$sentence")
  rollback_entry_failed=1
  rollback_folder_failed=1
}

# rollback_move <relative-path> <moved|engine>
#
# Moves an entry into the dated folder's moved/ or engine/, its relative path
# kept, parents made 0700. A destination that already exists is never
# overwritten. In the planning walk it only notes that the dated folder is
# needed. Returns 1 when the entry was not moved.
rollback_move() {
  local destination="${backup_dir}/$2/$1"
  if [[ "$rollback_walk" == plan ]]; then
    rollback_needs_backup=1
    return 1
  fi
  [[ -n "$backup_dir" && ! -e "$destination" && ! -L "$destination" ]] || return 1
  (umask 077 && mkdir -p -- "${destination%/*}") || return 1
  mv -- "${target_dir}/$1" "$destination"
}

# rollback_claim_of <relative-path>
#
# Sets rollback_claim: `own` when the journal claims the path (a file, or a
# directory whole), `parent` when it claims something inside it, else `none`.
rollback_claim_of() {
  local claim
  rollback_claim=none
  for claim in "${rollback_engine_entries[@]}"; do
    if [[ "$claim" == "$1" || "$claim" == "$1/" ]]; then
      rollback_claim=own
      return 0
    fi
    [[ "$claim" != "$1/"?* ]] || rollback_claim=parent
  done
}

# rollback_entry <relative-path>
#
# One entry of the walk (rollback_walk is `plan` or `apply`). A path the
# journal claims is removed, or, when the containers could not be stopped,
# moved into engine/; a real directory holding claimed paths is descended
# into and then removed with rmdir, which cannot remove anything left in it;
# anything else is moved into moved/ (or, with no journal and the containers
# still up, into engine/ with everything else new).
rollback_entry() {
  local relative="$1" path="${target_dir}/$1" saved_options child
  local -a children=()
  if [[ "$rollback_journal_present" == 1 ]]; then
    rollback_claim_of "$relative"
    case "$rollback_claim" in
      own)
        if [[ "$rollback_down_failed" == 1 ]]; then
          rollback_move "$relative" engine || [[ "$rollback_walk" == plan ]] ||
            rollback_obstacle 'Could not move %s aside.' "$path"
        elif [[ "$rollback_walk" == apply ]] && ! rm -rf -- "$path"; then
          rollback_obstacle 'Could not remove %s.' "$path"
        fi
        return 0
        ;;
      parent)
        if [[ -d "$path" && ! -L "$path" ]]; then
          saved_options="$(shopt -p nullglob dotglob)" || true
          shopt -s nullglob dotglob
          children=("$path"/*)
          eval "$saved_options"
          for child in "${children[@]}"; do
            rollback_entry "${relative}/${child##*/}"
          done
          if [[ "$rollback_walk" == apply ]] && ! rmdir -- "$path" 2>/dev/null; then
            rollback_obstacle 'Could not remove %s.' "$path"
          fi
          return 0
        fi
        ;;
    esac
  fi
  if [[ "$rollback_journal_present" != 1 && "$rollback_down_failed" == 1 ]]; then
    if rollback_move "$relative" engine; then
      rollback_kept_unrecorded=1
      return 0
    fi
  elif rollback_move "$relative" moved; then
    rollback_moved_aside=1
    return 0
  fi
  [[ "$rollback_walk" == plan ]] || rollback_obstacle 'Could not move %s aside.' "$path"
}

# rollback_walk_folder <path>...
#
# The walk over the folder's top-level entries: the originals and
# orbit-install-backups are skipped; the engine's fixed scratch names are
# removed; everything else goes through rollback_entry.
rollback_walk_folder() {
  local path name original
  for path in "$@"; do
    name="${path##*/}"
    [[ -e "$path" || -L "$path" ]] || continue
    for original in "${rollback_original_entries[@]}"; do
      [[ "$name" != "$original" ]] || continue 2
    done
    [[ "$name" != orbit-install-backups ]] || continue
    # Fixed by contract: made before the engine's first staged write, or the
    # engine's atomic-write and lock-reclaim scratch names.
    case "$name" in
      .orbit-install-staging.* | .orbit-engine.lock | \
        .env-orbit.installing.* | .env-orbit.updating.* | .env-orbit.migrating.* | .orbit-engine.lock.stale-*)
        if [[ "$rollback_walk" == apply ]] && ! rm -rf -- "$path"; then
          rollback_obstacle 'Could not remove %s.' "$path"
        fi
        continue
        ;;
    esac
    rollback_entry "$name"
  done
}

# restore_originals
#
# Puts each original entry back from originals/ as a unit: the current entry
# removed (or, when the containers could not be stopped, moved into engine/,
# where the stop command needs it), then `cp -a` from the copy, then verified
# with `diff -r`. A put-back that fails keeps the copy and names it.
restore_originals() {
  local name path copy="${backup_dir}/originals"
  for name in "${rollback_original_entries[@]}"; do
    path="${target_dir}/${name}"
    if [[ -e "$path" || -L "$path" ]]; then
      if [[ "$rollback_down_failed" == 1 ]]; then
        rollback_move "$name" engine || {
          rollback_restore_failed "$path"
          continue
        }
      elif ! rm -rf -- "$path"; then
        rollback_restore_failed "$path"
        continue
      fi
    fi
    if ! cp -a -- "${copy}/${name}" "$path" ||
      ! diff -r --no-dereference -- "${copy}/${name}" "$path" >/dev/null 2>&1; then
      rollback_restore_failed "$path"
    fi
  done
}

rollback_restore_failed() {
  rollback_keep_originals=1
  rollback_restore_named=1
  rollback_restore_failed_paths+=("$1")
  rollback_obstacles+=("Could not put back $(printf '%q' "$1"); a copy of the original is kept in $(printf '%q' "${backup_dir}/originals").")
  rollback_folder_failed=1
}

# rollback_files
#
# Puts the folder back (section 2 of the design, redesign r5): a planning
# walk first, so the dated folder is made only when something has to be moved
# into it -- if it cannot be made, nothing is moved and the folder is left as
# the rollback found it -- then the walk itself, then the originals.
rollback_files() {
  local saved_options
  local -a present=()
  # Read here, not after the engine: a signal's trap reaches the rollback
  # before any line after run_engine.
  read_engine_journal
  [[ "$rollback_snapshot_taken" == 1 && -n "$target_dir" && "$target_dir" != / ]] || return 1
  saved_options="$(shopt -p nullglob dotglob)" || true
  shopt -s nullglob dotglob
  present=("$target_dir"/*)
  eval "$saved_options"
  rollback_walk=plan
  rollback_needs_backup=0
  rollback_walk_folder "${present[@]}"
  if [[ "$rollback_needs_backup" == 1 ]]; then
    if [[ -n "$backup_dir" ]] && ! backup_root_is_sane; then
      backup_dir=""
    elif [[ -z "$backup_dir" ]]; then
      prepare_backup_dir optional 2>/dev/null || true
    fi
    if [[ -z "$backup_dir" ]]; then
      rollback_obstacles+=("Could not make $(printf '%q' "$backup_root") to keep files in; nothing was moved.")
      rollback_nothing_moved=1
      rollback_folder_failed=1
      return 1
    fi
  fi
  rollback_walk=apply
  rollback_walk_folder "${present[@]}"
  restore_originals
  if [[ "$rollback_moved_aside" == 1 && "$rollback_journal_present" == 1 ]]; then
    rollback_report+=("Files this install did not write were moved, not deleted: they are in $(printf '%q' "${backup_dir}/moved")")
  elif [[ "$rollback_moved_aside" == 1 ]]; then
    rollback_report+=("The engine did not record which files it wrote (an image older than this installer, or an engine that stopped before recording), so everything new was moved, not deleted: it is in $(printf '%q' "${backup_dir}/moved")")
  elif [[ "$rollback_kept_unrecorded" == 1 ]]; then
    rollback_report+=("The engine did not record which files it wrote (an image older than this installer, or an engine that stopped before recording), and the containers' stop command needs its files, so everything new was kept together, not deleted, in $(printf '%q' "${backup_dir}/engine")")
  fi
  [[ "$rollback_moved_aside" != 1 && "$rollback_kept_unrecorded" != 1 ]] || rollback_moved=1
  [[ "$rollback_folder_failed" != 1 ]]
}

# rollback_fresh_install
#
# Docker first (Compose needs the files it is about to lose), then the
# folder, which is put back even when the containers could not be stopped:
# what the engine wrote is then kept whole in engine/, where the one stop
# command runs. Returns 0 only when everything the attempt created is gone.
# Sets rollback_action: `retry` when installing again can work (after the
# one command, when there is one), `abort` when the folder could not be put
# back. A second interrupt does not stop it half-way: INT, TERM and HUP are
# caught (not ignored, which every child would inherit) until it ends; a
# signal waits for the current Docker call. All its Docker calls share one
# 8 s deadline: the launcher kills 15 s after its TERM, a TERM landing in a
# bounded probe may already have cost 6 s, and the last kill-after adds 1 s.
rollback_fresh_install() {
  local status=0 stop_dir
  rollback_obstacles=()
  rollback_report=()
  rollback_down_failed=0
  rollback_down_volumes=()
  rollback_failed_volumes=()
  rollback_folder_failed=0
  rollback_restore_failed_paths=()
  rollback_entry_failed=0
  rollback_nothing_moved=0
  rollback_volumes_unlisted=0
  rollback_recovery_command=""
  rollback_stop_command=""
  trap 'rollback_interrupted=130' INT; trap 'rollback_interrupted=143' TERM; trap 'rollback_interrupted=129' HUP
  installer_ui_event rollback installer running rollback rollback 2>/dev/null || true
  rollback_docker_timed_out=0
  rollback_docker_deadline=$((SECONDS + 8))
  rollback_docker || status=1
  rollback_docker_deadline=""
  # First in the report, so it precedes the obstacles it explains.
  [[ "$rollback_docker_timed_out" != 1 ]] ||
    rollback_report+=("Docker did not finish within 8 s, so the rollback stopped waiting for it; what it could not do is named below. Once Docker is answering again (check that it is running and its disk is not full), run the command below.")
  rollback_files || status=1
  if [[ "$rollback_down_failed" == 1 ]]; then
    stop_dir="$target_dir"
    if [[ -n "$backup_dir" ]] && is_regular_non_symlink_file "${backup_dir}/engine/docker-compose.yml"; then
      stop_dir="${backup_dir}/engine"
    fi
    rollback_stop_command="cd $(printf '%q' "$stop_dir") && $(shell_words docker compose --project-name "$compose_project_name" --env-file "$environment_file" down --remove-orphans)"
    ((${#rollback_down_volumes[@]} == 0)) ||
      rollback_stop_command+=" && $(shell_words docker volume rm -- "${rollback_down_volumes[@]}")"
  fi
  if [[ "$status" == 0 ]]; then
    rollback_outcome=complete
    rollback_action=retry
    installer_ui_event rollback installer completed rollback rollback 2>/dev/null || true
  elif [[ "$rollback_folder_failed" == 1 ]]; then
    # Installing again cannot work until the person acts: no command, and
    # the copy of the originals is kept.
    rollback_outcome=incomplete
    rollback_action=abort
    ((${#rollback_original_entries[@]} == 0)) || rollback_keep_originals=1
  else
    # The folder is fresh again; what is left is in Docker.
    rollback_outcome=incomplete
    rollback_action=retry
    if [[ -n "$rollback_stop_command" ]]; then
      rollback_recovery_command="$rollback_stop_command"
    elif ((${#rollback_failed_volumes[@]} > 0)); then
      rollback_recovery_command="$(shell_words docker volume rm -- "${rollback_failed_volumes[@]}")"
    fi
  fi
  [[ "$rollback_keep_originals" == 1 ]] || release_rollback_copies || true
  ((rollback_interrupted == 0)) ||
    printf 'Orbit installer: An interrupt arrived during the rollback; the rollback was finished first.\n' >&2 || true
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  return "$status"
}

# print_rollback_report
#
# What the rollback moved, and where it is kept, one line each.
print_rollback_report() {
  local line
  for line in "${rollback_report[@]}"; do
    printf 'Orbit installer: %s\n' "$line" >&2 || true
  done
}

# print_rollback_obstacles
#
# The report of a rollback that could not finish: what is left, then the
# next step. A command is alone on its own line so it can be copied whole.
# Nothing here asks the person to delete anything, and the closing line
# fits the obstacle: an original to copy back, files left in the folder, or
# entries to clear (never the copy of the originals).
print_rollback_obstacles() {
  local obstacle name path copy_line
  local no_volume_line='If the next install names a volume this install left, remove that volume by the name it prints.'
  print_rollback_report
  if [[ "$rollback_folder_failed" == 1 ]]; then
    if [[ "$rollback_down_failed" == 1 ]]; then
      printf 'Orbit installer: This install could not be fully rolled back: the containers could not be stopped.\n' >&2 || true
    else
      printf 'Orbit installer: This install could not be fully rolled back.\n' >&2 || true
    fi
    for obstacle in "${rollback_obstacles[@]}"; do
      printf 'Orbit installer: %s\n' "$obstacle" >&2 || true
    done
    for name in "${rollback_failed_volumes[@]}"; do
      printf 'Orbit installer: The volume %s could not be removed.\n' "$name" >&2 || true
    done
    [[ "$rollback_volumes_unlisted" != 1 ]] ||
      printf 'Orbit installer: The volumes this install created could not be listed. %s\n' "$no_volume_line" >&2 || true
    # copy_line: a line above named the originals copy, either this one or a
    # "Could not put back" obstacle.
    copy_line="$rollback_restore_named"
    if [[ "$rollback_keep_originals" == 1 && "$rollback_restore_named" != 1 ]]; then
      printf "Orbit installer: A copy of this folder's original files is kept in %s.\n" "$(printf '%q' "${backup_dir}/originals")" >&2 || true
      copy_line=1
    fi
    [[ -z "$rollback_stop_command" ]] ||
      printf 'Orbit installer: To stop the containers, run this in a terminal:\n%s\n' "$rollback_stop_command" >&2 || true
    ((${#rollback_failed_volumes[@]} == 0)) ||
      printf 'Orbit installer: To remove the volumes, run this in a terminal:\n%s\n' "$(shell_words docker volume rm -- "${rollback_failed_volumes[@]}")" >&2 || true
    # The closing line depends on the obstacle: never a bare "clear what is
    # named above" under a line naming the backups folder or the copy.
    for path in "${rollback_restore_failed_paths[@]}"; do
      printf 'Orbit installer: Replace %s with the copy in %s, then install again.\n' \
        "$(printf '%q' "$path")" "$(printf '%q' "${backup_dir}/originals/$(basename -- "$path")")" >&2 || true
    done
    if [[ "$rollback_nothing_moved" == 1 ]]; then
      if [[ "$rollback_down_failed" == 1 || "$rollback_volumes_unlisted" == 1 ]] || ((${#rollback_failed_volumes[@]} > 0)); then
        printf 'Orbit installer: The files this install wrote are still in the folder. Fix the cause named above, then install again.\n' >&2 || true
      else
        printf 'Orbit installer: The containers and volumes were removed; the files this install wrote are still in the folder. Fix the cause named above, then install again.\n' >&2 || true
      fi
    fi
    if [[ "$rollback_entry_failed" == 1 ]]; then
      if [[ "$copy_line" == 1 ]]; then
        printf 'Orbit installer: Clear the entries this install could not remove, named above, then install again. The copy of your original files can stay where it is.\n' >&2 || true
      else
        printf 'Orbit installer: Clear the entries this install could not remove, named above, then install again.\n' >&2 || true
      fi
    fi
  elif [[ "$rollback_down_failed" == 1 ]]; then
    printf 'Orbit installer: This install could not be fully rolled back: the containers could not be stopped. The folder is as it was before%s%s; what this install wrote is kept in %s so the containers can still be stopped.\n' \
      "$(rollback_unit_clause)" "$(rollback_moved_phrase)" "$(printf '%q' "${backup_dir}/engine")" >&2 || true
    printf 'Orbit installer: Run this in a terminal, then install again:\n%s\n' "$rollback_recovery_command" >&2 || true
    if [[ "$rollback_volumes_unlisted" == 1 ]]; then
      printf 'Orbit installer: The volumes this install created could not be listed. %s\n' "$no_volume_line" >&2 || true
    elif ((${#rollback_down_volumes[@]} == 0)); then
      printf 'Orbit installer: %s\n' "$no_volume_line" >&2 || true
    fi
  elif ((${#rollback_failed_volumes[@]} > 0)); then
    for name in "${rollback_failed_volumes[@]}"; do
      printf 'Orbit installer: This install could not be fully rolled back: the volume %s could not be removed.\n' "$name" >&2 || true
    done
    printf 'Orbit installer: Run this in a terminal, then install again:\n%s\n' "$rollback_recovery_command" >&2 || true
  else
    printf 'Orbit installer: This install could not be fully rolled back: the volumes it created could not be listed. The folder is as it was before%s%s.\n' \
      "$(rollback_unit_clause)" "$(rollback_moved_phrase)" >&2 || true
    printf 'Orbit installer: %s\n' "$no_volume_line" >&2 || true
  fi
}

# release_rollback_copies
#
# Removes the copy of the original entries, then the emptied dated folder
# and the root this run made, each with rmdir, which cannot remove a folder
# that still holds moved/, engine/ or an earlier run's folder.
release_rollback_copies() {
  [[ -n "$backup_dir" ]] || return 0
  if ! rm -rf -- "${backup_dir}/originals"; then
    printf "Orbit installer: could not remove the copy of this folder's original files: %s.\n" "$(printf '%q' "${backup_dir}/originals")" >&2 || true
    return 1
  fi
  if rmdir -- "$backup_dir" 2>/dev/null && [[ "$backup_root_created" == 1 ]]; then
    rmdir -- "$backup_root" 2>/dev/null || true
  fi
  return 0
}

prepare_service_images() {
  installer_ui_phase=preparation
  installer_ui_component=database
  installer_ui_event preparation database starting service-preparation pull
  stop_point
  docker_reporting compose pull orbit-db ||
    fail_with image-registry retry "Could not prepare the Orbit database image."
  installer_ui_event preparation database completed service-preparation pull

  installer_ui_component=application
  # No actual pull call: the application image was already resolved and
  # pulled during the identity phase above. Still emits the same
  # starting/completed pair every sibling component in this phase gets
  # (#1151 O1-Q2), so a UI tracking per-component state never sees a
  # "completed" with no matching "starting".
  installer_ui_event preparation application starting service-preparation pull
  installer_ui_event preparation application completed service-preparation pull

  installer_ui_component=clamav
  installer_ui_event preparation clamav starting service-preparation pull
  stop_point
  docker_reporting compose pull orbit-clamav ||
    fail_with image-registry retry "Could not prepare the private scanner image."
  installer_ui_event preparation clamav completed service-preparation pull

  case "$selected_profile" in
    processing|full)
      installer_ui_component=tika
      installer_ui_event preparation tika starting service-preparation pull
      stop_point
      docker_reporting compose pull orbit-tika ||
        fail_with image-registry retry "Could not prepare the optional document-processing image."
      installer_ui_event preparation tika completed service-preparation pull
      ;;
    *) installer_ui_event preparation tika skipped service-preparation skip ;;
  esac
  case "$selected_profile" in
    ai|full)
      installer_ui_component=ollama
      installer_ui_event preparation ollama starting service-preparation pull
      stop_point
      docker_reporting compose pull orbit-ollama ||
        fail_with image-registry retry "Could not prepare the optional local-model service image."
      installer_ui_event preparation ollama completed service-preparation pull
      ;;
    *) installer_ui_event preparation ollama skipped service-preparation skip ;;
  esac
}

start_services() {
  local output

  # Starting the containers is the last step of preparing services, not the
  # database wait (#1455): the database is waited on only once they exist.
  installer_ui_phase=preparation
  installer_ui_component=compose
  # The start record for Docker (#1456): which of this project's volumes
  # existed before `compose up`. The engine already refused a fresh install
  # beside an existing database volume (#1151 O1-S3); the others may be
  # left from an older attempt, and stay. If Docker cannot say, nothing is
  # started, so nothing needs cleaning up.
  if [[ "$target_was_empty" == 1 ]] && ! list_deployment_volumes rollback_preexisting_volumes; then
    fail_with docker-host retry "Could not list Docker volumes before starting services, so a failed start could not be cleaned up; nothing was started."
  fi
  installer_ui_event preparation compose starting service-start start
  stop_point
  compose_started=1
  if ! docker_reporting_whole "$compose_up_timeout_seconds" \
    docker compose --project-name "$compose_project_name" --env-file "$environment_file" up -d --no-build --remove-orphans; then
    note_why_not_running orbit-db orbit-app
    # A fresh install is rolled back by fail(), Docker included, and then
    # says retry; an update keeps its deployment and points at Repair.
    fail_with docker-host repair "Orbit services could not be created or started."
  fi
  stop_point
  installer_ui_event preparation compose completed service-start start
}

# --- why a service is not ready (#1456 decision, note 40388) ------------------
#
# A readiness wait that ends is classified the way Kubernetes classifies a
# rollout: a container that is not running (exited, dead, restarting,
# created, missing) has failed; one still running with its probe failing has
# not yet progressed. The facts come from single `docker inspect --format`
# fields of the service's container only -- never its logs (the
# application's log carries the claim code; Postgres can log passwords) and
# never the whole inspect document (it holds the environment).

# inspect_field <container> <single-field template>
inspect_field() {
  local value
  value="$(timeout --signal=TERM --kill-after=1s 5s docker inspect --format "$2" "$1" 2>/dev/null </dev/null)" || return 1
  value="${value%%$'\n'*}"
  [[ "$value" != *[[:cntrl:]]* && "$value" != "<no value>" ]] || return 1
  printf '%s' "$value"
}

# container_facts <service>
#
# Sets container_state (running, stopped, missing or unknown),
# container_exit_code, and container_summary: one line naming the service
# and its facts.
container_facts() {
  local service="$1" id status exit_code oom restarts health error
  container_state=unknown
  container_exit_code=unknown
  container_restarts=unknown
  container_summary="${service}: its state could not be read"
  if ! id="$(bounded_compose_probe ps --all -q "$service" 2>/dev/null)"; then
    return 0
  fi
  id="${id%%$'\n'*}"
  if [[ -z "$id" ]]; then
    container_state=missing
    container_summary="${service} is not running: its container is missing"
    return 0
  fi
  [[ "$id" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || return 0
  status="$(inspect_field "$id" '{{.State.Status}}')" || return 0
  exit_code="$(inspect_field "$id" '{{.State.ExitCode}}')" || exit_code=""
  oom="$(inspect_field "$id" '{{.State.OOMKilled}}')" || oom=""
  restarts="$(inspect_field "$id" '{{.RestartCount}}')" || restarts=""
  health="$(inspect_field "$id" '{{.State.Health.Status}}')" || health=""
  error="$(inspect_field "$id" '{{.State.Error}}' | docker_output_excerpt)" || error=""
  [[ "$exit_code" =~ ^-?[0-9]{1,10}$ ]] || exit_code=unknown
  [[ "$oom" =~ ^(true|false)$ ]] || oom=unknown
  [[ "$restarts" =~ ^[0-9]{1,10}$ ]] || restarts=unknown
  [[ "$health" =~ ^[a-z]{1,16}$ ]] || health=""
  case "$status" in
    running) container_state=running ;;
    exited|dead|restarting|created|removing) container_state=stopped ;;
    *) return 0 ;;
  esac
  container_exit_code="$exit_code"
  container_restarts="$restarts"
  if [[ "$container_state" == running ]]; then
    container_summary="${service} is running:"
  else
    container_summary="${service} stopped:"
  fi
  container_summary+=" status=${status} exit-code=${exit_code} oom-killed=${oom} restarts=${restarts}"
  [[ -z "$health" || "$health" == none ]] || container_summary+=" health=${health}"
  [[ -z "$error" ]] || container_summary+=" error=${error:0:300}"
}

# free_space_summary
#
# One line: the space left (`df -Pk`) in this folder's file system and in
# Docker's data directory, the two a start fills. Either is left out when it
# cannot be read.
free_space_summary() {
  local root kb line=""
  kb="$(df -Pk -- "$target_dir" 2>/dev/null | awk 'NR == 2 { print $4 }')" || kb=""
  [[ ! "$kb" =~ ^[0-9]{1,15}$ ]] || line="$((kb / 1024)) MB available for this folder"
  root="$(timeout --signal=TERM --kill-after=1s 5s docker info --format '{{.DockerRootDir}}' 2>/dev/null </dev/null)" || root=""
  if [[ "$root" == /* && "$root" != *[[:cntrl:]]* && ${#root} -le 512 ]]; then
    kb="$(df -Pk -- "$root" 2>/dev/null | awk 'NR == 2 { print $4 }')" || kb=""
    [[ ! "$kb" =~ ^[0-9]{1,15}$ ]] || line+="${line:+; }$((kb / 1024)) MB available for Docker's data (${root})"
  fi
  [[ -z "$line" ]] || printf 'Free space: %s' "$line"
}

# note_why_not_running <service>...
#
# After a failed start: a facts line for each of these services whose
# container exists and is not running, then the free-space line.
note_why_not_running() {
  local service line
  for service in "$@"; do
    container_facts "$service"
    [[ "$container_state" != stopped ]] || installer_failure_notes+=("$container_summary")
  done
  line="$(free_space_summary)"
  [[ -z "$line" ]] || installer_failure_notes+=("$line")
}

# sample_restart_count <service>
#
# The service's restart count before its wait, for the crash-loop check.
sample_restart_count() {
  local id count
  id="$(bounded_compose_probe ps --all -q "$1" 2>/dev/null)" || return 0
  id="${id%%$'\n'*}"
  [[ "$id" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || return 0
  count="$(inspect_field "$id" '{{.RestartCount}}')" || return 0
  [[ ! "$count" =~ ^[0-9]{1,10}$ ]] || restarts_before["$1"]="$count"
}

# required_service_not_ready <service> <label> <stopped-reason> <running-reason>
#
# A required service's wait ended on a fresh install. A container that is not
# running has failed: its facts and the free space are shown and fail() rolls
# back, so the next step is a retry. One still running, or whose state
# cannot be read, has not failed: nothing is removed -- a rollback would
# delete the progress a retry needs -- and the deployment is left to finish
# starting, with Repair the next step.
required_service_not_ready() {
  local service="$1" label="$2" stopped_reason="$3" running_reason="$4" line check before
  container_facts "$service"
  # A crash loop (Kubernetes' CrashLoopBackOff) can read `running` at the
  # deadline: three or more restarts since before the wait is a failure. One
  # or two may be a slow start, and take the left-running path below.
  before="${restarts_before[$service]:-}"
  if [[ "$container_state" == running && "$before" =~ ^[0-9]+$ && "$container_restarts" =~ ^[0-9]+$ ]] &&
    ((10#$container_restarts - 10#$before >= 3)); then
    container_state=stopped
    container_summary="${container_summary/ is running:/ keeps restarting:} (restarts before the wait: ${before})"
  fi
  installer_failure_notes+=("$container_summary")
  if [[ "$container_state" == stopped || "$container_state" == missing ]]; then
    line="$(free_space_summary)"
    [[ -z "$line" ]] || installer_failure_notes+=("$line")
    fail_with "$stopped_reason" repair "${label} stopped before it was ready."
  fi
  rollback_armed=0
  check="cd $(printf '%q' "$target_dir") && $(shell_words docker compose --project-name "$compose_project_name" --env-file "$environment_file" ps)"
  if [[ "$container_state" == running ]]; then
    fail_with "$running_reason" repair "${label} did not report ready within ${readiness_timeout_seconds} s; it is left running and may still finish starting. Check: ${check}. If it is not ready in a few minutes, run Repair."
  fi
  fail_with "$running_reason" repair "${label} did not report ready within ${readiness_timeout_seconds} s, and its state could not be read, so nothing was removed; the deployment is left in place. Check: ${check}. Then run Repair."
}

# optional_service_not_ready <component> <service> <label> <starting-note> <update-message>
#
# An optional service never fails a fresh install (#1456 decision): its last
# event is `waiting ... continue`, and the completion screen says why it is
# not ready. An update keeps failing on it, as before.
optional_service_not_ready() {
  local component="$1" service="$2" label="$3" starting="$4" message="$5"
  if [[ "$optional_interrupted" == 1 ]]; then
    optional_notes+=("${label}: ${starting}")
    installer_ui_event optional "$component" waiting optional-status continue
    return 0
  fi
  # An update keeps failing on an optional service -- except the local model
  # service on a run with a confirmed download: the download is its own step,
  # which never fails an install (#1474), and is not skipped for it.
  if [[ "$target_was_empty" != 1 ]] && ! [[ "$component" == ollama && "$model_pull_requested" == 1 ]]; then
    fail_with optional-unavailable repair "$message"
  fi
  container_facts "$service"
  case "$container_state" in
    stopped) optional_notes+=("${label}: stopped (exit ${container_exit_code}); run Repair.") ;;
    missing) optional_notes+=("${label}: not running (its container is missing); run Repair.") ;;
    *) optional_notes+=("${label}: ${starting}") ;;
  esac
  installer_ui_event optional "$component" waiting optional-status continue
}

wait_for_deployment_readiness() {
  installer_ui_phase=database
  installer_ui_component=database
  installer_ui_event database database starting database-health start
  [[ "$target_was_empty" != 1 ]] || sample_restart_count orbit-db
  if ! wait_for_component_health database database database-health probe_database_health; then
    [[ "$target_was_empty" == 1 ]] ||
      fail_with database-auth-migration repair "The database did not become healthy within the bounded startup window."
    required_service_not_ready orbit-db "The database" database-auth-migration database-auth-migration
  fi

  installer_ui_phase=application
  installer_ui_component=application
  installer_ui_event application application starting application-health start
  [[ "$target_was_empty" != 1 ]] || sample_restart_count orbit-app
  if ! wait_for_component_health application application application-health probe_application_health; then
    if [[ "$target_was_empty" != 1 ]]; then
      container_facts orbit-app
      [[ "$container_state" != running ]] ||
        fail_with health-timeout repair "Orbit did not report ready within the bounded startup window."
      fail_with application-startup repair "Orbit stopped before it could report ready; the bounded status does not claim an unproven cause."
    fi
    required_service_not_ready orbit-app "Orbit" application-startup health-timeout
  fi

  # The database and the application are ready: the deployment is real and
  # usable, and the optional phase only reports how the rest converges
  # (#1456 ruling, note 40394). The rollback is disarmed, and an interrupt
  # from here kills the waiting child and ends the optional waits.
  trap 'optional_interrupted=1' INT TERM HUP
  # An update's stop that came as the application became ready is the
  # optional phase's from here: the deployment is ready (#1518).
  if [[ -n "$stop_status" ]]; then
    optional_interrupted=1
    stop_status=""
  fi
  rolling_forward=0
  rollback_armed=0
  # Nothing is rolled back from here, so the copy of the originals goes.
  release_rollback_copies || true
  optional_window=1

  installer_ui_phase=optional
  installer_ui_component=clamav
  [[ "$optional_interrupted" == 1 ]] || installer_ui_event optional clamav starting optional-status health
  if [[ "$optional_interrupted" == 1 ]] || ! wait_for_component_health optional clamav optional-status probe_clamav_health; then
    optional_service_not_ready clamav orbit-clamav "Scanner" \
      "still starting (first signature download); uploads are refused until it is ready." \
      "The private scanner did not become healthy within the bounded startup window."
  fi

  case "$selected_profile" in
    processing|full)
      installer_ui_component=tika
      [[ "$optional_interrupted" == 1 ]] || installer_ui_event optional tika starting optional-status health
      if [[ "$optional_interrupted" == 1 ]] || ! wait_for_component_health optional tika optional-status probe_tika_health; then
        optional_service_not_ready tika orbit-tika "Document processing" \
          "still starting; documents are processed once it is ready." \
          "The selected document-processing service did not become healthy within the bounded startup window."
      fi
      ;;
    *) installer_ui_event optional tika skipped optional-status skip ;;
  esac

  case "$selected_profile" in
    ai|full)
      installer_ui_component=ollama
      local ollama_ready=1
      [[ "$optional_interrupted" == 1 ]] || installer_ui_event optional ollama starting optional-status health
      if [[ "$optional_interrupted" == 1 ]] || ! wait_for_component_health optional ollama optional-status probe_ollama_health; then
        ollama_ready=0
        optional_service_not_ready ollama orbit-ollama "Local model service" \
          "still starting; it is used once it is ready." \
          "The selected local-model service did not become healthy within the bounded startup window."
      fi
      [[ "$model_pull_requested" != 1 ]] || pull_confirmed_model
      # The service's last event matches its completion line.
      [[ "$ollama_ready" == 1 ]] || installer_ui_event optional ollama waiting optional-status continue
      ;;
    *) installer_ui_event optional ollama skipped optional-status skip ;;
  esac
}

# pull_confirmed_model
#
# The confirmed model is downloaded by the one-off orbit-ollama-model-pull
# service, the documented command (#1474): orbit-ollama itself sits only on
# the internal processing network and has no route out. A failed download
# never fails the install: Orbit runs without it, and the pull's own words
# and the command to run it again are shown.
pull_confirmed_model() {
  local output="${engine_work_dir}/model-pull.out" again
  # A known, project-scoped name: the container outlives a killed client
  # (its first process is a shell with no TERM handler), so an interrupt
  # removes it by this name -- that container only, never `compose down`.
  local container="${compose_project_name}-orbit-ollama-model-pull-install"
  again="$(shell_words docker compose --env-file "$environment_file" --profile ai-model-pull run --rm orbit-ollama-model-pull)"
  if [[ "$optional_interrupted" != 1 ]]; then
    installer_ui_event optional ollama running service-preparation pull
    # A killed earlier run can leave this container behind; Docker refuses
    # a second one under the same name, so every retry would fail.
    timeout --signal=TERM --kill-after=1s 15s docker rm -f -- "$container" </dev/null >/dev/null 2>&1 || true
    # A background child, so an interrupt can stop the download (#1456
    # ruling); its words go to a private file, as a pipe would need a
    # foreground command substitution.
    if run_interruptibly docker compose --project-name "$compose_project_name" --env-file "$environment_file" \
      --profile ai-model-pull run --rm -T --name "$container" orbit-ollama-model-pull </dev/null >"$output" 2>&1; then
      installer_ui_event optional ollama completed service-preparation pull
      return 0
    fi
    if [[ "$optional_interrupted" == 1 ]]; then
      timeout --signal=TERM --kill-after=1s 15s docker rm -f -- "$container" </dev/null >/dev/null 2>&1 || true
    fi
  fi
  installer_ui_event optional ollama waiting optional-status continue
  if [[ "$optional_interrupted" == 1 ]]; then
    optional_notes+=("Local model: not downloaded (the install was interrupted); Orbit runs without it. To download it: ${again}")
    return 0
  fi
  installer_failure_detail="$(tail -c 16384 -- "$output" 2>/dev/null | docker_output_excerpt)" || installer_failure_detail=""
  if [[ -n "$installer_failure_detail" ]]; then
    printf 'Orbit installer: Docker said: %s\n' "$installer_failure_detail" >&2 || true
  fi
  installer_failure_detail=""
  optional_notes+=("Local model: the confirmed download did not complete; Orbit runs without it. To try again: ${again}")
}

print_completion_screen() {
  local public_url
  # The deployment is committed and running by now, so this is the generic
  # failure, never configuration-failure: that reason tells the launcher to
  # reconfigure and hands it the configure tree (#1227).
  public_url="$(read_environment_value APP_URL)" ||
    fail_with failure retry "The validated public URL could not be read for completion."

  printf '\nOrbit is ready.\n'
  printf 'Public URL: %s\n' "$public_url"
  printf 'Version: %s\n' "$image_version"
  printf 'Channel: %s\n' "$channel"
  printf 'Revision: %s\n' "${revision:0:12}"
  printf 'Image digest: %s\n' "$applied_digest"
  printf 'Optional profiles: %s\n' "$selected_profile"
  local note
  for note in "${optional_notes[@]}"; do
    printf '%s\n' "$note"
  done
  printf 'Status: docker compose --env-file %s ps\n' "$environment_file"
  printf 'Logs: docker compose --env-file %s logs --tail 200\n' "$environment_file"
  # ADR-0022 section 1: the claim is generated in the running process's
  # memory only and printed once, by the application after its start-up
  # reports, in the container's own log -- it has no file, no Compose secret and no installer-visible
  # form, so this is a pointer to where to read it, never the code itself.
  printf 'Claim this instance: run "docker compose --env-file %s logs orbit-app" and open the claim link it prints to create the first administrator.\n' "$environment_file"
  # #968 (slice 1 of #966): a hard block here was considered and rejected --
  # it would fail an offline install -- so this is an instruction, not a
  # gate. The administration screen carries its own persistent reminder
  # until a bundle is actually recorded.
  printf 'Export a recovery bundle now: run "bash scripts/backup.sh" then "bash scripts/export-recovery-bundle.sh <backup.tar>" in the deployment directory -- see "Exporting a recovery bundle" in the administrator guide. It is the only way back in if the encryption key is ever lost.\n'
}

# --- the bootstrap ------------------------------------------------------------

installer_ui_event host host starting host-tools check

# repair is signposted, never run, before anything else (#533): the two
# scripts' exit-code vocabularies collide (docs/engine-events.md, "Repair
# stream"). Install and update are the engine's to accept or refuse, since
# only it validates the target.
if [[ "$requested_action" == repair ]]; then
  printf 'phase=rollback component=installer state=blocked reason=repair-unavailable action=repair elapsed=%ss\n' \
    "$((SECONDS - installer_process_started_at))"
  printf 'Orbit installer: repair_unavailable; this installer does not perform repair. Run "bash scripts/repair.sh --check" from this directory to diagnose, then "--plan" to see what it would do. No deployment files or services were changed.\n' >&2
  exit 3
fi

target_dir="$(pwd -P)" || fail "Could not resolve the installation directory."
[[ "$target_dir" != *:* ]] ||
  fail "The installation directory's path contains a character Docker cannot mount; choose a directory without ':'."

command -v docker >/dev/null 2>&1 || fail "Docker is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
command -v timeout >/dev/null 2>&1 || fail "GNU timeout is required for bounded health checks."
installer_ui_event host host completed host-tools check

# Resolve the release manifest (ADR-0031 #7) and pin the pull to the digest
# it names, never a moving tag, so `latest`/`preview`/a version pin all
# become a lookup and never the identity itself (ADR-0008 already says this
# of tags).
installer_ui_phase=identity
installer_ui_component=image
installer_ui_event identity image starting image-identity pull
check_cosign_usable && cosign_usable=1 || cosign_usable=0

if [[ -n "${ORBIT_RELEASE_MANIFEST:-}" ]]; then
  # Handed over already verified -- by get-orbit.sh, or by the launcher via
  # ai/orbit-launcher#171's ORBIT_LAUNCHER_INSTALL_SCRIPT_PATH caller.
  [[ -f "$ORBIT_RELEASE_MANIFEST" ]] ||
    fail "ORBIT_RELEASE_MANIFEST does not point at a readable file: ${ORBIT_RELEASE_MANIFEST}."
  release_manifest_path="$ORBIT_RELEASE_MANIFEST"
else
  # Called directly, not via $(...): see the comment at the end of
  # self_fetch_release_manifest for why command substitution here would
  # silently drop its cleanup of release_manifest_work_dir.
  self_fetch_release_manifest
fi

manifest_digest="$(manifest_field "$release_manifest_path" digest)"
[[ "$manifest_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail "The release manifest names no valid image digest."

resolved_reference="${image_repository}@${manifest_digest}"
[[ "$resolved_reference" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]] ||
  fail "The release manifest's image reference is not an immutable digest reference."
docker_reporting docker pull --quiet "$resolved_reference" ||
  fail "Could not pull ${resolved_reference} named by the release manifest. If the image is private, authenticate with ${registry} first."

if ! inspect_output="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$resolved_reference" 2>/dev/null)"; then
  fail "Could not inspect ${resolved_reference} to confirm its digest."
fi

digest_confirmed=0
while IFS= read -r candidate; do
  if [[ "$candidate" == "$resolved_reference" ]]; then
    digest_confirmed=1
    break
  fi
done <<< "$inspect_output"
[[ "$digest_confirmed" == 1 ]] ||
  fail "The registry did not return an immutable digest matching ${resolved_reference} named by the release manifest."

if [[ "$cosign_usable" == 1 ]]; then
  if ! cosign verify "$resolved_reference" \
    --certificate-identity-regexp "$countersign_identity_regexp" \
    --certificate-oidc-issuer "$countersign_oidc_issuer" \
    > /dev/null 2>&1; then
    if [[ "$release_manifest_stable" == 1 ]]; then
      fail "cosign could not verify the countersignature on ${resolved_reference}; refusing on channel ${channel}."
    fi
    printf 'Orbit installer: no countersignature yet for %s; continuing with the release-manifest check only.\n' "$resolved_reference" >&2
  fi
fi

# The image records the exact source revision that produced it. That revision
# is identity evidence, not a download location: the deployment assets come
# out of this same digest (ADR-0019), so a compose file cannot drift from the
# image it configures and no commit id has to stay resolvable for an install
# to work.
if ! revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$resolved_reference" 2>/dev/null)"; then
  fail "Could not inspect ${resolved_reference} for its source revision."
fi
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] ||
  fail "The published image does not record the source revision that produced it."

if ! image_version="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$resolved_reference" 2>/dev/null)"; then
  fail "Could not inspect the published image for its semantic version."
fi
semver_pattern='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
[[ "$image_version" =~ $semver_pattern ]] ||
  fail "The published image does not record a valid semantic version."
# A tag can be moved; the label inside a digest cannot. So when the operator
# pins a version tag, require the image's own embedded version to name that
# same release — an image parked at a version tag is not evidence that it is
# that version (ADR-0016).
if [[ "$channel" =~ $semver_pattern && "$image_version" != "$channel" ]]; then
  fail "The published image's embedded version (${image_version}) does not match the requested version tag (${channel})."
fi
readonly applied_digest="${resolved_reference##*@}"

# The image says where it keeps the assets it was built from. An image
# without that label predates ADR-0019 and cannot be installed from: there is
# nothing to extract, and the revision it names may no longer resolve. The
# label is read before the image is asked for its banner (#1016): an image
# built before ADR-0019 cannot render the banner either, and that failure
# reports a retryable registry fault, which sends an operator round a loop
# no retry can end. The supportability question is cheap, needs no
# container, and has the accurate answer.
readonly deployment_assets_root="/opt/orbit/deploy"
if ! bundled_assets_root="$(docker image inspect --format '{{index .Config.Labels "io.orbit.deployment-assets"}}' "$resolved_reference" 2>/dev/null)"; then
  fail "Could not inspect ${resolved_reference} for its bundled deployment assets."
fi
# This refusal can never succeed by retrying: the image was built before
# ADR-0019 and no later attempt against the same tag changes that. The
# default action for this phase is "retry" (default_failure_action), which
# would tell a consumer to loop forever (#1038); action=abort marks it
# terminal instead. install_ui is never loaded this early (load_installer_ui
# runs after assets are staged), so this raw fail() line bypasses
# installer-ui.sh's action vocabulary and abort is emitted verbatim — see
# #1038 for the launcher-side change still needed to treat it as terminal.
[[ -n "$bundled_assets_root" ]] ||
  fail_with image-registry abort "The published image was built before Orbit bundled its deployment assets and is not a supported install target (ADR-0016, ADR-0019)."
[[ "$bundled_assets_root" == "$deployment_assets_root" ]] ||
  fail "The published image records deployment assets somewhere other than ${deployment_assets_root}."
readonly bundled_assets_root

installer_ui_event identity image running image-identity inspect
# Captured, then shown: a launcher that went away (a closed stdout) must not
# turn into a banner the image "could not render".
if ! banner="$(docker run --rm --entrypoint /opt/orbit/scripts/container-entrypoint.sh \
  "$resolved_reference" --banner)"; then
  fail "The resolved Orbit image could not render its canonical banner."
fi
printf '%s\n' "$banner" || true
installer_ui_event identity image completed image-identity verify

gather_host_facts
engine_host_identity
snapshot_fresh_target

# The engine: everything that reads or writes the deployment (F1). It prints
# its own events and questions; what happened comes back in its outcome.
run_engine
if ! read_engine_outcome; then
  installer_ui_phase=configuration
  installer_ui_component=configuration
  # A fresh folder is rolled back like any other failure, staging directory
  # included, and the rollback's own report says whether the copy is kept.
  staging_note=""
  [[ "$rollback_armed" == 1 ]] ||
    staging_note=" A hard interruption leaves its staging directory for review: remove it, then rerun."
  fail_with failure retry "The install engine stopped without reporting a result (docker run exit status ${engine_status}); see the lines above.${staging_note}"
fi
# Without an outcome the engine may have committed, so the rollback stayed
# armed above. An outcome says: one that failed has rolled itself back, one
# that stopped changed nothing, and only a committed fresh install stays armed.
[[ "${engine_outcome[status]}" == ok && "${engine_outcome[fresh]:-}" == 1 ]] || rollback_armed=0
case "${engine_outcome[status]}" in
  ok)
    # The engine committed: from here a fresh install is rolled back on any
    # failure, this one included (#1456).
    [[ "${engine_outcome[fresh]:-}" != 1 ]] || rollback_armed=1
    # An update committed: from here it rolls forward (#1518). An interrupt
    # is recorded, not obeyed: the step under way ends (a pull or a wait at
    # once; `compose up` only by itself), and the run ends as its failure,
    # with the signal's exit status.
    if [[ "${engine_outcome[fresh]:-}" != 1 ]]; then
      trap 'stop_status=130' INT; trap 'stop_status=143' TERM; trap 'stop_status=129' HUP
      rolling_forward=1
    fi
    [[ "$engine_status" == 0 ]] ||
      fail_with failure retry "The install engine reported success but exited with status ${engine_status}."
    ;;
  failed)
    # The engine has already rolled back, and handed the launcher its tree
    # on a configuration-failure; the terminal event is this script's.
    installer_ui_phase="${engine_outcome[phase]:-configuration}"
    installer_ui_component="${engine_outcome[component]:-configuration}"
    fail_with "${engine_outcome[reason]:-failure}" "${engine_outcome[action]:-retry}" \
      "${engine_outcome[message]:-The install engine failed.}"
    ;;
  stopped)
    # Cancelled (130), the terminal closed (1) or an answer was refused (2);
    # the engine said which, and nothing was changed.
    flush_pending_ui_events
    [[ "$engine_status" =~ ^(1|2|130)$ ]] || engine_status=1
    exit "$engine_status"
    ;;
  repair)
    flush_pending_ui_events
    exit 3
    ;;
esac

# --- after the commit: Compose (F1's third phase) ---------------------------

# The files are committed by now. A failure from here on is never
# configuration-failure, which tells the launcher to reconfigure (#1227). On
# a fresh install it rolls the folder and Docker back (#1456); an update's
# committed files stay.
target_was_empty="${engine_outcome[fresh]}"
selected_profile="${engine_outcome[profile]}"
load_installer_ui || fail_with failure retry "The deployment's installer UI helper is unavailable."

compose_project_name="$(read_environment_value COMPOSE_PROJECT_NAME 2>/dev/null)" ||
  fail_with failure retry "Could not read the deployment's Docker Compose project name; refusing to start Compose."
[[ "$compose_project_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] ||
  fail_with failure retry "Could not verify the configured Docker Compose project name; refusing to start Compose."

# Guarantee #17: the database volume this update attached to is still the
# one, and the only one, by that exact name.
if [[ -n "${engine_outcome[database-volume]}" ]]; then
  recheck_volume="${engine_outcome[database-volume]}"
  recheck_list="$(docker volume ls --filter "name=^${recheck_volume}\$" --format '{{.Name}}' 2>/dev/null)" ||
    fail_with failure retry "Could not verify the existing Orbit database volume; refusing to start Compose."
  [[ "$recheck_list" == "$recheck_volume" ]] ||
    fail_with failure retry "The existing Orbit database volume changed during installation; refusing to start Compose."
fi

if [[ "${engine_outcome[model-pull]}" == 1 ]]; then
  model_pull_requested=1
  # The pull service reads OLLAMA_MODEL from .env-orbit itself (#1474).
  read_environment_value OLLAMA_MODEL >/dev/null 2>&1 ||
    fail_with failure retry "The confirmed local model could not be read from the configuration."
fi

export ORBIT_IMAGE="$resolved_reference"
installer_ui_phase=compose
installer_ui_component=compose
stop_point
if ! compose config --quiet >/dev/null 2>&1; then
  fail_with failure retry "Docker Compose configuration is invalid; review the named configuration fields and rerun."
fi
installer_ui_event compose compose completed compose-validation check
printf 'Orbit installer: configuration, OIDC discovery, and Docker Compose preflight passed; starting services.\n' || true

prepare_service_images
start_services
wait_for_deployment_readiness

installer_ui_phase=complete
installer_ui_component=installer
installer_ui_event complete installer completed deployment-ready complete
# Installed and ready: nothing after this is a reason to undo it.
rollback_armed=0
# Installed: a closed stdout only loses the screen, not the result.
print_completion_screen || true
