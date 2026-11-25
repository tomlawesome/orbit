#!/usr/bin/env bash
#
# Report-only security scan of every tracked Python file with a pinned ruff
# (#1592). Runs only the S (flake8-bandit) rules; --isolated stops any ruff
# config in the repository from widening or changing that selection.
#
# Writes the full report (ruff's JSON output format) to
# .orbit-code-scan/ruff.json and prints counts by rule code. Exits 0 whatever
# ruff finds; exits non-zero only if the pinned ruff cannot be installed and
# verified (scripts/ci/ensure-ruff.sh), or the scan itself fails to run.
#
# Usage: bash scripts/ci/scan-ruff.sh   (from anywhere; runs at the repo root)
set -Eeuo pipefail

repo_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo_root"

ruff="$(bash scripts/ci/ensure-ruff.sh)" || {
  printf 'scan-ruff: could not install a verified ruff; failing.\n' >&2
  exit 1
}

out=".orbit-code-scan"
mkdir -p "$out"
report="${out}/ruff.json"

files=()
while IFS= read -r -d '' f; do
  [[ -f "$f" ]] || continue
  case "$f" in
    node_modules/* | */node_modules/* | .git/*) continue ;;
  esac
  files+=("$f")
done < <(git ls-files -z -- '*.py')

if ((${#files[@]} == 0)); then
  printf '[]\n' > "$report"
  printf 'scan-ruff: no tracked Python files; nothing to scan.\n'
  exit 0
fi

# ruff exits 1 when it finds something; that is not a failure here. Exit 2
# (abnormal termination) is: no report would exist.
rc=0
"$ruff" check --isolated --no-cache --select S --output-format=json \
  --exit-zero "${files[@]}" > "$report" || rc=$?
if ((rc != 0)); then
  printf 'scan-ruff: ruff failed to run (exit %d); failing.\n' "$rc" >&2
  exit 1
fi

# shellcheck disable=SC2016  # JS template literals, not shell expansions
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const by = {};
for (const f of r) by[f.code] = (by[f.code] || 0) + 1;
console.log(`scan-ruff: ${process.argv[2]} files scanned, ${r.length} findings (report-only) -> ${process.argv[1]}`);
for (const [c, n] of Object.entries(by).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) console.log(`  ${c}  ${n}`);
for (const f of r.slice(0, 10)) console.log(`  ${f.filename.replace(process.cwd() + "/", "")}:${f.location.row} ${f.code} ${f.message}`);
' "$report" "${#files[@]}"
exit 0
