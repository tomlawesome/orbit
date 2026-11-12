import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import {
  FIXTURE_IMAGE,
  composeUpCalls,
  makeFixture,
  runRepair,
  runRepairBetweenPlanAndExecute,
  scratchDir,
  stderrLines,
  treeSnapshot,
} from "./repair-test-harness.mjs";

// #1804 points 2-5 and #1798 points 1-2, written from the issue texts alone.
// (#1798 point 3, the stdout pattern list, is pinned in repair.test.mjs.)
//
//  #1804.2 a restarting container is not "not running": finding
//          service-restarting (target container, fail), planned manual, no
//          start; the database reachability check still runs.
//  #1804.3 recreate-services is planned only when every start-services
//          precondition holds; else folder-moved is planned manual, naming the
//          first blocker as start-services does.
//  #1804.4 a failed recreate-services prints a bounded "Docker said:" excerpt.
//  #1804.5 no database container and no database volume: start-services is not
//          planned; manual with database-volume-missing; refused at execution.
//  #1798.1 an undecided folder check blocks start-services (manual).
//  #1798.2 do_start_services re-reads the labels and refuses on a foreign or
//          untrusted one: "Orbit repair: start-services refused, nothing was
//          changed: <reason>."

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const STOPPED = { db: "stopped", app: "stopped" };
const RUNNING = { db: "running", app: "running" };

function labelsWorld({ labels } = {}) {
  const scratch = scratchDir();
  const oldDir = join(scratch, "old-orbit-folder");
  const labelsPath = join(scratch, "labels");
  writeFileSync(labelsPath, `${labels?.(oldDir) ?? oldDir}\n`);
  return { scratch, oldDir, labelsPath, docker: { workingDirLabelsPath: labelsPath } };
}

describe("#1804.2 a container that keeps restarting", () => {
  it("raises service-restarting for the application, not services-not-running", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--check"], { db: "running", app: "restarting" });
    expect(result.stdout).toContain("finding class=service-restarting target=container severity=fail");
    expect(result.stdout).not.toContain("class=services-not-running");
  });

  it("plans it manual, names the service and the logs, and plans no start", () => {
    const targetDir = makeFixture();
    const before = treeSnapshot(targetDir);
    const result = runRepair(targetDir, ["--plan"], { db: "running", app: "restarting" });
    expect(result.stdout).toContain("plan action=manual resolves=service-restarting");
    expect(result.stdout).not.toContain("plan action=start-services");
    const guidance = stderrLines(result).filter((line) => line.includes("orbit-app") && /logs/u.test(line));
    expect(guidance.length).toBeGreaterThan(0);
    expect(guidance.join("\n")).toMatch(/re-run repair/u);
    expect(composeUpCalls(result)).toEqual([]);
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  it("--execute --safe-only runs no compose up for it", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { db: "running", app: "restarting" });
    expect(result.stdout).not.toContain("execute action=start-services");
    expect(composeUpCalls(result)).toEqual([]);
    expect(result.argv.filter((line) => /^(restart|rm|stop|kill) /u.test(line))).toEqual([]);
  });

  it("names the right service when the database is the one restarting", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--plan"], { db: "restarting", app: "running" });
    expect(result.stdout).toContain("plan action=manual resolves=service-restarting");
    expect(stderrLines(result).filter((line) => line.includes("orbit-db") && /logs/u.test(line)).length).toBeGreaterThan(0);
  });

  it("with the database restarting, the reachability check still runs: database-unreachable and its log guidance appear", () => {
    const targetDir = makeFixture();
    const check = runRepair(targetDir, ["--check"], { db: "restarting", app: "running" });
    expect(check.stdout).toContain("finding class=service-restarting target=container severity=fail");
    expect(check.stdout).toContain("finding class=database-unreachable target=database severity=fail");
    expect(check.stdout).not.toContain("class=services-not-running");

    const plan = runRepair(targetDir, ["--plan"], { db: "restarting", app: "running" });
    expect(plan.stdout).toContain("plan action=manual resolves=database-unreachable");
    expect(plan.stderr).toContain("read the orbit-db container's logs");
  });

  it("a restarting container is not counted for services-not-running even beside a stopped one", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--check"], { db: "restarting", app: "stopped" });
    expect(result.stdout).toContain("finding class=service-restarting target=container severity=fail");
  });

  it("stopped containers still raise services-not-running and no service-restarting (pins the old case)", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--check"], STOPPED);
    expect(result.stdout).toContain("finding class=services-not-running target=container severity=fail");
    expect(result.stdout).not.toContain("service-restarting");
  });
});

// The preconditions of start-services (as repair-start-services.test.mjs
// provokes them). recreate-services must be held to the same ones.
const BLOCKERS = [
  ["managed-file-missing", (d) => rmSync(join(d, ".env-orbit"))],
  [
    "managed-file-symlink",
    (d) => {
      writeFileSync(join(d, "real-env-orbit"), "APP_URL=https://orbit.repair-test.internal\n", { mode: 0o600 });
      rmSync(join(d, ".env-orbit"));
      symlinkSync(join(d, "real-env-orbit"), join(d, ".env-orbit"));
    },
  ],
  ["managed-file-permissions", (d) => chmodSync(join(d, ".env-orbit"), 0o644)],
  ["secret-missing", (d) => rmSync(join(d, ".orbit-secrets", "session-secret"))],
  ["secret-permissions", (d) => chmodSync(join(d, ".orbit-secrets", "postgres-password"), 0o644)],
  ["secrets-directory-invalid", (d) => chmodSync(join(d, ".orbit-secrets"), 0o755)],
  ["configuration-incomplete", (d) => writeFileSync(join(d, ".env-orbit"), `ORBIT_IMAGE=${FIXTURE_IMAGE}\n`, { mode: 0o600 })],
  [
    "configuration-migration-interrupted",
    (d) => {
      writeFileSync(join(d, ".env-orbit.orbit-config.rollback"), readFileSync(join(d, ".env-orbit"), "utf8"), { mode: 0o600 });
      writeFileSync(join(d, ".env-orbit"), "APP_URL=https://orbit.repair-test.internal\n", { mode: 0o600 });
    },
  ],
  [
    "deployment-version-unsupported",
    (d) => {
      const kept = readFileSync(join(d, ".env-orbit"), "utf8")
        .split("\n")
        .filter((line) => !line.startsWith("ORBIT_CONFIG_APPLIED_"))
        .join("\n");
      writeFileSync(join(d, ".env-orbit"), kept, { mode: 0o600 });
    },
  ],
  ["staging-evidence-present", (d) => mkdirSync(join(d, ".orbit-install-staging.abcdef"), { mode: 0o700 })],
  ["compose-interpolation-failed", () => {}, { composeFails: true }],
  ["container-foreign-owner", () => {}, { containers: [{ id: "0123456789ab", service: "not-an-orbit-service" }] }],
  ["unrelated-resource-present", () => {}, { volumes: ["someother_orbit-db-data"] }],
  [
    "image-identity-mismatch",
    () => {},
    { imageInspect: { present: true, id: "sha256:" + "2".repeat(64) }, appImageId: "sha256:" + "1".repeat(64) },
  ],
];

describe("#1804.3 recreate-services has start-services' preconditions", () => {
  it("control: with every precondition met, folder-moved is planned as recreate-services", () => {
    const targetDir = makeFixture();
    const world = labelsWorld();
    const result = runRepair(targetDir, ["--plan"], { ...RUNNING, docker: world.docker });
    expect(result.stdout).toContain("plan action=recreate-services resolves=folder-moved");
  });

  it.each(BLOCKERS)("%s: folder-moved is planned manual, naming the blocker, and nothing is recreated", (cls, provoke, dockerExtra = {}) => {
    const targetDir = makeFixture();
    provoke(targetDir);
    const world = labelsWorld();
    const state = { ...RUNNING, docker: { ...world.docker, ...dockerExtra } };
    const check = runRepair(targetDir, ["--check"], state);
    expect(check.stdout).toContain(`finding class=${cls} `);
    expect(check.stdout).toContain("finding class=folder-moved target=deployment severity=fail");

    const plan = runRepair(targetDir, ["--plan"], state);
    expect(plan.stdout).not.toContain("plan action=recreate-services");
    expect(plan.stdout).toContain("plan action=manual resolves=folder-moved");
    expect(plan.stderr).toContain(cls);

    const executed = runRepair(targetDir, ["--execute", "--safe-only"], state);
    expect(executed.stdout).not.toContain("execute action=recreate-services");
    expect(composeUpCalls(executed)).toEqual([]);
  });

  it("names the first unmet precondition when several fail, as start-services does", () => {
    const targetDir = makeFixture();
    chmodSync(join(targetDir, ".orbit-secrets", "postgres-password"), 0o644); // secret-permissions
    mkdirSync(join(targetDir, ".orbit-install-staging.abcdef"), { mode: 0o700 }); // staging-evidence-present
    const world = labelsWorld();
    const result = runRepair(targetDir, ["--plan"], { ...RUNNING, docker: world.docker });
    expect(result.stdout).toContain("plan action=manual resolves=folder-moved");
    const guidance = stderrLines(result).filter((line) => line.includes("secret-permissions") || line.includes("staging-evidence-present"));
    expect(guidance.join("\n")).toContain("secret-permissions");
    expect(guidance.join("\n")).not.toContain("staging-evidence-present");
  });
});

describe("#1804.4 a failed recreate-services says why", () => {
  const dockerWords =
    "\u001b[31mError response from daemon: no space left on device\u001b[0m\u0007\u0000\r\n" + "x".repeat(6000) + "\nlast line";

  it("prints one bounded Docker said line on stderr, control characters stripped, and keeps stdout enum-only", () => {
    const targetDir = makeFixture();
    const world = labelsWorld();
    const result = runRepair(targetDir, ["--execute", "--safe-only"], {
      ...RUNNING,
      docker: world.docker,
      upFails: true,
      upStderr: dockerWords,
    });

    expect(result.stdout).toContain("execute action=recreate-services resolves=folder-moved result=failed");
    expect(result.status).toBe(4);
    const said = stderrLines(result).filter((line) => line.includes("Docker said:"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Orbit repair: Docker said:");
    expect(said[0]).toContain("no space left on device");
    expect(said[0].length).toBeLessThanOrEqual(600);
    expect(said[0]).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/u);
    expect(result.stderr).not.toContain("\u001b");
    expect(result.stdout).not.toContain("Docker said");
    expect(result.stdout).not.toContain("no space left");
    expect(result.stdout).not.toContain("xxxx");
  });

  it("keeps Docker's own words when they are short", () => {
    const targetDir = makeFixture();
    const world = labelsWorld();
    const result = runRepair(targetDir, ["--execute", "--safe-only"], {
      ...RUNNING,
      docker: world.docker,
      upFails: true,
      upStderr: "Error response from daemon: no space left on device\n",
    });
    expect(stderrLines(result).filter((line) => line.includes("Docker said:") && line.includes("no space left on device"))).toHaveLength(1);
  });
});

describe("#1804.5 containers and database volume both gone", () => {
  const BOTH_GONE = { db: "absent", app: "absent" };
  const VOLUME = { volumes: ["repairtest_orbit-db-data"] };

  it("--check raises database-volume-missing beside services-not-running", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--check"], BOTH_GONE);
    expect(result.stdout).toContain("finding class=services-not-running target=container severity=fail");
    expect(result.stdout).toContain("finding class=database-volume-missing target=database severity=fail");
  });

  it("--plan: no start-services; manual, with guidance that says what is missing and what to do", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--plan"], BOTH_GONE);
    expect(result.stdout).not.toContain("plan action=start-services");
    expect(result.stdout).toContain("plan action=manual resolves=services-not-running");
    expect(result.stderr).toMatch(/data is missing/u);
    expect(result.stderr).toMatch(/new, empty database/u);
    expect(result.stderr).toMatch(/restore from a backup/u);
    expect(result.stderr).toMatch(/installer/u);
  });

  it("--execute --safe-only never brings up a new empty database", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--execute", "--safe-only"], BOTH_GONE);
    expect(result.stdout).not.toContain("execute action=start-services");
    expect(composeUpCalls(result)).toEqual([]);
    expect(result.stateOf("orbit-db")).toBe("absent");
  });

  it("with the volume present, start-services is planned and runs (pins the ordinary case)", () => {
    const targetDir = makeFixture();
    expect(runRepair(targetDir, ["--check"], { ...BOTH_GONE, docker: VOLUME }).stdout).not.toContain("database-volume-missing");
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...BOTH_GONE, docker: VOLUME });
    expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=done");
    expect(composeUpCalls(result)).toHaveLength(1);
  });

  it("a stopped database container is not 'no database container': start-services is still planned without the volume listed", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--plan"], STOPPED);
    expect(result.stdout).not.toContain("database-volume-missing");
    expect(result.stdout).toContain("plan action=start-services resolves=services-not-running");
  });

  it("do_start_services checks again at execution: the volume vanishing after the plan refuses, changes nothing, exit 4", async () => {
    const targetDir = makeFixture();
    const result = await runRepairBetweenPlanAndExecute(
      targetDir,
      ["--execute", "--safe-only"],
      { ...BOTH_GONE, docker: VOLUME },
      ({ stateDir }) => writeFileSync(join(stateDir, "volumes-vanished"), ""),
    );
    expect(result.stdout).toContain("plan action=start-services resolves=services-not-running"); // volume was there at plan time
    expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=failed");
    expect(result.stdout).toContain("execution result=failed done=0 failed=1");
    expect(result.status).toBe(4);
    expect(composeUpCalls(result)).toEqual([]);
    expect(result.stderr).toContain("Orbit repair: start-services refused, nothing was changed: ");
    expect(result.stderr).toMatch(/new, empty database/u);
  });
});

describe("#1798.1 an undecided folder check blocks start-services", () => {
  const UNTRUSTED = [
    ["not absolute", () => "relative/old-orbit-zzmark"],
    ["over 4096 bytes", () => `/${"zzmark".repeat(700)}`],
    ["holding an escape control character", () => "/tmp/zzmark\u001b[31mred"],
    ["holding a carriage return", () => "/tmp/zzmark\rafter"],
  ];

  it.each(UNTRUSTED)("a label %s: no folder finding, start-services is not planned, services-not-running is manual naming the folder check", (_name, label) => {
    const targetDir = makeFixture();
    const world = labelsWorld({ labels: label });
    const state = { ...STOPPED, docker: world.docker };

    const check = runRepair(targetDir, ["--check"], state);
    expect(check.stdout).not.toContain("folder-moved");
    expect(check.stdout).not.toContain("folder-elsewhere");
    expect(check.stdout).toMatch(/diagnosis result=failed checked=19 skipped=1$/mu);
    expect(check.stdout).toContain("finding class=services-not-running");

    const plan = runRepair(targetDir, ["--plan"], state);
    expect(plan.stdout).not.toContain("plan action=start-services");
    expect(plan.stdout).toContain("plan action=manual resolves=services-not-running");
    expect(plan.stderr).toMatch(/folder/iu);
    expect(plan.stderr).not.toContain("zzmark");
    expect(plan.stdout).not.toContain("zzmark");

    const executed = runRepair(targetDir, ["--execute", "--safe-only"], state);
    expect(executed.stdout).not.toContain("execute action=start-services");
    expect(composeUpCalls(executed)).toEqual([]);
  });

  it("a decided folder check (every label is this folder) still plans start-services (pins the ordinary case)", () => {
    const targetDir = makeFixture();
    const world = labelsWorld({ labels: () => targetDir });
    const result = runRepair(targetDir, ["--plan"], { ...STOPPED, docker: world.docker });
    expect(result.stdout).toContain("plan action=start-services resolves=services-not-running");
  });
});

describe("#1798.2 do_start_services re-reads the labels at execution", () => {
  const CHANGES = [
    ["names a folder that is gone", (w) => w.oldDir],
    ["names another folder that exists", () => scratchDir()],
    ["can no longer be trusted (not absolute)", () => "relative/zzmark"],
  ];

  it.each(CHANGES)("a label that %s after the plan: refuses, changes nothing, result=failed, exit 4", async (_name, newLabel) => {
    const targetDir = makeFixture();
    const world = labelsWorld({ labels: () => targetDir });
    const result = await runRepairBetweenPlanAndExecute(
      targetDir,
      ["--execute", "--safe-only"],
      { ...STOPPED, docker: world.docker },
      () => writeFileSync(world.labelsPath, `${newLabel(world)}\n`),
    );
    expect(result.stdout).toContain("plan action=start-services resolves=services-not-running"); // labels were fine at plan time
    expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=failed");
    expect(result.stdout).toContain("execution result=failed done=0 failed=1");
    expect(result.status).toBe(4);
    expect(composeUpCalls(result)).toEqual([]);
    expect(result.stateOf("orbit-db")).toBe("stopped");
    expect(result.stderr).toContain("Orbit repair: start-services refused, nothing was changed: ");
    expect(result.stdout).not.toContain("zzmark");
    expect(result.stderr).not.toContain("zzmark");
  });

  it("with the labels unchanged between plan and execution, the start goes ahead (pins the ordinary case)", async () => {
    const targetDir = makeFixture();
    const world = labelsWorld({ labels: () => targetDir });
    const result = await runRepairBetweenPlanAndExecute(targetDir, ["--execute", "--safe-only"], { ...STOPPED, docker: world.docker }, () => {});
    expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=done");
    expect(composeUpCalls(result)).toHaveLength(1);
    expect(result.status).toBe(0);
  });
});

// #1804.6 repair.sh's side of "the folder is gone": it already follows the rule
// (a label's folder is gone only when nothing exists at the path and the
// nearest existing folder above it can be searched), so these pin it. The
// install.sh side is in install.folder-facts.test.mjs.
describe("#1804.6 repair.sh: only a path with nothing there, under a searchable parent, is a moved folder", () => {
  it("a label naming a file is not a moved folder (pin)", () => {
    const targetDir = makeFixture();
    const scratch = scratchDir();
    const file = join(scratch, "a-file");
    writeFileSync(file, "");
    const world = labelsWorld({ labels: () => file });
    const result = runRepair(targetDir, ["--check"], { ...RUNNING, docker: world.docker });
    expect(result.stdout).not.toContain("folder-moved");
  });

  it("a label whose nearest existing parent cannot be searched is not a moved folder (pin)", () => {
    const targetDir = makeFixture();
    const scratch = scratchDir();
    const parent = join(scratch, "locked");
    mkdirSync(parent);
    const world = labelsWorld({ labels: () => join(parent, "old-orbit") });
    chmodSync(parent, 0o000);
    try {
      const result = runRepair(targetDir, ["--check"], { ...RUNNING, docker: world.docker });
      expect(result.stdout).not.toContain("folder-moved");
    } finally {
      chmodSync(parent, 0o700);
    }
  });
});
