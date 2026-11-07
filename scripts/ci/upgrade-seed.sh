#!/usr/bin/env bash
#
# Upgrade matrix (#1663, part of #1647): seed an install on the old version,
# then read the data back after the update.
#
# Usage:
#   scripts/ci/upgrade-seed.sh seed     <target-dir> <base-url>
#   scripts/ci/upgrade-seed.sh readback <target-dir> <base-url>
#
# State lives in <target-dir>/.upgrade-seed/ (files and dir mode 600/700):
# cookie jar, CSRF header, seeded credentials, ids, document sha256.
# On failure prints `step=<verb> assertion=<id> detail="..."` and exits 1.
# Never prints the claim code, the password or a cookie: secrets only travel
# on stdin or in 600-mode files, never in argv.
#
# The API shapes are those of v0.3.3, checked by the #1647 spike. v0.3.3 to
# v0.3.5 share the same routes, so nothing here is keyed by version; if an older
# tag ever differs, branch on it here with a comment saying which tag.
set -Eeuo pipefail
umask 077

STEP="${1:-}"
TARGET="${2:-}"
BASE="${3:-}"
case "$STEP" in seed | readback) ;; *)
  echo "usage: $0 seed|readback <target-dir> <base-url>" >&2
  exit 2
  ;;
esac
if [ ! -d "$TARGET" ] || [ -z "$BASE" ]; then
  echo "usage: $0 seed|readback <target-dir> <base-url>" >&2
  exit 2
fi
BASE="${BASE%/}"
STATE="$TARGET/.upgrade-seed"
JAR="$STATE/cookies"
CSRF="$STATE/csrf-header"
CREDS="$STATE/credentials.json"
IDS="$STATE/ids.json"
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

# Origin the server expects: the APP_URL origin (https, not the loopback URL we
# connect to). Falls back to the base URL when there is no .env-orbit.
ORIGIN="$BASE"
if [ -f "$TARGET/.env-orbit" ]; then
  app_url="$(sed -n 's/^APP_URL=//p' "$TARGET/.env-orbit" | tail -n 1 | tr -d "\"'\r")"
  if [ -n "$app_url" ]; then
    ORIGIN="$(printf '%s' "$app_url" | sed -E 's#^([a-z]+://[^/]+).*#\1#')"
  fi
fi

fail() { # fail <assertion> <detail>
  local detail="${2//\"/\'}"
  printf 'step=%s assertion=%s detail="%s"\n' "$STEP" "$1" "${detail//$'\n'/ }"
  exit 1
}

STATUS=""
# call <method> <path> [stdin-body] -- sets STATUS, leaves the response in $BODY.
# Cookies and the CSRF header come from files so none of it reaches argv.
call() {
  local args=(-sS -o "$BODY" -w '%{http_code}' -X "$1" -b "$JAR" -c "$JAR"
    -H "Origin: $ORIGIN" -H 'Content-Type: application/json')
  [ -s "$CSRF" ] && args+=(-H "@$CSRF")
  [ $# -ge 3 ] && args+=(--data-binary @-)
  STATUS="$(curl "${args[@]}" "$BASE$2" <<<"${3:-}" 2>/dev/null)" || STATUS=000
}

login() { # POST the seeded credentials; sets STATUS
  call POST /api/auth/local/login "$(jq -c '{email, password}' "$CREDS")"
}

refresh_csrf() { # writes the CSRF header file from the current session
  call GET /api/auth/session
  [ "$STATUS" = 200 ] || return 1
  jq -r '"X-CSRF-Token: " + .csrfToken' "$BODY" >"$CSRF"
}

uuid() { cat /proc/sys/kernel/random/uuid; }

# 1x1 PNG, 70 bytes: the server accepts only PDF, JPEG and PNG.
png() { base64 -d <<<'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='; }

seed() {
  local logs code hid sid iid did email password sha
  rm -rf "$STATE"
  mkdir -p "$STATE"
  : >"$JAR"

  # Default log format is text: take the line ending `sign-in screen: <code>`.
  logs="$(cd "$TARGET" && { docker compose --env-file .env-orbit logs --no-color orbit-app 2>/dev/null || true; })"
  code="$(sed -n 's/.*sign-in screen: *//p' <<<"$logs" | tail -n 1 | tr -d '[:space:]')"
  [ -n "$code" ] || code="$(sed -n 's/.*#claim=\([^[:space:]]*\).*/\1/p' <<<"$logs" | tail -n 1)"
  [ -n "$code" ] || fail claim-code-found "no claim notice in the orbit-app log"

  email="upgrade-seed@example.invalid"
  password="$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n')Aa1"
  EMAIL="$email" PASSWORD="$password" jq -n '{email: env.EMAIL, password: env.PASSWORD}' >"$CREDS"

  call POST /api/auth/bootstrap/claim "$(CLAIM="$code" jq -nc '{claim: env.CLAIM}')"
  [ "$STATUS" = 200 ] || fail claim-accepted "bootstrap/claim answered $STATUS"
  call POST /api/auth/bootstrap/local \
    "$(jq -c '{email, displayName: "Upgrade Seed", password}' "$CREDS")"
  [ "$STATUS" = 201 ] || fail claim-accepted "bootstrap/local answered $STATUS"

  # bootstrap/local already signed us in; this second login proves the credentials.
  login
  [ "$STATUS" = 200 ] || fail login-accepted "local/login answered $STATUS"
  refresh_csrf || fail login-accepted "auth/session answered $STATUS"

  hid="$(uuid)" sid="$(uuid)" iid="$(uuid)" did="$(uuid)"
  call POST /api/workspace/commands "$(jq -nc --arg h "$hid" --arg s "$sid" '{
    type: "household.create",
    household: {id: $h, name: "Upgrade Seed", timezone: "Europe/London", currency: "GBP",
      memberCount: 1, canManage: true, onboardingComplete: true,
      sections: [{id: $s, name: "Home", icon: "home", accent: "sage", visible: true}], items: []}}')"
  [ "$STATUS" = 200 ] || fail household-created "household.create answered $STATUS"
  call POST /api/workspace/commands "$(jq -nc --arg h "$hid" --arg s "$sid" --arg i "$iid" --arg a "$(uuid)" '{
    type: "item.upsert", householdId: $h, kind: "service",
    item: {id: $i, sectionId: $s, title: "Upgrade seed item", currency: "GBP",
      dueDate: "2030-01-01", recurrenceMonths: 12, importance: "normal"},
    activity: {id: $a, itemId: $i, occurredAt: "2030-01-01T00:00:00Z"}}')"
  [ "$STATUS" = 200 ] || fail item-created "item.upsert answered $STATUS: $(head -c 400 "$BODY")"

  png >"$STATE/document.png"
  sha="$(sha256sum "$STATE/document.png" | cut -d' ' -f1)"
  STATUS="$(curl -sS -o "$BODY" -w '%{http_code}' -X POST -b "$JAR" -c "$JAR" \
    -H "Origin: $ORIGIN" -H "@$CSRF" -H 'Content-Type: image/png' \
    -H 'x-orbit-filename: upgrade-seed.png' -H "x-orbit-document-id: $did" \
    --data-binary "@$STATE/document.png" "$BASE/api/households/$hid/items/$iid/documents" 2>/dev/null)" || STATUS=000
  # 202 means the scan is still running; the bytes are stored either way.
  case "$STATUS" in 201 | 202) ;; *) fail document-uploaded "upload answered $STATUS" ;; esac

  jq -n --arg h "$hid" --arg i "$iid" --arg d "$did" --arg s "$sha" \
    '{householdId: $h, itemId: $i, documentId: $d, sha256: $s}' >"$IDS"
  echo "seeded item $iid with document $did (sha256 $sha)"
}

# get <path> -- a GET that logs in once more on 401 (R4: the session may not
# survive the update). One re-login per run, never a loop.
RELOGGED=0
get() {
  call GET "$1"
  if [ "$STATUS" = 401 ] && [ "$RELOGGED" = 0 ]; then
    RELOGGED=1
    login
    if [ "$STATUS" = 200 ]; then call GET "$1"; fi
  fi
}

readback() {
  local iid did want got
  [ -s "$IDS" ] || fail health-ready "no seed state under $STATE"
  iid="$(jq -r .itemId "$IDS")" did="$(jq -r .documentId "$IDS")" want="$(jq -r .sha256 "$IDS")"

  call GET /api/health
  if [ "$STATUS" != 200 ] || [ "$(jq -r '.status // empty' "$BODY" 2>/dev/null)" != ready ]; then
    fail health-ready "health answered $STATUS"
  fi

  get /api/workspace
  [ "$STATUS" = 200 ] || fail item-readable "workspace answered $STATUS"
  jq -e --arg i "$iid" '[.workspace.households[]?.items[]?.id] | index($i) != null' "$BODY" >/dev/null ||
    fail item-readable "seeded item not in the workspace"

  get "/api/documents/$did/download"
  [ "$STATUS" = 200 ] || fail document-readable "download answered $STATUS"
  got="$(sha256sum "$BODY" | cut -d' ' -f1)"
  [ "$got" = "$want" ] || fail document-readable "sha256 differs from the seeded document"
  echo "readback ok: item $iid and document $did intact"
}

"$STEP"
