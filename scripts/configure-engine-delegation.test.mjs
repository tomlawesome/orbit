import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeEngineDockerShim } from "./engine-docker-shim.mjs";
import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";
import { PTY_DEADLINE_MS, failOnPtyDeadline } from "./pty-deadline.mjs";

// scripts/configure.sh after #1210: a thin shell that resolves the engine
// image, makes sure it is present, and runs every flow as one `docker run
// --rm` of the orbit CLI with the deployment directory at /orbit-deploy
// (build notes D1-D3, D5). A fake `docker` on PATH (scripts/engine-docker-
// shim.mjs) records each argv and runs this checkout's CLI in place of the
// container, so these tests prove the exact docker invocation and that the
// engine behind it does the work. No test reaches a real daemon.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoDir = join(scriptsDir, "..");
const LOCAL_IMAGE = "orbit-local:abcdef123456";
const DIGEST_IMAGE = `registry.delegation.invalid/orbit@sha256:${"d".repeat(64)}`;

const scratchDirs = [];
afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop(), { recursive: true, force: true });
});
function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function makeFixture({ envFile } = {}) {
  const targetDir = scratchDir("orbit-configure-delegation-");
  mkdirSync(join(targetDir, "scripts"));
  writeFileSync(join(targetDir, "scripts", "configure.sh"), readFileSync(join(scriptsDir, "configure.sh")));
  writeFileSync(join(targetDir, ".env-orbit.example"), readFileSync(join(repoDir, ".env-orbit.example")));
  if (envFile !== undefined) writeFileSync(join(targetDir, ".env-orbit"), envFile, { mode: 0o600 });
  return targetDir;
}

function makeDocker(options) {
  const binDir = scratchDir("orbit-configure-delegation-bin-");
  writeEngineDockerShim(binDir, options);
  return { binDir, log: join(binDir, "calls.jsonl") };
}

function run(targetDir, args, { env = {}, input = "", docker = makeDocker(), cwd = targetDir } = {}) {
  const result = failOnProcessDeadline(spawnSync("bash", [join(targetDir, "scripts", "configure.sh"), ...args], {
    cwd,
    input,
    encoding: "utf8",
    env: {
      PATH: `${docker.binDir}:${process.env.PATH}`,
      HOME: process.env.HOME ?? tmpdir(),
      ORBIT_FAKE_DOCKER_LOG: docker.log,
      ...env,
    },
    ...processGuard(),
  }), { label: `configure.sh ${args.join(" ")}` });
  return { ...result, calls: dockerCalls(docker.log) };
}

function dockerCalls(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const runCall = (calls) => calls.find((call) => call[0] === "run");

/** The pieces of a `docker run` argv these tests assert on. */
function shape(call) {
  const imageIndex = call.indexOf("--entrypoint") + 2;
  const flags = call.slice(1, imageIndex - 2);
  const env = [];
  const volumes = [];
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index] === "-e") env.push(flags[++index]);
    else if (flags[index] === "-v") volumes.push(flags[++index]);
  }
  return {
    interactive: flags.includes("-i"),
    tty: flags.includes("-t"),
    network: flags[flags.indexOf("--network") + 1],
    env,
    volumes,
    image: call[imageIndex],
    command: call.slice(imageIndex + 1),
  };
}

describe("the docker run each flow becomes (D1)", () => {
  it.each([
    [[], "rw", ["configure"], false],
    [["--check"], "ro", ["check"], false],
    [["--check-rollback"], "ro", ["check", "--rollback"], false],
    [["--set-deployment-profile", "ai", "llama3:8b"], "rw", ["configure", "--set-deployment-profile", "ai", "llama3:8b"], false],
    [["--set-oidc-secret"], "rw", ["configure", "--set-oidc-secret"], true],
  ])("configure.sh %j", (args, mode, command, interactive) => {
    const targetDir = makeFixture({ envFile: `ORBIT_CONFIG_SCHEMA_VERSION=1\nORBIT_IMAGE=${LOCAL_IMAGE}\n` });
    const result = run(targetDir, args, { input: "delegation-secret\n" });
    const call = shape(runCall(result.calls));
    expect(call.image).toBe(LOCAL_IMAGE);
    expect(call.network).toBe("none");
    expect(call.volumes).toEqual([`${targetDir}:/orbit-deploy:${mode}`]);
    expect(call.command).toEqual(["/opt/orbit/cli/orbit.js", ...command, "--dir", "/orbit-deploy"]);
    expect(call.interactive).toBe(interactive);
    expect(call.tty).toBe(false);
  });

  it("--init with the environment answers runs the engine, which writes them (exit 0)", () => {
    const targetDir = makeFixture();
    const result = run(targetDir, ["--init"], {
      env: {
        ORBIT_IMAGE: LOCAL_IMAGE,
        ORBIT_CONFIGURE_APP_URL: "https://orbit.delegation.invalid",
        ORBIT_CONFIGURE_OIDC_ISSUER: "https://auth.delegation.invalid/application/o/orbit/",
        ORBIT_CONFIGURE_OIDC_CLIENT_ID: "delegation-client",
      },
    });
    expect(result.status).toBe(0);
    expect(shape(runCall(result.calls)).command).toEqual(["/opt/orbit/cli/orbit.js", "configure", "--init", "--dir", "/orbit-deploy"]);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain("OIDC_CLIENT_ID=delegation-client\n");
  });

  it("--preflight mounts the --file's own directory read-only, resolved from the caller's directory", () => {
    const targetDir = makeFixture();
    const elsewhere = scratchDir("orbit-configure-delegation-target-");
    writeFileSync(join(elsewhere, ".env-orbit"), "APP_URL=https://orbit.delegation.invalid\n", { mode: 0o600 });
    const result = run(targetDir, ["--preflight", "--file", ".env-orbit"], { env: { ORBIT_IMAGE: LOCAL_IMAGE }, cwd: elsewhere });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("safely_migratable ORBIT_CONFIG_SCHEMA_VERSION\n");
    const call = shape(runCall(result.calls));
    expect(call.volumes).toEqual([`${elsewhere}:/orbit-deploy:ro`]);
    expect(call.command).toEqual(["/opt/orbit/cli/orbit.js", "configure", "--preflight", "--file", "/orbit-deploy/.env-orbit", "--dir", "/orbit-deploy"]);
  });

  it("--migrate mounts that directory read-write and prints the engine's one success line", () => {
    const targetDir = makeFixture();
    const elsewhere = scratchDir("orbit-configure-delegation-target-");
    writeFileSync(join(elsewhere, ".env-orbit"), "APP_URL=https://orbit.delegation.invalid\n", { mode: 0o600 });
    const digest = `sha256:${"d".repeat(64)}`;
    const result = run(
      targetDir,
      ["--migrate", "--transaction", "--file", ".env-orbit", "--orbit-image", DIGEST_IMAGE, "--applied-version", "v1.0.0", "--compose-project-name", "orbit", "--applied-digest", digest],
      { env: { ORBIT_IMAGE: LOCAL_IMAGE }, cwd: elsewhere },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`Orbit configuration: migrated from schema v0 version legacy/unknown digest legacy/unknown to schema v1 version v1.0.0 digest ${digest}\n`);
    expect(shape(runCall(result.calls)).volumes).toEqual([`${elsewhere}:/orbit-deploy:rw`]);
  });
});

describe("a terminal is passed through only to the flows that prompt (D3)", () => {
  function runOnPty(targetDir, args, env) {
    const docker = makeDocker();
    const command = `exec bash '${join(targetDir, "scripts", "configure.sh")}' ${args.join(" ")}`;
    const result = spawnSync("script", ["-qeE", "never", "-c", command, "/dev/null"], {
      cwd: targetDir,
      input: "\x04",
      encoding: "utf8",
      timeout: PTY_DEADLINE_MS,
      killSignal: "SIGKILL",
      env: { PATH: `${docker.binDir}:${process.env.PATH}`, HOME: process.env.HOME ?? tmpdir(), TERM: "xterm", ORBIT_FAKE_DOCKER_LOG: docker.log, ...env },
    });
    failOnPtyDeadline(result, { label: `configure.sh ${args.join(" ")} on a pty`, deadlineMs: PTY_DEADLINE_MS });
    return dockerCalls(docker.log).filter((call) => call[0] === "run").map(shape);
  }

  it("--init with no answers gets -t on a terminal", () => {
    const targetDir = makeFixture();
    const [onTerminal] = runOnPty(targetDir, ["--init"], { ORBIT_IMAGE: LOCAL_IMAGE });
    expect(onTerminal.tty).toBe(true);
    expect(onTerminal.interactive).toBe(true);
  });

  it("--init in machine-prompt mode never gets -t, even on a terminal", () => {
    const targetDir = makeFixture();
    const [onTerminal] = runOnPty(targetDir, ["--init"], { ORBIT_IMAGE: LOCAL_IMAGE, ORBIT_CONFIGURE_PROMPTS: "machine" });
    expect(onTerminal.tty).toBe(false);
    expect(onTerminal.interactive).toBe(true);
  });

  it("--check never gets -t, so its output stays plain lines", () => {
    const targetDir = makeFixture({ envFile: `ORBIT_IMAGE=${LOCAL_IMAGE}\n` });
    const [onTerminal] = runOnPty(targetDir, ["--check"], {});
    expect(onTerminal.tty).toBe(false);
    expect(onTerminal.interactive).toBe(false);
  });

  it("--init without a terminal or answers does not ask for one and the engine refuses", () => {
    const targetDir = makeFixture();
    const result = spawnSync("setsid", ["bash", join(targetDir, "scripts", "configure.sh"), "--init"], {
      cwd: targetDir,
      input: "",
      encoding: "utf8",
      env: { PATH: `${makeDocker().binDir}:${process.env.PATH}`, HOME: process.env.HOME ?? tmpdir(), ORBIT_IMAGE: LOCAL_IMAGE },
      ...processGuard(),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Guided configuration needs a controlling terminal");
  });
});

describe("whose files the engine writes (D5, #1258)", () => {
  function identity(calls) {
    const env = shape(runCall(calls)).env;
    return [env.find((entry) => entry.startsWith("ORBIT_HOST_UID=")), env.find((entry) => entry.startsWith("ORBIT_HOST_GID="))];
  }
  const uid = String(process.getuid());
  const gid = String(process.getgid());

  it("forwards the operator's uid and gid on rootful Docker", () => {
    const targetDir = makeFixture();
    const result = run(targetDir, [], { env: { ORBIT_IMAGE: LOCAL_IMAGE } });
    expect(result.status).toBe(0);
    expect(identity(result.calls)).toEqual([`ORBIT_HOST_UID=${uid}`, `ORBIT_HOST_GID=${gid}`]);
    expect(statSync(join(targetDir, ".env-orbit")).uid).toBe(process.getuid());
  });

  it("forwards 0:0 on rootless Docker, where container root is already the operator", () => {
    const targetDir = makeFixture();
    const result = run(targetDir, ["--check"], { env: { ORBIT_IMAGE: LOCAL_IMAGE }, docker: makeDocker({ rootless: true }) });
    expect(identity(result.calls)).toEqual(["ORBIT_HOST_UID=0", "ORBIT_HOST_GID=0"]);
  });

  it("never passes --user", () => {
    const targetDir = makeFixture();
    const result = run(targetDir, ["--check"], { env: { ORBIT_IMAGE: LOCAL_IMAGE } });
    expect(runCall(result.calls)).not.toContain("--user");
  });
});

describe("which image runs the engine (D2)", () => {
  it("ORBIT_IMAGE from the environment wins over .env-orbit", () => {
    const targetDir = makeFixture({ envFile: `ORBIT_IMAGE=orbit-local:111111111111\n` });
    const result = run(targetDir, ["--check"], { env: { ORBIT_IMAGE: LOCAL_IMAGE } });
    expect(shape(runCall(result.calls)).image).toBe(LOCAL_IMAGE);
  });

  it("falls back to the last ORBIT_IMAGE line in .env-orbit", () => {
    const targetDir = makeFixture({ envFile: `ORBIT_IMAGE=orbit-local:111111111111\nORBIT_IMAGE=${LOCAL_IMAGE}\n` });
    const result = run(targetDir, ["--check"]);
    expect(shape(runCall(result.calls)).image).toBe(LOCAL_IMAGE);
  });

  it("--check-rollback can read the image from the rollback copy when .env-orbit has none", () => {
    const targetDir = makeFixture({ envFile: "APP_URL=\n" });
    writeFileSync(join(targetDir, ".env-orbit.orbit-config.rollback"), `ORBIT_IMAGE=${LOCAL_IMAGE}\n`, { mode: 0o600 });
    const result = run(targetDir, ["--check-rollback"]);
    expect(shape(runCall(result.calls)).image).toBe(LOCAL_IMAGE);
  });

  it("refuses with both ways to supply one when there is no image anywhere, before any docker run", () => {
    const targetDir = makeFixture();
    const result = run(targetDir, []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No Orbit image to run configuration with. Set ORBIT_IMAGE");
    expect(result.stderr).toContain("records it in .env-orbit");
    expect(result.calls).toEqual([]);
    expect(existsSync(join(targetDir, ".env-orbit"))).toBe(false);
  });

  it("refuses a mutable tag", () => {
    const targetDir = makeFixture();
    const result = run(targetDir, [], { env: { ORBIT_IMAGE: "ghcr.io/tomlawesome/orbit:latest" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ORBIT_IMAGE must be an immutable registry digest");
    expect(runCall(result.calls)).toBeUndefined();
  });

  it("pulls a digest that is not present locally before the first engine call", () => {
    const targetDir = makeFixture();
    const result = run(targetDir, [], { env: { ORBIT_IMAGE: DIGEST_IMAGE }, docker: makeDocker({ imagePresent: false }) });
    expect(result.status).toBe(0);
    const verbs = result.calls.map((call) => call[0]);
    expect(verbs.indexOf("pull")).toBeGreaterThanOrEqual(0);
    expect(verbs.indexOf("pull")).toBeLessThan(verbs.indexOf("run"));
    expect(result.calls.find((call) => call[0] === "pull")).toContain(DIGEST_IMAGE);
  });

  it("refuses a local tag that is not present (nothing to pull)", () => {
    const targetDir = makeFixture();
    const result = run(targetDir, [], { env: { ORBIT_IMAGE: LOCAL_IMAGE }, docker: makeDocker({ imagePresent: false }) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`The Orbit image ${LOCAL_IMAGE} is not present locally`);
    expect(result.calls.map((call) => call[0])).not.toContain("pull");
    expect(runCall(result.calls)).toBeUndefined();
  });

  it("fails closed when a missing digest cannot be pulled", () => {
    const targetDir = makeFixture();
    const result = run(targetDir, [], { env: { ORBIT_IMAGE: DIGEST_IMAGE }, docker: makeDocker({ imagePresent: false, pullSucceeds: false }) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Could not pull ${DIGEST_IMAGE}`);
    expect(runCall(result.calls)).toBeUndefined();
  });
});

describe("nothing configured travels on a command line", () => {
  it("the OIDC secret arrives on stdin and the answers by -e NAME, never as values in argv", () => {
    const targetDir = makeFixture({ envFile: `ORBIT_CONFIG_SCHEMA_VERSION=1\nORBIT_IMAGE=${LOCAL_IMAGE}\n` });
    const secret = "delegation-secret-never-in-argv";
    const result = run(targetDir, ["--set-oidc-secret"], {
      input: `${secret}\n`,
      env: { ORBIT_CONFIGURE_APP_URL: "https://answer-never-in-argv.invalid" },
    });
    expect(result.status).toBe(0);
    expect(readFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "utf8")).toBe(secret);
    const flat = JSON.stringify(result.calls);
    expect(flat).not.toContain(secret);
    expect(flat).not.toContain("answer-never-in-argv");
    expect(shape(runCall(result.calls)).env).toContain("ORBIT_CONFIGURE_APP_URL");
  });
});

describe("exit codes", () => {
  it("usage errors are exit 2 and never reach docker", () => {
    const targetDir = makeFixture();
    for (const args of [["--not-a-real-flag"], ["--check", "extra"], ["--set-deployment-profile"]]) {
      const result = run(targetDir, args, { env: { ORBIT_IMAGE: LOCAL_IMAGE } });
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr).toContain("Usage:");
      expect(result.calls).toEqual([]);
    }
  });

  it("the engine's own refusal passes through (exit 1) and its usage error too (exit 2)", () => {
    const targetDir = makeFixture({ envFile: `ORBIT_CONFIG_SCHEMA_VERSION=1\nORBIT_IMAGE=${LOCAL_IMAGE}\n` });
    expect(run(targetDir, ["--init"], { env: { ORBIT_CONFIGURE_APP_URL: "https://orbit.delegation.invalid" } }).status).toBe(1);
    expect(run(targetDir, ["--set-deployment-profile", "bogus"]).status).toBe(2);
  });
});
