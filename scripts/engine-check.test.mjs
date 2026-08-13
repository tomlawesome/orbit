import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// scripts/engine-check.sh is the first delegation point for issue #295's
// engine-delivery architecture (docs/engine-events.md, "In-container engine
// invocation (v0)"): by default it is a behavior-preserving proxy onto
// `bash scripts/configure.sh --check`; only ORBIT_ENGINE_CHECK=container
// switches it to composing a `docker compose run --rm --no-deps` one-off
// against the bundled orbit CLI. Like scripts/repair.test.mjs, this suite
// runs the script from copied fixtures in scratch directories (the script
// forces its own cwd to its containing checkout) and puts a fake `docker`
// ahead of the real one on PATH for every container-mode invocation, so no
// test ever reaches a real daemon, container, volume, or image.

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoDir = join(scriptsDir, "..");
const engineCheckScriptSource = readFileSync(join(scriptsDir, "engine-check.sh"), "utf8");
const configureScriptSource = readFileSync(join(scriptsDir, "configure.sh"), "utf8");
const configurationScriptSource = readFileSync(join(scriptsDir, "configuration.sh"), "utf8");
const installerUiSource = readFileSync(join(scriptsDir, "installer-ui.sh"), "utf8");
const environmentExampleSource = readFileSync(join(repoDir, ".env-orbit.example"), "utf8");

// Every spawnSync call in this file gets an explicit, closed/piped stdio
// config (never "inherit") and a hard timeout+killSignal, so a wedged child
// fails this test loudly within seconds instead of hanging the whole CI job
// until its own outer timeout.
const SPAWN_TIMEOUT_MS = 30_000;
const SPAWN_OPTS = { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: SPAWN_TIMEOUT_MS, killSignal: "SIGKILL" };

const scratchDirs = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-engine-check-"));
  scratchDirs.push(dir);
  return dir;
}

// A minimal deployment-shaped fixture: enough for configure.sh --check to
// report a deterministic (not necessarily "ready") verdict, and enough for
// engine-check.sh's own Compose-project-name derivation and .env-orbit
// presence check to succeed.
function makeFixture({ withEnvFile = true, composeProjectName = "enginechecktest" } = {}) {
  // `composeProjectName: null` (not `undefined` — a default parameter only
  // applies to a literal `undefined`) opts out of writing the line at all,
  // so a caller can exercise the fallback-derivation branches below.
  const targetDir = scratchDir();
  mkdirSync(join(targetDir, "scripts"));
  writeFileSync(join(targetDir, "scripts", "engine-check.sh"), engineCheckScriptSource);
  chmodSync(join(targetDir, "scripts", "engine-check.sh"), 0o755);
  writeFileSync(join(targetDir, "scripts", "configure.sh"), configureScriptSource);
  chmodSync(join(targetDir, "scripts", "configure.sh"), 0o755);
  writeFileSync(join(targetDir, "scripts", "configuration.sh"), configurationScriptSource);
  chmodSync(join(targetDir, "scripts", "configuration.sh"), 0o755);
  writeFileSync(join(targetDir, "scripts", "installer-ui.sh"), installerUiSource);
  chmodSync(join(targetDir, "scripts", "installer-ui.sh"), 0o755);
  writeFileSync(join(targetDir, ".env-orbit.example"), environmentExampleSource);
  if (withEnvFile) {
    const envLines = [
      "APP_URL=https://orbit.engine-check-test.internal",
      "ORBIT_IMAGE=orbit-local:abcdef123456",
      "OIDC_ISSUER=https://auth.engine-check-test.internal/application/o/orbit/",
      "OIDC_CLIENT_ID=engine-check-test-client",
      "OIDC_CLIENT_SECRET=engine-check-test-secret",
      "OIDC_CALLBACK_URL=https://orbit.engine-check-test.internal/api/auth/callback",
      ...(composeProjectName ? [`COMPOSE_PROJECT_NAME=${composeProjectName}`] : []),
      "",
    ].join("\n");
    writeFileSync(join(targetDir, ".env-orbit"), envLines);
    chmodSync(join(targetDir, ".env-orbit"), 0o600);
  }
  return targetDir;
}

// A fake `docker` that logs its exact argv (one argument per line, so a
// value containing spaces is unambiguous) to `argvLogPath` and then exits
// with `exitCode` — never touching a real daemon, container, volume, or
// image. Bash, not Node: `docker compose --env-file <path>` collides with
// Node 20.6+'s own `--env-file` CLI-flag interception (the same reason
// docs/adr-notes/295-install-port-plan.md's slice 5 section gives for why
// its own shipped-adapter argv fakes are bash scripts).
function makeFakeDockerBin({ exitCode = 0, argvLogPath }) {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-engine-check-fakebin-"));
  scratchDirs.push(binDir);
  const script = ["#!/usr/bin/env bash", `printf '%s\\n' "$@" > '${argvLogPath}'`, `exit ${exitCode}`, ""].join("\n");
  writeFileSync(join(binDir, "docker"), script);
  chmodSync(join(binDir, "docker"), 0o755);
  return binDir;
}

// A PATH containing bash and the handful of coreutils engine-check.sh's
// container-mode branch calls (basename, tr) but deliberately no `docker`
// at all — proving the script's own `command -v docker` gate, not a fake
// docker that merely fails once invoked (docker itself is at /usr/bin in
// this sandbox alongside bash/coreutils, so it cannot be excluded by
// pointing PATH at a real system directory).
function makeDockerlessBinDir() {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-engine-check-nodocker-"));
  scratchDirs.push(binDir);
  for (const tool of ["bash", "basename", "tr", "cat", "printf"]) {
    const realPath = spawnSync("which", [tool], SPAWN_OPTS).stdout.trim();
    if (realPath) symlinkSync(realPath, join(binDir, tool));
  }
  return binDir;
}

function runEngineCheck(targetDir, args, { pathPrefix, env } = {}) {
  const pathValue = pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH;
  return spawnSync("bash", [join(targetDir, "scripts", "engine-check.sh"), ...args], {
    cwd: targetDir,
    ...SPAWN_OPTS,
    env: { PATH: pathValue, HOME: process.env.HOME ?? tmpdir(), ...env },
  });
}

describe("default mode (ORBIT_ENGINE_CHECK unset): behavior-preserving proxy", () => {
  it("delegates to `bash scripts/configure.sh --check` byte-for-byte, with no docker on PATH at all", () => {
    const targetDir = makeFixture();
    const direct = spawnSync("bash", ["scripts/configure.sh", "--check"], { cwd: targetDir, ...SPAWN_OPTS });
    const viaWrapper = runEngineCheck(targetDir, []);
    expect(viaWrapper.stdout).toBe(direct.stdout);
    expect(viaWrapper.status).toBe(direct.status);
  });

  it("stays the default proxy even when ORBIT_ENGINE_CHECK is set to something other than \"container\"", () => {
    const targetDir = makeFixture();
    const result = runEngineCheck(targetDir, [], { env: { ORBIT_ENGINE_CHECK: "host" } });
    const direct = spawnSync("bash", ["scripts/configure.sh", "--check"], { cwd: targetDir, ...SPAWN_OPTS });
    expect(result.stdout).toBe(direct.stdout);
    expect(result.status).toBe(direct.status);
  });

  it("accepts --plain as an inert flag without forwarding it to configure.sh (which has no such flag)", () => {
    const targetDir = makeFixture();
    const result = runEngineCheck(targetDir, ["--plain"]);
    const direct = spawnSync("bash", ["scripts/configure.sh", "--check"], { cwd: targetDir, ...SPAWN_OPTS });
    expect(result.stdout).toBe(direct.stdout);
    expect(result.status).toBe(direct.status);
  });

  it("rejects an unrecognised flag with a usage error (exit 2), before touching docker or configure.sh", () => {
    const targetDir = makeFixture();
    const result = runEngineCheck(targetDir, ["--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });
});

describe("ORBIT_ENGINE_CHECK=container: composes the documented one-off invocation", () => {
  it("invokes docker with exactly the documented argv, and propagates its exit code", () => {
    const targetDir = makeFixture({ composeProjectName: "enginechecktest" });
    const argvLogPath = join(targetDir, "docker-argv.log");
    const binDir = makeFakeDockerBin({ exitCode: 0, argvLogPath });

    const result = runEngineCheck(targetDir, [], { pathPrefix: binDir, env: { ORBIT_ENGINE_CHECK: "container" } });

    expect(result.status).toBe(0);
    const argv = readFileSync(argvLogPath, "utf8").split("\n").filter((line) => line.length > 0);
    expect(argv).toEqual([
      "compose",
      "--project-name",
      "enginechecktest",
      "--env-file",
      ".env-orbit",
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--entrypoint",
      "node",
      "--volume",
      `${targetDir}:/orbit-deploy:ro`,
      "orbit-app",
      "/opt/orbit/cli/orbit.js",
      "check",
      "--dir",
      "/orbit-deploy",
    ]);
  });

  it("propagates a nonzero docker compose exit code unchanged", () => {
    const targetDir = makeFixture();
    const argvLogPath = join(targetDir, "docker-argv.log");
    const binDir = makeFakeDockerBin({ exitCode: 1, argvLogPath });

    const result = runEngineCheck(targetDir, [], { pathPrefix: binDir, env: { ORBIT_ENGINE_CHECK: "container" } });

    expect(result.status).toBe(1);
  });

  it("derives the Compose project name from the current directory's basename when .env-orbit has none", () => {
    const targetDir = makeFixture({ composeProjectName: null });
    const argvLogPath = join(targetDir, "docker-argv.log");
    const binDir = makeFakeDockerBin({ exitCode: 0, argvLogPath });

    const result = runEngineCheck(targetDir, [], { pathPrefix: binDir, env: { ORBIT_ENGINE_CHECK: "container" } });

    expect(result.status).toBe(0);
    const argv = readFileSync(argvLogPath, "utf8").split("\n").filter((line) => line.length > 0);
    const projectNameIndex = argv.indexOf("--project-name");
    expect(projectNameIndex).toBeGreaterThanOrEqual(0);
    expect(argv[projectNameIndex + 1]).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
  });

  it("a COMPOSE_PROJECT_NAME set only in the environment (not .env-orbit) is honored", () => {
    const targetDir = makeFixture({ composeProjectName: null });
    const argvLogPath = join(targetDir, "docker-argv.log");
    const binDir = makeFakeDockerBin({ exitCode: 0, argvLogPath });

    const result = runEngineCheck(targetDir, [], {
      pathPrefix: binDir,
      env: { ORBIT_ENGINE_CHECK: "container", COMPOSE_PROJECT_NAME: "env-supplied-project" },
    });

    expect(result.status).toBe(0);
    const argv = readFileSync(argvLogPath, "utf8").split("\n").filter((line) => line.length > 0);
    const projectNameIndex = argv.indexOf("--project-name");
    expect(argv[projectNameIndex + 1]).toBe("env-supplied-project");
  });

  it("refuses (exit 5) when docker is unavailable, before ever changing directory into a Compose invocation", () => {
    const targetDir = makeFixture();
    const dockerlessBinDir = makeDockerlessBinDir();
    const result = runEngineCheck(targetDir, [], {
      env: { ORBIT_ENGINE_CHECK: "container", PATH: dockerlessBinDir },
    });
    expect(result.status).toBe(5);
  });

  it("refuses (exit 5) when .env-orbit is missing", () => {
    const targetDir = makeFixture({ withEnvFile: false });
    const argvLogPath = join(targetDir, "docker-argv.log");
    const binDir = makeFakeDockerBin({ exitCode: 0, argvLogPath });

    const result = runEngineCheck(targetDir, [], { pathPrefix: binDir, env: { ORBIT_ENGINE_CHECK: "container" } });

    expect(result.status).toBe(5);
  });

  it("never places a secret value on the composed docker argv (this script never reads one)", () => {
    const targetDir = makeFixture();
    const argvLogPath = join(targetDir, "docker-argv.log");
    const binDir = makeFakeDockerBin({ exitCode: 0, argvLogPath });

    runEngineCheck(targetDir, [], { pathPrefix: binDir, env: { ORBIT_ENGINE_CHECK: "container" } });

    const argv = readFileSync(argvLogPath, "utf8");
    expect(argv).not.toContain("engine-check-test-secret");
  });
});
