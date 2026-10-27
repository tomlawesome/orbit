// scripts/install.sh, the bootstrap shell around the install engine (#1212):
// an interrupt that lands on an Update after the engine's commit (#1518).
// An update is never rolled back, so the run rolls forward: nothing is undone,
// no step is cut part-way, and the run ends like a failure of the step it was in
// -- one terminal `failed` event, `retry` while the containers have not been
// started, `repair` from `compose up` on. Written from the specification alone,
// before the change. Fixtures and helpers: install-test-support.mjs.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import {
  allThreeVolumes,
  eventLines,
  pidAlive,
  readOptional,
  recognisedVolume,
  recoveryFixture,
  runInstall,
  runInstallSignalled,
  scratchDir,
  terminalFailure,
  treeSnapshot,
  volumeRemovals,
  volumesLeftBehind,
  wellFormedEvent,
} from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const statusCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

/** A deployment already installed, then an update of it: the engine says `ok` and not fresh, as the model-download tests set it up. */
function updateFixture() {
  const fixture = recoveryFixture();
  expect(runInstall(fixture.targetDir, fixture.environment).status).toBe(0);
  const own = recognisedVolume("orbit");
  const stateDir = scratchDir("state");
  return {
    targetDir: fixture.targetDir,
    stateDir,
    environment: {
      FAKE_STATE_DIR: stateDir,
      FAKE_VOLUMES: own.volume,
      FAKE_PS: JSON.stringify(own.ps),
      FAKE_CONTAINER_IMAGES: JSON.stringify(own.images),
      FAKE_ENGINE_EXIT: "0",
      FAKE_ENGINE_OUTCOME: "status=ok\nfresh=0\nprofile=standard\nmodel-pull=0\ndatabase-volume=\n",
    },
  };
}

function failedEvents(stdout) {
  return eventLines(stdout).filter((line) => / state=failed /.test(line));
}

/** The run ended with exactly one terminal `failed` event, matching `pattern`, and no completion. */
function expectOneTerminalFailure(result, pattern) {
  const events = eventLines(result.stdout);
  for (const line of events) expect(line).toMatch(wellFormedEvent);
  expect(failedEvents(result.stdout)).toHaveLength(1);
  expect(terminalFailure(result.stdout)).toMatch(pattern);
  expect(events.at(-1)).toBe(terminalFailure(result.stdout));
  expect(events.some((line) => /^phase=complete /.test(line))).toBe(false);
  expect(events.some((line) => /^phase=rollback /.test(line))).toBe(false);
}

describe("install.sh: an interrupt after an update's commit ends like a failure of its step (#1518)", () => {
  it.each(Object.entries(statusCodes))("on %s during the database wait: one terminal failed event, repair, exit %i", async (signal, code) => {
    const { targetDir, environment } = updateFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_HANG_PROBE: "orbit-db", ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60" },
      { signal, marker: "hung-probe" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.status).toBe(code);
    expectOneTerminalFailure(result, /^phase=database component=database state=failed reason=failure action=repair /);
    expect(result.calls).not.toContain("volume rm");
    expect(result.calls).not.toContain(" down ");
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(true);
    expect(result.hungAlive).toBe(false);
  });

  it("on SIGTERM during an image pull: stops at once, retry, and the containers are never started", async () => {
    const { targetDir, stateDir, environment } = updateFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_HANG_PULL: "orbit-db", ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60" },
      { signal: "SIGTERM", marker: "hung-pull" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.status).toBe(143);
    expectOneTerminalFailure(result, /^phase=preparation component=database state=failed reason=failure action=retry /);
    expect(result.signalToExitMs).toBeLessThan(3000);
    expect(existsSync(join(stateDir, "up-called"))).toBe(false);
    expect(result.hungAlive).toBe(false);
  });

  it.each([
    ["the database", "orbit-db", /^phase=database component=database state=failed reason=failure action=repair /],
    ["the application", "orbit-app", /^phase=application component=application state=failed reason=failure action=repair /],
  ])("on SIGTERM during the wait for %s: stops within one poll, not after the probe's own bound", async (_name, probe, terminal) => {
    const { targetDir, environment } = updateFixture();
    const result = await runInstallSignalled(
      targetDir,
      {
        ...environment,
        FAKE_HANG_PROBE: probe,
        ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60",
        ORBIT_INSTALLER_POLL_INTERVAL_SECONDS: "2",
      },
      { signal: "SIGTERM", marker: "hung-probe" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.status).toBe(143);
    expectOneTerminalFailure(result, terminal);
    expect(result.signalToExitMs).toBeLessThan(3000);
    expect(result.hungAlive).toBe(false);
  });
});

describe("install.sh: `compose up` is never cut by an interrupt (#1518)", () => {
  it("an update: the start runs to its end, then the run ends as a failed start (repair), with nothing rolled back and no waits", async () => {
    const { targetDir, stateDir, environment } = updateFixture();
    const before = treeSnapshot(targetDir);
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_UP_DELAY: "3", ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60" },
      { signal: "SIGTERM", marker: "hung-up" },
    );
    expect(result.signalSent).toBe(true);
    expect(existsSync(join(stateDir, "up-finished"))).toBe(true);
    expect(result.status).toBe(143);
    expectOneTerminalFailure(result, /^phase=preparation component=compose state=failed reason=failure action=repair /);
    expect(eventLines(result.stdout).some((line) => line.includes("reason=database-health"))).toBe(false);
    expect(result.calls).not.toContain("volume rm");
    expect(result.calls).not.toContain(" down ");
    // The committed files are still there, unchanged by the stop.
    const after = treeSnapshot(targetDir);
    for (const name of [".env-orbit", "docker-compose.yml"]) {
      expect(after[name]).toBeDefined();
      expect(after[name]).toBe(before[name]);
    }
    expect(result.hungAlive).toBe(false);
  });

  it("a fresh install: the start runs to its end, then the rollback still puts everything back (retry)", async () => {
    const { targetDir, stateDir, environment, before } = recoveryFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_UP_DELAY: "3", ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60" },
      { signal: "SIGTERM", marker: "hung-up" },
    );
    expect(result.signalSent).toBe(true);
    expect(existsSync(join(stateDir, "up-finished"))).toBe(true);
    expect(result.status).toBe(143);
    expect(failedEvents(result.stdout)).toHaveLength(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /);
    expect(eventLines(result.stdout).some((line) => /^phase=rollback component=installer state=completed /.test(line))).toBe(true);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(volumeRemovals(result.calls)).toEqual(allThreeVolumes);
    expect(volumesLeftBehind(stateDir)).toEqual([]);
    expect(result.hungAlive).toBe(false);
  });
});

describe("install.sh: the bound on `compose up` (#1518)", () => {
  it("ORBIT_INSTALLER_COMPOSE_UP_TIMEOUT_SECONDS=2: an update whose start never ends fails as a failed start, and the start is stopped", () => {
    const { targetDir, stateDir, environment } = updateFixture();
    const started = Date.now();
    let result;
    let alive = false;
    try {
      result = runInstall(targetDir, {
        ...environment,
        FAKE_HANG_UP: "1",
        ORBIT_INSTALLER_COMPOSE_UP_TIMEOUT_SECONDS: "2",
        ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60",
      });
    } finally {
      // Whatever happened, do not leave the hung fake start behind.
      const hungPid = Number(readOptional(join(stateDir, "hung-up")));
      alive = Number.isInteger(hungPid) && hungPid > 0 && pidAlive(hungPid);
      if (alive) process.kill(hungPid, "SIGKILL");
    }
    const elapsedMs = Date.now() - started;
    expect(result.status).not.toBe(0);
    expect(terminalFailure(result.stdout)).toMatch(/^phase=preparation component=compose state=failed reason=docker-host action=repair /);
    expect(failedEvents(result.stdout)).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(15_000);
    expect(alive).toBe(false);
  });
});

describe("install.sh: guards for an update's normal endings (#1518)", () => {
  it("an update with no interrupt still ends complete, deployment-ready, exit 0", () => {
    const { targetDir, environment } = updateFixture();
    const result = runInstall(targetDir, environment);
    expect(result.status).toBe(0);
    expect(eventLines(result.stdout).some((line) => /^phase=complete .* state=completed reason=deployment-ready /.test(line))).toBe(true);
    expect(failedEvents(result.stdout)).toEqual([]);
  });

  it("an interrupt during the optional window of an update still ends complete, exit 0", async () => {
    const { targetDir, environment } = updateFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_HANG_PROBE: "orbit-clamav", ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60" },
      { signal: "SIGTERM", marker: "hung-probe" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.status).toBe(0);
    const events = eventLines(result.stdout);
    expect(events.some((line) => /^phase=complete .* state=completed /.test(line))).toBe(true);
    expect(failedEvents(result.stdout)).toEqual([]);
    expect(events.some((line) => /^phase=rollback /.test(line))).toBe(false);
    expect(result.hungAlive).toBe(false);
  });
});
