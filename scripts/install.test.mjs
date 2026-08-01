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
  symlinkSync,
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

const repository = "example/orbit-fixture";
const registry = "fake-registry.example";
const imageRepository = `${registry}/${repository}`;
const digest = "a".repeat(64);
const revision = "b".repeat(40);
const resolvedReference = `${imageRepository}@sha256:${digest}`;
const assetBase = `https://raw.githubusercontent.com/${repository}/${revision}`;
const deploymentAssets = [
  "docker-compose.yml",
  "docker-compose.mail.yml",
  "docker-compose.mail-alias-rotation.yml",
  ".env-orbit.example",
  "config/tika-config.xml",
  "scripts/configure.sh",
];

const fakeDockerScript = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  'if [[ -n "${FAKE_CALL_LOG:-}" ]]; then',
  "  printf 'docker %s\\n' \"$*\" >> \"$FAKE_CALL_LOG\"",
  "fi",
  'case "$1" in',
  "  compose)",
  '    if [[ "${FAKE_COMPOSE_FAIL:-}" == "1" && "${2:-}" != "version" ]]; then',
  "      exit 23",
  "    fi",
  "    exit 0",
  "    ;;",
  "  pull)",
  "    exit 0",
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
  'url=""',
  "while [[ $# -gt 0 ]]; do",
  '  case "$1" in',
  "    --output)",
  '      output="$2"',
  "      shift 2",
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
  'if [[ -n "${FAKE_CALL_LOG:-}" ]]; then',
  "  printf 'curl %s\\n' \"$asset\" >> \"$FAKE_CALL_LOG\"",
  "fi",
  'if [[ -n "${FAKE_CURL_FAIL_ASSET:-}" && "$asset" == "${FAKE_CURL_FAIL_ASSET}" ]]; then',
  "  exit 22",
  "fi",
  'case "$asset" in',
  "  scripts/configure.sh)",
  "    cat <<'SCRIPT' > \"$output\"",
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  "printf 'CONFIGURE_INVOKED ORBIT_IMAGE=%s\\n' \"${ORBIT_IMAGE:-}\"",
  'if [[ "${FAKE_CONFIGURE_SKIP_ENV:-}" != "1" && ! -e .env-orbit ]]; then',
  "  printf 'CONFIGURED_ENV=1\\n' > .env-orbit",
  "fi",
  'if [[ "${FAKE_CONFIGURE_SKIP_SECRETS:-}" != "1" && ! -e .orbit-secrets ]]; then',
  "  mkdir .orbit-secrets",
  "fi",
  '[[ ! -e .env-orbit ]] || chmod 600 .env-orbit',
  '[[ ! -e .orbit-secrets ]] || chmod 700 .orbit-secrets',
  'if [[ "${FAKE_CONFIGURE_FAIL:-}" == "1" ]]; then',
  '  [[ ! -f .env-orbit ]] || printf "CONFIGURE_MUTATION=1\\n" >> .env-orbit',
  '  [[ ! -d .orbit-secrets ]] || printf "configure-secret\\n" > .orbit-secrets/configure-secret',
  '  [[ ! -f .orbit-secrets/configure-secret ]] || chmod 600 .orbit-secrets/configure-secret',
  "  exit 42",
  "fi",
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

function makeFullExistingDeployment(targetDir) {
  writeFileSync(
    join(targetDir, ".env-orbit"),
    "EXISTING_ENV=1\nORBIT_IMAGE=old-registry.example/orbit@sha256:" + "c".repeat(64) + "\n",
  );
  chmodSync(join(targetDir, ".env-orbit"), 0o640);
  for (const [index, asset] of deploymentAssets.entries()) {
    const path = join(targetDir, asset);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `PRIOR-${asset}\n`);
    chmodSync(path, index % 2 === 0 ? 0o640 : 0o600);
  }
  mkdirSync(join(targetDir, ".orbit-secrets"));
  chmodSync(join(targetDir, ".orbit-secrets"), 0o750);
  writeFileSync(join(targetDir, ".orbit-secrets", "sentinel"), "KEEP-SECRET\n");
  chmodSync(join(targetDir, ".orbit-secrets", "sentinel"), 0o640);
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
      ...envOverrides,
    },
  });
  const calls = readOptionalFile(logPath);
  return { ...result, calls };
}

describe("install.sh", () => {
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
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("starts a new image assignment on its own line when the existing environment has no final newline", () => {
    const targetDir = makeTarget();
    makeExistingDeployment(targetDir);
    writeFileSync(join(targetDir, ".env-orbit"), "EXISTING_ENV=1");

    const result = runInstall(targetDir);

    expect(result.status).toBe(0);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(
      `EXISTING_ENV=1\nORBIT_IMAGE=${resolvedReference}\n`,
    );
  });

  it("keeps committed files when Compose fails after persistence", () => {
    const targetDir = makeTarget();

    const result = runInstall(targetDir, { FAKE_COMPOSE_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain(
      `ORBIT_IMAGE=${resolvedReference}`,
    );
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(true);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });
});
