// scripts/install.sh --plain --update with ORBIT_INSTALL_PROFILE (#1542): the
// launcher's Configure option changes an installed deployment between
// standard and processing. Written from the specification alone (issue #1542),
// before the change. The real engine runs against the fake docker; the shell
// reports the outcome file's `profile=` on its "Optional profiles:" line and
// starts or stops orbit-tika from it. Fixtures: install-test-support.mjs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { makePreprovisionedDeployment, makeTarget, recognisedVolume, runInstall, targetEntries } from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/** An installed deployment of `profile`, made by a real plain install, ready to be updated. */
function installed(profile) {
  const targetDir = makeTarget();
  makePreprovisionedDeployment(targetDir);
  const first = runInstall(targetDir, { ORBIT_INSTALL_PROFILE: profile }, ["--plain", "--install"]);
  expect(first.status).toBe(0);
  return targetDir;
}

function update(targetDir, requested) {
  const own = recognisedVolume("orbit");
  return runInstall(
    targetDir,
    { ORBIT_INSTALL_PROFILE: requested, FAKE_VOLUMES: own.volume, FAKE_PS: JSON.stringify(own.ps), FAKE_CONTAINER_IMAGES: JSON.stringify(own.images) },
    ["--plain", "--update"],
  );
}

const callLines = (result) => result.calls.split("\n");
// `docker compose ... stop orbit-tika` or `... rm -s -f orbit-tika`: an explicit stop or remove of the service.
const tikaDropped = (line) => /\bcompose\b/.test(line) && /\s(stop|rm|kill)\s/.test(line) && /\sorbit-tika\b/.test(line);

describe("install.sh --plain --update: ORBIT_INSTALL_PROFILE (#1542)", () => {
  it("changes processing to standard: profile lines emptied, orbit-tika stopped and removed explicitly, outcome names standard", () => {
    const targetDir = installed("processing");
    const result = update(targetDir, "standard");
    expect(result.status).toBe(0);
    const env = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    expect(env).not.toMatch(/^COMPOSE_PROFILES=.*\S/m);
    expect(env).not.toMatch(/^TIKA_URL=.*\S/m);
    // `up --remove-orphans` leaves a service behind an inactive profile running, so the stop is explicit.
    const dropped = callLines(result).filter(tikaDropped);
    expect(dropped.some((line) => /\sstop\s/.test(line))).toBe(true);
    expect(dropped.some((line) => /\srm\s/.test(line))).toBe(true);
    expect(result.stdout).toContain("Optional profiles: standard");
  });

  it("changes standard to processing: TIKA_URL set, orbit-tika started, outcome names processing", () => {
    const targetDir = installed("standard");
    const result = update(targetDir, "processing");
    expect(result.status).toBe(0);
    const env = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    expect(env).toContain("COMPOSE_PROFILES=processing\n");
    expect(env).toContain("TIKA_URL=http://orbit-tika:9998\n");
    expect(result.calls).toContain("compose --project-name orbit --env-file .env-orbit pull orbit-tika");
    expect(callLines(result).filter(tikaDropped)).toEqual([]);
    expect(result.stdout).toContain("Optional profiles: processing");
  });

  it("leaves a standard deployment alone when standard is requested: no service is dropped", () => {
    const targetDir = installed("standard");
    const result = update(targetDir, "standard");
    expect(result.status).toBe(0);
    expect(callLines(result).filter(tikaDropped)).toEqual([]);
    expect(result.stdout).toContain("Optional profiles: standard");
  });

  it("refuses a change of a local-model deployment before anything is written or started", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir, ["COMPOSE_PROFILES=ai", "OLLAMA_MODEL=llama3.2:3b"]);
    const envBefore = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    const entriesBefore = targetEntries(targetDir);
    const result = update(targetDir, "standard");
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("ORBIT_INSTALL_PROFILE cannot change a deployment that uses a local model; use the installer at a terminal.");
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(envBefore);
    expect(targetEntries(targetDir)).toEqual(entriesBefore);
    expect(result.calls).not.toContain(" up -d");
    expect(callLines(result).filter(tikaDropped)).toEqual([]);
  });
});
