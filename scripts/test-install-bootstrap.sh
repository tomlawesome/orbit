#!/usr/bin/env bash
# Published-bootstrap install acceptance (issue #590).
#
# The documented way an operator installs a pre-release build is the
# bootstrap:
#
#   curl -fsSL https://raw.githubusercontent.com/tomlawesome/orbit/preview/scripts/install.sh \
#     | ORBIT_CHANNEL=preview bash
#
# Nothing else exercises that. scripts/test-install-acceptance.sh performs a
# real fresh install but builds its own image and serves every asset from the
# working tree through a fail-closed curl shim, so it never fetches the
# bootstrap, never resolves a published channel tag, and never touches a
# registry. This harness covers exactly those three steps:
#
#   1. install.sh is fetched over the network from the target branch and piped
#      to bash, as documented — not read from this checkout.
#   2. ORBIT_CHANNEL resolves the moving channel tag to an immutable digest,
#      and .env-orbit records ORBIT_IMAGE as repo@sha256:... — never the tag.
#   3. The digest the installer pinned is compared against the digest the
#      registry serves for that tag right now, asked for independently over
#      the registry API rather than through Docker.
#
# Deliberately the inverse of the acceptance harness's shim policy: there,
# every network fetch is intercepted so no external state can influence the
# result; here the network path *is* the subject, so fetches are real and only
# the OIDC discovery URL is redirected — to the disposable sidecar in
# tests/oidc, over TLS the shim actually verifies. No provider credential is
# involved, and none is needed: install.sh validates discovery for shape.
#
# The sidecar is reached through the shim rather than a hosts entry because
# configure.sh's validate_oidc_issuer refuses a loopback issuer, and adding a
# name to /etc/hosts needs root this host does not grant. The shim performs
# only the name and port translation a hosts entry would; the request, the
# response and the certificate check are real.
#
# What this does NOT cover: the interactive command centre. This is the piped
# bootstrap, which by construction has no controlling terminal, so install.sh
# takes its unattended path. The interactive path is covered by
# scripts/installer-simulation.sh and by the launcher compatibility gate
# (.github/workflows/launcher-install-compat.yml). Stated here because #590
# exists to stop that gap being silent.
#
# Usage:
#   bash scripts/test-install-bootstrap.sh [--branch preview] [--channel preview] [--keep]
#
#   --branch   branch to fetch install.sh from        (default: preview)
#   --channel  ORBIT_CHANNEL the installer resolves   (default: preview)
#   --keep     keep the work directory and containers on exit
#   --red      corrupt the expected digest and require the comparison to fire,
#              proving the assertion is not vacuous (as --red does in
#              scripts/test-install-acceptance.sh)
set -Eeuo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
branch="preview"
channel="preview"
keep_mode=0
red_mode=0
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --branch) branch="${2:?--branch needs a value}"; shift 2 ;;
    --channel) channel="${2:?--channel needs a value}"; shift 2 ;;
    --keep) keep_mode=1; shift ;;
    --red) red_mode=1; shift ;;
    *) printf 'test-install-bootstrap: unknown option %s\n' "$1" >&2; exit 2 ;;
  esac
done

repository="tomlawesome/orbit"
registry="ghcr.io"
issuer="https://orbit-oidc.bootstrap.invalid/application/o/orbit/"

note() { printf 'test-install-bootstrap: %s\n' "$1"; }
fail() { printf 'test-install-bootstrap: %s\n' "$1" >&2; exit 1; }

for command_name in curl docker jq node openssl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})'
}

workdir="$(mktemp -d /tmp/orbit-bootstrap.XXXXXX)"
# The target directory name becomes the Compose project the installer
# persists, so everything this run creates carries a name no other deployment
# on this host can own. See AGENTS.md on Compose project collisions.
# Lowercased: this becomes a Docker image tag as well as the Compose
# project, and a tag must be lowercase.
project_suffix="${workdir##*.}"
project_name="orbit-bootstrap-${project_suffix,,}"
target="$workdir/$project_name"
oidc_container="${project_name}-oidc"
oidc_port="$(free_port)"
orbit_port="$(free_port)"
while [[ "$orbit_port" == "$oidc_port" ]]; do orbit_port="$(free_port)"; done

cleanup() {
  local status=$?
  if [[ "$keep_mode" == 1 ]]; then
    note "kept: $workdir (compose project $project_name, oidc container $oidc_container)"
    return "$status"
  fi
  # Only ever this run's own project: never a bare `compose down` that could
  # adopt whatever COMPOSE_PROJECT_NAME a stray .env-orbit names.
  if [[ -f "$target/docker-compose.yml" ]]; then
    (cd "$target" && docker compose -p "$project_name" --env-file .env-orbit \
      down --volumes --remove-orphans >/dev/null 2>&1) || true
  fi
  docker rm -f "$oidc_container" >/dev/null 2>&1 || true
  rm -rf -- "$workdir"
  return "$status"
}
trap cleanup EXIT INT TERM

# --- the disposable identity provider --------------------------------------

start_oidc() {
  docker build --quiet -t "${project_name}-oidc:test" "$repo_root/tests/oidc" >/dev/null ||
    fail "could not build the disposable OIDC sidecar"
  docker run --detach --name "$oidc_container" \
    --env TEST_OIDC_ISSUER="$issuer" \
    --publish "127.0.0.1:${oidc_port}:4443" \
    "${project_name}-oidc:test" >/dev/null ||
    fail "could not start the disposable OIDC sidecar"

  # Its certificate is generated at start, so take it from the running
  # service and verify against it — the shim never disables verification.
  local waited=0
  until openssl s_client -connect "127.0.0.1:${oidc_port}" -showcerts </dev/null 2>/dev/null |
    openssl x509 -outform pem > "$workdir/oidc-ca.pem" 2>/dev/null &&
    [[ -s "$workdir/oidc-ca.pem" ]]; do
    waited=$((waited + 1))
    [[ "$waited" -lt 30 ]] || fail "the OIDC sidecar did not serve TLS within 30s"
    sleep 1
  done
  curl --fail --silent --show-error --cacert "$workdir/oidc-ca.pem" \
    "https://127.0.0.1:${oidc_port}/.well-known/openid-configuration" |
    jq -e --arg issuer "$issuer" '.issuer == $issuer' >/dev/null ||
    fail "the OIDC sidecar did not serve a discovery document for $issuer"
  note "disposable OIDC provider on 127.0.0.1:${oidc_port} issuing as $issuer"
}

# --- the one redirected URL ------------------------------------------------

make_shim() {
  mkdir -p "$workdir/shim"
  cat > "$workdir/shim/curl" <<SHIM
#!/usr/bin/env bash
# Pass-through curl. Every URL reaches the network unchanged except the OIDC
# discovery document, which is served by this run's own sidecar over verified
# TLS. Unlike the acceptance harness's shim this does not fail closed: the
# real fetches are what issue #590 exists to exercise.
set -Eeuo pipefail
discovery_url="${issuer}.well-known/openid-configuration"
rewritten="https://127.0.0.1:${oidc_port}/.well-known/openid-configuration"
args=()
for arg in "\$@"; do
  if [[ "\$arg" == "\$discovery_url" ]]; then
    args+=(--cacert "$workdir/oidc-ca.pem" "\$rewritten")
  else
    args+=("\$arg")
  fi
done
exec /usr/bin/curl "\${args[@]}"
SHIM
  chmod 755 "$workdir/shim/curl"
}

# --- what the registry says today ------------------------------------------

registry_digest() {
  local token
  token="$(curl --fail --silent --show-error \
    "https://${registry}/token?scope=repository:${repository}:pull&service=${registry}" |
    jq -r '.token')"
  [[ -n "$token" && "$token" != "null" ]] || fail "could not obtain an anonymous registry token"
  curl --fail --silent --show-error --head \
    --header "Authorization: Bearer ${token}" \
    --header 'Accept: application/vnd.oci.image.index.v1+json' \
    --header 'Accept: application/vnd.oci.image.manifest.v1+json' \
    --header 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
    --header 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
    "https://${registry}/v2/${repository}/manifests/${channel}" |
    tr -d '\r' | awk 'tolower($1) == "docker-content-digest:" { print $2 }'
}

# --- the pre-provisioned target --------------------------------------------

make_target() {
  mkdir -p -- "$target/.orbit-secrets"
  chmod 700 "$target/.orbit-secrets"
  printf 'bootstrap-client-secret\n' > "$target/.orbit-secrets/oidc-client-secret"
  chmod 600 "$target/.orbit-secrets/oidc-client-secret"
  # APP_URL is a deployment-ready public origin because configure.sh --check
  # refuses a loopback one; health is still probed on the published port.
  {
    printf 'APP_URL=https://orbit.bootstrap.invalid\n'
    printf 'ORBIT_PORT=%s\n' "$orbit_port"
    printf 'ORBIT_BIND_ADDRESS=127.0.0.1\n'
    printf 'OIDC_ISSUER=%s\n' "$issuer"
    printf 'OIDC_CLIENT_ID=orbit-bootstrap\n'
    printf 'OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret\n'
    printf 'OIDC_CALLBACK_URL=https://orbit.bootstrap.invalid/api/auth/callback\n'
  } > "$target/.env-orbit"
  chmod 600 "$target/.env-orbit"
}

# --- the run ---------------------------------------------------------------

expected_digest="$(registry_digest)"
[[ "$expected_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail "the registry did not return a digest for ${registry}/${repository}:${channel}"
note "registry serves ${channel} as ${expected_digest}"
if [[ "$red_mode" == 1 ]]; then
  # Flip the final nibble: still a well-formed digest, still not this one.
  case "${expected_digest: -1}" in
    0) expected_digest="${expected_digest%?}1" ;;
    *) expected_digest="${expected_digest%?}0" ;;
  esac
  note "red: expecting the corrupted digest ${expected_digest}"
fi

start_oidc
make_shim
make_target

bootstrap_url="https://raw.githubusercontent.com/${repository}/${branch}/scripts/install.sh"
note "fetching the bootstrap from ${bootstrap_url}"
curl --fail --silent --show-error --location "$bootstrap_url" > "$workdir/install.sh" ||
  fail "could not fetch install.sh from ${branch}"
[[ -s "$workdir/install.sh" ]] || fail "the fetched install.sh is empty"
if cmp --silent "$workdir/install.sh" "$repo_root/scripts/install.sh"; then
  note "the published bootstrap matches this checkout's install.sh"
else
  note "the published bootstrap differs from this checkout — testing the published one, as intended"
fi

note "installing into $target as Compose project $project_name (this pulls a real image)"
# Piped exactly as documented: bash reads the script from stdin, so the
# installer has no stdin of its own and no controlling terminal, which is the
# unattended path an operator following the README actually takes.
if ! (cd "$target" && env PATH="$workdir/shim:$PATH" ORBIT_CHANNEL="$channel" \
  timeout 1800 bash "$workdir/install.sh") > "$workdir/install.log" 2>&1; then
  tail -30 "$workdir/install.log" >&2
  fail "the published bootstrap did not complete"
fi

# --- assertions ------------------------------------------------------------

grep -q '^phase=complete .*state=completed' "$workdir/install.log" ||
  fail "terminal phase=complete event missing from the install log"

pinned="$(grep '^ORBIT_IMAGE=' "$target/.env-orbit" | head -1)"
pinned="${pinned#ORBIT_IMAGE=}"
[[ -n "$pinned" ]] || fail "no ORBIT_IMAGE was persisted"
case "$pinned" in
  *@sha256:*) ;;
  *) fail "persisted ORBIT_IMAGE is not digest-pinned: $pinned" ;;
esac
if [[ "$red_mode" == 1 ]]; then
  # The comparison is the point of this harness, so prove it can fail: the
  # expected digest was corrupted before the install, and a green result here
  # would mean the assertion never really looked.
  if [[ "$pinned" == "${registry}/${repository}@${expected_digest}" ]]; then
    fail "red run: the corrupted digest still compared equal — the assertion is vacuous"
  fi
  note "red: the digest comparison fired against $pinned"
  note "red run complete; no green result is claimed"
  exit 0
fi
[[ "$pinned" == "${registry}/${repository}@${expected_digest}" ]] ||
  fail "persisted ORBIT_IMAGE ($pinned) is not the digest the registry serves for ${channel} (${expected_digest})"
note "ORBIT_IMAGE pinned to $pinned"

curl --fail --silent --max-time 10 "http://127.0.0.1:${orbit_port}/api/health" |
  jq -e '.status == "ready" and .service == "orbit"' >/dev/null ||
  fail "/api/health did not report ready"

note "green: the published ${branch} bootstrap installed ${channel} at ${expected_digest} and reached a healthy /api/health"
note "not covered here: the interactive command centre — see the header"
