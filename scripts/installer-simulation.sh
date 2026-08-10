#!/usr/bin/env bash
set -Eeuo pipefail

# Safe, non-mutating simulation of the installer command centre (issue #260).
#
# Exercises the real command-centre renderer and input widgets from the fixed
# sibling installer-ui.sh against fixed, synthetic data. It never inspects or
# depends on a real target, never touches a file or directory, never invokes
# Docker, Compose, curl, network, registry or OIDC operations, never pulls an
# image or model, never starts or stops a service, never uses a real
# credential, and never persists, logs or replays anything typed into the
# hidden-input exercise. Repair stays presentation-only here; issue #261
# supplies real repair execution.

plain_mode=0
if [[ "${1:-}" == --plain ]]; then
  plain_mode=1
  shift
fi
[[ $# -eq 0 ]] || {
  printf 'Usage: %s [--plain]\n' "$0" >&2
  exit 2
}

simulation_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" ||
  { printf 'Orbit installer simulation: could not resolve the simulation script directory.\n' >&2; exit 1; }
simulation_ui_script="$simulation_dir/installer-ui.sh"
[[ -f "$simulation_ui_script" && ! -L "$simulation_ui_script" ]] ||
  { printf 'Orbit installer simulation: the simulation UI helper is missing or unsafe.\n' >&2; exit 1; }
# The UI helper is the fixed local sibling shipped with this script, never a
# fetched or caller-supplied path.
# shellcheck source=./installer-ui.sh
source "$simulation_ui_script"

if [[ "$plain_mode" == 1 ]]; then
  export ORBIT_INSTALLER_PLAIN=1
  installer_ui_init --plain --simulation
else
  installer_ui_init --simulation
fi

has_controlling_terminal() {
  local terminal_fd=""
  if ! { exec {terminal_fd}<>/dev/tty; } 2>/dev/null; then
    return 1
  fi
  exec {terminal_fd}>&-
}

sim_pause() {
  # Bounded presentation pacing only; gates on nothing external and never
  # blocks longer than a fraction of a second.
  [[ "$installer_ui_mode" == tty ]] || return 0
  sleep 0.15
}

run_plain_simulation() {
  # Plain/non-TTY simulation is deterministic and always the fixed success
  # path: there is no interactive input to branch on.
  installer_ui_emit bootstrap installer starting initial begin
  installer_ui_emit host host completed host-tools check
  installer_ui_emit identity image completed image-identity verify
  installer_ui_emit assets assets completed assets-verified fetch
  installer_ui_emit configuration configuration completed configuration-migration verify
  installer_ui_emit oidc oidc completed provider-discovery verify
  installer_ui_emit compose compose completed compose-validation check
  installer_ui_emit database database healthy database-health health
  installer_ui_emit application application healthy application-health health
  installer_ui_emit optional clamav healthy optional-status health
  installer_ui_emit complete installer completed deployment-ready complete
  printf 'Orbit installer simulation: fixed synthetic success scenario (profile=standard).\n'
  printf 'Public URL: https://simulated.invalid.example\n'
  printf 'Image digest: SIMULATED-DIGEST-NOT-REAL\n'
  printf 'No deployment occurred.\n'
}

if [[ "$plain_mode" == 1 ]] || ! has_controlling_terminal; then
  run_plain_simulation
  exit 0
fi

terminal_fd=""
close_terminal() {
  [[ -z "$terminal_fd" ]] || { exec {terminal_fd}>&- 2>/dev/null || true; terminal_fd=""; }
}
cancel() {
  close_terminal
  exit "$1"
}

exec {terminal_fd}<>/dev/tty

top_choice="$(installer_ui_select "$terminal_fd" \
  'Simulation: Greetings, what can we do for you today? This is a safe rehearsal; nothing will be installed, updated or repaired.' install \
  install Install \
  update Update \
  repair Repair \
  exit Exit)" || cancel "$?"

if [[ "$top_choice" == exit ]]; then
  cancel 130
fi

if [[ "$top_choice" == repair ]]; then
  installer_ui_emit rollback installer blocked repair-unavailable repair
  printf 'Orbit installer simulation: repair_unavailable; issue #261 supplies repair execution. Nothing was changed.\n'
  printf 'No deployment occurred.\n'
  close_terminal
  exit 0
fi

profile_choice="$(installer_ui_select "$terminal_fd" \
  'Simulation: choose a deployment profile (synthetic; nothing is applied)' standard \
  standard 'Standard Orbit - required core and private scanning' \
  processing 'Document processing - optional local Tika' \
  full 'Full local stack - optional Tika and local Ollama' \
  custom 'Custom - choose one fixed supported optional-service combination')" || cancel "$?"

if [[ "$profile_choice" == custom ]]; then
  profile_choice="$(installer_ui_select "$terminal_fd" \
    'Simulation: custom optional services (synthetic; nothing is applied)' standard \
    standard 'No optional service' \
    processing 'Document processing only' \
    ai 'Local Ollama infrastructure only' \
    full 'Document processing and local Ollama infrastructure')" || cancel "$?"
fi

printf '\nBounded text-editing exercise: nothing typed here is saved, applied or logged.\n' >&"$terminal_fd"
sample_note="$(installer_ui_read_text "$terminal_fd" 'Sample deployment note (discarded immediately): ' 128)" || cancel "$?"
unset sample_note

printf '\nSynthetic hidden-input exercise: this is not a real credential prompt. Anything typed is discarded and never stored, logged or replayed.\n' >&"$terminal_fd"
installer_ui_read_secret "$terminal_fd" 'Synthetic hidden value (discarded, not a real credential): ' 128 >/dev/null || cancel "$?"

review_choice="$(installer_ui_select "$terminal_fd" \
  "Simulation final review: profile=${profile_choice}. Continue to a fixed representative scenario? Nothing is installed." apply \
  apply 'Continue to the fixed scenario choice' \
  cancel 'Cancel without changing files or services')" || cancel "$?"
[[ "$review_choice" == apply ]] || cancel 130

scenario_choice="$(installer_ui_select "$terminal_fd" \
  'Simulation: choose a fixed representative scenario to preview' success \
  success 'Success - synthetic services become healthy' \
  database-failure 'Representative failure - database authentication' \
  health-timeout 'Representative failure - application health timeout' \
  optional-failure 'Representative failure - optional service unavailable')" || cancel "$?"

close_terminal

case "$scenario_choice" in
  success)
    installer_ui_emit database database starting database-health start
    sim_pause
    installer_ui_emit database database healthy database-health health
    installer_ui_emit application application starting application-health start
    sim_pause
    installer_ui_emit application application healthy application-health health
    installer_ui_emit optional clamav healthy optional-status health
    installer_ui_emit complete installer completed deployment-ready complete
    printf '\nSimulation summary (synthetic; nothing was deployed):\n'
    printf 'Profile: %s\n' "$profile_choice"
    printf 'Public URL: https://simulated.invalid.example\n'
    printf 'Image digest: SIMULATED-DIGEST-NOT-REAL\n'
    ;;
  database-failure)
    installer_ui_emit database database starting database-health start
    sim_pause
    installer_ui_emit database database failed database-auth-migration repair
    printf '\nOrbit installer simulation: representative database-authentication failure shown above. This is a fixed, synthetic scenario; no real database or credential was involved.\n'
    ;;
  health-timeout)
    installer_ui_emit database database healthy database-health health
    installer_ui_emit application application starting application-health start
    sim_pause
    installer_ui_emit application application failed health-timeout repair
    printf '\nOrbit installer simulation: representative application-health-timeout failure shown above. This is a fixed, synthetic scenario; no real application was probed.\n'
    ;;
  optional-failure)
    installer_ui_emit database database healthy database-health health
    installer_ui_emit application application healthy application-health health
    installer_ui_emit optional clamav failed optional-unavailable repair
    printf '\nOrbit installer simulation: representative optional-service failure shown above. This is a fixed, synthetic scenario; no real optional service was probed.\n'
    ;;
esac
printf 'No deployment occurred.\n'
