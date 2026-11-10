import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { composeUpCalls, makeFixture, runRepair, scratchDir } from "./repair-test-harness.mjs";

// The decisions recorded on #1804 after the first tests were written.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const RESTORE_GUIDANCE_PREFIX =
  "manual step: a restore has not been finished and keeps Orbit stopped; run bash scripts/restore.sh --finish once Orbit is healthy, or bash scripts/restore.sh --recover to roll it back, then re-run repair (resolves=";
const UNDECIDED_GUIDANCE =
  "manual step: services are not running, and repair can't tell which folder this deployment's containers were made in; check them with docker ps -a, then re-run repair (resolves=services-not-running)";

function labels(content) {
  const scratch = scratchDir();
  const path = join(scratch, "labels");
  writeFileSync(path, content);
  return { workingDirLabelsPath: path, scratch };
}

describe("#1804 decisions", () => {
  it("restarting beside stopped: services-not-running is manual naming service-restarting, and nothing is started", () => {
    const targetDir = makeFixture();
    const state = { db: "stopped", app: "restarting" };
    const plan = runRepair(targetDir, ["--plan"], state);
    expect(plan.stdout).not.toContain("plan action=start-services");
    expect(plan.stdout).toContain("plan action=manual resolves=services-not-running");
    expect(plan.stderr).toContain("service-restarting");

    const executed = runRepair(targetDir, ["--execute", "--safe-only"], state);
    expect(executed.stdout).not.toContain("execute action=start-services");
    expect(composeUpCalls(executed)).toEqual([]);
  });

  it.each([["running"], ["stopped"]])("folder-moved with a journal and %s services: manual with the restore-unfinished guidance", (status) => {
    const targetDir = makeFixture();
    mkdirSync(join(targetDir, "backups", ".orbit-restore"), { recursive: true });
    writeFileSync(join(targetDir, "backups", ".orbit-restore", "restore.journal"), "{}\n");
    const world = labels(`${scratchDir()}/old-orbit-folder\n`);
    const plan = runRepair(targetDir, ["--plan"], { db: status, app: status, docker: { workingDirLabelsPath: world.workingDirLabelsPath } });
    expect(plan.stdout).toContain("plan action=manual resolves=folder-moved");
    expect(plan.stdout).not.toContain("plan action=recreate-services");
    expect(plan.stderr).toContain(RESTORE_GUIDANCE_PREFIX);
    expect(plan.stderr).toMatch(/\(resolves=folder-moved\)/u);
  });

  it("an undecided folder check gives the exact manual guidance", () => {
    const targetDir = makeFixture();
    const world = labels("relative/old-orbit\n");
    const plan = runRepair(targetDir, ["--plan"], { db: "stopped", app: "stopped", docker: { workingDirLabelsPath: world.workingDirLabelsPath } });
    expect(plan.stdout).toContain("plan action=manual resolves=services-not-running");
    expect(plan.stderr).toContain(UNDECIDED_GUIDANCE);
  });
});
