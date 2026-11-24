#!/usr/bin/env bash
#
# Report-only opengrep code scan (#1592): runs the rules this repository keeps
# in .opengrep/rules/ -- and only those, never a registry or downloaded rule
# set (owner, #1592) -- over the server (src/), the web app (web/src/) and the
# CI and tooling scripts (scripts/), TypeScript, JavaScript and Svelte.
#
# Writes the full report in opengrep's JSON format to
# .orbit-code-scan/opengrep.json and prints counts by rule and severity plus
# the first findings. Exits 0 whatever the rules find: this is the report
# stage, blocking comes later. It exits non-zero only when the scan itself
# could not happen -- opengrep missing or failing verification
# (scripts/ci/ensure-opengrep.sh), or opengrep stopping with a fatal error --
# so a broken or tampered scanner is never mistaken for a clean result.
#
# Offline: with a local --config opengrep fetches nothing, and opengrep states
# it sends no metrics (there is no --metrics flag to pass). Where the kernel
# allows an unprivileged network namespace (unshare -rn) the scan also runs
# with no network at all; otherwise it runs normally and says so.
#
# Limits: opengrep has no Svelte parser. The JavaScript/TypeScript rules see
# .ts/.js/.mjs/.cjs files, not <script> blocks inside .svelte files; .svelte
# files are covered only by the regex rule for {@html}.
#
# Rules are tested with `opengrep test .opengrep/tests` (fixtures beside
# symlinks to each rule). Never use `opengrep validate`: it fetches a lint
# rule set from semgrep.dev.
#
# Usage (from anywhere; paths are resolved from the repository root):
#   bash scripts/ci/scan-opengrep.sh
set -Eeuo pipefail

repo_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo_root"

readonly RULES_DIR=".opengrep/rules"
readonly REPORT_DIR=".orbit-code-scan"
readonly REPORT="${REPORT_DIR}/opengrep.json"
readonly TARGETS=(src web/src scripts)
# Vendored, generated and fixture trees; opengrep also honours .gitignore.
readonly EXCLUDES=(node_modules .git .svelte-kit build dist coverage fixtures __fixtures__ "*.min.js")

fail() { printf 'scan-opengrep: %s\n' "$1" >&2; exit 1; }

opengrep="$(bash scripts/ci/ensure-opengrep.sh)" ||
  fail "opengrep is not available or failed verification; no scan was run"

[[ -d "$RULES_DIR" ]] || fail "no rules directory ${RULES_DIR}"
mkdir -p "$REPORT_DIR"

exclude_args=()
for pattern in "${EXCLUDES[@]}"; do
  exclude_args+=("--exclude=${pattern}")
done

runner=()
if unshare -rn true > /dev/null 2>&1; then
  runner=(unshare -rn)
  printf 'scan-opengrep: running with no network (unshare -rn)\n' >&2
else
  printf 'scan-opengrep: no unprivileged network namespace here; running with the local rules only\n' >&2
fi

started=$SECONDS
status=0
"${runner[@]}" "$opengrep" scan \
  --config "$RULES_DIR" \
  --json \
  --quiet \
  "${exclude_args[@]}" \
  "${TARGETS[@]}" > "$REPORT" 2> "${REPORT_DIR}/opengrep.log" || status=$?
elapsed=$((SECONDS - started))

# 0 = ran (with or without findings); 1 only appears with --error, unused here.
if ((status > 1)) || ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$REPORT" 2> /dev/null; then
  tail -n 20 "${REPORT_DIR}/opengrep.log" | sed 's/^/scan-opengrep: opengrep: /' >&2
  fail "opengrep did not complete (exit ${status}); see ${REPORT_DIR}/opengrep.log"
fi

node - "$REPORT" "$elapsed" <<'EOF'
const fs = require("fs");
const [report, elapsed] = process.argv.slice(2);
const j = JSON.parse(fs.readFileSync(report, "utf8"));
const results = j.results || [];
const count = (key) => results.reduce((m, r) => m.set(key(r), (m.get(key(r)) || 0) + 1), new Map());
const scanned = (j.paths && j.paths.scanned) || [];
console.log(`opengrep: ${results.length} finding(s) in ${scanned.length} scanned file(s), ${(j.errors || []).length} error(s), ${elapsed}s; report: ${report}`);
console.log("by rule:");
for (const [k, v] of [...count((r) => r.check_id.replace(/^.*\./, ""))].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
console.log("by severity:");
for (const [k, v] of [...count((r) => r.extra.severity)].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
const rank = { ERROR: 0, WARNING: 1, INFO: 2 };
const top = [...results].sort((a, b) => (rank[a.extra.severity] ?? 3) - (rank[b.extra.severity] ?? 3)).slice(0, 15);
if (top.length) console.log("first findings:");
for (const r of top) console.log(`  ${r.extra.severity.padEnd(7)} ${r.path}:${r.start.line}  ${r.check_id.replace(/^.*\./, "")}`);
for (const e of (j.errors || []).slice(0, 5)) console.log(`  error: ${(e.path || "")} ${(e.message || e.type || "").toString().split("\n")[0]}`);
EOF

printf 'scan-opengrep: report-only; findings do not fail this job\n' >&2
exit 0
