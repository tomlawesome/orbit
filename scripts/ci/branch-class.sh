#!/usr/bin/env bash
# Print the class of a branch name: dev, preview, main, hotfix or other (#1362).
# Usage: branch-class.sh <branch>
#
# The one table the `classify` and `build_image` jobs read for the branch-to-
# gate mapping. `rules: if:` lines and the workflow rule stay literal in
# .gitlab-ci.yml: GitLab evaluates those before any script runs.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: branch-class.sh <branch>" >&2
  exit 2
fi
case "$1" in
  dev) echo dev ;;
  preview) echo preview ;;
  main) echo main ;;
  hotfix/*) echo hotfix ;;
  *) echo other ;;
esac
