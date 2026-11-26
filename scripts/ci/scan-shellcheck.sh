#!/usr/bin/env bash
#
# Report-only shellcheck scan of every tracked shell script (#1592).
#
# Files: tracked *.sh/*.bash files plus tracked files whose first line is a
# sh/bash shebang, minus vendored and build directories. Writes shellcheck's
# json1 report to .orbit-code-scan/shellcheck.json and prints a summary.
# Exits 0 whatever shellcheck finds (report first, then block); exits non-zero
# when the pinned tool cannot be installed and verified, or leaves no readable
# json1 report.
#
# Usage (from anywhere): bash scripts/ci/scan-shellcheck.sh
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo_root"

shellcheck="$(bash scripts/ci/ensure-shellcheck.sh)" || exit 1

out_dir=".orbit-code-scan"
report="${out_dir}/shellcheck.json"
mkdir -p "$out_dir"

excluded='(^|/)(node_modules|vendor|dist|build|coverage|\.git)/'
shebang='^#![[:space:]]*(/usr/bin/env[[:space:]]+(-S[[:space:]]+)?)?(/[^[:space:]]*/)?(ba)?sh([[:space:]]|$)'
list="$(mktemp)"
trap 'rm -f "$list"' EXIT

while IFS= read -r -d '' f; do
  [[ -f "$f" && ! -L "$f" ]] || continue
  [[ "$f" =~ $excluded ]] && continue
  case "$f" in
    *.sh | *.bash) printf '%s\0' "$f" ;;
    *)
      first="$(head -n 1 -- "$f" 2> /dev/null | tr -d '\0' || :)"
      if [[ "$first" =~ $shebang ]]; then
        printf '%s\0' "$f"
      fi
      ;;
  esac
done < <(git ls-files -z) > "$list"

count="$(tr -cd '\0' < "$list" | wc -c)"
printf 'scan-shellcheck: %s scripts, %s\n' "$count" "$("$shellcheck" --version | sed -n 's/^version: /shellcheck /p')"

# The tool exits 1 when it has findings; that is the report, not a failure.
# One invocation, so the report is a single json1 document.
rc=0
if ((count > 0)); then
  xargs -0 "$shellcheck" --format=json1 < "$list" > "$report" || rc=$?
else
  printf '{"comments":[]}\n' > "$report"
fi
# A run that leaves no readable json1 report is a broken tool, not a clean
# result: fail, as the other scanners do, and leave no report saying 0 findings.
if ! node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (!r || !Array.isArray(r.comments)) process.exit(1);
' "$report" 2> /dev/null; then
  printf 'scan-shellcheck: shellcheck exit %s and no readable report; failing. Findings never fail this scan, a broken run does.\n' "$rc" >&2
  rm -f "$report"
  exit 1
fi

node -e '
const fs = require("fs");
const comments = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).comments || [];
const byLevel = {}, byCode = {}, byFile = {};
for (const c of comments) {
  byLevel[c.level] = (byLevel[c.level] || 0) + 1;
  const k = "SC" + c.code; byCode[k] = (byCode[k] || 0) + 1;
  byFile[c.file] = (byFile[c.file] || 0) + 1;
}
const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
console.log("scan-shellcheck: " + comments.length + " findings in " + Object.keys(byFile).length + " files");
for (const l of ["error", "warning", "info", "style"]) console.log("  " + l.padEnd(8) + (byLevel[l] || 0));
console.log("  top codes: " + top(byCode, 10).map(([k, v]) => k + " x" + v).join(", "));
console.log("  top files: " + top(byFile, 5).map(([k, v]) => k + " x" + v).join(", "));
' "$report"
printf 'scan-shellcheck: report at %s (report-only, exit 0)\n' "$report"
exit 0
