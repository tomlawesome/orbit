import { spawnSync } from "node:child_process";
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
import { describe, expect, it } from "vitest";

// This suite is fully mocked: fake `docker` and `curl` executables are placed
// ahead of the real ones on PATH, so no test needs Docker, a registry,
// network access, Git or a TTY.

const installScript = fileURLToPath(new URL("./install.sh", import.meta.url));
const configurationScriptPath = fileURLToPath(new URL("./configuration.sh", import.meta.url));

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
  "config/tika-config.xml",
  "scripts/configure.sh",
  "scripts/configuration.sh",
  "scripts/backup.sh",
  "scripts/restore.sh",
];

const fakeDockerScript = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  'if [[ -n "${FAKE_CALL_LOG:-}" ]]; then',
  "  printf 'docker %s\\n' \"$*\" >> \"$FAKE_CALL_LOG\"",
  "fi",
  'case "$1" in',
  "  compose)",
  '    if [[ "${FAKE_COMPOSE_CONFIG_FAIL:-}" == "1" && " $* " == *" config "* ]]; then',
  "      exit 23",
  "    fi",
  '    if [[ "${FAKE_COMPOSE_FAIL:-}" == "1" && "${2:-}" != "version" && " $* " != *" config "* ]]; then',
  "      exit 23",
  "    fi",
  "    exit 0",
  "    ;;",
  "  pull)",
  "    exit 0",
  "    ;;",
  "  run)",
  "    args=(\"$@\")",
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
  "  scripts/configuration.sh)",
  '    if [[ "${FAKE_USE_REAL_CONFIGURATION:-0}" == "1" ]]; then',
  '      cp -- "${FAKE_CONFIGURATION_SCRIPT_PATH:?}" "$output"',
  "    else",
  "      cat <<'SCRIPT' > \"$output\"",
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  "exit 0",
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

function runInstall(targetDir, envOverrides = {}) {
  const binDir = makeFakeBin();
  const logDir = mkdtempSync(join(tmpdir(), "orbit-install-log-"));
  const logPath = join(logDir, "calls.log");
  const result = spawnSync("bash", [installScript], {
    cwd: targetDir,
    encoding: "utf8",
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: process.env.HOME ?? tmpdir(),
      ORBIT_REPOSITORY: repository,
      ORBIT_REGISTRY: registry,
      FAKE_IMAGE_REPOSITORY: imageRepository,
      FAKE_DOCKER_DIGEST: digest,
      FAKE_DOCKER_REVISION: revision,
      FAKE_ASSET_BASE: assetBase,
      FAKE_CALL_LOG: logPath,
      FAKE_CONFIGURATION_SCRIPT_PATH: configurationScriptPath,
      FAKE_USE_REAL_CONFIGURATION: "0",
      FAKE_CONFIGURE_READY: "1",
      ...envOverrides,
    },
  });
  const calls = readOptionalFile(logPath);
  return { ...result, calls };
}

function runInstallWithControllingTerminal(targetDir, envOverrides = {}, input = "") {
  const binDir = makeFakeBin();
  const logDir = mkdtempSync(join(tmpdir(), "orbit-install-log-"));
  const logPath = join(logDir, "calls.log");
  const result = spawnSync("script", ["-qec", `exec </dev/null; bash ${installScript}`, "/dev/null"], {
    cwd: targetDir,
    encoding: "utf8",
    input,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: process.env.HOME ?? tmpdir(),
      ORBIT_REPOSITORY: repository,
      ORBIT_REGISTRY: registry,
      FAKE_IMAGE_REPOSITORY: imageRepository,
      FAKE_DOCKER_DIGEST: digest,
      FAKE_DOCKER_REVISION: revision,
      FAKE_ASSET_BASE: assetBase,
      FAKE_CALL_LOG: logPath,
      FAKE_CONFIGURE_READY: "0",
      ...envOverrides,
    },
  });
  const calls = readOptionalFile(logPath);
  return { ...result, calls };
}

describe("install.sh", () => {
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
    const parserCall = result.calls.split("\n").find((line) => line.startsWith("docker run"));
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
      `${appUrl}\n${issuer}\n${clientId}\n${secret}\n`,
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
    const parserCall = result.calls.split("\n").find((line) => line.startsWith("docker run"));
    expect(parserCall).toContain("--entrypoint node");
    expect(parserCall).toContain("--network none");
    expect(parserCall).toContain("--read-only");
    expect(parserCall).toContain("--cap-drop ALL");
    expect(parserCall).toContain("--security-opt no-new-privileges");
    expect(parserCall).not.toContain("auth.tty-install.internal");
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
    expect(existsSync(join(targetDir, "config", "tika-config.xml"))).toBe(true);
    expect(existsSync(join(targetDir, "scripts", "backup.sh"))).toBe(true);
    expect(existsSync(join(targetDir, "scripts", "restore.sh"))).toBe(true);
    expect(existsSync(join(targetDir, ".env-orbit.orbit-config.rollback"))).toBe(false);
    expect(lstatSync(join(targetDir, "scripts", "backup.sh")).isFile()).toBe(true);
    expect(lstatSync(join(targetDir, "scripts", "restore.sh")).isFile()).toBe(true);
    expect(result.calls).toContain(`scripts/backup.sh`);
    expect(result.calls).toContain(`scripts/restore.sh`);
    expect(result.stdout).not.toContain("BACKUP_INVOKED");
    expect(result.stdout).not.toContain("RESTORE_INVOKED");
    const backup = spawnSync("bash", [join(targetDir, "scripts", "backup.sh")], {
      encoding: "utf8",
    });
    expect(backup.status).toBe(0);
    expect(backup.stdout).toBe("BACKUP_INVOKED\n");
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

    const result = runInstall(targetDir, { FAKE_CURL_FAIL_ASSET: "config/tika-config.xml" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Could not fetch config/tika-config.xml");
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

  it("migrates a legacy configuration through the installer and remains idempotent", () => {
    const targetDir = makeTarget();
    makeLegacyExistingDeployment(targetDir);
    const environmentPath = join(targetDir, ".env-orbit");
    const before = readFileSync(environmentPath, "utf8");
    const expected = `${before}ORBIT_CONFIG_SCHEMA_VERSION=1\n`;

    const result = runInstall(targetDir, { FAKE_USE_REAL_CONFIGURATION: "1" });

    expect(result.status).toBe(0);
    const migratedEnvironment = snapshotPath(environmentPath);
    expect(migratedEnvironment?.type).toBe("file");
    expect(migratedEnvironment?.mode & 0o777).toBe(0o600);
    expect(migratedEnvironment?.content === expected).toBe(true);
    expect(existsSync(join(targetDir, ".env-orbit.orbit-config.rollback"))).toBe(false);
    expect(stagingLeftovers(targetDir)).toEqual([]);

    const rerun = runInstall(targetDir, { FAKE_USE_REAL_CONFIGURATION: "1" });

    expect(rerun.status).toBe(0);
    const rerunEnvironment = snapshotPath(environmentPath);
    expect(rerunEnvironment?.type).toBe("file");
    expect(rerunEnvironment?.content === expected).toBe(true);
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
      FAKE_MV_FAIL_DEST: "config/tika-config.xml",
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
