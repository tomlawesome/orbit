#!/usr/bin/env bash
#
# Report-only zizmor scan of the GitHub workflows and actions (#1592, report
# stage: owner decision, "report first, then block"). Exits 0 whatever zizmor
# finds; exits non-zero only when the pinned tool cannot be installed and
# verified (scripts/ci/ensure-zizmor.sh) or fails to run at all, so a missing,
# tampered or broken tool is never silent.
#
# Offline: no GitHub token is passed and --offline forbids network audits.
# Report: .orbit-code-scan/zizmor.json (zizmor --format=json, v1). Run from
# anywhere; it works from the repository root.
set -Eeuo pipefail

repo_root="$(CDPATH="" cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo_root"

zizmor="$(bash scripts/ci/ensure-zizmor.sh)" || exit 1

out_dir=".orbit-code-scan"
report="${out_dir}/zizmor.json"
mkdir -p "$out_dir"

# Workflow files and action definitions, skipping vendored and build dirs.
targets=()
while IFS= read -r -d '' f; do
  targets+=("$f")
done < <(find .github \( -path '*/node_modules' -o -path '*/.git' \) -prune -o \
  -type f \( -path '.github/workflows/*.yml' -o -path '.github/workflows/*.yaml' \
  -o -name action.yml -o -name action.yaml \) -print0 | sort -z)

if [[ ${#targets[@]} -eq 0 ]]; then
  printf '[]\n' > "$report"
  printf 'scan-zizmor: no workflows or actions found; nothing to scan.\n'
  exit 0
fi

start="$(date +%s)"
# Token variables are unset so nothing can turn on online audits.
rc=0
env -u GH_TOKEN -u GITHUB_TOKEN -u ZIZMOR_GITHUB_TOKEN \
  "$zizmor" --offline --no-progress --no-exit-codes --format=json \
  "${targets[@]}" > "$report" 2> "${out_dir}/zizmor.stderr" || rc=$?
elapsed=$(($(date +%s) - start))

printf 'scan-zizmor: zizmor exit %s, %s file(s), %ss, report %s (json v1)\n' \
  "$rc" "${#targets[@]}" "$elapsed" "$report"
if [[ $rc -ne 0 ]]; then
  printf 'scan-zizmor: zizmor failed to run (exit %s); failing. Findings never fail this scan, a broken run does:\n' "$rc" >&2
  head -n 20 "${out_dir}/zizmor.stderr" >&2 || :
  exit 1
fi

node -e '
const fs = require("fs");
const f = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const sev = {}, aud = {};
for (const x of f) {
  const s = x.determinations.severity;
  sev[s] = (sev[s] || 0) + 1;
  const k = x.ident + " (" + s + ")";
  aud[k] = (aud[k] || 0) + 1;
}
console.log("findings: " + f.length);
console.log("by severity: " + (Object.entries(sev).map(([k, v]) => k + "=" + v).join(" ") || "none"));
console.log("by audit:");
for (const [k, v] of Object.entries(aud).sort((a, b) => b[1] - a[1])) console.log("  " + String(v).padStart(4) + "  " + k);
console.log("top findings:");
const rank = { High: 0, Medium: 1, Low: 2, Informational: 3 };
f.sort((a, b) => (rank[a.determinations.severity] ?? 9) - (rank[b.determinations.severity] ?? 9));
for (const x of f.slice(0, 10)) {
  const l = x.locations[0].symbolic;
  console.log("  [" + x.determinations.severity + "] " + x.ident + " " + l.key.Local.verbatim_path + ":" + (x.locations[0].concrete.location.start_point.row + 1));
}
' "$report" || printf 'scan-zizmor: could not summarise the report (see %s)\n' "$report"
exit 0
