import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { PTY_DEADLINE_MS, PTY_TEST_TIMEOUT_MS, failOnPtyDeadline, ptyWatchdog } from "./pty-deadline.mjs";
import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// This suite is fully mocked: fake `docker` and `curl` executables are placed
// ahead of the real ones on PATH, so no test needs Docker, a registry,
// network access, Git or a TTY. It still spawns the real install.sh under
// bash, some through a pty; a spawn that takes tens of milliseconds quiet
// takes seconds on a starved core (#698). Budget and reasoning:
// scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const installScript = fileURLToPath(new URL("./install.sh", import.meta.url));
const configurationScriptPath = fileURLToPath(new URL("./configuration.sh", import.meta.url));
const backupScriptPath = fileURLToPath(new URL("./backup.sh", import.meta.url));
const restoreScriptPath = fileURLToPath(new URL("./restore.sh", import.meta.url));
const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));

const repository = "example/orbit-fixture";
const registry = "fake-registry.example";
const imageRepository = `${registry}/${repository}`;
const digest = "a".repeat(64);
const revision = "b".repeat(40);
const resolvedReference = `${imageRepository}@sha256:${digest}`;
const assetBase = `https://raw.githubusercontent.com/${repository}/${revision}`;
const preflightSuccessLine =
  "Orbit installer: configuration, OIDC discovery, and Docker Compose preflight passed; starting services.";
const deploymentAssets = [
  "docker-compose.yml",
  "docker-compose.mail.yml",
  "docker-compose.mail-alias-rotation.yml",
  ".env-orbit.example",
  "config/tika-config.json",
  "scripts/configure.sh",
  "scripts/installer-ui.sh",
  "scripts/configuration.sh",
  "scripts/backup.sh",
  "scripts/restore.sh",
  "scripts/repair.sh",
  "scripts/engine-check.sh",
];

const fakeDockerScript = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  "probe_ready() {",
  '  local name="$1" failures="$2" counter_file="${FAKE_PROBE_COUNTER_DIR:?}/$1" count=0',
  '  [[ ! -f "$counter_file" ]] || count="$(cat "$counter_file")"',
  '  count=$((count + 1))',
  '  printf "%s" "$count" > "$counter_file"',
  '  ((count > failures))',
  "}",
  "print_container_row() {",
  '  if [[ "${FAKE_DOCKER_TEMPLATE_DELIMITER:-}" == "|" ]]; then',
  "    printf '%s|%s|%s\\n' \"$1\" \"$2\" \"$3\"",
  "  else",
  "    printf '%s\\\\t%s\\\\t%s\\n' \"$1\" \"$2\" \"$3\"",
  "  fi",
  "}",
  'if [[ -n "${FAKE_CALL_LOG:-}" ]]; then',
  "  printf 'docker %s\\n' \"$*\" >> \"$FAKE_CALL_LOG\"",
  "fi",
  'case "$1" in',
  "  volume)",
  '    if [[ "${2:-}" == "ls" ]]; then',
  '      if [[ -n "${FAKE_DOCKER_VOLUME_NAMES:-}" ]]; then',
  '        printf "%s\\n" "${FAKE_DOCKER_VOLUME_NAMES}"',
  '      elif [[ "${FAKE_DOCKER_EXISTING_DB_VOLUME:-}" == "1" ]]; then',
  "        printf 'orbit_orbit-db-data\\n'",
  "      fi",
  '    elif [[ "${2:-}" == "inspect" ]]; then',
  '      if [[ "$*" == *"com.docker.compose.volume"* ]]; then',
  '        # docker volume inspect emits a literal backslash-t for this template.',
  '        if [[ "$*" == *"|"* ]]; then',
  "          printf '%s|orbit-db-data\\n' \"${FAKE_DOCKER_VOLUME_PROJECT:-orbit}\"",
  "        else",
  "          printf '%s\\\\torbit-db-data\\n' \"${FAKE_DOCKER_VOLUME_PROJECT:-orbit}\"",
  "        fi",
  "      else",
  '        printf "%s\\n" "${FAKE_DOCKER_VOLUME_PROJECT:-orbit}"',
  "      fi",
  "    fi",
  "    exit 0",
  "    ;;",
  "  ps)",
  '    if [[ "$*" == *"|"* ]]; then',
  '      FAKE_DOCKER_TEMPLATE_DELIMITER="|"',
  "    else",
  '      FAKE_DOCKER_TEMPLATE_DELIMITER="literal-tab"',
  "    fi",
  '    if [[ "$*" == *"volume="* ]]; then',
  "      print_container_row \"${FAKE_DOCKER_DB_CONTAINER_ID:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}\" \"${FAKE_DOCKER_DB_PROJECT:-${FAKE_DOCKER_VOLUME_PROJECT:-orbit}}\" \"${FAKE_DOCKER_DB_SERVICE:-orbit-db}\"",
  '      if [[ "${FAKE_DOCKER_DUPLICATE_DB_CONTAINER:-0}" == "1" ]]; then',
  "        print_container_row \"${FAKE_DOCKER_DUPLICATE_DB_CONTAINER_ID:-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc}\" \"${FAKE_DOCKER_DB_PROJECT:-${FAKE_DOCKER_VOLUME_PROJECT:-orbit}}\" \"${FAKE_DOCKER_DB_SERVICE:-orbit-db}\"",
  "      fi",
  '      if [[ "${FAKE_DOCKER_EXTRA_DB_VOLUME_CONSUMER:-0}" == "1" ]]; then',
  "        print_container_row \"${FAKE_DOCKER_EXTRA_DB_VOLUME_CONSUMER_ID:-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee}\" \"${FAKE_DOCKER_DB_PROJECT:-${FAKE_DOCKER_VOLUME_PROJECT:-orbit}}\" \"${FAKE_DOCKER_EXTRA_DB_VOLUME_CONSUMER_SERVICE:-worker}\"",
  "      fi",
  '    elif [[ "$*" == *"label=com.docker.compose.project="* ]]; then',
  "      print_container_row \"${FAKE_DOCKER_APP_CONTAINER_ID:-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}\" \"${FAKE_DOCKER_APP_PROJECT:-${FAKE_DOCKER_VOLUME_PROJECT:-orbit}}\" \"${FAKE_DOCKER_APP_SERVICE:-orbit-app}\"",
  '      if [[ "${FAKE_DOCKER_DUPLICATE_APP_CONTAINER:-0}" == "1" ]]; then',
  "        print_container_row \"${FAKE_DOCKER_DUPLICATE_APP_CONTAINER_ID:-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd}\" \"${FAKE_DOCKER_APP_PROJECT:-${FAKE_DOCKER_VOLUME_PROJECT:-orbit}}\" \"${FAKE_DOCKER_APP_SERVICE:-orbit-app}\"",
  "      fi",
  "    fi",
  "    exit 0",
  "    ;;",
  "  inspect)",
  '    printf "%s\\n" "${FAKE_DOCKER_APP_IMAGE:?}"',
  "    exit 0",
  "    ;;",
  "  compose)",
  '    if [[ "$*" == *"config --hash orbit-app"* ]]; then',
  '      printf "%s\\n" "${FAKE_DOCKER_CONFIG_HASH:-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff}"',
  "      exit 0",
  "    fi",
  '    if [[ "${FAKE_COMPOSE_CONFIG_FAIL:-}" == "1" && " $* " == *" config "* ]]; then',
  "      exit 23",
  "    fi",
  '    if [[ "$*" == *"exec -T orbit-db"*"pg_isready"* ]]; then',
  '      probe_ready database "${FAKE_DATABASE_HEALTH_FAILURES:-0}"',
  "      exit $?",
  "    fi",
  '    if [[ "$*" == *"exec -T orbit-app"*"/api/health"* ]]; then',
  '      probe_ready application "${FAKE_APP_HEALTH_FAILURES:-0}"',
  "      exit $?",
  "    fi",
  '    if [[ "$*" == *"exec -T orbit-app true"* && "${FAKE_APP_CONTAINER_STOPPED:-0}" == "1" ]]; then',
  "      exit 1",
  "    fi",
  '    if [[ "$*" == *"exec -T orbit-clamav"*"clamdscan --ping"* ]]; then',
  '      probe_ready clamav "${FAKE_CLAMAV_HEALTH_FAILURES:-0}"',
  "      exit $?",
  "    fi",
  '    if [[ "$*" == *"exec -T orbit-app"*"orbit-tika:9998/version"* ]]; then',
  '      probe_ready tika "${FAKE_TIKA_HEALTH_FAILURES:-0}"',
  "      exit $?",
  "    fi",
  '    if [[ "$*" == *"exec -T orbit-ollama"*"ollama list"* ]]; then',
  '      probe_ready ollama "${FAKE_OLLAMA_HEALTH_FAILURES:-0}"',
  "      exit $?",
  "    fi",
  '    if [[ "$*" == *"exec -T orbit-ollama"*"ollama pull"* ]]; then',
  '      [[ "${FAKE_OLLAMA_PULL_FAIL:-0}" != "1" ]]',
  "      exit $?",
  "    fi",
  '    if [[ "${FAKE_COMPOSE_FAIL:-}" == "1" && " $* " != *" version "* && " $* " != *" config "* ]]; then',
  "      exit 23",
  "    fi",
  "    exit 0",
  "    ;;",
  "  pull)",
  "    exit 0",
  "    ;;",
  "  run)",
  "    args=(\"$@\")",
  '    if [[ "$*" == *"--entrypoint /opt/orbit/scripts/container-entrypoint.sh"* ]]; then',
  "      printf 'FAKE_CANONICAL_BANNER\\n'",
  "      exit 0",
  "    fi",
  '    [[ "${args[${#args[@]} - 2]:-}" == "-e" ]] || exit 24',
  "    interactive=0",
  '    for argument in "${args[@]}"; do',
  '      if [[ "$argument" == "--interactive" || "$argument" == "-i" ]]; then interactive=1; fi',
  "    done",
  '    if [[ "${FAKE_REQUIRE_INTERACTIVE:-0}" == "1" && "$interactive" != "1" ]]; then',
  '      payload=""',
  "    else",
  '      payload="$(cat)"',
  "    fi",
  '    if printf "%s" "$payload" | node --input-type=commonjs -e "${args[${#args[@]} - 1]}"; then parser_status=0; else parser_status=$?; fi; exit "$parser_status"',
  "    ;;",
  "  image)",
  '    args="$*"',
  '    case "$args" in',
  "      *RepoDigests*)",
  '        if [[ "${FAKE_DOCKER_INSPECT_FAIL:-}" == "1" ]]; then',
  "          printf 'fake image inspect failure\\n' >&2",
  "          exit 17",
  "        fi",
  '        if [[ "${FAKE_DOCKER_OMIT_DIGEST:-}" == "1" ]]; then',
  "          exit 0",
  "        fi",
  "        printf '%s@sha256:%s\\n' \"${FAKE_IMAGE_REPOSITORY:?}\" \"${FAKE_DOCKER_DIGEST:?}\"",
  "        exit 0",
  "        ;;",
  "      *image.revision*)",
  '        if [[ "${FAKE_DOCKER_REVISION_INSPECT_FAIL:-}" == "1" ]]; then',
  "          printf 'fake revision inspect failure\\n' >&2",
  "          exit 18",
  "        fi",
  '        if [[ "${FAKE_DOCKER_OMIT_REVISION:-}" == "1" ]]; then',
  "          printf '\\n'",
  "          exit 0",
  "        fi",
  "        printf '%s\\n' \"${FAKE_DOCKER_REVISION:?}\"",
  "        exit 0",
  "        ;;",
  "      *image.version*)",
  '        printf "%s\\n" "${FAKE_DOCKER_VERSION:-v1.2.0}"',
  "        exit 0",
  "        ;;",
  "    esac",
  "    exit 1",
  "    ;;",
  "esac",
  "exit 1",
  "",
].join("\n");

const fakeCurlScript = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  'output=""',
  'write_out=""',
  'url=""',
  "while [[ $# -gt 0 ]]; do",
  '  case "$1" in',
  "    --output)",
  '      output="$2"',
  "      shift 2",
  "      ;;",
  "    --write-out)",
  '      write_out="$2"',
  "      shift 2",
  "      ;;",
  "    --connect-timeout|--header|--max-filesize|--max-time|--proto|--proto-redir)",
  "      shift 2",
  "      ;;",
  "    --tlsv1.2)",
  "      shift",
  "      ;;",
  "    --fail|--silent|--show-error|--location)",
  "      shift",
  "      ;;",
  "    *)",
  '      url="$1"',
  "      shift",
  "      ;;",
  "  esac",
  "done",
  'prefix="${FAKE_ASSET_BASE:?}/"',
  'asset="${url#"$prefix"}"',
  'if [[ "$url" == https://*"/.well-known/openid-configuration" ]]; then',
  '  if [[ "${FAKE_OIDC_NETWORK_FAIL:-}" == "1" ]]; then exit 7; fi',
  '  discovery_issuer="${url%/.well-known/openid-configuration}"',
  '  [[ "$discovery_issuer" == */ ]] || discovery_issuer="$discovery_issuer/"',
  '  if [[ -n "${FAKE_CALL_LOG:-}" ]]; then printf "curl oidc-discovery\\n" >> "$FAKE_CALL_LOG"; fi',
  '  if [[ -n "${FAKE_OIDC_RESPONSE_BODY:-}" ]]; then',
  '    printf "%s" "$FAKE_OIDC_RESPONSE_BODY" > "$output"',
  "  else",
  '    printf "{\\\"issuer\\\":\\\"%s\\\",\\\"authorization_endpoint\\\":\\\"%s/authorize\\\",\\\"token_endpoint\\\":\\\"%s/token\\\",\\\"jwks_uri\\\":\\\"%s/jwks\\\"}" "$discovery_issuer" "$discovery_issuer" "$discovery_issuer" "$discovery_issuer" > "$output"',
  "  fi",
  '  printf "%s" "${FAKE_OIDC_HTTP_STATUS:-200}"',
  "  exit 0",
  "fi",
  'if [[ -n "${FAKE_CALL_LOG:-}" ]]; then',
  "  printf 'curl %s\\n' \"$asset\" >> \"$FAKE_CALL_LOG\"",
  "fi",
  'if [[ -n "${FAKE_CURL_FAIL_ASSET:-}" && "$asset" == "${FAKE_CURL_FAIL_ASSET}" ]]; then',
  "  exit 22",
  "fi",
  'if [[ -n "${FAKE_INVALID_ASSET:-}" && "$asset" == "${FAKE_INVALID_ASSET}" ]]; then',
  "  printf 'this is not valid shell syntax (\\n' > \"$output\"",
  "  exit 0",
  "fi",
  'case "$asset" in',
  "  scripts/configure.sh)",
  "    cat <<'SCRIPT' > \"$output\"",
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  'repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"',
  'cd "$repo_dir"',
  "printf 'CONFIGURE_INVOKED ORBIT_IMAGE=%s\\n' \"${ORBIT_IMAGE:-}\"",
  "case \"${1:-}\" in",
  "  --check)",
  '    if [[ -f .env-orbit && -s .orbit-secrets/oidc-client-secret ]]; then',
  "      printf '%s\\n' 'ready APP_URL' 'ready ORBIT_IMAGE' 'ready OIDC_ISSUER' 'ready OIDC_CLIENT_ID' 'ready OIDC_CLIENT_SECRET' 'ready OIDC_CALLBACK_URL'",
  "      exit 0",
  "    fi",
  "    printf '%s\\n' 'missing APP_URL' 'missing ORBIT_IMAGE' 'missing OIDC_ISSUER' 'missing OIDC_CLIENT_ID' 'missing OIDC_CLIENT_SECRET' 'missing OIDC_CALLBACK_URL'",
  "    exit 1",
  "    ;;",
  "  --init)",
  '    [[ "${FAKE_CONFIGURE_INIT_FAIL:-}" != "1" ]] || exit 42',
  '    profile_lines="$(grep -E "^(COMPOSE_PROFILES|TIKA_URL|OLLAMA_MODEL)=" .env-orbit 2>/dev/null || true)"',
  '    if [[ "${FAKE_CONFIGURE_INIT_PROMPT:-}" == "1" ]]; then',
  "      exec {fake_tty_fd}<>/dev/tty",
  '      IFS= read -r -u "$fake_tty_fd" app_url || exit 1',
  '      IFS= read -r -u "$fake_tty_fd" issuer || exit 1',
  '      IFS= read -r -u "$fake_tty_fd" client_id || exit 1',
  "      exec {fake_tty_fd}>&-",
  "    else",
  '      app_url="https://orbit.install-test.internal"',
  '      issuer="https://auth.install-test.internal/application/o/orbit/"',
  '      client_id="install-test-client"',
  "    fi",
  "    cat > .env-orbit <<ENV",
  "APP_URL=${app_url}",
  "ORBIT_IMAGE=${ORBIT_IMAGE:-fake-registry.example/example/orbit-fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}",
  "OIDC_ISSUER=${issuer}",
  "OIDC_CLIENT_ID=${client_id}",
  "OIDC_CLIENT_SECRET=",
  "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret",
  "OIDC_CALLBACK_URL=${app_url}/api/auth/callback",
  "ENV",
  '    [[ -z "$profile_lines" ]] || printf "%s\\n" "$profile_lines" >> .env-orbit',
  "    mkdir -p .orbit-secrets",
  "    chmod 700 .orbit-secrets",
  "    : > .orbit-secrets/oidc-client-secret",
  "    chmod 600 .env-orbit .orbit-secrets/oidc-client-secret",
  "    exit 0",
  "    ;;",
  "  --set-oidc-secret)",
  '    if [[ "${ORBIT_CONFIGURE_TTY_INPUT:-}" == "1" ]]; then',
  "      exec {fake_tty_fd}<>/dev/tty",
  '      IFS= read -r -s -u "$fake_tty_fd" secret || exit 1',
  '      printf "\\n" >&"$fake_tty_fd"',
  "      exec {fake_tty_fd}>&-",
  "    else",
  "      IFS= read -r -s secret || exit 1",
  "    fi",
  "    [[ -n \"$secret\" ]] || exit 1",
  "    mkdir -p .orbit-secrets",
  "    printf '%s' \"$secret\" > .orbit-secrets/oidc-client-secret",
  "    chmod 700 .orbit-secrets",
  "    chmod 600 .orbit-secrets/oidc-client-secret",
  "    sed -i 's/^OIDC_CLIENT_SECRET=.*/OIDC_CLIENT_SECRET=/' .env-orbit",
  "    printf '%s\\n' 'OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret' >> .env-orbit",
  "    exit 0",
  "    ;;",
  "  --set-deployment-profile)",
  '    preset="${2:-}"',
  '    model="${3:-}"',
  '    profiles=""',
  '    tika_url=""',
  '    case "$preset" in',
  "      standard) ;;",
  '      processing) profiles="processing"; tika_url="http://orbit-tika:9998" ;;',
  '      ai) profiles="ai" ;;',
  '      full) profiles="processing,ai"; tika_url="http://orbit-tika:9998" ;;',
  "      *) exit 2 ;;",
  "    esac",
  '    for assignment in "COMPOSE_PROFILES=$profiles" "TIKA_URL=$tika_url" "OLLAMA_MODEL=$model"; do',
  '      key="${assignment%%=*}"',
  '      if grep -q "^${key}=" .env-orbit; then',
  '        sed -i "s|^${key}=.*|${assignment}|" .env-orbit',
  "      else",
  '        printf "%s\\n" "$assignment" >> .env-orbit',
  "      fi",
  "    done",
  "    exit 0",
  "    ;;",
  "esac",
  'if [[ "${FAKE_CONFIGURE_SKIP_ENV:-}" != "1" ]]; then',
  "  if [[ ! -e .env-orbit ]]; then",
  "    cat > .env-orbit <<ENV",
  "APP_URL=https://orbit.install-test.internal",
  "ORBIT_IMAGE=${ORBIT_IMAGE:-fake-registry.example/example/orbit-fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}",
  "OIDC_ISSUER=https://auth.install-test.internal/application/o/orbit/",
  "OIDC_CLIENT_ID=install-test-client",
  "OIDC_CLIENT_SECRET=",
  "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret",
  "OIDC_CALLBACK_URL=https://orbit.install-test.internal/api/auth/callback",
  "ENV",
  "  fi",
  "fi",
  'if [[ "${FAKE_CONFIGURE_SKIP_SECRETS:-}" != "1" ]]; then',
  "  mkdir -p .orbit-secrets",
  "  chmod 700 .orbit-secrets",
  "  if [[ ! -e .orbit-secrets/oidc-client-secret ]]; then if [[ \"${FAKE_CONFIGURE_READY:-}\" == \"1\" ]]; then printf 'fake-oidc-secret' > .orbit-secrets/oidc-client-secret; else : > .orbit-secrets/oidc-client-secret; fi; fi",
  "  chmod 600 .orbit-secrets/oidc-client-secret",
  "fi",
  'if [[ "${FAKE_CONFIGURE_MUTATE_POSTGRES_PASSWORD:-}" == "1" ]]; then',
  "  printf 'mutated-postgres-password' > .orbit-secrets/postgres-password",
  "  chmod 600 .orbit-secrets/postgres-password",
  "fi",
  '[[ ! -e .env-orbit ]] || chmod 600 .env-orbit',
  'if [[ "${FAKE_CONFIGURE_FAIL:-}" == "1" ]]; then',
  '  [[ ! -f .env-orbit ]] || printf "CONFIGURE_MUTATION=1\\n" >> .env-orbit',
  '  [[ ! -d .orbit-secrets ]] || printf "configure-secret\\n" > .orbit-secrets/configure-secret',
  '  [[ ! -f .orbit-secrets/configure-secret ]] || chmod 600 .orbit-secrets/configure-secret',
  "  exit 42",
  "fi",
  "SCRIPT",
  "    ;;",
  "  scripts/backup.sh)",
  "    cat <<'SCRIPT' > \"$output\"",
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  "printf 'BACKUP_INVOKED\\n'",
  "SCRIPT",
  "    ;;",
  "  scripts/installer-ui.sh)",
  '    cp -- "${FAKE_INSTALLER_UI_PATH:?}" "$output"',
  "    ;;",
  "  scripts/configuration.sh)",
  '    if [[ "${FAKE_USE_REAL_CONFIGURATION:-0}" == "1" ]]; then',
  '      cp -- "${FAKE_CONFIGURATION_SCRIPT_PATH:?}" "$output"',
  "    else",
  "      cat <<'SCRIPT' > \"$output\"",
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  "printf 'Orbit configuration: already current schema v1 version v1.2.0 digest sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'",
  "SCRIPT",
  "    fi",
  "    ;;",
  "  scripts/restore.sh)",
  "    cat <<'SCRIPT' > \"$output\"",
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  "printf 'RESTORE_INVOKED\\n'",
  "SCRIPT",
  "    ;;",
  "  scripts/repair.sh)",
  "    cat <<'SCRIPT' > \"$output\"",
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  "printf 'REPAIR_INVOKED\\n'",
  "SCRIPT",
  "    ;;",
  "  scripts/engine-check.sh)",
  "    cat <<'SCRIPT' > \"$output\"",
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  "printf 'ENGINE_CHECK_INVOKED\\n'",
  "SCRIPT",
  "    ;;",
  "  *)",
  "    printf 'fake content for %s\\n' \"$asset\" > \"$output\"",
  "    ;;",
  "esac",
  "",
].join("\n");

const fakeMvScript = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  "args=(\"$@\")",
  'destination="${args[${#args[@]} - 1]}"',
  'if [[ -n "${FAKE_MV_FAIL_DEST:-}" && "$destination" == "${FAKE_MV_FAIL_DEST}" && ! -e "${FAKE_MV_FAIL_MARKER:?}" ]]; then',
  '  : > "${FAKE_MV_FAIL_MARKER}"',
  "  exit 73",
  "fi",
  "exec /bin/mv \"$@\"",
  "",
].join("\n");

function makeFakeBin() {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-install-fakebin-"));
  writeFileSync(join(binDir, "docker"), fakeDockerScript);
  chmodSync(join(binDir, "docker"), 0o755);
  writeFileSync(join(binDir, "curl"), fakeCurlScript);
  chmodSync(join(binDir, "curl"), 0o755);
  writeFileSync(join(binDir, "mv"), fakeMvScript);
  chmodSync(join(binDir, "mv"), 0o755);
  return binDir;
}

function makeTarget() {
  return mkdtempSync(join(tmpdir(), "orbit-install-target-"));
}

function makeExistingDeployment(targetDir) {
  writeFileSync(join(targetDir, ".env-orbit"), "EXISTING_ENV=1\n");
  writeFileSync(join(targetDir, "docker-compose.yml"), "PRIOR-COMPOSE-CONTENT\n");
  mkdirSync(join(targetDir, ".orbit-secrets"));
}

function makePreprovisionedDeployment(targetDir) {
  writeFileSync(
    join(targetDir, ".env-orbit"),
    [
      "APP_URL=https://orbit.preprovisioned-install.internal",
      "ORBIT_IMAGE=old-registry.example/orbit@sha256:" + "c".repeat(64),
      "OIDC_ISSUER=https://auth.preprovisioned-install.internal/application/o/orbit/",
      "OIDC_CLIENT_ID=preprovisioned-install-client",
      "OIDC_CLIENT_SECRET=",
      "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret",
      "OIDC_CALLBACK_URL=https://orbit.preprovisioned-install.internal/api/auth/callback",
      "",
    ].join("\n"),
  );
  chmodSync(join(targetDir, ".env-orbit"), 0o600);
  mkdirSync(join(targetDir, ".orbit-secrets"));
  chmodSync(join(targetDir, ".orbit-secrets"), 0o700);
  writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "preprovisioned-oidc-secret");
  chmodSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), 0o600);
}

function makeFullExistingDeployment(targetDir) {
  writeFileSync(
    join(targetDir, ".env-orbit"),
    [
      "EXISTING_ENV=1",
      "APP_URL=https://orbit.install-test.internal",
      "ORBIT_IMAGE=old-registry.example/orbit@sha256:" + "c".repeat(64),
      "OIDC_ISSUER=https://auth.install-test.internal/application/o/orbit/",
      "OIDC_CLIENT_ID=existing-install-client",
      "OIDC_CLIENT_SECRET=",
      "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret",
      "OIDC_CALLBACK_URL=https://orbit.install-test.internal/api/auth/callback",
      "",
    ].join("\n"),
  );
  chmodSync(join(targetDir, ".env-orbit"), 0o600);
  for (const [index, asset] of deploymentAssets.entries()) {
    const path = join(targetDir, asset);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `PRIOR-${asset}\n`);
    chmodSync(path, index % 2 === 0 ? 0o640 : 0o600);
  }
  mkdirSync(join(targetDir, ".orbit-secrets"));
  chmodSync(join(targetDir, ".orbit-secrets"), 0o700);
  writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "existing-oidc-secret");
  chmodSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), 0o600);
  writeFileSync(join(targetDir, ".orbit-secrets", "postgres-password"), "existing-postgres-password");
  chmodSync(join(targetDir, ".orbit-secrets", "postgres-password"), 0o600);
  writeFileSync(join(targetDir, ".orbit-secrets", "sentinel"), "KEEP-SECRET\n");
  chmodSync(join(targetDir, ".orbit-secrets", "sentinel"), 0o640);
}

function makeLegacyExistingDeployment(targetDir) {
  makeFullExistingDeployment(targetDir);
  writeFileSync(
    join(targetDir, ".env-orbit"),
    [
      "APP_URL=https://orbit.install-test.internal",
      `ORBIT_IMAGE=${resolvedReference}`,
      "OIDC_ISSUER=https://auth.install-test.internal/application/o/orbit/",
      "OIDC_CLIENT_ID=existing-install-client",
      "OIDC_CLIENT_SECRET=legacy-client-secret",
      "OIDC_CALLBACK_URL=https://orbit.install-test.internal/api/auth/callback",
      "POSTGRES_DB=orbit",
      "POSTGRES_USER=orbit",
      "",
    ].join("\n"),
  );
  chmodSync(join(targetDir, ".env-orbit"), 0o600);
  unlinkSync(join(targetDir, "scripts", "backup.sh"));
  unlinkSync(join(targetDir, "scripts", "restore.sh"));
}

function recognizedVolumeOverrides(project = "renamed-orbit") {
  return {
    FAKE_DOCKER_VOLUME_NAMES: `${project}_orbit-db-data`,
    FAKE_DOCKER_VOLUME_PROJECT: project,
    FAKE_DOCKER_DB_CONTAINER_ID: "c".repeat(64),
    FAKE_DOCKER_APP_CONTAINER_ID: "d".repeat(64),
  };
}

function snapshotPath(path) {
  let descriptor;
  try {
    // Open before inspecting. Subsequent file reads use this descriptor, so a
    // pathname replacement cannot redirect the snapshot after a type check.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    if (error.code === "ELOOP") {
      const target = readlinkSync(path);
      const linkStats = lstatSync(path);
      return { mode: linkStats.mode & 0o7777, type: "symlink", target };
    }
    throw error;
  }

  try {
    const stats = fstatSync(descriptor);
    const snapshot = { mode: stats.mode & 0o7777 };
    if (stats.isDirectory()) {
      return {
        ...snapshot,
        type: "directory",
        entries: readdirSync(path)
          .sort()
          .map((entry) => [entry, snapshotPath(join(path, entry))]),
      };
    }
    if (stats.isFile()) {
      return {
        ...snapshot,
        type: "file",
        content: readFileSync(descriptor, "utf8"),
      };
    }
    return { ...snapshot, type: "other" };
  } finally {
    closeSync(descriptor);
  }
}

function managedSnapshot(targetDir) {
  return [...deploymentAssets, ".env-orbit", ".orbit-secrets"].map((path) => [
    path,
    snapshotPath(join(targetDir, path)),
  ]);
}

function targetEntries(targetDir) {
  return readdirSync(targetDir).sort();
}

function stagingLeftovers(targetDir) {
  return readdirSync(targetDir).filter((name) => name.startsWith(".orbit-install-staging"));
}

function readOptionalFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function runInstall(targetDir, envOverrides = {}, args = []) {
  const binDir = makeFakeBin();
  const logDir = mkdtempSync(join(tmpdir(), "orbit-install-log-"));
  const logPath = join(logDir, "calls.log");
  const priorEnvironment = readOptionalFile(join(targetDir, ".env-orbit"));
  const priorImage = /^ORBIT_IMAGE=([^\n]*)$/m.exec(priorEnvironment)?.[1] ?? resolvedReference;
  const result = failOnProcessDeadline(spawnSync("bash", [installScript, ...args], {
    cwd: targetDir,
    encoding: "utf8",
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: process.env.HOME ?? tmpdir(),
      TERM: "xterm",
      ORBIT_REPOSITORY: repository,
      ORBIT_REGISTRY: registry,
      FAKE_IMAGE_REPOSITORY: imageRepository,
      FAKE_DOCKER_DIGEST: digest,
      FAKE_DOCKER_REVISION: revision,
      FAKE_DOCKER_VERSION: "v1.2.0",
      FAKE_DOCKER_APP_IMAGE: priorImage,
      FAKE_DOCKER_CONFIG_HASH: "f".repeat(64),
      FAKE_DOCKER_RUNNING_CONFIG_HASH: "f".repeat(64),
      FAKE_ASSET_BASE: assetBase,
      FAKE_CALL_LOG: logPath,
      FAKE_PROBE_COUNTER_DIR: logDir,
      FAKE_CONFIGURATION_SCRIPT_PATH: configurationScriptPath,
      FAKE_INSTALLER_UI_PATH: fileURLToPath(new URL("./installer-ui.sh", import.meta.url)),
      FAKE_USE_REAL_CONFIGURATION: "0",
      FAKE_CONFIGURE_READY: "1",
      ...envOverrides,
    },
    ...processGuard(),
  }), { label: "runInstall" });
  const calls = readOptionalFile(logPath);
  return { ...result, calls };
}

function runInstallWithControllingTerminal(targetDir, envOverrides = {}, input = "", args = []) {
  const binDir = makeFakeBin();
  const logDir = mkdtempSync(join(tmpdir(), "orbit-install-log-"));
  const logPath = join(logDir, "calls.log");
  const result = spawnSync("script", ["-qeE", "never", "-c", `exec </dev/null; bash ${installScript} ${args.join(" ")}`, "/dev/null"], {
    cwd: targetDir,
    encoding: "utf8",
    input,
    // Deadline and its justification: pty-deadline.mjs (#595).
    timeout: PTY_DEADLINE_MS,
    killSignal: "SIGKILL",
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: process.env.HOME ?? tmpdir(),
      TERM: "xterm",
      ORBIT_REPOSITORY: repository,
      ORBIT_REGISTRY: registry,
      FAKE_IMAGE_REPOSITORY: imageRepository,
      FAKE_DOCKER_DIGEST: digest,
      FAKE_DOCKER_REVISION: revision,
      FAKE_DOCKER_VERSION: "v1.2.0",
      FAKE_ASSET_BASE: assetBase,
      FAKE_CALL_LOG: logPath,
      FAKE_PROBE_COUNTER_DIR: logDir,
      FAKE_INSTALLER_UI_PATH: fileURLToPath(new URL("./installer-ui.sh", import.meta.url)),
      FAKE_CONFIGURE_READY: "0",
      ...envOverrides,
    },
  });
  const calls = readOptionalFile(logPath);
  return failOnPtyDeadline(
    { ...result, calls },
    { label: "runInstallWithControllingTerminal", deadlineMs: PTY_DEADLINE_MS },
  );
}

function runInstallWithPromptedTerminalInput(
  targetDir,
  envOverrides = {},
  interactions = [],
  args = [],
) {
  const binDir = makeFakeBin();
  const logDir = mkdtempSync(join(tmpdir(), "orbit-install-log-"));
  const logPath = join(logDir, "calls.log");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "script",
      ["-qeE", "never", "-c", `exec </dev/null; bash ${installScript} ${args.join(" ")}`, "/dev/null"],
      {
        cwd: targetDir,
        env: {
          PATH: `${binDir}:${process.env.PATH}`,
          HOME: process.env.HOME ?? tmpdir(),
          TERM: "xterm",
          ORBIT_REPOSITORY: repository,
          ORBIT_REGISTRY: registry,
          FAKE_IMAGE_REPOSITORY: imageRepository,
          FAKE_DOCKER_DIGEST: digest,
          FAKE_DOCKER_REVISION: revision,
          FAKE_DOCKER_VERSION: "v1.2.0",
          FAKE_ASSET_BASE: assetBase,
          FAKE_CALL_LOG: logPath,
          FAKE_PROBE_COUNTER_DIR: logDir,
          FAKE_INSTALLER_UI_PATH: fileURLToPath(new URL("./installer-ui.sh", import.meta.url)),
          FAKE_CONFIGURE_READY: "0",
          ...envOverrides,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    let interactionIndex = 0;
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const watchdog = ptyWatchdog({ label: "runInstallWithPromptedTerminalInput", kill: () => child.kill("SIGKILL") });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      watchdog.touch();
      // Two prompts can land in one chunk; answer every one that is on
      // screen, or the second waits for output that will never come.
      //
      // stdin stays open after the last answer: never child.stdin.end().
      // Closing it races the widget's 0.08s follow-up read after an Escape
      // (#611, #512), and a child left waiting for input is now named by the
      // idle watchdog rather than hanging.
      let interaction = interactions[interactionIndex];
      while (interaction && stdout.includes(interaction.after)) {
        child.stdin.write(interaction.input);
        interactionIndex += 1;
        interaction = interactions[interactionIndex];
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; watchdog.touch(); });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      if (settled) return;
      settled = true;
      watchdog.stop();
      if (watchdog.reason) {
        reject(watchdog.error({ stdout, stderr }));
        return;
      }
      resolve({
        status,
        signal,
        stdout,
        stderr,
        calls: readOptionalFile(logPath),
        promptedInteractions: interactionIndex,
      });
    });
  });
}

describe("install.sh", () => {
  it("rejects mismatched direct install and update modes before external actions", () => {
    const existingTarget = makeTarget();
    makeFullExistingDeployment(existingTarget);
    const install = runInstall(existingTarget, {}, ["--install"]);
    expect(install.status).not.toBe(0);
    expect(install.stderr).toContain("use Update");
    expect(install.calls).toBe("");

    const emptyTarget = makeTarget();
    const update = runInstall(emptyTarget, {}, ["--update"]);
    expect(update.status).not.toBe(0);
    expect(update.stderr).toContain("recognized existing Orbit deployment");
    expect(update.calls).toBe("");
    expect(targetEntries(emptyTarget)).toEqual([]);
  });

  it("keeps direct repair non-mutating until issue #261 supplies execution", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, {}, ["--plain", "--repair"]);

    expect(result.status).toBe(3);
    expect(`${result.stdout}${result.stderr}`).toContain("repair_unavailable");
    expect(result.stdout).toContain("phase=rollback component=installer state=blocked reason=repair-unavailable action=repair");
    expect(result.calls).toBe("");
    expect(targetEntries(targetDir)).toEqual([]);
  });

  it("exits the interactive command centre without mutating the target", () => {
    const targetDir = makeTarget();

    const result = runInstallWithControllingTerminal(targetDir, {}, "\x1b[B\x1b[B\x1b[B\r");

    expect(result.status).toBe(130);
    expect(result.stdout).toContain("Greetings, what can we do for you today?");
    expect(result.calls).not.toContain("config --quiet");
    expect(result.calls).not.toContain("up -d");
    expect(targetEntries(targetDir)).toEqual([]);
  });

  it("keeps interactive repair non-mutating and bounded", () => {
    const targetDir = makeTarget();

    const result = runInstallWithControllingTerminal(targetDir, {}, "\x1b[B\x1b[B\r");

    expect(result.status).toBe(3);
    expect(`${result.stdout}${result.stderr}`).toContain("repair_unavailable");
    expect(result.calls).not.toContain("config --quiet");
    expect(result.calls).not.toContain("up -d");
    expect(targetEntries(targetDir)).toEqual([]);
  });

  it("cancels profile selection without creating files or services", async () => {
    const targetDir = makeTarget();

    const result = await runInstallWithPromptedTerminalInput(targetDir, {}, [
      { after: "Greetings, what can we do for you today?", input: "\r" },
      { after: "Choose a deployment profile", input: "\x1b" },
    ]);

    expect(result.status).toBe(130);
    expect(result.promptedInteractions).toBe(2);
    expect(result.calls).not.toContain("config --quiet");
    expect(result.calls).not.toContain("up -d");
    expect(targetEntries(targetDir)).toEqual([]);
  }, PTY_TEST_TIMEOUT_MS);

  it("guides and persists the document-processing profile after final review", () => {
    const targetDir = makeTarget();
    const appUrl = "https://orbit.profile-test.internal";
    const issuer = "https://auth.profile-test.internal/application/o/orbit/";

    const result = runInstallWithControllingTerminal(
      targetDir,
      { FAKE_CONFIGURE_INIT_PROMPT: "1", TERM: "dumb" },
      `1\n2\n1\n${appUrl}\n${issuer}\nprofile-client\nprofile-secret\n1\n`,
    );

    expect(result.status).toBe(0);
    const environment = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    expect(environment).toContain("COMPOSE_PROFILES=processing\n");
    expect(environment).toContain("TIKA_URL=http://orbit-tika:9998\n");
    expect(environment).toContain("OLLAMA_MODEL=\n");
    expect(result.stdout).toContain("Ollama is optional local infrastructure");
    expect(result.calls).toContain("up -d");
  });

  it("checks capacity and separately confirms a selected local model download", async () => {
    const targetDir = makeTarget();
    const model = "qwen3:8b";

    // Answers follow the prompts they answer, not a stopwatch: the timed
    // version of this test sent its seven answers on fixed delays and failed
    // on a starved core, where the installer had not reached the prompt the
    // next answer was meant for (#698). The secret has no visible prompt --
    // the stand-in configure reads it silently -- so its cue is the stand-in
    // announcing a call with no ORBIT_IMAGE, which only --set-oidc-secret does.
    const result = await runInstallWithPromptedTerminalInput(
      targetDir,
      { TERM: "dumb" },
      [
        { after: "Greetings, what can we do for you today?", input: "1\n" },
        { after: "Choose a deployment profile", input: "3\n" },
        { after: "Bounded local model identifier:", input: `${model}\n` },
        { after: "Prepare the selected local model after Ollama becomes healthy?", input: "2\n" },
        { after: "Review: OIDC remains required", input: "1\n" },
        { after: "CONFIGURE_INVOKED ORBIT_IMAGE=\r", input: "full-secret\n" },
        { after: "Final review: apply the collected core settings", input: "1\n" },
      ],
    );

    expect(result.status).toBe(0);
    const environment = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    expect(environment).toContain("COMPOSE_PROFILES=processing,ai\n");
    expect(environment).toContain("TIKA_URL=http://orbit-tika:9998\n");
    expect(environment).toContain(`OLLAMA_MODEL=${model}\n`);
    expect(result.stdout).toContain("Host capacity check:");
    expect(result.calls).toContain("pull orbit-tika");
    expect(result.calls).toContain("pull orbit-ollama");
    expect(result.calls).toContain("orbit-tika:9998/version");
    expect(result.calls).toContain("exec -T orbit-ollama ollama list");
    expect(result.calls).toContain(`exec -T orbit-ollama ollama pull ${model}`);
    expect(result.stdout).not.toContain("full-secret");
  });

  it("fails a selected optional service with a stable bounded reason", () => {
    const targetDir = makeTarget();
    const appUrl = "https://orbit.processing-failure.internal";
    const issuer = "https://auth.processing-failure.internal/application/o/orbit/";

    const result = runInstallWithControllingTerminal(
      targetDir,
      {
        FAKE_CONFIGURE_INIT_PROMPT: "1",
        FAKE_TIKA_HEALTH_FAILURES: "99",
        ORBIT_INSTALLER_POLL_INTERVAL_SECONDS: "1",
        ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "1",
        TERM: "dumb",
      },
      `1\n2\n1\n${appUrl}\n${issuer}\nprocessing-client\nprocessing-secret\n1\n`,
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "phase=optional component=tika state=failed reason=optional-unavailable action=repair",
    );
    expect(result.stdout).not.toContain("phase=complete component=installer state=completed");
    expect(`${result.stdout}${result.stderr}`).not.toContain("processing-secret");
  });

  it("preserves an existing valid profile by default during interactive update", () => {
    const targetDir = makeTarget();
    makeFullExistingDeployment(targetDir);
    const environmentPath = join(targetDir, ".env-orbit");
    writeFileSync(
      environmentPath,
      `${readFileSync(environmentPath, "utf8")}COMPOSE_PROFILES=processing\nTIKA_URL=http://orbit-tika:9998\nOLLAMA_MODEL=\n`,
    );
    chmodSync(environmentPath, 0o600);

    const result = runInstallWithControllingTerminal(
      targetDir,
      { FAKE_CONFIGURE_READY: "1" },
      "\r\r\r",
    );

    expect(result.status).toBe(0);
    const updated = readFileSync(environmentPath, "utf8");
    expect(updated).toContain("COMPOSE_PROFILES=processing\n");
    expect(updated).toContain("TIKA_URL=http://orbit-tika:9998\n");
    expect(updated).toContain("OLLAMA_MODEL=\n");
    expect(result.stdout).toContain(`Current: schema=legacy/unknown version=legacy/unknown digest=sha256:${"c".repeat(64)} optional-profile=processing`);
    expect(result.stdout).toContain(`Target: schema=v1 version=v1.2.0 digest=sha256:${digest} channel=latest`);
    expect(result.calls).toContain("up -d");
  });

  it("renders ordered plain semantic events and the immutable image banner", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, {}, ["--plain"]);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/\x1b\[/u);
    const events = [
      "phase=host component=host state=completed reason=host-tools action=check",
      "phase=identity component=image state=completed reason=image-identity action=verify",
      "phase=assets component=assets state=completed reason=assets-verified action=fetch",
      "phase=configuration component=configuration state=completed reason=configuration-migration action=verify",
      "phase=oidc component=oidc state=completed reason=provider-discovery action=verify",
      "phase=compose component=compose state=completed reason=compose-validation action=check",
      "phase=preparation component=application state=completed reason=service-preparation action=pull",
      "phase=database component=database state=healthy reason=database-health action=health",
      "phase=application component=application state=healthy reason=application-health action=health",
      "phase=optional component=clamav state=healthy reason=optional-status action=health",
      "phase=complete component=installer state=completed reason=deployment-ready action=complete",
    ];
    let previousIndex = -1;
    for (const event of events) {
      const index = result.stdout.indexOf(event);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    const bannerCall = result.calls
      .split("\n")
      .find((line) => line.includes("container-entrypoint.sh") && line.endsWith(" --banner"));
    expect(bannerCall).toContain(resolvedReference);
    expect(bannerCall).not.toContain(":preview");
    expect(result.stdout).toContain("FAKE_CANONICAL_BANNER");
  });

  it("states fixed profile resource classes, optional boundaries and local privacy", () => {
    const source = readFileSync(installScript, "utf8");

    expect(source).toContain("standard relative resources");
    expect(source).toContain("medium relative resources");
    expect(source).toContain("high relative resources");
    expect(source).toContain("Required Orbit core and private scanning stay enabled");
    expect(source).toContain("document processing and local AI are optional services");
    expect(source).toContain("private Compose network");
    expect(source).toContain("not yet consumed by Orbit product workflows");
  });

  it("waits through transient database and application startup before reporting completion", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, {
      FAKE_DATABASE_HEALTH_FAILURES: "1",
      FAKE_APP_HEALTH_FAILURES: "2",
      ORBIT_INSTALLER_POLL_INTERVAL_SECONDS: "1",
    }, ["--plain"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("phase=database component=database state=waiting reason=database-health action=wait");
    expect(result.stdout).toContain("phase=application component=application state=waiting reason=application-health action=wait");
    const readyIndex = result.stdout.indexOf("phase=application component=application state=healthy");
    const completeIndex = result.stdout.indexOf("phase=complete component=installer state=completed");
    expect(readyIndex).toBeGreaterThanOrEqual(0);
    expect(completeIndex).toBeGreaterThan(readyIndex);
    expect(result.calls.match(/\/api\/health/gu)).toHaveLength(3);
  });

  it("withholds completion and emits a bounded health-timeout failure", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, {
      FAKE_APP_HEALTH_FAILURES: "99",
      ORBIT_INSTALLER_POLL_INTERVAL_SECONDS: "1",
      ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "1",
    }, ["--plain"]);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "phase=application component=application state=failed reason=health-timeout action=repair",
    );
    expect(result.stdout).not.toContain("phase=complete component=installer state=completed");
    expect(result.stderr).toContain("Orbit did not report ready within the bounded startup window");
    expect(result.stderr).not.toContain("APP_URL=");
  });

  it("classifies database readiness failure separately from application health", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, {
      FAKE_DATABASE_HEALTH_FAILURES: "99",
      ORBIT_INSTALLER_POLL_INTERVAL_SECONDS: "1",
      ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "1",
    }, ["--plain"]);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "phase=database component=database state=failed reason=database-auth-migration action=repair",
    );
    expect(result.calls).not.toContain("/api/health");
    expect(result.stdout).not.toContain("phase=complete component=installer state=completed");
  });

  it("prints only validated deployment identity and exact status commands after readiness", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, {}, ["--plain"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Public URL: https://orbit.install-test.internal");
    expect(result.stdout).toContain("Version: v1.2.0");
    expect(result.stdout).toContain("Channel: latest");
    expect(result.stdout).toContain(`Revision: ${revision.slice(0, 12)}`);
    expect(result.stdout).toContain(`Image digest: sha256:${digest}`);
    expect(result.stdout).toContain("Optional profiles: standard");
    expect(result.stdout).toContain("Status: docker compose --env-file .env-orbit ps");
    expect(result.stdout).toContain("Logs: docker compose --env-file .env-orbit logs --tail 200");
  });

  it("rejects unsupported installer options before any external action", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, {}, ["--unsupported"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
    expect(result.calls).toBe("");
    expect(targetEntries(targetDir)).toEqual([]);
  });

  it("rejects hostile display identity overrides before external action", () => {
    for (const overrides of [
      { ORBIT_CHANNEL: "latest\nSECRET=channel" },
      { ORBIT_REPOSITORY: "owner/repo\u001b[31m" },
      { ORBIT_REGISTRY: "registry.example\nSECRET=registry" },
    ]) {
      const targetDir = makeTarget();
      const result = runInstall(targetDir, overrides);
      expect(result.status).toBe(2);
      expect(result.calls).toBe("");
      expect(`${result.stdout}${result.stderr}`).not.toContain("SECRET=");
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/\x1b\[/u);
      expect(targetEntries(targetDir)).toEqual([]);
    }
  });

  it("sources the UI helper only from the immutable private staging area", () => {
    const source = readFileSync(installScript, "utf8");

    expect(source).toContain('candidate="$staging_dir/scripts/installer-ui.sh"');
    expect(source).toContain('is_regular_non_symlink_file "$candidate"');
    expect(source).not.toContain("installer_ui_local_path");
    expect(source.indexOf('bash -n "$staging_dir/$script"')).toBeLessThan(
      source.indexOf('load_installer_ui || fail'),
    );
  });

  it("uses literal delimiters for every Docker template/parser pair", () => {
    const source = readFileSync(installScript, "utf8");

    expect(source).toContain(
      '--format \'{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}\'',
    );
    expect(source).toContain(
      '--format \'{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}\'',
    );
    expect(source).toContain("IFS='|'");
    expect(source).not.toContain(
      '--format \'{{index .Labels "com.docker.compose.project"}}\\t{{index .Labels "com.docker.compose.volume"}}\'',
    );
    expect(source).not.toContain(
      '--format \'{{.ID}}\\t{{.Label "com.docker.compose.project"}}\\t{{.Label "com.docker.compose.service"}}\'',
    );
  });

  it("documents the configuration and database recovery identity contract", () => {
    const readme = readFileSync(readmePath, "utf8");

    expect(readme).toContain('preupgrade_config="$preupgrade_dir/orbit-pre-upgrade.env"');
    expect(readme).toContain('chmod 600 "$preupgrade_config"');
    expect(readme).toContain("configuration or pre-start failure automatically restores");
    expect(readme).toContain(".orbit-install-staging.*");
    expect(readme).toContain('cp -- "$preupgrade_config" .env-orbit');
    expect(readme).toContain('bash scripts/restore.sh "$backup_path"');
    expect(readme).toContain('rm -f -- "$preupgrade_config"');
    expect(readme).toContain("validated `COMPOSE_PROJECT_NAME`");
  });

  it("persists a validated Compose project identity for fresh installs", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, {
      COMPOSE_PROJECT_NAME: "fresh-orbit",
      FAKE_USE_REAL_CONFIGURATION: "1",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain(
      "COMPOSE_PROJECT_NAME=fresh-orbit",
    );
    expect(result.stdout).not.toContain("fresh-orbit");
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("keeps backup and restore commands on the persisted env-file project", () => {
    for (const path of [backupScriptPath, restoreScriptPath]) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain('docker compose --env-file "$environment_file"');
      expect(source).not.toContain("--project-name orbit");
    }
  });

  it("refuses a fresh non-TTY install before Compose when core configuration requires attention", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, { FAKE_CONFIGURE_READY: "0" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("APP_URL");
    expect(result.stderr).toContain("OIDC_ISSUER");
    expect(result.stderr).toContain("OIDC_CLIENT_ID");
    expect(result.stderr).toContain("OIDC_CLIENT_SECRET");
    expect(result.stderr).toContain("OIDC_CALLBACK_URL");
    expect(result.calls).not.toContain("config --quiet");
    expect(result.calls).not.toContain("up -d");
    expect(targetEntries(targetDir)).toEqual([]);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("keeps OIDC discovery input attached to the isolated parser container", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, { FAKE_REQUIRE_INTERACTIVE: "1" });

    expect(result.status).toBe(0);
    const parserCall = result.calls
      .split("\n")
      .find((line) => line.startsWith("docker run") && line.includes("--entrypoint node"));
    expect(parserCall).toContain("--interactive");
    expect(result.calls).toContain("curl oidc-discovery");
  });

  it("collects guided core configuration and the OIDC secret from a controlling terminal", () => {
    const targetDir = makeTarget();
    const appUrl = "https://orbit.tty-install.internal";
    const issuer = "https://auth.tty-install.internal/application/o/orbit/";
    const clientId = "tty-install-client";
    const secret = "tty-install-secret";

    const result = runInstallWithControllingTerminal(
      targetDir,
      { FAKE_CONFIGURE_INIT_PROMPT: "1" },
      `${appUrl}\n${issuer}\n${clientId}\n${secret}\n1\n`,
      ["--install"],
    );

    expect(result.status).toBe(0);
    const environment = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    expect(environment).toContain(`APP_URL=${appUrl}`);
    expect(environment).toContain(`OIDC_ISSUER=${issuer}`);
    expect(environment).toContain(`OIDC_CLIENT_ID=${clientId}`);
    expect(environment).toContain(`OIDC_CALLBACK_URL=${appUrl}/api/auth/callback`);
    expect(readFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "utf8")).toBe(secret);
    expect(result.calls).toContain("config --quiet");
    expect(result.calls).toContain("up -d");
    const parserCall = result.calls
      .split("\n")
      .find((line) => line.startsWith("docker run") && line.includes("--entrypoint node"));
    expect(parserCall).toContain("--entrypoint node");
    expect(parserCall).toContain("--network none");
    expect(parserCall).toContain("--read-only");
    expect(parserCall).toContain("--cap-drop ALL");
    expect(parserCall).toContain("--security-opt no-new-privileges");
    expect(parserCall).not.toContain("auth.tty-install.internal");
  });

  it("keeps the target unchanged when the final guided review is cancelled", () => {
    const targetDir = makeTarget();
    const result = runInstallWithControllingTerminal(
      targetDir,
      { FAKE_CONFIGURE_INIT_PROMPT: "1" },
      [
        "https://orbit.cancelled-review.internal",
        "https://auth.cancelled-review.internal/application/o/orbit/",
        "cancelled-client",
        "cancelled-secret",
        "2",
        "",
      ].join("\n"),
      ["--install"],
    );

    expect(result.status).toBe(130);
    expect(result.stdout).toContain("Final review:");
    expect(result.calls).not.toContain("config --quiet");
    expect(result.calls).not.toContain("up -d");
    expect(targetEntries(targetDir)).toEqual([]);
    expect(`${result.stdout}${result.stderr}`).not.toContain("cancelled-secret");
  });

  it("reports successful preflight before the first service-start action", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, { FAKE_CONFIGURE_READY: "1" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(preflightSuccessLine);
    const composeCalls = result.calls
      .split("\n")
      .filter((line) => line.startsWith("docker compose"));
    const preflightIndex = composeCalls.findIndex((line) => line.includes("config --quiet"));
    const pullIndex = composeCalls.findIndex((line) => line.includes("pull orbit-db"));
    const startupIndex = composeCalls.findIndex((line) => line.includes("up -d"));
    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(pullIndex).toBeGreaterThan(preflightIndex);
    expect(startupIndex).toBeGreaterThan(preflightIndex);
  });

  it("supports a complete non-TTY pre-provisioned bootstrap without a Compose file", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);

    const result = runInstall(targetDir);

    expect(result.status).toBe(0);
    expect(result.calls).toContain("config --quiet");
    expect(result.calls).toContain("up -d");
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain(
      `ORBIT_IMAGE=${resolvedReference}`,
    );
    expect(readFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "utf8")).toBe(
      "preprovisioned-oidc-secret",
    );
  });

  it("preserves pre-provisioned inputs byte-for-byte when pre-commit Compose validation fails", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const before = managedSnapshot(targetDir);
    const beforeEntries = targetEntries(targetDir);

    const result = runInstall(targetDir, { FAKE_COMPOSE_CONFIG_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Docker Compose configuration is invalid");
    expect(managedSnapshot(targetDir)).toEqual(before);
    expect(targetEntries(targetDir)).toEqual(beforeEntries);
    expect(result.calls).toContain("config --quiet");
    expect(result.calls).not.toContain("up -d");
  });

  it("rejects extra top-level input before Docker or downloads", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    writeFileSync(join(targetDir, "extra.txt"), "not allowed\n");

    const result = runInstall(targetDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("safe pre-provisioned bootstrap");
    expect(result.calls).toBe("");
  });

  it.each([
    ["broad permissions", (secretPath) => chmodSync(secretPath, 0o640)],
    ["a symlink", (secretPath) => {
      unlinkSync(secretPath);
      const replacement = mkdtempSync(join(tmpdir(), "orbit-preprovisioned-secret-"));
      writeFileSync(join(replacement, "secret"), "outside-secret");
      symlinkSync(join(replacement, "secret"), secretPath);
    }],
  ])("rejects pre-provisioned secret input with %s before Docker or downloads", (_label, mutate) => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    mutate(join(targetDir, ".orbit-secrets", "oidc-client-secret"));

    const result = runInstall(targetDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("safe pre-provisioned bootstrap");
    expect(result.calls).toBe("");
  });

  it("reaches configuration with the resolved digest on a clean source-less target", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`CONFIGURE_INVOKED ORBIT_IMAGE=${resolvedReference}`);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain(
      `ORBIT_IMAGE=${resolvedReference}`,
    );
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(true);
    expect(existsSync(join(targetDir, "config", "tika-config.json"))).toBe(true);
    expect(existsSync(join(targetDir, "scripts", "backup.sh"))).toBe(true);
    expect(existsSync(join(targetDir, "scripts", "restore.sh"))).toBe(true);
    // issue #383 shipping gap: repair.sh and engine-check.sh must be fetched
    // and installed onto every deployed target exactly like backup.sh/
    // restore.sh, or `bash scripts/repair.sh`/`bash scripts/engine-check.sh`
    // fails with "no such file" on any real deployment despite both scripts
    // being fully operator-facing (repair.sh's own header documents running
    // it directly against a deployed target; engine-check.sh's header
    // states it is "exactly like configure.sh/repair.sh").
    expect(existsSync(join(targetDir, "scripts", "repair.sh"))).toBe(true);
    expect(existsSync(join(targetDir, "scripts", "engine-check.sh"))).toBe(true);
    expect(existsSync(join(targetDir, ".env-orbit.orbit-config.rollback"))).toBe(false);
    expect(lstatSync(join(targetDir, "scripts", "backup.sh")).isFile()).toBe(true);
    expect(lstatSync(join(targetDir, "scripts", "restore.sh")).isFile()).toBe(true);
    expect(lstatSync(join(targetDir, "scripts", "repair.sh")).isFile()).toBe(true);
    expect(lstatSync(join(targetDir, "scripts", "engine-check.sh")).isFile()).toBe(true);
    expect(result.calls).toContain(`scripts/backup.sh`);
    expect(result.calls).toContain(`scripts/restore.sh`);
    expect(result.calls).toContain(`scripts/repair.sh`);
    expect(result.calls).toContain(`scripts/engine-check.sh`);
    expect(result.stdout).not.toContain("BACKUP_INVOKED");
    expect(result.stdout).not.toContain("RESTORE_INVOKED");
    expect(result.stdout).not.toContain("REPAIR_INVOKED");
    expect(result.stdout).not.toContain("ENGINE_CHECK_INVOKED");
    const backup = failOnProcessDeadline(spawnSync("bash", [join(targetDir, "scripts", "backup.sh")], {
      encoding: "utf8",
      ...processGuard(),
    }), { label: "backup.sh stand-in" });
    expect(backup.status).toBe(0);
    expect(backup.stdout).toBe("BACKUP_INVOKED\n");
    const repair = failOnProcessDeadline(spawnSync("bash", [join(targetDir, "scripts", "repair.sh")], {
      encoding: "utf8",
      ...processGuard(),
    }), { label: "repair.sh stand-in" });
    expect(repair.status).toBe(0);
    expect(repair.stdout).toBe("REPAIR_INVOKED\n");
    const engineCheck = failOnProcessDeadline(spawnSync("bash", [join(targetDir, "scripts", "engine-check.sh")], {
      encoding: "utf8",
      ...processGuard(),
    }), { label: "engine-check.sh stand-in" });
    expect(engineCheck.status).toBe(0);
    expect(engineCheck.stdout).toBe("ENGINE_CHECK_INVOKED\n");
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("rejects an unsafe non-empty target before any pull or download", () => {
    const targetDir = makeTarget();
    writeFileSync(join(targetDir, "unrelated-file.txt"), "not an orbit deployment\n");

    const result = runInstall(targetDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to install here");
    expect(result.calls).toBe("");
  });

  // issue #383 (install.sh:270 finding, verified/fixed alongside the
  // deep-review findings above): staging_dir is created directly inside the
  // target ("./.orbit-install-staging.XXXXXX") and target_is_empty globs
  // with dotglob, so a leftover staging directory from an earlier attempt
  // that was SIGKILLed/OOM-killed/power-lost (never ran the EXIT trap's own
  // cleanup) makes an otherwise-empty target look non-empty on every
  // subsequent run. Before this fix, that produced only the generic
  // "not empty and not a recognizable Orbit deployment" refusal, with no
  // mention of the hidden directory actually responsible — the operator had
  // to go looking for it themselves. The fix names it explicitly instead;
  // it deliberately never auto-removes it, so this still refuses (target
  // validation's safety contract is unchanged), it just tells the operator
  // what is blocking the retry and that it is safe to remove once confirmed
  // no install is still in progress.
  it("names a leftover .orbit-install-staging.* directory in the refusal instead of the generic message (issue #383)", () => {
    const targetDir = makeTarget();
    mkdirSync(join(targetDir, ".orbit-install-staging.abc123"), { mode: 0o700 });

    const result = runInstall(targetDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("A previous install attempt was interrupted");
    expect(result.stderr).toContain(".orbit-install-staging.abc123");
    expect(result.stderr).not.toContain("not a recognizable Orbit deployment");
    expect(result.calls).toBe("");
    // Never auto-removed: only a human may confirm no install is still in
    // progress before deleting it.
    expect(existsSync(join(targetDir, ".orbit-install-staging.abc123"))).toBe(true);
  });

  it("rejects a target whose existing-deployment marker is a symlink", () => {
    const targetDir = makeTarget();
    writeFileSync(join(targetDir, ".env-orbit"), "EXISTING_ENV=1\n");
    writeFileSync(join(targetDir, "docker-compose.yml"), "PRIOR-COMPOSE-CONTENT\n");
    const realSecretsElsewhere = mkdtempSync(join(tmpdir(), "orbit-install-secrets-"));
    symlinkSync(realSecretsElsewhere, join(targetDir, ".orbit-secrets"));

    const result = runInstall(targetDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to install here");
    expect(result.calls).toBe("");
  });

  it("leaves existing files unchanged when an asset fetch fails", () => {
    const targetDir = makeTarget();
    makeExistingDeployment(targetDir);

    const result = runInstall(targetDir, { FAKE_CURL_FAIL_ASSET: "config/tika-config.json" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Could not fetch config/tika-config.json");
    expect(readFileSync(join(targetDir, "docker-compose.yml"), "utf8")).toBe(
      "PRIOR-COMPOSE-CONTENT\n",
    );
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe("EXISTING_ENV=1\n");
    expect(existsSync(join(targetDir, "config"))).toBe(false);
    expect(existsSync(join(targetDir, "scripts"))).toBe(false);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("leaves a recognised deployment unchanged when backup fetch fails", () => {
    const targetDir = makeTarget();
    makeFullExistingDeployment(targetDir);
    const before = managedSnapshot(targetDir);

    const result = runInstall(targetDir, { FAKE_CURL_FAIL_ASSET: "scripts/backup.sh" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Could not fetch scripts/backup.sh");
    expect(managedSnapshot(targetDir)).toEqual(before);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("refuses to overwrite an existing backup script symlink", () => {
    const targetDir = makeTarget();
    makeFullExistingDeployment(targetDir);
    unlinkSync(join(targetDir, "scripts", "backup.sh"));
    const symlinkTarget = mkdtempSync(join(tmpdir(), "orbit-install-backup-link-"));
    symlinkSync(symlinkTarget, join(targetDir, "scripts", "backup.sh"));
    const before = managedSnapshot(targetDir);

    const result = runInstall(targetDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to overwrite scripts/backup.sh");
    expect(managedSnapshot(targetDir)).toEqual(before);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("adds recovery scripts to a recognised legacy deployment", () => {
    const targetDir = makeTarget();
    makeLegacyExistingDeployment(targetDir);
    expect(existsSync(join(targetDir, "scripts", "backup.sh"))).toBe(false);
    expect(existsSync(join(targetDir, "scripts", "restore.sh"))).toBe(false);

    const result = runInstall(targetDir);

    expect(result.status).toBe(0);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain(
      "APP_URL=https://orbit.install-test.internal",
    );
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain(
      `ORBIT_IMAGE=${resolvedReference}`,
    );
    expect(readFileSync(join(targetDir, ".orbit-secrets", "sentinel"), "utf8")).toBe(
      "KEEP-SECRET\n",
    );
    expect(lstatSync(join(targetDir, "scripts", "backup.sh")).isFile()).toBe(true);
    expect(lstatSync(join(targetDir, "scripts", "restore.sh")).isFile()).toBe(true);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("refuses a new target when an existing Orbit database volume is present", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, { FAKE_DOCKER_EXISTING_DB_VOLUME: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("existing Orbit database volume");
    expect(result.calls).toContain("docker volume ls");
    expect(result.calls).not.toContain("docker pull");
    expect(result.calls).not.toContain("curl");
    expect(result.calls).not.toContain("config --quiet");
    expect(result.calls).not.toContain("up -d");
    expect(targetEntries(targetDir)).toEqual([]);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("refuses a pre-provisioned target when an existing Orbit database volume is present", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const before = managedSnapshot(targetDir);

    const result = runInstall(targetDir, { FAKE_DOCKER_EXISTING_DB_VOLUME: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("existing Orbit database volume");
    expect(result.calls).not.toContain("docker pull");
    expect(result.calls).not.toContain("curl");
    expect(managedSnapshot(targetDir)).toEqual(before);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("refuses a fresh target when a renamed-directory Orbit volume is orphaned", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, {
      FAKE_DOCKER_VOLUME_NAMES: "old-directory_orbit-db-data",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("existing Orbit database volume");
    expect(result.calls).not.toContain("docker pull");
    expect(result.calls).not.toContain("curl");
    expect(result.calls).not.toContain("up -d");
    expect(targetEntries(targetDir)).toEqual([]);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("accepts a recognized deployment when stored and recomputed config hashes diverge", () => {
    const targetDir = makeTarget();
    makeLegacyExistingDeployment(targetDir);
    const passwordPath = join(targetDir, ".orbit-secrets", "postgres-password");
    const beforePassword = readFileSync(passwordPath);

    const result = runInstall(targetDir, {
      ...recognizedVolumeOverrides(),
      FAKE_DOCKER_CONFIG_HASH: "e".repeat(64),
      FAKE_USE_REAL_CONFIGURATION: "1",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toContain("docker compose --project-name renamed-orbit");
    expect(result.calls).not.toContain("docker compose --project-name orbit ");
    expect(result.calls).not.toContain("config --hash orbit-app");
    expect(readFileSync(installScript, "utf8")).not.toContain("config --hash orbit-app");
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain(
      "COMPOSE_PROJECT_NAME=renamed-orbit",
    );
    expect(readFileSync(passwordPath)).toEqual(beforePassword);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("refuses an explicit Compose project mismatch with a proven database volume", () => {
    const targetDir = makeTarget();
    makeLegacyExistingDeployment(targetDir);
    const environmentPath = join(targetDir, ".env-orbit");
    writeFileSync(environmentPath, `${readFileSync(environmentPath, "utf8")}COMPOSE_PROJECT_NAME=declared-orbit\n`);
    chmodSync(environmentPath, 0o600);

    const result = runInstall(targetDir, {
      ...recognizedVolumeOverrides("renamed-orbit"),
      FAKE_USE_REAL_CONFIGURATION: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match the recognized database volume");
    expect(result.calls).not.toContain("docker pull");
    expect(result.calls).not.toContain("curl");
    expect(result.calls).not.toContain("up -d");
    expect(result.stderr).not.toContain("declared-orbit");
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("uses stopped-container ownership evidence for a recognized orphaned deployment volume", () => {
    const targetDir = makeTarget();
    makeLegacyExistingDeployment(targetDir);

    const result = runInstall(targetDir, {
      ...recognizedVolumeOverrides("stopped-orbit"),
      FAKE_USE_REAL_CONFIGURATION: "1",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toContain("docker ps -a");
    expect(result.calls).toContain("docker compose --project-name stopped-orbit");
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("refuses a recognized deployment when multiple Orbit database volumes exist", () => {
    const targetDir = makeTarget();
    makeLegacyExistingDeployment(targetDir);

    const result = runInstall(targetDir, {
      FAKE_DOCKER_VOLUME_NAMES: "first-orbit_orbit-db-data\nsecond-orbit_orbit-db-data",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Multiple Orbit database volumes");
    expect(result.calls).not.toContain("docker pull");
    expect(result.calls).not.toContain("curl");
    expect(result.calls).not.toContain("up -d");
    expect(result.stderr).not.toContain("existing-postgres-password");
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("refuses a same-image volume whose stopped containers do not match the recognized deployment", () => {
    const targetDir = makeTarget();
    makeLegacyExistingDeployment(targetDir);

    const result = runInstall(targetDir, {
      ...recognizedVolumeOverrides("recognized-orbit"),
      FAKE_DOCKER_APP_PROJECT: "unrelated-orbit",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("existing Orbit database volume");
    expect(result.calls).not.toContain("docker pull");
    expect(result.calls).not.toContain("curl");
    expect(result.calls).not.toContain("up -d");
    expect(result.stderr).not.toContain("existing-postgres-password");
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("refuses malformed canonical volume labels", () => {
    const targetDir = makeTarget();
    makeLegacyExistingDeployment(targetDir);

    const result = runInstall(targetDir, {
      ...recognizedVolumeOverrides("malformed-orbit"),
      FAKE_DOCKER_VOLUME_PROJECT: "malformed project",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("existing Orbit database volume");
    expect(result.calls).not.toContain("docker pull");
    expect(result.calls).not.toContain("curl");
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("refuses a database volume with an extra non-database consumer", () => {
    const targetDir = makeTarget();
    makeLegacyExistingDeployment(targetDir);

    const result = runInstall(targetDir, {
      ...recognizedVolumeOverrides(),
      FAKE_DOCKER_EXTRA_DB_VOLUME_CONSUMER: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("database volume");
    expect(result.calls).not.toContain("docker pull");
    expect(result.calls).not.toContain("curl");
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it.each([
    ["duplicate database containers", { FAKE_DOCKER_DUPLICATE_DB_CONTAINER: "1" }],
    ["duplicate app containers", { FAKE_DOCKER_DUPLICATE_APP_CONTAINER: "1" }],
    ["wrong database service", { FAKE_DOCKER_DB_SERVICE: "postgres" }],
    ["wrong app service", { FAKE_DOCKER_APP_SERVICE: "web" }],
    ["mismatched app image", { FAKE_DOCKER_APP_IMAGE: `other-registry.example/orbit@sha256:${"e".repeat(64)}` }],
  ])("refuses a recognized deployment with %s", (_label, override) => {
    const targetDir = makeTarget();
    makeLegacyExistingDeployment(targetDir);

    const result = runInstall(targetDir, {
      ...recognizedVolumeOverrides(),
      ...override,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("database volume");
    expect(result.calls).not.toContain("docker pull");
    expect(result.calls).not.toContain("curl");
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("refuses a recognised upgrade without the preserved database password file", () => {
    const targetDir = makeTarget();
    makeFullExistingDeployment(targetDir);
    unlinkSync(join(targetDir, ".orbit-secrets", "postgres-password"));
    const before = managedSnapshot(targetDir);

    const result = runInstall(targetDir, { FAKE_DOCKER_EXISTING_DB_VOLUME: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("preserved POSTGRES_PASSWORD_FILE");
    expect(result.calls).not.toContain("docker pull");
    expect(result.calls).not.toContain("curl");
    expect(managedSnapshot(targetDir)).toEqual(before);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("preserves the prior database password byte-for-byte on a recognized upgrade", () => {
    const targetDir = makeTarget();
    makeLegacyExistingDeployment(targetDir);
    const passwordPath = join(targetDir, ".orbit-secrets", "postgres-password");
    const beforePassword = readFileSync(passwordPath);

    const result = runInstall(targetDir, {
      FAKE_DOCKER_EXISTING_DB_VOLUME: "1",
      FAKE_USE_REAL_CONFIGURATION: "1",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(passwordPath)).toEqual(beforePassword);
    expect(result.stdout).not.toContain("existing-postgres-password");
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("rolls back a recognized upgrade if configuration changes the prior database password", () => {
    const targetDir = makeTarget();
    makeLegacyExistingDeployment(targetDir);
    const before = managedSnapshot(targetDir);

    const result = runInstall(targetDir, {
      FAKE_DOCKER_EXISTING_DB_VOLUME: "1",
      FAKE_USE_REAL_CONFIGURATION: "1",
      FAKE_CONFIGURE_MUTATE_POSTGRES_PASSWORD: "1",
    });

    expect(result.status).not.toBe(0);
    expect(managedSnapshot(targetDir)).toEqual(before);
    expect(result.stdout).not.toContain("existing-postgres-password");
    expect(result.stderr).not.toContain("mutated-postgres-password");
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("migrates a legacy configuration through the installer and remains idempotent", () => {
    const targetDir = makeTarget();
    makeLegacyExistingDeployment(targetDir);
    const environmentPath = join(targetDir, ".env-orbit");
    const result = runInstall(targetDir, { FAKE_USE_REAL_CONFIGURATION: "1" });

    expect(result.status).toBe(0);
    const migratedEnvironment = snapshotPath(environmentPath);
    expect(migratedEnvironment?.type).toBe("file");
    expect(migratedEnvironment?.mode & 0o777).toBe(0o600);
    expect(migratedEnvironment?.content).toContain("ORBIT_CONFIG_SCHEMA_VERSION=1\n");
    expect(migratedEnvironment?.content).toContain("ORBIT_CONFIG_APPLIED_VERSION=v1.2.0\n");
    expect(migratedEnvironment?.content).toContain(`ORBIT_CONFIG_APPLIED_DIGEST=sha256:${"a".repeat(64)}\n`);
    expect(result.stdout).toContain(
      `Orbit configuration: migrated from schema v0 version legacy/unknown digest legacy/unknown to schema v1 version v1.2.0 digest sha256:${"a".repeat(64)}`,
    );
    const expected = migratedEnvironment?.content;
    expect(existsSync(join(targetDir, ".env-orbit.orbit-config.rollback"))).toBe(false);
    expect(stagingLeftovers(targetDir)).toEqual([]);

    const rerun = runInstall(targetDir, { FAKE_USE_REAL_CONFIGURATION: "1" });

    expect(rerun.status).toBe(0);
    const rerunEnvironment = snapshotPath(environmentPath);
    expect(rerunEnvironment?.type).toBe("file");
    expect(rerunEnvironment?.content).toBe(expected);
    expect(rerun.stdout).toContain(
      `Orbit configuration: already current schema v1 version v1.2.0 digest sha256:${"a".repeat(64)}`,
    );
    expect(existsSync(join(targetDir, ".env-orbit.orbit-config.rollback"))).toBe(false);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("restores the exact legacy configuration when a later transaction step fails", () => {
    const targetDir = makeTarget();
    makeLegacyExistingDeployment(targetDir);
    const environmentPath = join(targetDir, ".env-orbit");
    const before = readFileSync(environmentPath, "utf8");
    const beforeEntries = targetEntries(targetDir);

    const result = runInstall(targetDir, {
      FAKE_USE_REAL_CONFIGURATION: "1",
      FAKE_CONFIGURE_FAIL: "1",
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(environmentPath, "utf8") === before).toBe(true);
    expect(statSync(environmentPath).mode & 0o777).toBe(0o600);
    expect(targetEntries(targetDir)).toEqual(beforeEntries);
    expect(existsSync(join(targetDir, ".env-orbit.orbit-config.rollback"))).toBe(false);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("rolls a legacy deployment back when the final restore-script rename fails", () => {
    const targetDir = makeTarget();
    makeLegacyExistingDeployment(targetDir);
    const before = managedSnapshot(targetDir);
    const beforeEntries = targetEntries(targetDir);
    const markerDir = mkdtempSync(join(tmpdir(), "orbit-install-legacy-mv-failure-"));

    const result = runInstall(targetDir, {
      FAKE_MV_FAIL_DEST: "scripts/restore.sh",
      FAKE_MV_FAIL_MARKER: join(markerDir, "failed"),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restoring the previous deployment");
    expect(managedSnapshot(targetDir)).toEqual(before);
    expect(targetEntries(targetDir)).toEqual(beforeEntries);
    expect(existsSync(join(targetDir, "scripts", "backup.sh"))).toBe(false);
    expect(existsSync(join(targetDir, "scripts", "restore.sh"))).toBe(false);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("leaves a recognised deployment unchanged when a new script fails syntax validation", () => {
    const targetDir = makeTarget();
    makeFullExistingDeployment(targetDir);
    const before = managedSnapshot(targetDir);

    const result = runInstall(targetDir, { FAKE_INVALID_ASSET: "scripts/restore.sh" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Fetched scripts/restore.sh failed a syntax check");
    expect(managedSnapshot(targetDir)).toEqual(before);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("fails closed when the registry omits an immutable digest", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, { FAKE_DOCKER_OMIT_DIGEST: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not return an immutable digest");
    expect(result.calls).not.toContain("curl");
  });

  it("fails closed when the published image omits its source revision", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, { FAKE_DOCKER_OMIT_REVISION: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not record the source revision");
    expect(result.calls).not.toContain("curl");
  });

  it("reports a direct image inspection failure explicitly", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, { FAKE_DOCKER_INSPECT_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Could not inspect");
    expect(result.calls).not.toContain("curl");
  });

  it("reports a source revision inspection failure explicitly", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, { FAKE_DOCKER_REVISION_INSPECT_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("for its source revision");
    expect(result.calls).not.toContain("curl");
  });

  it("fails clearly and rolls back when configuration leaves no regular environment file", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, { FAKE_CONFIGURE_SKIP_ENV: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not leave a regular, non-symlink .env-orbit");
    expect(result.stderr).not.toContain("grep:");
    expect(targetEntries(targetDir)).toEqual([]);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("restores every existing managed path after a mid-asset rename failure", () => {
    const targetDir = makeTarget();
    makeFullExistingDeployment(targetDir);
    const before = managedSnapshot(targetDir);
    const beforeEntries = targetEntries(targetDir);
    const markerDir = mkdtempSync(join(tmpdir(), "orbit-install-mv-failure-"));

    const result = runInstall(targetDir, {
      FAKE_MV_FAIL_DEST: "config/tika-config.json",
      FAKE_MV_FAIL_MARKER: join(markerDir, "failed"),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restoring the previous deployment");
    expect(managedSnapshot(targetDir)).toEqual(before);
    expect(targetEntries(targetDir)).toEqual(beforeEntries);
    expect(existsSync(join(targetDir, ".env-orbit.orbit-config.rollback"))).toBe(false);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("restores an existing deployment after configuration mutates files and fails", () => {
    const targetDir = makeTarget();
    makeFullExistingDeployment(targetDir);
    const before = managedSnapshot(targetDir);
    const beforeEntries = targetEntries(targetDir);

    const result = runInstall(targetDir, { FAKE_CONFIGURE_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Configuration failed");
    expect(managedSnapshot(targetDir)).toEqual(before);
    expect(targetEntries(targetDir)).toEqual(beforeEntries);
    expect(existsSync(join(targetDir, ".env-orbit.orbit-config.rollback"))).toBe(false);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("returns a clean target to empty after configuration fails", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, { FAKE_CONFIGURE_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Configuration failed");
    expect(targetEntries(targetDir)).toEqual([]);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("retains existing environment and secret sentinels on a recognised upgrade", () => {
    const targetDir = makeTarget();
    makeFullExistingDeployment(targetDir);

    const result = runInstall(targetDir);

    expect(result.status).toBe(0);
    const environment = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    expect(environment).toContain("EXISTING_ENV=1");
    expect(environment).toContain(`ORBIT_IMAGE=${resolvedReference}`);
    expect(environment).not.toContain("ORBIT_IMAGE=old-registry.example");
    expect(readFileSync(join(targetDir, ".orbit-secrets", "sentinel"), "utf8")).toBe(
      "KEEP-SECRET\n",
    );
    expect(readFileSync(join(targetDir, "docker-compose.yml"), "utf8")).toBe(
      "fake content for docker-compose.yml\n",
    );
    expect(existsSync(join(targetDir, "scripts", "backup.sh"))).toBe(true);
    expect(existsSync(join(targetDir, "scripts", "restore.sh"))).toBe(true);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("retains an existing OIDC client secret file, byte-for-byte and mode 0600, on a recognised upgrade", () => {
    const targetDir = makeTarget();
    makeFullExistingDeployment(targetDir);
    writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "existing-oidc-client-secret-value");
    chmodSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), 0o600);

    const result = runInstall(targetDir);

    expect(result.status).toBe(0);
    const secretPath = join(targetDir, ".orbit-secrets", "oidc-client-secret");
    expect(readFileSync(secretPath, "utf8")).toBe("existing-oidc-client-secret-value");
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("starts a new image assignment on its own line when the existing environment has no final newline", () => {
    const targetDir = makeTarget();
    makeFullExistingDeployment(targetDir);
    const completeEnvironment = readFileSync(join(targetDir, ".env-orbit"), "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("ORBIT_IMAGE="))
      .join("\n")
      .replace(/\n$/, "");
    writeFileSync(join(targetDir, ".env-orbit"), completeEnvironment);
    chmodSync(join(targetDir, ".env-orbit"), 0o600);

    const result = runInstall(targetDir);

    expect(result.status).toBe(0);
    const environmentLines = readFileSync(join(targetDir, ".env-orbit"), "utf8").split("\n");
    expect(environmentLines).toContain(`ORBIT_IMAGE=${resolvedReference}`);
    expect(environmentLines).not.toContain(`EXISTING_ENV=1ORBIT_IMAGE=${resolvedReference}`);
  });

  it("collapses a duplicated image assignment to a single resolved line", () => {
    const targetDir = makeTarget();
    makeFullExistingDeployment(targetDir);
    // An env file that already carries the key twice must not come out still
    // carrying it twice. docker compose takes the last and is unharmed, but a
    // duplicated managed key leaves every other reader free to disagree.
    const doubled = readFileSync(join(targetDir, ".env-orbit"), "utf8").replace(
      /^ORBIT_IMAGE=.*$/m,
      (line) => `${line}\n${line}`,
    );
    writeFileSync(join(targetDir, ".env-orbit"), doubled);
    chmodSync(join(targetDir, ".env-orbit"), 0o600);
    expect(doubled.split("\n").filter((line) => line.startsWith("ORBIT_IMAGE=")).length).toBe(2);

    const result = runInstall(targetDir);

    expect(result.status).toBe(0);
    const environmentLines = readFileSync(join(targetDir, ".env-orbit"), "utf8").split("\n");
    const imageLines = environmentLines.filter((line) => line.startsWith("ORBIT_IMAGE="));
    expect(imageLines).toEqual([`ORBIT_IMAGE=${resolvedReference}`]);
  });

  it("refuses an incomplete recognised upgrade without starting Compose", () => {
    const targetDir = makeTarget();
    makeExistingDeployment(targetDir);
    writeFileSync(join(targetDir, ".env-orbit"), "EXISTING_ENV=1");
    const beforeEntries = targetEntries(targetDir);

    const result = runInstall(targetDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OIDC_ISSUER requires attention");
    expect(result.calls).not.toContain("config --quiet");
    expect(result.calls).not.toContain("up -d");
    expect(targetEntries(targetDir)).toEqual(beforeEntries);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe("EXISTING_ENV=1");
  });

  it("rolls back installed files when Compose configuration validation fails", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, { FAKE_COMPOSE_CONFIG_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Docker Compose configuration is invalid");
    expect(result.stdout).not.toContain(preflightSuccessLine);
    expect(existsSync(join(targetDir, ".env-orbit"))).toBe(false);
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(false);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("keeps committed files when a later Compose operation fails", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, { FAKE_COMPOSE_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain(
      `ORBIT_IMAGE=${resolvedReference}`,
    );
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(true);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("does not expose provider or secret details when discovery is unavailable", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, {
      FAKE_CONFIGURE_READY: "1",
      FAKE_OIDC_NETWORK_FAIL: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OIDC provider is unavailable");
    expect(`${result.stdout}${result.stderr}`).toContain("reason=provider-unavailable action=retry");
    expect(result.stderr).not.toContain("auth.install-test.internal");
    expect(result.stderr).not.toContain("provider-body-secret");
    expect(result.calls).not.toContain("config --quiet");
    expect(result.calls).not.toContain("up -d");
  });

  it("distinguishes an invalid discovery response from provider unavailability", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, {
      FAKE_CONFIGURE_READY: "1",
      FAKE_OIDC_HTTP_STATUS: "404",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OIDC provider configuration could not be validated");
    expect(`${result.stdout}${result.stderr}`).toContain("reason=configuration-failure action=retry");
    expect(result.stderr).not.toContain("auth.install-test.internal");
    expect(result.calls).not.toContain("config --quiet");
    expect(result.calls).not.toContain("up -d");
  });

  it.each([
    ["invalid JSON", "not-json"],
    [
      "a wrong issuer",
      JSON.stringify({
        issuer: "https://wrong-issuer.install-test.internal/",
        authorization_endpoint: "https://auth.install-test.internal/authorize",
        token_endpoint: "https://auth.install-test.internal/token",
        jwks_uri: "https://auth.install-test.internal/jwks",
      }),
    ],
    [
      "a missing required endpoint",
      JSON.stringify({
        issuer: "https://auth.install-test.internal/application/o/orbit/",
        authorization_endpoint: "https://auth.install-test.internal/authorize",
        token_endpoint: "https://auth.install-test.internal/token",
      }),
    ],
    [
      "a non-HTTPS required endpoint",
      JSON.stringify({
        issuer: "https://auth.install-test.internal/application/o/orbit/",
        authorization_endpoint: "http://auth.install-test.internal/authorize",
        token_endpoint: "https://auth.install-test.internal/token",
        jwks_uri: "https://auth.install-test.internal/jwks",
      }),
    ],
  ])("rejects discovery metadata with %s before Compose", (_label, body) => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, { FAKE_OIDC_RESPONSE_BODY: body });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OIDC provider configuration could not be validated");
    expect(result.calls).not.toContain("config --quiet");
    expect(result.calls).not.toContain("up -d");
  });

  it("does not expose invalid discovery bodies or provider details", () => {
    const targetDir = makeTarget();
    const body = JSON.stringify({
      issuer: "https://auth.install-test.internal/application/o/orbit/",
      authorization_endpoint: "https://auth.install-test.internal/authorize",
      token_endpoint: "https://auth.install-test.internal/token",
      jwks_uri: "http://auth.install-test.internal/jwks",
      body_secret: "provider-body-secret",
    });

    const result = runInstall(targetDir, { FAKE_OIDC_RESPONSE_BODY: body });
    const output = `${result.stdout}\n${result.stderr}\n${result.calls}`;

    expect(result.status).not.toBe(0);
    expect(output).not.toContain("provider-body-secret");
    expect(output).not.toContain("auth.install-test.internal");
  });
});

describe("install.sh version-tag identity (#676)", () => {
  it("installs a version tag whose image embeds that same version", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);

    const result = runInstall(
      targetDir,
      { ORBIT_CHANNEL: "v1.3.0", FAKE_DOCKER_VERSION: "v1.3.0" },
      ["--plain"],
    );

    expect(result.status).toBe(0);
    expect(result.calls).toContain("up -d");
    expect(result.stdout).toContain("Version: v1.3.0");
    expect(result.stdout).toContain("Channel: v1.3.0");
  });

  it("refuses a version tag whose image embeds a different version", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);

    const result = runInstall(targetDir, {
      ORBIT_CHANNEL: "v1.3.0",
      FAKE_DOCKER_VERSION: "v1.2.0",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match the requested version tag");
    expect(result.calls).not.toContain("up -d");
  });

  it("leaves a moving channel tag unbound to any particular version", () => {
    // `latest` legitimately carries whatever build it points at; only a
    // version tag makes a claim about which release it is.
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);

    const result = runInstall(
      targetDir,
      { ORBIT_CHANNEL: "latest", FAKE_DOCKER_VERSION: "v1.2.0" },
      ["--plain"],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Version: v1.2.0");
  });

  it("still refuses a label that is not a semantic version", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);

    const result = runInstall(targetDir, {
      FAKE_DOCKER_VERSION: "preview-release-v1.0.0-30597511059-1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not record a valid semantic version");
    expect(result.calls).not.toContain("up -d");
  });
});

describe("install.sh --simulate", () => {
  it("rejects --simulate combined with an installer action before any external action", () => {
    const targetDir = makeTarget();

    for (const action of ["--install", "--update", "--repair"]) {
      const result = runInstall(targetDir, {}, ["--simulate", action]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Usage:");
      expect(result.calls).toBe("");
    }
    expect(targetEntries(targetDir)).toEqual([]);
  });

  it("dispatches the plain simulation before target and deployment-environment validation, without files or external calls", () => {
    const targetDir = makeTarget();
    // A non-empty, non-recognizable target would fail validate_target for a
    // real install/update; simulation must never reach that check.
    writeFileSync(join(targetDir, "unrelated-file"), "not an Orbit deployment\n");
    const beforeEntries = targetEntries(targetDir);

    const result = runInstall(targetDir, { ORBIT_CHANNEL: "not a valid channel" }, ["--plain", "--simulate"]);

    expect(result.status).toBe(0);
    expect(result.calls).toBe("");
    expect(targetEntries(targetDir)).toEqual(beforeEntries);
    expect(result.stdout).toContain("simulation=true");
    expect(result.stdout).toContain("No deployment occurred.");
    expect(result.stdout).not.toMatch(/\x1b\[/u);
  });

  it("chooses the fixed deterministic success path in plain mode", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, {}, ["--plain", "--simulate"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("state=healthy");
    expect(result.stdout).toContain("state=completed");
    expect(result.stdout).toContain("SIMULATED-DIGEST-NOT-REAL");
    expect(result.stdout).not.toContain(`sha256:${digest}`);
    expect(result.calls).toBe("");
  });

  it("cancels the interactive simulation with a lone Escape at the top-level menu", () => {
    const targetDir = makeTarget();
    const beforeEntries = targetEntries(targetDir);

    const result = runInstallWithControllingTerminal(targetDir, {}, "\x1b", ["--simulate"]);

    expect(result.status).toBe(130);
    expect(result.stdout).toContain("Simulation: Greetings");
    expect(result.calls).toBe("");
    expect(targetEntries(targetDir)).toEqual(beforeEntries);
  });

  // Cued by prompt text rather than typed ahead: with both keys written up
  // front and the pty closed behind them, the Escape's follow-up read raced
  // the teardown and the child sat on its 180s deadline under load (#698).
  it("cancels the interactive simulation with a lone Escape at the profile menu", async () => {
    const targetDir = makeTarget();
    const beforeEntries = targetEntries(targetDir);

    const result = await runInstallWithPromptedTerminalInput(targetDir, {}, [
      { after: "Simulation: Greetings, what can we do for you today?", input: "\r" },
      { after: "Simulation: choose a deployment profile", input: "\x1b" },
    ], ["--simulate"]);

    expect(result.status).toBe(130);
    expect(result.promptedInteractions).toBe(2);
    expect(result.calls).toBe("");
    expect(targetEntries(targetDir)).toEqual(beforeEntries);
  }, PTY_TEST_TIMEOUT_MS);

  it("exits the interactive simulation from the top-level Exit choice", () => {
    const targetDir = makeTarget();

    const result = runInstallWithControllingTerminal(targetDir, {}, "\x1b[B\x1b[B\x1b[B\r", ["--simulate"]);

    expect(result.status).toBe(130);
    expect(result.calls).toBe("");
    expect(targetEntries(targetDir)).toEqual([]);
  });

  it("keeps interactive Repair presentation-only and non-mutating in simulation", () => {
    const targetDir = makeTarget();

    const result = runInstallWithControllingTerminal(targetDir, {}, "\x1b[B\x1b[B\r", ["--simulate"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("repair_unavailable");
    expect(result.stdout).toContain("No deployment occurred.");
    expect(result.calls).toBe("");
    expect(targetEntries(targetDir)).toEqual([]);
  });

  it("walks the full interactive simulation to a fixed success scenario without mutation or external calls", () => {
    const targetDir = makeTarget();
    const secret = "not-a-real-credential";

    const result = runInstallWithControllingTerminal(
      targetDir,
      {},
      `\r\rhello-note\r${secret}\r\r\r`,
      ["--simulate"],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("hello-note");
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).toContain("healthy");
    expect(result.stdout).toContain("completed");
    expect(result.stdout).toContain("No deployment occurred.");
    expect(result.calls).toBe("");
    expect(targetEntries(targetDir)).toEqual([]);
  });

  it("presents the fixed representative failure scenarios without a real error or credential", () => {
    const targetDir = makeTarget();

    const result = runInstallWithControllingTerminal(
      targetDir,
      {},
      "\r\rnote\rsecret\r\r\x1b[B\r",
      ["--simulate"],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("database-auth-migration");
    expect(result.stdout).toContain("No deployment occurred.");
    expect(result.calls).toBe("");
    expect(targetEntries(targetDir)).toEqual([]);
  });
});
