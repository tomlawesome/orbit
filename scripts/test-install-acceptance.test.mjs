import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard, processWatchdog } from "./process-budget.mjs";

// #894: project_name, registry_name and both ports used to be the fixed
// literals "orbit-acceptance" / "orbit-acceptance-registry" / 5300 / 3210,
// so two runs of scripts/test-install-acceptance.sh on one host shared a
// Compose project and a pair of ports -- either run's cleanup sweep removed
// the other's containers and volumes. This drives the real script (not a
// text match on its source) with TEST_INSTALL_ACCEPTANCE_DRY_RUN=1, a hook
// that prints the derived names and ports and exits right after the one
// real sweep_debris call, before any install, network or long-lived
// container work runs. A fake `docker` on PATH stands in for the daemon
// during that one sweep, logging every invocation so the test can prove the
// sweep filters use the derived project name rather than the old literal.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = fileURLToPath(new URL("./test-install-acceptance.sh", import.meta.url));

let workdir;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "orbit-test-install-acceptance-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/** A `docker` stub that logs every invocation's argv and answers every
 * subcommand as if nothing is running: `ps`/`volume ls`/`network ls`
 * `--filter` queries print nothing (so the `xargs -r` pipelines they feed
 * are no-ops), and `rm -f` on the registry name exits 0 as it would against
 * a container that never existed. */
function stubDockerOnPath() {
  const binDir = join(workdir, "bin");
  mkdirSync(binDir, { recursive: true });
  const log = join(workdir, "docker-calls.log");
  writeFileSync(log, "");

  const stub = join(binDir, "docker");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
case " $* " in *" logs "*) printf 'stub-docker-logs-marker\\n' ;; esac
exit 0
`,
  );
  // 0o755
  spawnSync("chmod", ["755", stub]);
  return { log, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } };
}

function dryRun(extraEnv = {}) {
  const { log, env } = stubDockerOnPath();
  const result = failOnProcessDeadline(
    spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...env, TEST_INSTALL_ACCEPTANCE_DRY_RUN: "1", ...extraEnv },
      ...processGuard(),
    }),
    { label: "dryRun" },
  );
  expect(result.status, `stderr: ${result.stderr}`).toBe(0);
  const dockerCalls = readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  return { stdout: result.stdout, dockerCalls };
}

function projectLine(stdout) {
  const line = stdout.split("\n").find((l) => l.startsWith("[acceptance] project: "));
  expect(line, `no project line in:\n${stdout}`).toBeTruthy();
  // "[acceptance] project: <name> (registry <name>-registry on 127.0.0.1:<port>, app on 127.0.0.1:<port>)"
  const match = line.match(
    /^\[acceptance\] project: (\S+) \(registry (\S+) on 127\.0\.0\.1:(\d+), app on 127\.0\.0\.1:(\d+)\)$/,
  );
  expect(match, `unparseable project line: ${line}`).toBeTruthy();
  const [, projectName, registryName, registryPort, appPort] = match;
  return { projectName, registryName, registryPort, appPort };
}

describe("scripts/test-install-acceptance.sh per-run isolation (#894)", () => {
  it("derives a project name distinct from the old fixed literal", () => {
    const { stdout } = dryRun();
    const { projectName, registryName } = projectLine(stdout);
    expect(projectName).not.toBe("orbit-acceptance");
    expect(projectName).toMatch(/^orbit-acceptance-[0-9a-f]{8}-\d+$/);
    expect(registryName).toBe(`${projectName}-registry`);
  });

  it("derives different project names and ports across two invocations", () => {
    const first = projectLine(dryRun().stdout);
    const second = projectLine(dryRun().stdout);

    // Different PID each spawn, so the project name (which embeds $$)
    // cannot collide even for two runs from the same checkout.
    expect(second.projectName).not.toBe(first.projectName);
    expect(second.registryName).not.toBe(first.registryName);
    // Ports are picked by the kernel independently each run; asserting they
    // differ would be flaky if the kernel ever reused one, so this only
    // checks both are present and numeric -- the isolation guarantee is the
    // project/registry name, proven above.
    expect(Number(first.registryPort)).toBeGreaterThan(0);
    expect(Number(second.registryPort)).toBeGreaterThan(0);
  });

  it("honours an explicit COMPOSE_PROJECT_NAME override, same as install.sh", () => {
    const { stdout } = dryRun({ COMPOSE_PROJECT_NAME: "orbit-acceptance-ci-override" });
    const { projectName, registryName } = projectLine(stdout);
    expect(projectName).toBe("orbit-acceptance-ci-override");
    expect(registryName).toBe("orbit-acceptance-ci-override-registry");
  });

  it("sweeps debris filtered on the derived project name, not the old literal", () => {
    const { stdout, dockerCalls } = dryRun();
    const { projectName, registryName } = projectLine(stdout);

    const filterCalls = dockerCalls.filter((call) => call.includes("--filter"));
    expect(filterCalls.length).toBeGreaterThan(0);
    for (const call of filterCalls) {
      expect(call).toContain(`--filter label=com.docker.compose.project=${projectName}`);
      // The old fixed literal was a prefix of every derived name, so this
      // has to check the whole filter value, not just absence of the
      // substring "orbit-acceptance".
      expect(call).not.toMatch(/--filter label=com\.docker\.compose\.project=orbit-acceptance($| )/);
    }

    const rmCalls = dockerCalls.filter((call) => call.startsWith("rm -f"));
    expect(rmCalls.some((call) => call.includes(registryName))).toBe(true);
    expect(rmCalls.some((call) => call.includes("orbit-acceptance-registry"))).toBe(false);
  });
});

// #1241: every stack the scripts bring up must tear itself down completely,
// on success, failure and interruption, exactly once. The hook values `fail`
// and `wait` leave the run in the state a real one reaches mid-scenario (a
// target with Compose files, an installer log, a built and a pushed image) and
// end it by an assertion failure or by waiting for a signal; the fake docker
// records what teardown asked of the daemon.
function parseRun(stdout) {
  const workdirLine = stdout.split("\n").find((l) => l.startsWith("[acceptance] work directory: "));
  expect(workdirLine, `no work directory line in:\n${stdout}`).toBeTruthy();
  const evidence = stdout.match(/^\[acceptance\] evidence kept in: (.+)$/m)?.[1];
  return { runDir: workdirLine.slice("[acceptance] work directory: ".length), evidence, ...projectLine(stdout) };
}

function readCalls(log) {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function runScript(mode, args = [], extraEnv = {}) {
  const { log, env } = stubDockerOnPath();
  const evidenceRoot = join(workdir, "evidence");
  const result = failOnProcessDeadline(
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: { ...env, TEST_INSTALL_ACCEPTANCE_DRY_RUN: mode, ORBIT_EVIDENCE_ROOT: evidenceRoot, ...extraEnv },
      ...processGuard(),
    }),
    { label: `runScript ${mode}` },
  );
  return { result, run: parseRun(result.stdout), calls: readCalls(log), evidenceRoot };
}

/** Starts the script in `wait` mode, delivers `signal` once it is blocked, and
 * resolves with its exit status once it has finished tearing down. */
function runSignalled(signal) {
  const { log, env } = stubDockerOnPath();
  const evidenceRoot = join(workdir, "evidence");
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script], {
      env: { ...env, TEST_INSTALL_ACCEPTANCE_DRY_RUN: "wait", ORBIT_EVIDENCE_ROOT: evidenceRoot },
    });
    let stdout = "";
    let signalled = false;
    const watchdog = processWatchdog({ label: `runSignalled ${signal}`, kill: () => child.kill("SIGKILL") });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      watchdog.touch();
      if (!signalled && stdout.includes("dry run: waiting for a signal")) {
        signalled = true;
        child.kill(signal);
      }
    });
    child.stderr.on("data", () => watchdog.touch());
    child.on("error", (error) => {
      watchdog.stop();
      reject(error);
    });
    child.on("close", (status) => {
      watchdog.stop();
      if (watchdog.reason) {
        reject(watchdog.error({ stdout, stderr: "" }));
        return;
      }
      resolve({ status, stdout, run: parseRun(stdout), calls: readCalls(log), evidenceRoot });
    });
  });
}

function expectFullTeardown({ calls, run }) {
  const { projectName, registryName, registryPort, runDir } = run;
  // Compose down for the primary and the local-only target, volumes and
  // orphans included.
  expect(calls.filter((c) => c === "compose --env-file .env-orbit down --volumes --remove-orphans")).toHaveLength(2);
  // Both projects are swept by label: containers (profile services included),
  // volumes and networks, and container removal takes anonymous volumes too.
  for (const project of [projectName, `${projectName}-local`]) {
    for (const kind of ["ps -aq", "volume ls -q", "network ls -q"]) {
      expect(calls, `${kind} for ${project}`).toContain(`${kind} --filter label=com.docker.compose.project=${project}`);
    }
  }
  // The registry container goes with its anonymous volume (-v).
  expect(calls.filter((c) => c === `rm -f -v ${registryName}`).length).toBeGreaterThan(1);
  expect(calls.some((c) => /^rm -f ${registryName}$/.test(c))).toBe(false);
  // Exactly the image references this run made, never an image ID.
  const registryImage = `127.0.0.1:${registryPort}/acceptance/orbit`;
  expect(calls).toContain(`rmi ${registryImage}:latest`);
  expect(calls).toContain(`rmi ${registryImage}@sha256:${"0".repeat(64)}`);
  expect(calls).toContain("rmi orbit-acceptance-local:dry-run");
  const rmiCalls = calls.filter((c) => c.startsWith("rmi "));
  for (const call of rmiCalls) {
    expect(call).toMatch(new RegExp(`^rmi (${registryImage.replace(/[.]/g, "\\.")}[:@]\\S+|orbit-acceptance-local:dry-run)$`));
  }
  expect(existsSync(runDir)).toBe(false);
}

describe("scripts/test-install-acceptance.sh teardown (#1241)", () => {
  it("removes everything the run created when an assertion fails", () => {
    const outcome = runScript("fail");
    expect(outcome.result.status).toBe(1);
    expectFullTeardown(outcome);
    expect(outcome.result.stdout.match(/teardown: starting/g)).toHaveLength(1);
  });

  it("keeps the installer log, compose logs and failure reason of a failed run, and prints where", () => {
    const { result, run, evidenceRoot } = runScript("fail");
    expect(result.status).toBe(1);
    expect(run.evidence, `no evidence path in:\n${result.stdout}`).toBeTruthy();
    expect(run.evidence.startsWith(`${evidenceRoot}/test-install-acceptance-`)).toBe(true);
    // The work directory is gone; the evidence is what is left.
    expect(existsSync(run.runDir)).toBe(false);
    expect(readFileSync(join(run.evidence, "install.log"), "utf8")).toContain(`installer log marker for ${run.projectName}`);
    expect(readFileSync(join(run.evidence, "failure.txt"), "utf8")).toContain("simulated assertion failure");
    expect(readFileSync(join(run.evidence, `compose-${run.projectName}.log`), "utf8")).toContain("stub-docker-logs-marker");
    expect(readFileSync(join(run.evidence, "registry.log"), "utf8")).toContain("stub-docker-logs-marker");
    // Deployment secrets and config are never copied.
    const names = readdirSync(run.evidence);
    expect(names.some((n) => n.includes(".env-orbit") || n.includes("orbit-secrets"))).toBe(false);
  });

  it("writes no evidence for a run that passed, and still tears down", () => {
    const { result, run, calls } = runScript("1");
    expect(result.status).toBe(0);
    expect(run.evidence).toBeUndefined();
    expect(existsSync(run.runDir)).toBe(false);
    expect(calls.filter((c) => c === `rm -f -v ${run.registryName}`).length).toBeGreaterThan(1);
  });

  it("no longer leaves anything behind on failure through ORBIT_ACCEPTANCE_KEEP_ON_FAIL", () => {
    const { result, run } = runScript("fail", [], { ORBIT_ACCEPTANCE_KEEP_ON_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(existsSync(run.runDir)).toBe(false);
  });

  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ])("tears everything down exactly once on %s", async (signal, expectedStatus) => {
    const outcome = await runSignalled(signal);
    expect(outcome.status).toBe(expectedStatus);
    expectFullTeardown(outcome);
    expect(outcome.stdout.match(/teardown: starting/g)).toHaveLength(1);
    // An interrupted run keeps its evidence like a failed one.
    expect(readFileSync(join(outcome.run.evidence, "install.log"), "utf8")).toContain("installer log marker");
  });
});

describe("scripts/test-install-acceptance.sh --keep (#1241)", () => {
  it("removes nothing and prints the commands that tear it all down, registry included", () => {
    const { result, run, calls } = runScript("fail", ["--keep"]);
    try {
      expect(result.status).toBe(1);
      // Nothing is removed: the only registry removal is the start-up sweep,
      // and there is no compose down, image removal or work directory removal.
      expect(calls.filter((c) => c === `rm -f -v ${run.registryName}`)).toHaveLength(1);
      expect(calls.some((c) => c.includes(" down ") || c.startsWith("rmi "))).toBe(false);
      expect(existsSync(run.runDir)).toBe(true);

      const registryImage = `127.0.0.1:${run.registryPort}/acceptance/orbit`;
      const out = result.stdout;
      expect(out).toContain(`docker rm -f -v ${run.registryName}`);
      expect(out).toContain(`docker rmi ${registryImage}:latest`);
      expect(out).toContain(`docker rmi ${registryImage}@sha256:${"0".repeat(64)}`);
      expect(out).toContain("docker rmi orbit-acceptance-local:dry-run");
      expect(out).toContain(`rm -rf -- ${run.runDir}`);
      expect(out).toContain(`(cd ${run.runDir}/${run.projectName} && docker compose --env-file .env-orbit down --volumes --remove-orphans)`);
      for (const project of [run.projectName, `${run.projectName}-local`]) {
        expect(out).toContain(`docker ps -aq --filter label=com.docker.compose.project=${project} | xargs -r docker rm -f -v`);
        expect(out).toContain(`docker volume ls -q --filter label=com.docker.compose.project=${project} | xargs -r docker volume rm`);
        expect(out).toContain(`docker network ls -q --filter label=com.docker.compose.project=${project} | xargs -r docker network rm`);
      }
    } finally {
      rmSync(run.runDir, { recursive: true, force: true });
    }
  });
});
