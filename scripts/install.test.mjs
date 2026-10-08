import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { PTY_TEST_TIMEOUT_MS, ptyWatchdog } from "./pty-deadline.mjs";
import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// scripts/install.sh, the bootstrap shell around the install engine (#1212).
//
// Since the flip this script owns three things and this suite proves them:
// the bootstrap before the engine (arguments, settings, tools, the release
// manifest and its signatures, the pull, the image's labels and banner, the
// Docker facts the engine needs), the one engine run and what the shell does
// with its outcome, and Compose after the commit (service images, start,
// readiness, the completion screen). Everything the engine decides --
// target validation, volume safety, configuration, OIDC discovery, the file
// transaction, the launcher tree -- is proven in src/lib/*.test.ts and
// src/cli/orbit.install.test.ts. Every case the bash-era suite held is
// mapped to the test that now proves it in
// docs/adr-notes/1212-bash-test-retirement.md.
//
// Fully mocked: a fake `docker` first on PATH answers the bootstrap's calls
// from FAKE_* settings and runs the real engine from this checkout (through
// tsx) for the one `docker run ... /opt/orbit/cli/orbit.js install`, with
// the bind mounts translated back to host paths -- so the shell and the
// engine are exercised together without a daemon, an image or a network.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const installScript = fileURLToPath(new URL("./install.sh", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const engineTsx = join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
const engineCli = join(repositoryRoot, "src", "cli", "orbit.ts");

const repository = "example/orbit-fixture";
const registry = "fake-registry.example";
const imageRepository = `${registry}/${repository}`;
const digest = "a".repeat(64);
const revision = "b".repeat(40);
const resolvedReference = `${imageRepository}@sha256:${digest}`;
const preflightSuccessLine =
  "Orbit installer: configuration, OIDC discovery, and Docker Compose preflight passed; starting services.";
const deploymentAssets = [
  "docker-compose.yml",
  "docker-compose.mail.yml",
  ".env-orbit.example",
  "config/tika-config.json",
  "scripts/configure.sh",
  "scripts/installer-ui.sh",
  "scripts/backup.sh",
  "scripts/restore.sh",
  "scripts/repair.sh",
  "scripts/export-recovery-bundle.sh",
  "scripts/import-recovery-bundle.sh",
];

// A release manifest handed over already verified, as get-orbit.sh or the
// launcher would (ADR-0031 #7).
const releaseManifestDir = mkdtempSync(join(tmpdir(), "orbit-install-manifest-fixture-"));
const releaseManifestPath = join(releaseManifestDir, "orbit-release-manifest.json");
writeFileSync(
  releaseManifestPath,
  JSON.stringify(
    {
      schema: "https://tomlawson.io/schemas/orbit-release-manifest/v1",
      version: "1.2.0",
      channel: "preview",
      commit: revision,
      image: { repository: imageRepository, digest: `sha256:${digest}` },
      launcher: { tag: "v1.0.0", commit: revision },
      files: {},
      recordedAt: "2026-09-24T00:00:00Z",
    },
    null,
    2,
  ),
);

// The image's bundled deployment assets (ADR-0019): this checkout's own.
const assetsRoot = mkdtempSync(join(tmpdir(), "orbit-install-assets-"));
for (const asset of deploymentAssets) {
  mkdirSync(dirname(join(assetsRoot, asset)), { recursive: true });
  copyFileSync(join(repositoryRoot, asset), join(assetsRoot, asset));
}

// The fake docker. Every call is appended to FAKE_CALL_LOG as
// "docker <args>"; the engine run's own argv and environment go to
// FAKE_ENGINE_LOG as JSON.
const fakeDockerScript = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
const env = process.env;
if (env.FAKE_CALL_LOG) fs.appendFileSync(env.FAKE_CALL_LOG, "docker " + argv.join(" ") + "\\n");
const out = (text) => process.stdout.write(text);
const json = (name, fallback) => (env[name] ? JSON.parse(env[name]) : fallback);
const flagValue = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const volumes = (env.FAKE_VOLUMES ?? "").split("\\n").filter(Boolean);
const exit = (code) => process.exit(code);

function runEngine() {
  const engineEnv = { PATH: env.PATH, HOME: env.HOME, TERM: env.TERM, ORBIT_ENGINE_CONTEXT: "container", ORBIT_INSTALL_TEST_ASSETS_ROOT: env.FAKE_ASSETS_ROOT };
  const mounts = [];
  const valueFlags = new Set(["-e", "--env", "-v", "--volume", "--entrypoint", "--network", "--user", "--name"]);
  let index = 1;
  let entrypoint;
  for (; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("-")) break;
    if (!valueFlags.has(flag)) continue;
    const value = argv[++index];
    if (flag === "-e" || flag === "--env") {
      const eq = value.indexOf("=");
      if (eq >= 0) engineEnv[value.slice(0, eq)] = value.slice(eq + 1);
      else if (env[value] !== undefined) engineEnv[value] = env[value];
    } else if (flag === "-v" || flag === "--volume") {
      const [source, target] = value.split(":");
      mounts.push([target, source]);
    } else if (flag === "--entrypoint") {
      entrypoint = value;
    }
  }
  const image = argv[index];
  const rest = argv.slice(index + 1);
  const translate = (value) => {
    for (const [target, source] of mounts) {
      if (value === target) return source;
      if (value.startsWith(target + "/")) return source + value.slice(target.length);
    }
    return value;
  };
  for (const key of Object.keys(engineEnv)) engineEnv[key] = translate(engineEnv[key]);
  Object.assign(engineEnv, json("FAKE_ENGINE_EXTRA_ENV", {}));
  if (env.FAKE_ENGINE_LOG) fs.appendFileSync(env.FAKE_ENGINE_LOG, JSON.stringify({ argv, entrypoint, image, rest, env: engineEnv }) + "\\n");
  if (entrypoint !== "node" || rest[0] !== "/opt/orbit/cli/orbit.js") {
    process.stderr.write("fake docker: unexpected run\\n");
    exit(125);
  }
  if (env.FAKE_ENGINE_EXIT !== undefined) {
    // A canned engine: write the outcome asked for, if any, and exit.
    const outcomeIndex = rest.indexOf("--outcome");
    if (env.FAKE_ENGINE_OUTCOME !== undefined && outcomeIndex >= 0) {
      fs.writeFileSync(translate(rest[outcomeIndex + 1]), env.FAKE_ENGINE_OUTCOME, { mode: 0o600 });
    }
    exit(Number(env.FAKE_ENGINE_EXIT));
  }
  const result = spawnSync("node", [${JSON.stringify(engineTsx)}, ${JSON.stringify(engineCli)}, ...rest.slice(1).map(translate)], { stdio: "inherit", env: engineEnv });
  if (result.signal === "SIGKILL") exit(137);
  exit(result.status === null ? 1 : result.status);
}

function compose() {
  if (argv[1] === "version") exit(env.FAKE_COMPOSE_MISSING === "1" ? 1 : 0);
  const sub = argv.find((arg, i) => i > 0 && !arg.startsWith("-") && !["--project-name", "--env-file"].includes(argv[i - 1]));
  const after = argv.slice(argv.indexOf(sub) + 1);
  if (sub === "config") exit(env.FAKE_COMPOSE_CONFIG_FAIL === "1" ? 1 : 0);
  if (sub === "pull") exit((env.FAKE_COMPOSE_PULL_FAIL ?? "") === after[0] ? 1 : 0);
  if (sub === "up") {
    // A failed first start that still created its database volume.
    if (env.FAKE_UP_CREATES_VOLUME === "1" && env.FAKE_STATE_DIR) fs.writeFileSync(env.FAKE_STATE_DIR + "/created-volume", flagValue("--project-name") + "_orbit-db-data");
    exit(env.FAKE_COMPOSE_UP_FAIL === "1" ? 1 : 0);
  }
  if (sub === "down") exit(0);
  if (sub === "exec") {
    // A probe is named by what it reaches: the service, or orbit-tika for
    // the probe the application runs against Tika.
    const text = after.join(" ");
    const probe = ["orbit-tika", "orbit-ollama", "orbit-clamav", "orbit-db", "orbit-app"].find((name) => text.includes(name));
    if (after.at(-1) === "true") exit(env.FAKE_APP_RUNNING === "1" ? 0 : 1);
    if ((env.FAKE_PROBE_FAIL ?? "").split(",").includes(probe)) exit(1);
    const transient = json("FAKE_PROBE_FAIL_TIMES", {})[probe];
    if (transient !== undefined && env.FAKE_STATE_DIR) {
      const counter = env.FAKE_STATE_DIR + "/probe-" + probe;
      const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
      fs.writeFileSync(counter, String(seen + 1));
      if (seen < transient) exit(1);
    }
    exit(0);
  }
  process.stderr.write("fake docker: unsupported compose " + argv.join(" ") + "\\n");
  exit(1);
}

switch (argv[0]) {
  case "compose":
    compose();
    break;
  case "pull":
    exit(env.FAKE_PULL_FAIL === "1" ? 1 : 0);
    break;
  case "image": {
    const format = flagValue("--format") ?? "";
    if (env.FAKE_INSPECT_FAIL && format.includes(env.FAKE_INSPECT_FAIL)) exit(1);
    if (format.includes("RepoDigests")) out((env.FAKE_REPO_DIGEST ?? argv[argv.length - 1]) + "\\n");
    else if (format.includes("org.opencontainers.image.revision")) out((env.FAKE_DOCKER_REVISION ?? "") + "\\n");
    else if (format.includes("org.opencontainers.image.version")) out((env.FAKE_DOCKER_VERSION ?? "") + "\\n");
    else if (format.includes("io.orbit.deployment-assets")) out((env.FAKE_ASSETS_LABEL ?? "/opt/orbit/deploy") + "\\n");
    exit(0);
    break;
  }
  case "run":
    if (argv.includes("--banner")) {
      if (env.FAKE_BANNER_FAIL === "1") exit(1);
      out("ORBIT FAKE BANNER\\n");
      exit(0);
    }
    runEngine();
    break;
  case "volume":
    if (argv[1] === "ls") {
      if (env.FAKE_VOLUME_LS_FAIL === "1") exit(1);
      const filter = (flagValue("--filter") ?? "").replace(/^name=/, "");
      const createdPath = (env.FAKE_STATE_DIR ?? "/nonexistent") + "/created-volume";
      if (fs.existsSync(createdPath)) volumes.push(fs.readFileSync(createdPath, "utf8"));
      if (filter.startsWith("^")) {
        const exact = filter.slice(1, -1);
        if (env.FAKE_VOLUME_GONE !== "1" && volumes.includes(exact)) out(exact + "\\n");
      } else {
        for (const volume of volumes) if (volume.includes(filter)) out(volume + "\\n");
      }
      exit(0);
    }
    if (argv[1] === "inspect") {
      const volume = argv[argv.length - 1];
      const labels = json("FAKE_VOLUME_LABELS", {});
      const project = volume.replace(/_orbit-db-data$/, "");
      out((labels[volume] ?? project + "|orbit-db-data") + "\\n");
      exit(0);
    }
    if (argv[1] === "rm") exit(0);
    break;
  case "ps": {
    const filter = flagValue("--filter") ?? "";
    out(json("FAKE_PS", {})[filter] ?? "");
    exit(0);
    break;
  }
  case "inspect": {
    out((json("FAKE_CONTAINER_IMAGES", {})[argv[argv.length - 1]] ?? "") + "\\n");
    exit(0);
    break;
  }
  case "info":
    out(env.FAKE_ROOTLESS === "1" ? "[name=seccomp,profile=builtin name=rootless]\\n" : "[name=seccomp,profile=builtin]\\n");
    exit(0);
    break;
}
process.stderr.write("fake docker: unsupported " + argv.join(" ") + "\\n");
exit(1);
`;

// Serves file:// release-manifest fixtures for the self-fetch tests; every
// other URL fails closed.
const fakeCurlScript = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  'if [[ -n "${FAKE_CALL_LOG:-}" ]]; then printf "curl %s\\n" "$*" >> "$FAKE_CALL_LOG"; fi',
  'output=""; url=""',
  "while [[ $# -gt 0 ]]; do",
  '  case "$1" in',
  '    --output|-o) output="$2"; shift 2 ;;',
  "    --connect-timeout|--max-time) shift 2 ;;",
  "    --fail|--silent|--show-error|--location) shift ;;",
  "    -*) printf 'curl: option %s: is unknown\\n' \"$1\" >&2; exit 2 ;;",
  '    *) url="$1"; shift ;;',
  "  esac",
  "done",
  'if [[ "$url" == file://* && -f "${url#file://}" ]]; then cp -- "${url#file://}" "$output"; exit 0; fi',
  "exit 22",
  "",
].join("\n");

const fakeCosignScript = [
  "#!/usr/bin/env bash",
  'if [[ "${1:-}" == "version" ]]; then [[ "${FAKE_COSIGN_UNUSABLE:-1}" == "0" ]] || exit 1; exit 0; fi',
  'if [[ "${1:-}" == "verify" || "${1:-}" == "verify-blob" ]]; then exit "${FAKE_COSIGN_VERIFY_EXIT:-0}"; fi',
  "exit 1",
  "",
].join("\n");

function makeFakeBin() {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-install-fakebin-"));
  for (const [name, source] of [
    ["docker", fakeDockerScript],
    ["curl", fakeCurlScript],
    ["cosign", fakeCosignScript],
  ]) {
    writeFileSync(join(binDir, name), source);
    chmodSync(join(binDir, name), 0o755);
  }
  return binDir;
}

function makeTarget() {
  return mkdtempSync(join(tmpdir(), "orbit-install-target-"));
}

/** A local-only pre-provisioned target (guarantee #6): the unattended install path. */
function makePreprovisionedDeployment(targetDir, extraLines = []) {
  writeFileSync(
    join(targetDir, ".env-orbit"),
    ["APP_URL=https://orbit.preprovisioned-install.internal", "ORBIT_AUTH_OIDC=false", ...extraLines, ""].join("\n"),
    { mode: 0o600 },
  );
  mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
  writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "preprovisioned-oidc-secret", { mode: 0o600 });
}

function targetEntries(targetDir) {
  return readdirSync(targetDir).sort();
}

function stagingLeftovers(targetDir) {
  return readdirSync(targetDir).filter((name) => name.startsWith(".orbit-install-staging"));
}

function readOptional(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function baseEnvironment(binDir, logDir) {
  return {
    PATH: `${binDir}:${process.env.PATH}`,
    HOME: process.env.HOME ?? tmpdir(),
    TERM: "xterm",
    ORBIT_REPOSITORY: repository,
    ORBIT_REGISTRY: registry,
    ORBIT_RELEASE_MANIFEST: releaseManifestPath,
    ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "2",
    ORBIT_INSTALLER_POLL_INTERVAL_SECONDS: "1",
    FAKE_DOCKER_REVISION: revision,
    FAKE_DOCKER_VERSION: "v1.2.0",
    FAKE_ASSETS_ROOT: assetsRoot,
    FAKE_CALL_LOG: join(logDir, "calls.log"),
    FAKE_ENGINE_LOG: join(logDir, "engine.log"),
    FAKE_STATE_DIR: logDir,
  };
}

function runInstall(targetDir, envOverrides = {}, args = []) {
  const binDir = makeFakeBin();
  const logDir = mkdtempSync(join(tmpdir(), "orbit-install-log-"));
  const result = failOnProcessDeadline(
    spawnSync("bash", [installScript, ...args], {
      cwd: targetDir,
      encoding: "utf8",
      env: { ...baseEnvironment(binDir, logDir), ...envOverrides },
      ...processGuard(),
    }),
    { label: "runInstall" },
  );
  return {
    ...result,
    calls: readOptional(join(logDir, "calls.log")),
    engineRuns: readOptional(join(logDir, "engine.log"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

/** Runs install.sh under `script`, so it has a controlling terminal, answering each prompt as it appears. */
function runInstallOnTerminal(targetDir, envOverrides = {}, interactions = [], args = []) {
  const binDir = makeFakeBin();
  const logDir = mkdtempSync(join(tmpdir(), "orbit-install-log-"));
  return new Promise((resolve, reject) => {
    const child = spawn("script", ["-qeE", "never", "-c", `bash ${installScript} ${args.join(" ")}`, "/dev/null"], {
      cwd: targetDir,
      env: { ...baseEnvironment(binDir, logDir), ...envOverrides },
    });
    let stdout = "";
    let stderr = "";
    let interactionIndex = 0;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const watchdog = ptyWatchdog({ label: "runInstallOnTerminal", kill: () => child.kill("SIGKILL") });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      watchdog.touch();
      // stdin stays open for the life of the child (AGENTS.md, pty traps).
      let interaction = interactions[interactionIndex];
      while (interaction && stdout.includes(interaction.after)) {
        child.stdin.write(interaction.input);
        interactionIndex += 1;
        interaction = interactions[interactionIndex];
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      watchdog.touch();
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
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
        calls: readOptional(join(logDir, "calls.log")),
        engineRuns: readOptional(join(logDir, "engine.log"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
        promptedInteractions: interactionIndex,
      });
    });
  });
}

function eventLines(output) {
  return output.split("\n").filter((line) => line.startsWith("phase="));
}

/** The recognised volume an update attaches to: one orbit-db, one orbit-app on the deployment's own image. */
function recognisedVolume(project, image = resolvedReference, dbId = "c".repeat(64), appId = "d".repeat(64)) {
  return {
    volume: `${project}_orbit-db-data`,
    ps: {
      [`volume=${project}_orbit-db-data`]: `${dbId}|${project}|orbit-db\n`,
      [`label=com.docker.compose.project=${project}`]: `${dbId}|${project}|orbit-db\n${appId}|${project}|orbit-app\n`,
    },
    images: { [appId]: image },
  };
}

describe("install.sh: arguments and settings, before anything runs", () => {
  it.each([[["--bogus"]], [["--install", "--update"]], [["extra"]]])("refuses %j as a usage error with no external call", (args) => {
    const targetDir = makeTarget();
    const result = runInstall(targetDir, {}, args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
    expect(result.calls).toBe("");
  });

  it.each([
    ["ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS", "901", "must be between 1 and 900"],
    ["ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS", "0", "must be between 1 and 900"],
    ["ORBIT_INSTALLER_POLL_INTERVAL_SECONDS", "10", "must be between 1 and 9"],
    ["ORBIT_CHANNEL", "not a channel!", "ORBIT_CHANNEL is invalid"],
    ["ORBIT_REPOSITORY", "no-slash", "ORBIT_REPOSITORY is invalid"],
    ["ORBIT_REGISTRY", "bad registry", "ORBIT_REGISTRY is invalid"],
  ])("refuses %s=%s with exit 2 and no external call", (name, value, message) => {
    const result = runInstall(makeTarget(), { [name]: value });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.calls).toBe("");
  });

  it("rejects hostile display identity overrides before any external call, without echoing them", () => {
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

  it("signposts --repair and exits 3 without touching Docker or the target (#533)", () => {
    const targetDir = makeTarget();
    const result = runInstall(targetDir, {}, ["--repair"]);
    expect(result.status).toBe(3);
    expect(result.stdout).toMatch(/^phase=rollback component=installer state=blocked reason=repair-unavailable action=repair elapsed=\d+s$/m);
    expect(result.stderr).toContain('Run "bash scripts/repair.sh --check" from this directory');
    expect(result.calls).toBe("");
    expect(targetEntries(targetDir)).toEqual([]);
  });

  it("refuses without Docker Compose v2", () => {
    const result = runInstall(makeTarget(), { FAKE_COMPOSE_MISSING: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Docker Compose v2 is required.");
    expect(result.stdout).toMatch(/^phase=host component=host state=failed reason=docker-host action=retry/m);
    expect(result.calls).not.toContain("docker pull");
  });
});

describe("install.sh --simulate", () => {
  it("rejects --simulate combined with an installer action", () => {
    for (const action of ["--install", "--update", "--repair"]) {
      const result = runInstall(makeTarget(), {}, ["--simulate", action]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--simulate cannot be combined");
      expect(result.calls).toBe("");
    }
  });

  it("dispatches the plain simulation before any validation, without files or external calls", () => {
    const targetDir = makeTarget();
    writeFileSync(join(targetDir, "unrelated-file"), "not an Orbit deployment\n");
    const result = runInstall(targetDir, { ORBIT_CHANNEL: "not a valid channel" }, ["--plain", "--simulate"]);
    expect(result.status).toBe(0);
    expect(result.calls).toBe("");
    expect(targetEntries(targetDir)).toEqual(["unrelated-file"]);
    expect(result.stdout).toContain("simulation=true");
    expect(result.stdout).toContain("No deployment occurred.");
    expect(result.stdout).toContain("SIMULATED-DIGEST-NOT-REAL");
  });
});

describe("install.sh: the image's identity", () => {
  it("refuses a handed-over manifest path that is not a file", () => {
    const result = runInstall(makeTarget(), { ORBIT_RELEASE_MANIFEST: "/nonexistent/manifest.json" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ORBIT_RELEASE_MANIFEST does not point at a readable file");
    expect(result.calls).not.toContain("docker pull");
  });

  it("refuses a manifest that names no valid digest", () => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-install-badmanifest-"));
    const manifest = join(dir, "manifest.json");
    writeFileSync(manifest, '{\n  "digest": "sha256:not-a-digest"\n}\n');
    const result = runInstall(makeTarget(), { ORBIT_RELEASE_MANIFEST: manifest });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The release manifest names no valid image digest.");
    expect(result.calls).not.toContain("docker pull");
  });

  it("pulls by the manifest's digest and refuses when the pull fails", () => {
    const result = runInstall(makeTarget(), { FAKE_PULL_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.calls).toContain(`docker pull --quiet ${resolvedReference}`);
    expect(result.stderr).toContain(`Could not pull ${resolvedReference}`);
    expect(result.stdout).toMatch(/^phase=identity component=image state=failed reason=image-registry action=retry/m);
  });

  it("refuses when the registry's digest does not match the manifest's", () => {
    const result = runInstall(makeTarget(), { FAKE_REPO_DIGEST: `${imageRepository}@sha256:${"e".repeat(64)}` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("did not return an immutable digest matching");
    expect(result.engineRuns).toEqual([]);
  });

  it.each([
    ["RepoDigests", "Could not inspect fake-registry.example/example/orbit-fixture@sha256:"],
    ["org.opencontainers.image.revision", "for its source revision"],
  ])("reports a failed image inspection (%s) explicitly", (format, message) => {
    const result = runInstall(makeTarget(), { FAKE_INSPECT_FAIL: format });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.engineRuns).toEqual([]);
  });

  it("installs a version tag whose image embeds that same version (#676)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { ORBIT_CHANNEL: "v1.3.0", FAKE_DOCKER_VERSION: "v1.3.0" }, ["--plain"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Version: v1.3.0");
    expect(result.stdout).toContain("Channel: v1.3.0");
  });

  it("refuses an image that records no source revision", () => {
    const result = runInstall(makeTarget(), { FAKE_DOCKER_REVISION: "main" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not record the source revision");
  });

  it("refuses a version label that is not a semantic version", () => {
    const result = runInstall(makeTarget(), { FAKE_DOCKER_VERSION: "preview-release-v1.0.0-1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not record a valid semantic version");
  });

  it("refuses a version tag whose image embeds a different version (#676)", () => {
    const result = runInstall(makeTarget(), { ORBIT_CHANNEL: "v1.3.0", ORBIT_RELEASE_MANIFEST: releaseManifestPath });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match the requested version tag (v1.3.0)");
    expect(result.engineRuns).toEqual([]);
  });

  it("refuses, terminally, an image built before the deployment assets were bundled (#1038)", () => {
    const result = runInstall(makeTarget(), { FAKE_ASSETS_LABEL: "" });
    // Read from the label alone: such an image is never asked for its banner (#1016).
    expect(result.calls).not.toContain("--banner");
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^phase=identity component=image state=failed reason=image-registry action=abort/m);
    expect(result.stderr).toContain("is not a supported install target");
  });

  it("refuses an image that keeps its assets somewhere else", () => {
    const result = runInstall(makeTarget(), { FAKE_ASSETS_LABEL: "/elsewhere" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("records deployment assets somewhere other than /opt/orbit/deploy");
  });

  it("refuses an image that cannot render its banner", () => {
    const result = runInstall(makeTarget(), { FAKE_BANNER_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not render its canonical banner");
    expect(result.engineRuns).toEqual([]);
  });

  it("refuses an unsigned image on a stable channel when cosign is usable", () => {
    const result = runInstall(makeTarget(), { ORBIT_CHANNEL: "latest", FAKE_COSIGN_UNUSABLE: "0", FAKE_COSIGN_VERIFY_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cosign could not verify the countersignature");
    expect(result.engineRuns).toEqual([]);
  });

  it("continues on the preview channel without a countersignature, saying so", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { ORBIT_CHANNEL: "preview", FAKE_COSIGN_UNUSABLE: "0", FAKE_COSIGN_VERIFY_EXIT: "1" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("no countersignature yet");
  });
});

describe("install.sh: the engine run", () => {
  it("installs a pre-provisioned target: one engine run, then Compose, then the completion screen (#6)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, {}, ["--plain"]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.engineRuns).toHaveLength(1);
    // The engine committed the deployment from the image's assets.
    for (const asset of deploymentAssets) expect(existsSync(join(targetDir, asset))).toBe(true);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain(`ORBIT_IMAGE=${resolvedReference}\n`);
    expect(stagingLeftovers(targetDir)).toEqual([]);
    // Compose only after the engine, in the deployment's own project.
    const calls = result.calls.split("\n");
    const engineAt = calls.findIndex((line) => line.includes("/opt/orbit/cli/orbit.js install"));
    const configAt = calls.findIndex((line) => line.includes("config --quiet"));
    expect(engineAt).toBeGreaterThan(-1);
    expect(configAt).toBeGreaterThan(engineAt);
    expect(result.calls).toContain("docker compose --project-name orbit --env-file .env-orbit up -d --no-build --remove-orphans");
    expect(result.calls).toContain("compose --project-name orbit --env-file .env-orbit pull orbit-db");
    expect(result.calls).toContain("compose --project-name orbit --env-file .env-orbit pull orbit-clamav");
    expect(result.calls).not.toContain("pull orbit-tika");
    expect(result.stdout).toContain(preflightSuccessLine);
    expect(result.stdout).toContain("Orbit is ready.");
    expect(result.stdout).toContain("Public URL: https://orbit.preprovisioned-install.internal");
    expect(result.stdout).toContain("Version: v1.2.0");
    expect(result.stdout).toContain(`Revision: ${revision.slice(0, 12)}`);
    expect(result.stdout).toContain(`Image digest: sha256:${digest}`);
    expect(result.stdout).toContain("Optional profiles: standard");
    expect(result.stdout).toContain("Channel: latest");
    expect(result.stdout).toContain("Status: docker compose --env-file .env-orbit ps");
    expect(result.stdout).toContain("Logs: docker compose --env-file .env-orbit logs --tail 200");
    expect(result.stdout).toContain('Claim this instance: run "docker compose --env-file .env-orbit logs orbit-app"');
    // The image's own banner, from the digest reference, before the engine.
    expect(result.stdout).toContain("ORBIT FAKE BANNER");
    expect(result.calls).toContain(`docker run --rm --entrypoint /opt/orbit/scripts/container-entrypoint.sh ${resolvedReference} --banner`);
    // Compose validates, prepares the images and only then starts anything.
    const at = (needle) => calls.findIndex((line) => line.includes(needle));
    expect(at("pull orbit-db")).toBeGreaterThan(configAt);
    expect(at("pull orbit-clamav")).toBeGreaterThan(at("pull orbit-db"));
    expect(at(" up -d ")).toBeGreaterThan(at("pull orbit-clamav"));
    // Every event is in the plain vocabulary, the engine's included.
    const events = eventLines(result.stdout);
    for (const line of events) {
      expect(line).toMatch(/^phase=[a-z-]+ component=[a-z-]+ state=[a-z-]+ reason=[a-z-]+ action=[a-z-]+ elapsed=[0-9]+s$/);
    }
    expect(events.at(-1)).toMatch(/^phase=complete component=installer state=completed reason=deployment-ready action=complete/);
    // The shell's own phases are replayed and rendered in order around the engine's.
    const shellPhases = events
      .map((line) => line.split(" ")[0].slice("phase=".length))
      .filter((phase) => !["assets", "configuration", "oidc"].includes(phase));
    expect([...new Set(shellPhases)]).toEqual(["host", "identity", "compose", "preparation", "database", "application", "optional", "complete"]);
    expect(events.some((line) => line.startsWith("phase=assets component=assets state=completed"))).toBe(true);
    expect(events.some((line) => line.startsWith("phase=oidc component=oidc state=skipped"))).toBe(true);
  });

  it("runs the engine as a plain one-off of the verified image: no socket, default network, the target mounted, the operator's identity", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, {}, ["--install"]);
    expect(result.status).toBe(0);
    const [run] = result.engineRuns;
    expect(run.argv.slice(0, 3)).toEqual(["run", "--rm", "--init"]);
    expect(run.argv).not.toContain("--network");
    expect(run.argv).not.toContain("-t");
    expect(run.argv).not.toContain("-i");
    expect(run.argv.join(" ")).not.toContain("docker.sock");
    expect(run.argv).toContain(`${realPath(targetDir)}:/orbit-deploy:rw`);
    expect(run.image).toBe(resolvedReference);
    expect(run.rest).toEqual(["/opt/orbit/cli/orbit.js", "install", "--action", "install", "--dir", "/orbit-deploy", "--outcome", "/orbit-install-result/outcome"]);
    expect(run.env.ORBIT_IMAGE).toBe(resolvedReference);
    expect(run.env.ORBIT_HOST_UID).toBe(String(process.getuid()));
    expect(run.env.ORBIT_HOST_GID).toBe(String(process.getgid()));
    const facts = JSON.parse(run.env.ORBIT_INSTALL_HOST_FACTS);
    expect(facts).toMatchObject({ imageVersion: "v1.2.0", imageRevision: revision, appliedDigest: `sha256:${digest}`, cosignUsable: false });
    expect(Buffer.from(facts.targetBasename, "base64").toString()).toBe(basename(realPath(targetDir)));
  });

  it("passes the operator's root as 0:0 under rootless Docker", () => {
    // A canned engine: this test's own process is not root, so the real
    // engine could not hand files to uid 0.
    const result = runInstall(makeTarget(), { FAKE_ROOTLESS: "1", FAKE_ENGINE_EXIT: "1" });
    expect(result.engineRuns[0].env).toMatchObject({ ORBIT_HOST_UID: "0", ORBIT_HOST_GID: "0" });
  });

  it("hands stdin to the engine only for machine prompts", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { ORBIT_CONFIGURE_PROMPTS: "machine" });
    expect(result.status).toBe(0);
    expect(result.engineRuns[0].argv).toContain("-i");
    expect(result.engineRuns[0].argv).not.toContain("-t");
    expect(result.engineRuns[0].env.ORBIT_INSTALL_INTERACTIVE).toBe("1");
  });

  it("describes every Orbit database volume on the host to the engine, which skips another project's on a fresh install (#1239)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const other = recognisedVolume("someone-else", `${imageRepository}@sha256:${"f".repeat(64)}`);
    const result = runInstall(targetDir, {
      FAKE_VOLUMES: `${other.volume}\nunrelated-volume`,
      FAKE_PS: JSON.stringify(other.ps),
      FAKE_CONTAINER_IMAGES: JSON.stringify(other.images),
    });
    expect(result.status).toBe(0);
    const facts = JSON.parse(result.engineRuns[0].env.ORBIT_INSTALL_HOST_FACTS);
    expect(facts.volumes.map((volume) => Buffer.from(volume.name, "base64").toString())).toEqual([other.volume]);
    expect(Buffer.from(facts.volumes[0].labels, "base64").toString()).toBe("someone-else|orbit-db-data");
    expect(Buffer.from(facts.projects[0].name, "base64").toString()).toBe("someone-else");
    expect(Buffer.from(facts.images[0].image, "base64").toString()).toBe(other.images["d".repeat(64)]);
  });

  it("refuses a fresh install beside this install's own leftover volume, naming the removal command (#15)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { FAKE_VOLUMES: "orbit_orbit-db-data" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("An existing Orbit database volume (orbit_orbit-db-data) requires a recognized deployment");
    expect(result.stderr).toContain("docker volume rm -- orbit_orbit-db-data");
    expect(result.calls).not.toContain(" up -d");
    expect(targetEntries(targetDir)).toEqual([".env-orbit", ".orbit-secrets"]);
  });

  it("fails closed when the volume listing itself fails", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { FAKE_VOLUME_LS_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not verify the existing Orbit database volume; refusing to start Compose.");
  });

  it("updates beside another stack's database volume, attaching to its own and re-checking it before Compose (#1261, #17)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    const own = recognisedVolume("orbit");
    const other = recognisedVolume("orbit-e2e-local-4242", `${imageRepository}@sha256:${"f".repeat(64)}`, "1".repeat(64), "2".repeat(64));
    const passwordBefore = readFileSync(join(targetDir, ".orbit-secrets", "postgres-password"));
    const environment = {
      FAKE_VOLUMES: `${other.volume}\n${own.volume}`,
      FAKE_PS: JSON.stringify({ ...own.ps, ...other.ps }),
      FAKE_CONTAINER_IMAGES: JSON.stringify({ ...own.images, ...other.images }),
    };

    const result = runInstall(targetDir, environment, ["--update"]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.calls).toContain("docker volume ls --filter name=^orbit_orbit-db-data$ --format {{.Name}}");
    expect(readFileSync(join(targetDir, ".orbit-secrets", "postgres-password"))).toEqual(passwordBefore);

    // The same update refuses when the recognised volume vanished after the engine ran.
    const gone = runInstall(targetDir, { ...environment, FAKE_VOLUME_GONE: "1" }, ["--update"]);
    expect(gone.status).toBe(1);
    expect(gone.stderr).toContain("The existing Orbit database volume changed during installation; refusing to start Compose.");
    expect(gone.calls).not.toContain(" up -d");
  });
});

describe("install.sh: the engine's outcome", () => {
  it("emits the engine's failure as the terminal event, after the engine rolled the target back", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    writeFileSync(join(targetDir, ".env-orbit"), "ORBIT_AUTH_OIDC=false\n", { mode: 0o600 });
    const result = runInstall(targetDir);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^phase=configuration component=configuration state=failed reason=configuration-failure action=retry elapsed=\d+s$/m);
    expect(result.stderr).toContain("Orbit installer: configuration fields requiring attention: APP_URL.");
    expect(result.stderr).toContain("Orbit installer: Required configuration fields require attention; refusing to start Compose.");
    expect(result.calls).not.toContain("compose --project-name");
    expect(targetEntries(targetDir)).toEqual([".env-orbit", ".orbit-secrets"]);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe("ORBIT_AUTH_OIDC=false\n");
  });

  it("names docker run's exit status when the engine died without a result", () => {
    const result = runInstall(makeTarget(), { FAKE_ENGINE_EXIT: "137" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The install engine stopped without reporting a result (docker run exit status 137)");
    expect(result.stdout).toMatch(/state=failed reason=failure action=retry/);
  });

  it.each([
    ["an unknown key", "status=ok\nsurprise=1\n"],
    ["an unknown status", "status=maybe\n"],
    ["a message with a control character", "status=failed\nmessage=a\u0007b\n"],
  ])("treats an outcome with %s as no result", (_label, outcome) => {
    const result = runInstall(makeTarget(), { FAKE_ENGINE_EXIT: "1", FAKE_ENGINE_OUTCOME: outcome });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stopped without reporting a result (docker run exit status 1)");
  });

  it.each([
    [130, "status=stopped\nmessage=Cancelled; no deployment files or services were changed.\n"],
    [1, "status=stopped\nmessage=The terminal closed before an answer was given.\n"],
    [2, "status=stopped\nmessage=refused\n"],
  ])("passes a stopped engine's exit %i through, starting nothing", (code, outcome) => {
    const result = runInstall(makeTarget(), { FAKE_ENGINE_EXIT: String(code), FAKE_ENGINE_OUTCOME: outcome });
    expect(result.status).toBe(code);
    expect(result.calls).not.toContain("compose --project-name");
  });

  it("exits 3 for the engine's Repair choice", () => {
    const result = runInstall(makeTarget(), { FAKE_ENGINE_EXIT: "3", FAKE_ENGINE_OUTCOME: "status=repair\n" });
    expect(result.status).toBe(3);
    expect(result.calls).not.toContain("compose --project-name");
  });

  it("refuses a success outcome from an engine that exited non-zero", () => {
    const result = runInstall(makeTarget(), {
      FAKE_ENGINE_EXIT: "1",
      FAKE_ENGINE_OUTCOME: "status=ok\nfresh=1\nprofile=standard\nmodel-pull=0\ndatabase-volume=\n",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reported success but exited with status 1");
  });
});

describe("install.sh: the launcher's configure tree (#1225)", () => {
  function launcherTree() {
    const tree = join(mkdtempSync(join(tmpdir(), "orbit-install-launcher-")), "tree");
    mkdirSync(tree, { mode: 0o700 });
    chmodSync(tree, 0o700);
    return tree;
  }

  it("mounts the launcher's directory into the engine, which writes the tree on a configuration-failure", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    writeFileSync(join(targetDir, ".env-orbit"), "ORBIT_AUTH_OIDC=false\n", { mode: 0o600 });
    const tree = launcherTree();
    const result = runInstall(targetDir, { ORBIT_LAUNCHER_CONFIG_TREE: `${tree}/` });
    expect(result.status).toBe(1);
    expect(result.engineRuns[0].argv).toContain(`${realPath(tree)}:/orbit-launcher-config-tree:rw`);
    expect(readdirSync(tree).sort()).toEqual([".env-orbit.example", ".orbit-image", "scripts"]);
    expect(readFileSync(join(tree, ".orbit-image"), "utf8")).toBe(`${resolvedReference}\n`);
    expect(statSync(join(tree, "scripts", "configure.sh")).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["a symlink", (parent) => {
      const real = join(parent, "real");
      mkdirSync(real, { mode: 0o700 });
      symlinkSync(real, join(parent, "link"));
      return join(parent, "link");
    }, "it is a symlink"],
    ["a symlink given with a trailing slash", (parent) => {
      const real = join(parent, "real");
      mkdirSync(real, { mode: 0o700 });
      symlinkSync(real, join(parent, "link"));
      return `${join(parent, "link")}//`;
    }, "it is a symlink"],
    ["missing", (parent) => join(parent, "absent"), "it does not exist"],
    ["a file", (parent) => {
      writeFileSync(join(parent, "file"), "x");
      return join(parent, "file");
    }, "it is not a directory"],
  ])("tells the engine why it could not mount a directory that is %s, and the engine says so once", (_label, arrange, reason) => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    writeFileSync(join(targetDir, ".env-orbit"), "ORBIT_AUTH_OIDC=false\n", { mode: 0o600 });
    const tree = arrange(mkdtempSync(join(tmpdir(), "orbit-install-launcher-")));
    const result = runInstall(targetDir, { ORBIT_LAUNCHER_CONFIG_TREE: tree });
    expect(result.status).toBe(1);
    expect(result.engineRuns[0].env.ORBIT_LAUNCHER_CONFIG_TREE_UNAVAILABLE).toBe(reason);
    expect(result.stderr.split("\n").filter((line) => line.includes("ORBIT_LAUNCHER_CONFIG_TREE"))).toEqual([
      `Orbit installer: ORBIT_LAUNCHER_CONFIG_TREE was not written because ${reason}.`,
    ]);
  });

  it("passes nothing about a tree the launcher did not ask for", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { ORBIT_LAUNCHER_CONFIG_TREE: "" });
    expect(result.status).toBe(0);
    expect(Object.keys(result.engineRuns[0].env).filter((key) => key.startsWith("ORBIT_LAUNCHER"))).toEqual([]);
  });
});

describe("install.sh: Compose, after the commit", () => {
  function installed(extra = {}) {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    return { targetDir, result: runInstall(targetDir, extra) };
  }

  it("reports an invalid Compose configuration as a plain failure, never a reconfigure, and starts nothing (#1227)", () => {
    const { targetDir, result } = installed({ FAKE_COMPOSE_CONFIG_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^phase=compose component=compose state=failed reason=failure action=retry/m);
    expect(result.stderr).toContain("Docker Compose configuration is invalid");
    expect(result.calls).not.toContain(" up -d");
    // Committed: the files stay.
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(true);
  });

  it("refuses when a service image cannot be prepared", () => {
    const { result } = installed({ FAKE_COMPOSE_PULL_FAIL: "orbit-clamav" });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^phase=preparation component=clamav state=failed reason=image-registry action=retry/m);
    expect(result.stderr).toContain("Could not prepare the private scanner image.");
  });

  it("tears a failed fresh start down and removes only this project's own volume, by its exact name (#1207)", () => {
    const { result } = installed({ FAKE_COMPOSE_UP_FAIL: "1", FAKE_VOLUMES: "" });
    expect(result.status).toBe(1);
    expect(result.calls).toContain("compose --project-name orbit --env-file .env-orbit down --remove-orphans");
    expect(result.calls).toContain("docker volume ls --filter name=orbit_orbit-db-data --format {{.Name}}");
    expect(result.stdout).toMatch(/^phase=database component=database state=failed reason=docker-host action=repair/m);
    expect(result.stderr).toContain("next action is the bounded Repair path");
  });

  it("bounds the database wait and points at repair", () => {
    const { result } = installed({ FAKE_PROBE_FAIL: "orbit-db" });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^phase=database component=database state=failed reason=database-auth-migration action=repair/m);
    expect(result.stdout).toMatch(/^phase=database component=database state=waiting reason=database-health action=wait/m);
  });

  it("tells a running application that never reported ready from one that stopped", () => {
    const { result } = installed({ FAKE_PROBE_FAIL: "orbit-app" });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/reason=application-startup action=repair/);
  });

  it("bounds the optional scanner's wait", () => {
    const { result } = installed({ FAKE_PROBE_FAIL: "orbit-clamav" });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^phase=optional component=clamav state=failed reason=optional-unavailable action=repair/m);
  });

  it("pulls the confirmed local model after Ollama is healthy (guarantee #20)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    // The model the engine's profile wizard saved, and a second run whose
    // engine reports the separately confirmed download.
    appendFileSync(join(targetDir, ".env-orbit"), "OLLAMA_MODEL=llama3.2:1b\n");
    const result = runInstall(targetDir, {
      FAKE_ENGINE_EXIT: "0",
      FAKE_ENGINE_OUTCOME: "status=ok\nfresh=0\nprofile=ai\nmodel-pull=1\ndatabase-volume=\n",
    });
    expect(result.status).toBe(0);
    expect(result.calls).toContain("compose --project-name orbit --env-file .env-orbit pull orbit-ollama");
    expect(result.calls).toContain("exec -T orbit-ollama ollama pull llama3.2:1b");
    expect(result.stdout).toContain("Optional profiles: ai");
  });
});

describe("install.sh on a terminal", () => {
  it("passes the terminal through to the engine, which asks, and leaves on Exit with 130 having started nothing", async () => {
    const targetDir = makeTarget();
    const result = await runInstallOnTerminal(targetDir, {}, [{ after: "Choose [install/update/repair/exit]", input: "4\r" }]);
    expect(result.promptedInteractions).toBe(1);
    expect(result.status).toBe(130);
    expect(result.engineRuns[0].argv).toEqual(expect.arrayContaining(["-i", "-t"]));
    expect(result.engineRuns[0].env.ORBIT_INSTALL_INTERACTIVE).toBe("1");
    expect(result.calls).not.toContain("compose --project-name");
    expect(targetEntries(targetDir)).toEqual([]);
  }, PTY_TEST_TIMEOUT_MS);
});

// ADR-0031 #7: install.sh fetching and verifying its own release manifest
// when no caller handed one over.
describe("install.sh release manifest (ADR-0031 #7)", () => {
  function generateKeyPair(dir, name = "key") {
    const privatePem = join(dir, `${name}.pem`);
    const publicPem = join(dir, `${name}.pub.pem`);
    execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", privatePem]);
    execFileSync("openssl", ["ec", "-in", privatePem, "-pubout", "-out", publicPem], { stdio: ["ignore", "ignore", "ignore"] });
    return { privatePem, publicPem };
  }

  function buildSelfFetchFixture(dir, privatePem, overrides = {}, route = ["releases", "latest", "download"]) {
    const assetsDir = join(dir, ...route);
    mkdirSync(assetsDir, { recursive: true });
    const manifest = {
      schema: "https://tomlawson.io/schemas/orbit-release-manifest/v1",
      version: "1.2.0",
      channel: "latest",
      commit: revision,
      image: { repository: imageRepository, digest: `sha256:${digest}` },
      launcher: { tag: "v1.0.0", commit: revision },
      files: {},
      recordedAt: "2026-09-24T00:00:00Z",
      ...overrides,
    };
    const manifestPath = join(assetsDir, "orbit-release-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    writeFileSync(
      join(assetsDir, "orbit-release-manifest.json.sig"),
      execFileSync("openssl", ["dgst", "-sha256", "-sign", privatePem, manifestPath]).toString("base64"),
    );
    return `file://${dir}`;
  }

  function selfFetch(extra = {}, overrides = {}, route = undefined) {
    const dir = mkdtempSync(join(tmpdir(), "orbit-install-selffetch-"));
    const { privatePem, publicPem } = generateKeyPair(dir);
    const baseUrl = buildSelfFetchFixture(dir, privatePem, overrides, route);
    return {
      ORBIT_RELEASE_MANIFEST: "",
      ORBIT_INSTALL_TEST_MANIFEST_BASE_URL: baseUrl,
      ORBIT_INSTALL_TEST_PUBLIC_KEY_FILE: publicPem,
      ORBIT_INSTALL_TEST_ALLOW_KEY_OVERRIDE: "1",
      ...extra,
    };
  }

  it("embeds the same cosign public key as get-orbit.sh and cosign.pub, byte for byte", () => {
    const cosignPub = readFileSync(fileURLToPath(new URL("../cosign.pub", import.meta.url)), "utf8");
    const match = /embedded_public_key='([\s\S]*?)'/u.exec(readFileSync(installScript, "utf8"));
    expect(`${match[1]}\n`).toBe(cosignPub);
  });

  it("fetches and verifies its own manifest, then removes its temporary directory (#1201)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const privateTmpDir = mkdtempSync(join(tmpdir(), "orbit-install-selffetch-tmpdir-"));
    const result = runInstall(targetDir, selfFetch({ TMPDIR: privateTmpDir }));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.engineRuns[0].image).toBe(resolvedReference);
    expect(readdirSync(privateTmpDir)).toEqual([]);
  });

  it("refuses a manifest signed by the wrong key, before any pull", () => {
    const env = selfFetch();
    const dir = mkdtempSync(join(tmpdir(), "orbit-install-selffetch-other-"));
    env.ORBIT_INSTALL_TEST_PUBLIC_KEY_FILE = generateKeyPair(dir, "committed").publicPem;
    const result = runInstall(makeTarget(), env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not verify the release manifest's signature");
    expect(result.calls).not.toContain("docker pull");
  });

  it("refuses a validly signed manifest for another version than the pinned channel", () => {
    const result = runInstall(makeTarget(), selfFetch({ ORBIT_CHANNEL: "v1.2.0" }, { version: "1.0.0" }, ["releases", "download", "v1.2.0"]));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Asked for v1.2.0 but the signed release manifest is for v1.0.0");
    expect(result.calls).not.toContain("docker pull");
  });

  it("refuses ORBIT_CHANNEL=preview without a handed-over manifest, fetching nothing (#1107)", () => {
    const result = runInstall(makeTarget(), { ORBIT_CHANNEL: "preview", ORBIT_RELEASE_MANIFEST: "" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("only installs stable releases");
    expect(result.calls).not.toContain("curl");
    expect(result.calls).not.toContain("docker pull");
  });

  it("refuses to swap the trusted key without the second test-only flag", () => {
    const result = runInstall(makeTarget(), selfFetch({ ORBIT_INSTALL_TEST_ALLOW_KEY_OVERRIDE: "" }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to swap the trust anchor");
  });
});

// Cases the bash-era suite held that sit at the seam between this script and
// the engine (docs/adr-notes/1212-bash-test-retirement.md).
describe("install.sh: identity, volumes and readiness across the seam", () => {
  it("hands an operator's COMPOSE_PROJECT_NAME to the engine, which persists it, and Compose uses it", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { COMPOSE_PROJECT_NAME: "fresh-orbit" });
    expect(result.status).toBe(0);
    expect(result.engineRuns[0].argv).toEqual(expect.arrayContaining(["-e", "COMPOSE_PROJECT_NAME"]));
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toMatch(/^COMPOSE_PROJECT_NAME=fresh-orbit$/m);
    expect(result.calls).toContain("docker compose --project-name fresh-orbit --env-file .env-orbit up -d");
  });

  it("still refuses a fresh install on its own project's volume when others are present, naming only its own (#1239)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { FAKE_VOLUMES: "someone-else_orbit-db-data\norbit_orbit-db-data" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("An existing Orbit database volume (orbit_orbit-db-data) requires a recognized deployment");
    expect(result.stderr).not.toContain("someone-else");
  });

  it("removes the database volume a failed fresh start created, and only that one, by exact name (#1151 O1-S3, #1207)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const other = recognisedVolume("someone-else", `${imageRepository}@sha256:${"f".repeat(64)}`);
    const result = runInstall(targetDir, {
      FAKE_COMPOSE_UP_FAIL: "1",
      FAKE_UP_CREATES_VOLUME: "1",
      FAKE_VOLUMES: other.volume,
      FAKE_PS: JSON.stringify(other.ps),
      FAKE_CONTAINER_IMAGES: JSON.stringify(other.images),
    });
    expect(result.status).toBe(1);
    const removals = result.calls.split("\n").filter((line) => line.startsWith("docker volume rm"));
    expect(removals).toEqual(["docker volume rm -- orbit_orbit-db-data"]);
  });

  it("never removes a database volume when an update's start fails", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    const own = recognisedVolume("orbit");
    const result = runInstall(
      targetDir,
      { FAKE_COMPOSE_UP_FAIL: "1", FAKE_VOLUMES: own.volume, FAKE_PS: JSON.stringify(own.ps), FAKE_CONTAINER_IMAGES: JSON.stringify(own.images) },
      ["--update"],
    );
    expect(result.status).toBe(1);
    expect(result.calls).not.toContain("volume rm");
    expect(result.calls).not.toContain(" down ");
  });

  it("asks Docker about stopped containers too when proving a volume is this deployment's", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    const own = recognisedVolume("orbit");
    const result = runInstall(
      targetDir,
      { FAKE_VOLUMES: own.volume, FAKE_PS: JSON.stringify(own.ps), FAKE_CONTAINER_IMAGES: JSON.stringify(own.images) },
      ["--update"],
    );
    expect(result.status).toBe(0);
    expect(result.calls).toContain("docker ps -a --filter volume=orbit_orbit-db-data");
    expect(result.calls).toContain("docker ps -a --filter label=com.docker.compose.project=orbit");
  });

  it("adds the scripts a recognised older deployment lacks", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    rmSync(join(targetDir, "scripts", "backup.sh"));
    rmSync(join(targetDir, "scripts", "restore.sh"));
    const result = runInstall(targetDir, {}, ["--update"]);
    expect(result.status).toBe(0);
    expect(readFileSync(join(targetDir, "scripts", "backup.sh"))).toEqual(readFileSync(join(assetsRoot, "scripts", "backup.sh")));
    expect(readFileSync(join(targetDir, "scripts", "restore.sh"))).toEqual(readFileSync(join(assetsRoot, "scripts", "restore.sh")));
  });

  it("waits through a transient database and application start before completing", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, {
      ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "20",
      FAKE_PROBE_FAIL_TIMES: JSON.stringify({ "orbit-db": 1, "orbit-app": 2 }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^phase=database component=database state=waiting reason=database-health action=wait/m);
    expect(result.stdout).toMatch(/^phase=application component=application state=waiting reason=application-health action=wait/m);
    const events = eventLines(result.stdout);
    expect(events.findIndex((line) => line.startsWith("phase=application component=application state=healthy"))).toBeLessThan(
      events.findIndex((line) => line.startsWith("phase=complete")),
    );
  });

  it("withholds completion with a bounded health-timeout when the application runs but never reports ready", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { FAKE_PROBE_FAIL: "orbit-app", FAKE_APP_RUNNING: "1" });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^phase=application component=application state=failed reason=health-timeout action=repair/m);
    expect(result.stderr).toContain("Orbit did not report ready within the bounded startup window.");
    expect(result.stdout).not.toContain("Orbit is ready.");
  });

  it.each([
    ["processing", "orbit-tika", "The selected document-processing service did not become healthy"],
    ["ai", "orbit-ollama", "The selected local-model service did not become healthy"],
  ])("prepares the %s profile's service and fails its bounded wait with a stable reason", (profile, service, message) => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    const result = runInstall(targetDir, {
      FAKE_ENGINE_EXIT: "0",
      FAKE_ENGINE_OUTCOME: `status=ok\nfresh=0\nprofile=${profile}\nmodel-pull=0\ndatabase-volume=\n`,
      FAKE_PROBE_FAIL: service,
    });
    expect(result.status).toBe(1);
    expect(result.calls).toContain(`pull ${service}`);
    expect(result.stdout).toMatch(new RegExp(`^phase=optional component=${service.slice("orbit-".length)} state=failed reason=optional-unavailable action=repair`, "m"));
    expect(result.stderr).toContain(message);
  });

  it("reports a completion-screen failure after the commit as reason=failure (#1227)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    const environment = readFileSync(join(targetDir, ".env-orbit"), "utf8").replace(/^APP_URL=.*\n/m, "");
    writeFileSync(join(targetDir, ".env-orbit"), environment, { mode: 0o600 });
    const tree = join(mkdtempSync(join(tmpdir(), "orbit-install-launcher-")), "tree");
    mkdirSync(tree, { mode: 0o700 });
    const result = runInstall(targetDir, {
      FAKE_ENGINE_EXIT: "0",
      FAKE_ENGINE_OUTCOME: "status=ok\nfresh=0\nprofile=standard\nmodel-pull=0\ndatabase-volume=\n",
      ORBIT_LAUNCHER_CONFIG_TREE: tree,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/state=failed reason=failure action=retry/);
    expect(result.stderr).toContain("The validated public URL could not be read for completion.");
    expect(readdirSync(tree)).toEqual([]);
  });
});

describe("install.sh: the UI helper it sources after the commit (guarantee #5)", () => {
  it.each([
    ["a symlink", (path) => {
      rmSync(path);
      symlinkSync(join(assetsRoot, "scripts", "installer-ui.sh"), path);
    }],
    ["not valid bash", (path) => writeFileSync(path, "installer_ui_init() {\n")],
  ])("refuses to source a committed installer-ui.sh that is %s, and starts nothing", (_label, damage) => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    damage(join(targetDir, "scripts", "installer-ui.sh"));
    const result = runInstall(targetDir, {
      FAKE_ENGINE_EXIT: "0",
      FAKE_ENGINE_OUTCOME: "status=ok\nfresh=0\nprofile=standard\nmodel-pull=0\ndatabase-volume=\n",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The deployment's installer UI helper is unavailable.");
    expect(result.stdout).toMatch(/state=failed reason=failure action=retry/);
    expect(result.calls).not.toContain("compose --project-name");
  });
});

describe("install.sh: the application readiness probe (guarantee #34)", () => {
  // The probe is the exact text install.sh runs in the application
  // container; only its fixed address is pointed at a local server here.
  function probeSource() {
    const match = /^readonly app_readiness_probe='([\s\S]*?)'$/mu.exec(readFileSync(installScript, "utf8"));
    expect(match).not.toBeNull();
    return match[1];
  }

  async function probeAgainst(status, body) {
    const { createServer } = await import("node:http");
    const server = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" }).end(body);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      const source = probeSource().replace("http://127.0.0.1:3000/", `http://127.0.0.1:${port}/`);
      return await new Promise((resolve) => {
        const child = spawn("node", ["-e", source]);
        child.on("close", (code) => resolve(code));
      });
    } finally {
      server.close();
    }
  }

  it.each([
    ["ready, from orbit", 200, '{"status":"ready","service":"orbit"}', 0],
    ["ready, from another service", 200, '{"status":"ready","service":"other"}', 1],
    ["starting", 200, '{"status":"starting","service":"orbit"}', 1],
    ["a 503", 503, '{"status":"ready","service":"orbit"}', 1],
    ["not JSON", 200, "ready", 1],
    ["a JSON array", 200, "[]", 1],
  ])("answers %s with exit %#", async (_label, status, body, code) => {
    expect(await probeAgainst(status, body)).toBe(code);
  });
});

describe("install.sh: what it holds by its source", () => {
  it("bounds every Compose health probe with timeout, stdin closed (guarantee #33)", () => {
    const source = readFileSync(installScript, "utf8");
    expect(source).toMatch(/timeout --signal=TERM --kill-after=1s 5s \\\n\s+docker compose --project-name "\$compose_project_name" --env-file "\$environment_file" "\$@" <\/dev\/null/u);
    for (const probe of ["probe_database_health", "probe_application_health", "probe_clamav_health", "probe_tika_health", "probe_ollama_health"]) {
      const body = new RegExp(`^${probe}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}`, "mu").exec(source)?.[1] ?? "";
      expect(body, probe).toContain("bounded_compose_probe exec -T");
    }
  });

  it("uses literal delimiters for every Docker template it parses, the formats the engine's volume check documents", () => {
    const source = readFileSync(installScript, "utf8");
    const engineSide = readFileSync(join(repositoryRoot, "src", "lib", "database-volume-safety.ts"), "utf8");
    for (const format of [
      '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}',
      '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}',
      "{{.Config.Image}}",
    ]) {
      expect(source).toContain(`--format '${format}'`);
      expect(engineSide).toContain(format);
    }
    expect(source).not.toMatch(/--format '[^']*\\t/u);
  });

  it("keeps backup and restore commands on the persisted env-file project", () => {
    for (const script of ["backup.sh", "restore.sh"]) {
      const source = readFileSync(join(repositoryRoot, "scripts", script), "utf8");
      expect(source).toContain('docker compose --env-file "$environment_file"');
      expect(source).not.toContain("--project-name orbit");
    }
  });

  it("documents the configuration and database recovery identity contract", () => {
    const procedure = readFileSync(join(repositoryRoot, "docs", "installer-guarantees.md"), "utf8");
    expect(procedure).toContain('preupgrade_config="$preupgrade_dir/orbit-pre-upgrade.env"');
    expect(procedure).toContain('chmod 600 "$preupgrade_config"');
    expect(procedure).toContain("configuration or pre-start failure automatically restores");
    expect(procedure).toContain(".orbit-install-staging.*");
    expect(procedure).toContain('cp -- "$preupgrade_config" .env-orbit');
    expect(procedure).toContain('bash scripts/restore.sh "$backup_path"');
    expect(procedure).toContain('rm -f -- "$preupgrade_config"');
    expect(procedure).toContain("validated `COMPOSE_PROJECT_NAME`");
  });
});

describe("install.sh --simulate on a terminal", () => {
  it("cancels the interactive simulation with a lone Escape at the profile menu", async () => {
    const targetDir = makeTarget();
    const result = await runInstallOnTerminal(
      targetDir,
      {},
      [
        { after: "Simulation: Greetings, what can we do for you today?", input: "\r" },
        { after: "Simulation: choose a deployment profile", input: "\x1b" },
      ],
      ["--simulate"],
    );
    expect(result.status).toBe(130);
    expect(result.promptedInteractions).toBe(2);
    expect(result.calls).toBe("");
    expect(targetEntries(targetDir)).toEqual([]);
  }, PTY_TEST_TIMEOUT_MS);
});

function realPath(path) {
  return execFileSync("realpath", [path], { encoding: "utf8" }).trim();
}
