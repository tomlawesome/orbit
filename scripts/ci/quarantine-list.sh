#!/bin/sh
# Prints the quarantine list for scripts/ci/flake-check.sh --quarantined: one
# line per @quarantine tag in the browser tests, derived from the tags
# themselves (the thing that really takes a test out of the gate), never kept
# by hand beside them (agent-infra scripts/flake-check/README.md, "Quarantine
# adapters"). The scan is scripts/check-quarantine.mjs's: every code file under
# tests/e2e and web/tests except the Playwright config, tag matched ignoring case.
#
# A tagged line that opens `test("title", ...` yields the title, which the flake
# heading must contain. A tag on a computed title or set by a condition (a
# template literal, `const tag = ...`) yields the file's name instead: the
# heading for such a test names its spec file.
set -eu

for dir in tests/e2e web/tests; do
  [ -d "$dir" ] || continue
  find "$dir" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.jsx' \
    -o -name '*.ts' -o -name '*.mts' -o -name '*.cts' -o -name '*.tsx' \) ! -name 'playwright.config.*'
done | sort | while IFS= read -r file; do
  grep -i '@quarantine' "$file" | while IFS= read -r line; do
    title=$(printf '%s\n' "$line" | sed -n "s/^[[:space:]]*test([\"'\`]\([^\"'\`\$]*\)[\"'\`],.*/\1/p")
    if [ -n "$title" ]; then
      printf '%s\n' "$title"
    else
      basename "$file"
    fi
  done
done | sort -u
