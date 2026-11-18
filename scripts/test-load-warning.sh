#!/usr/bin/env bash
# Prints one line when the 1-minute load average is above the CPU count, so a
# run on a loaded host is not trusted for its timeout failures (#1864). Never
# fails the run. ORBIT_TEST_LOAD1 and ORBIT_TEST_CPUS override the readings.
set -u

load1="${ORBIT_TEST_LOAD1:-}"
if [[ -z "$load1" && -r /proc/loadavg ]]; then
  read -r load1 _ < /proc/loadavg || load1=""
fi
cpus="${ORBIT_TEST_CPUS:-$(nproc 2> /dev/null || echo 1)}"

if [[ "$load1" =~ ^[0-9]+(\.[0-9]+)?$ && "$cpus" =~ ^[0-9]+$ ]] \
  && awk -v l="$load1" -v c="$cpus" 'BEGIN { exit !(l > c) }'; then
  printf 'Orbit tests: load average %s is above the %s CPUs; the run may fail by timeouts. Wait for the host to quiet, or lower ORBIT_TEST_WORKERS.\n' "$load1" "$cpus"
fi
exit 0
