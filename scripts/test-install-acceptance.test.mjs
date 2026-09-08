import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

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
