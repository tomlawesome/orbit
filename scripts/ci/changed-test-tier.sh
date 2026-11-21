#!/usr/bin/env bash
# Reads changed paths on stdin, one per line; prints one word (#1934):
#   whole   a non-source file changed: every test runs
#   unit    app code under web/src/ or src/ changed: the --changed selection
#           plus all of tests/unit/ (tests that read source as text are not
#           reachable through imports)
#   changed only the --changed selection
# The strongest tier wins. Markdown and source files outside web/src/ and src/
# stay narrow.
set -eu
tier=changed
while IFS= read -r p || [ -n "$p" ]; do
  case "$p" in
    '' | *.md) ;;
    web/src/* | src/*)
      case "$p" in
        *.js | *.mjs | *.cjs | *.ts | *.mts | *.cts | *.svelte) tier=unit ;;
        *) tier=whole; break ;;
      esac
      ;;
    *.js | *.mjs | *.cjs | *.ts | *.mts | *.cts | *.svelte) ;;
    *) tier=whole; break ;;
  esac
done
printf '%s\n' "$tier"
