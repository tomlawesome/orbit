#!/usr/bin/env bash
#
# The GitHub releases API calls shared by the three release-handoff scripts
# (#1824): github-upload-handoff.sh (GitLab fills and publishes a release),
# github-await-handoff.sh (GitHub reads it) and github-prune-handoffs.sh
# (GitLab deletes old ones). Source it; it runs nothing by itself, apart from
# reading GITHUB_API_URL and GITHUB_HANDOFF_REPO.
#
# Every call goes to the separate public handoff repository named by
# GITHUB_HANDOFF_REPO (<owner>/orbit-handoff), never to Orbit's own
# repository: GITHUB_REPOSITORY is deliberately not read, so a job that has it
# set cannot point the handoff at Orbit (ADR-0031).
#
# The caller defines fail() before sourcing, then calls gh_init with the
# token. The token goes into a header file in a private temporary directory,
# never on a command line, so it cannot show in a process listing or a shell
# trace; the directory is removed on exit.
#
# JSON is read with node, not jq: jq is not on every image these run on, and
# node is on all of them and on GitHub's runners (the same reason the other
# CI scripts read JSON with node).

gh_api="${GITHUB_API_URL:-https://api.github.com}"
gh_api="${gh_api%/}"
gh_repo="${GITHUB_HANDOFF_REPO:-}"
gh_tmp=""
# GitHub's list endpoints give at most 100 a page.
readonly GH_PER_PAGE=100
# A repository with more releases than this is not one this code was written for.
readonly GH_MAX_PAGES=100

gh_init() { # $1 token
  [[ "$gh_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
    fail "GITHUB_HANDOFF_REPO is not owner/name (the handoff repository, <owner>/orbit-handoff): ${gh_repo:-<unset>}"
  gh_tmp="$(mktemp -d)"
  trap 'rm -rf "$gh_tmp"' EXIT
  chmod 700 "$gh_tmp"
  printf 'Authorization: Bearer %s\n' "$1" > "${gh_tmp}/auth-header"
}

# Every call carries the token and pins the API version. --fail turns an HTTP
# error into a non-zero exit, and --show-error names it without the headers.
gh_curl() {
  curl --silent --show-error --fail \
    --header @"${gh_tmp}/auth-header" \
    --header 'X-GitHub-Api-Version: 2022-11-28' \
    "$@"
}

# Reads are retried a couple of times on GitHub's transient errors (5xx, 429);
# writes never are, so a write that half-happened is reported, not repeated.
gh_get() { # $1 url
  gh_curl --location --max-time 60 --retry 2 --retry-delay 3 \
    --header 'Accept: application/vnd.github+json' "$1"
}

# json <expression> [arg]: one value out of the JSON on stdin. The expression
# is JavaScript over `input` (the parsed document) and `arg`; a missing value
# prints nothing, an array prints one element per line, and a document that is
# not JSON exits 3.
json() {
  node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; }).on("end", () => {
      let input;
      try { input = JSON.parse(raw); } catch { process.exit(3); }
      const value = new Function("input", "arg", "return (" + process.argv[1] + ");")(input, process.argv[2]);
      if (Array.isArray(value)) process.stdout.write(value.map(String).join("\n") + (value.length ? "\n" : ""));
      else process.stdout.write(value === undefined || value === null ? "" : String(value));
    });
  ' -- "$1" "${2:-}"
}

# gh_pages <url-without-query> <row-expression>: fetches every page of a list
# endpoint and prints one tab-separated row per item, made by the expression
# over `r`. A page that is not a JSON array is a failure, never "no items".
gh_pages() {
  local url="$1" row="$2" page body count
  for ((page = 1; page <= GH_MAX_PAGES; page++)); do
    body="$(gh_get "${url}?per_page=${GH_PER_PAGE}&page=${page}")" ||
      fail "GitHub refused ${url#"$gh_api"} (page ${page})"
    count="$(json 'Array.isArray(input) ? input.length : ""' <<< "$body" || :)"
    [[ "$count" =~ ^[0-9]+$ ]] || fail "GitHub answered ${url#"$gh_api"} with something other than a list"
    json "input.map((r) => ${row})" <<< "$body"
    ((count == GH_PER_PAGE)) || return 0
  done
  fail "more than $((GH_PER_PAGE * GH_MAX_PAGES)) items at ${url#"$gh_api"}; refusing to guess"
}

# One row per release: id, tag name, draft (true/false), created_at,
# published_at (empty for a draft). GitHub sets created_at to the date of the
# commit the release tags, not when the release was made; published_at is when
# it was published.
gh_releases() {
  gh_pages "${gh_api}/repos/${gh_repo}/releases" \
    '[r.id, r.tag_name, r.draft === true, r.created_at, r.published_at ?? ""].join("\t")'
}

# One row per asset of a release: id, name, size.
gh_assets() { # $1 release id
  gh_pages "${gh_api}/repos/${gh_repo}/releases/$1/assets" \
    '[r.id, r.name, r.size].join("\t")'
}
