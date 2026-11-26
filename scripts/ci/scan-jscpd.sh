#!/usr/bin/env bash
#
# Report-only jscpd scan for duplicated code in the TypeScript, JavaScript and
# Svelte (#1596, report stage, as #1592's scanners). Exits 0 whatever jscpd
# finds; exits non-zero only when the pinned tool cannot be installed and
# verified (scripts/ci/ensure-jscpd.sh) or runs without leaving a report, so a
# missing, tampered or broken tool is never silent.
#
# Scans src/, web/src/ and scripts/. Tests, generated files (drizzle
# migrations, type declarations) and tmp/ are left out: duplication there is
# expected or not ours.
#
# Report: ${ORBIT_CODE_SCAN_DIR:-.orbit-code-scan}/jscpd.json (jscpd's json
# reporter). ORBIT_JSCPD_ENSURE names another ensure script (tests). Run from
# anywhere; it works from the repository root.
set -Eeuo pipefail

repo_root="$(CDPATH="" cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo_root"

jscpd="$(bash "${ORBIT_JSCPD_ENSURE:-scripts/ci/ensure-jscpd.sh}")" || {
  printf 'scan-jscpd: jscpd could not be installed and verified; failing.\n' >&2
  exit 1
}

out_dir="${ORBIT_CODE_SCAN_DIR:-.orbit-code-scan}"
report="${out_dir}/jscpd.json"
mkdir -p "$out_dir"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

ignores=(
  "**/*.test.*" "**/*.spec.*" "**/test/**" "**/tests/**" "**/__tests__/**"
  "**/test-support/**" "**/fixtures/**"
  "**/drizzle/**" "**/*.d.ts" "**/pnpm-lock.yaml" "**/package-lock.json"
  "**/tmp/**" "**/node_modules/**" "**/.svelte-kit/**" "**/build/**"
)
ignore_list="$(IFS=,; printf '%s' "${ignores[*]}")"

start="$(date +%s)"
rc=0
JSCPD_NO_TIPS=1 "$jscpd" \
  --format typescript,javascript,svelte \
  --ignore "$ignore_list" \
  --reporters json \
  --output "$work" \
  --silent \
  src web/src scripts > "${out_dir}/jscpd.stderr" 2>&1 || rc=$?
elapsed=$(($(date +%s) - start))

if [[ ! -s "${work}/jscpd-report.json" ]] ||
  ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "${work}/jscpd-report.json" 2> /dev/null; then
  printf 'scan-jscpd: jscpd exit %s and no readable report; failing. Findings never fail this scan, a broken run does:\n' "$rc" >&2
  head -n 20 "${out_dir}/jscpd.stderr" >&2 || :
  exit 1
fi
cp "${work}/jscpd-report.json" "$report"

printf 'scan-jscpd: jscpd exit %s, %ss, report %s\n' "$rc" "$elapsed" "$report"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const t = (r.statistics && r.statistics.total) || {};
const d = r.duplicates || [];
console.log("clones: " + d.length + (t.percentage !== undefined ? ", duplicated lines: " + t.percentage + "%" : ""));
const fmt = {};
for (const x of d) fmt[x.format] = (fmt[x.format] || 0) + 1;
console.log("by format: " + (Object.entries(fmt).map(([k, v]) => k + "=" + v).join(" ") || "none"));
' "$report" || printf 'scan-jscpd: could not summarise the report (see %s)\n' "$report"
exit 0
