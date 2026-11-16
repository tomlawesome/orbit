// #1576 step 1: an update from a renamed or moved folder. The engine finds it (the containers' working-folder label
// names a folder that is gone), the operator's answer arrives as ORBIT_INSTALL_FOLDER_MOVED=recreate, and the engine
// reports recreate=0|1 in its outcome; install.sh adds --force-recreate only for recreate=1. No shell-side label
// listing, one path.
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { makePreprovisionedDeployment, makeTarget, recognisedVolume, repositoryRoot, runInstall } from "./install-test-support.mjs";

const upLine = (calls) => calls.split("\n").find((line) => / up -d/.test(line));
// The shell's own label-only listing (de846310, removed by #1576 step 1): working_dir without the container id.
const labelOnlyListings = (calls) => calls.split("\n").filter((line) => /ps .*working_dir/.test(line) && !/\.ID/.test(line));
const forbidden = (calls) => {
  expect(calls).not.toMatch(/docker volume rm/);
  expect(calls).not.toMatch(/ down( |$)/m);
};

const rows = (dir) => ({
  db: `${"c".repeat(64)}|orbit|orbit-db|${dir}\n`,
  both: `${"c".repeat(64)}|orbit|orbit-db|${dir}\n${"d".repeat(64)}|orbit|orbit-app|${dir}\n`,
});

// An installed deployment whose containers' working_dir label is `label`, then an update run with `env` and the real engine.
function update(label, env = {}) {
  const targetDir = makeTarget();
  makePreprovisionedDeployment(targetDir);
  expect(runInstall(targetDir).status).toBe(0);
  const own = recognisedVolume("orbit");
  const result = runInstall(
    targetDir,
    {
      FAKE_VOLUMES: own.volume,
      FAKE_PS: JSON.stringify({ [`volume=${own.volume}`]: rows(label).db, [`label=com.docker.compose.project=orbit`]: rows(label).both }),
      FAKE_CONTAINER_IMAGES: JSON.stringify(own.images),
      // The old shell check's fake: nothing may read it any more.
      FAKE_WORKING_DIR_LABELS: `${label}\n`,
      ...env,
    },
    ["--update"],
  );
  return { targetDir, result };
}

// An update whose engine is canned: it exits 0 with exactly `outcome`.
function updateWithOutcome(outcome, env = {}) {
  const targetDir = makeTarget();
  makePreprovisionedDeployment(targetDir);
  expect(runInstall(targetDir).status).toBe(0);
  appendFileSync(join(targetDir, ".env-orbit"), "OLLAMA_MODEL=llama3.2:1b\n");
  const own = recognisedVolume("orbit");
  const result = runInstall(
    targetDir,
    { FAKE_VOLUMES: own.volume, FAKE_PS: JSON.stringify(own.ps), FAKE_CONTAINER_IMAGES: JSON.stringify(own.images), FAKE_ENGINE_EXIT: "0", FAKE_ENGINE_OUTCOME: outcome, ...env },
    ["--update"],
  );
  return { targetDir, result };
}

const okUpdate = (extra) => `status=ok\nfresh=0\nprofile=standard\nscanner=on\nmodel-pull=0\ndatabase-volume=\n${extra}`;
const lastEngineEnv = (result) => result.engineRuns[result.engineRuns.length - 1].env;

describe("install.sh and the engine's recreate outcome (#1576)", () => {
  it("forwards ORBIT_INSTALL_FOLDER_MOVED to the engine, beside the profile and scanner requests", () => {
    const { result } = updateWithOutcome(okUpdate("recreate=0\n"), { ORBIT_INSTALL_FOLDER_MOVED: "recreate", ORBIT_INSTALL_SCANNER: "on" });
    expect(lastEngineEnv(result).ORBIT_INSTALL_FOLDER_MOVED).toBe("recreate");
    expect(lastEngineEnv(result).ORBIT_INSTALL_SCANNER).toBe("on");
  }, PROCESS_TEST_TIMEOUT_MS);

  it("adds --force-recreate to the start only when the outcome says recreate=1", () => {
    const { result } = updateWithOutcome(okUpdate("recreate=1\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(upLine(result.calls)).toContain("up -d --no-build --remove-orphans");
    expect(upLine(result.calls)).toContain("--force-recreate");
    forbidden(result.calls);
  }, PROCESS_TEST_TIMEOUT_MS);

  it("does not force recreation for recreate=0", () => {
    const { result } = updateWithOutcome(okUpdate("recreate=0\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(upLine(result.calls)).toBeDefined();
    expect(upLine(result.calls)).not.toContain("--force-recreate");
  }, PROCESS_TEST_TIMEOUT_MS);

  it("treats a missing recreate key (an older engine) as 0", () => {
    const { result } = updateWithOutcome(okUpdate(""));
    expect(result.status, result.stderr).toBe(0);
    expect(upLine(result.calls)).toBeDefined();
    expect(upLine(result.calls)).not.toContain("--force-recreate");
  }, PROCESS_TEST_TIMEOUT_MS);

  it.each([["2"], ["yes"], ["true"], [""], ["01"], ["1 "]])("accepts only 0 or 1: recreate=%j is an unusable outcome, nothing is started", (value) => {
    const { result } = updateWithOutcome(okUpdate(`recreate=${value}\n`));
    expect(result.status).not.toBe(0);
    expect(upLine(result.calls)).toBeUndefined();
    forbidden(result.calls);
  }, PROCESS_TEST_TIMEOUT_MS);

  it("never forces recreation on a fresh install, and the engine is asked nothing about folders", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { FAKE_WORKING_DIR_LABELS: "/somewhere/else\n", ORBIT_INSTALL_FOLDER_MOVED: "recreate" });
    expect(result.status, result.stderr).toBe(0);
    expect(labelOnlyListings(result.calls)).toEqual([]);
    expect(upLine(result.calls)).toBeDefined();
    expect(upLine(result.calls)).not.toContain("--force-recreate");
    forbidden(result.calls);
  }, PROCESS_TEST_TIMEOUT_MS);
});

describe("update from a moved folder, install.sh with the real engine (#1576)", () => {
  const withGoneFolder = (run) => {
    const scratch = mkdtempSync(join(tmpdir(), "orbit-renamed-"));
    try {
      return run(join(scratch, "old-orbit"));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  it("with ORBIT_INSTALL_FOLDER_MOVED=recreate, makes the containers again (--force-recreate), keeps data, and lists no labels itself", () => {
    withGoneFolder((gone) => {
      const { result } = update(gone, { ORBIT_INSTALL_FOLDER_MOVED: "recreate" });
      expect(result.status, result.stderr).toBe(0);
      expect(upLine(result.calls)).toContain("--force-recreate");
      expect(labelOnlyListings(result.calls)).toEqual([]);
      forbidden(result.calls);
    });
  }, PROCESS_TEST_TIMEOUT_MS);

  it("without the variable, refuses with reason=folder-moved before Compose, naming the old folder and both ways on", () => {
    withGoneFolder((gone) => {
      const { targetDir, result } = update(gone);
      const shown = `${result.stdout}\n${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(shown).toContain("reason=folder-moved");
      expect(shown).toContain(gone);
      expect(shown).toContain("ORBIT_INSTALL_FOLDER_MOVED=recreate");
      expect(shown).not.toMatch(/(^|\s)mv /);
      expect(upLine(result.calls)).toBeUndefined();
      expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).not.toContain("ORBIT_PREVIOUS_IMAGE=");
      forbidden(result.calls);
    });
  }, PROCESS_TEST_TIMEOUT_MS);

  it("refuses a value other than recreate before anything is written", () => {
    withGoneFolder((gone) => {
      const { result } = update(gone, { ORBIT_INSTALL_FOLDER_MOVED: "yes" });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("ORBIT_INSTALL_FOLDER_MOVED");
      expect(upLine(result.calls)).toBeUndefined();
    });
  }, PROCESS_TEST_TIMEOUT_MS);

  it("ignores the variable when the folder is not moved: no recreation", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    const own = recognisedVolume("orbit");
    const result = runInstall(
      targetDir,
      {
        FAKE_VOLUMES: own.volume,
        FAKE_PS: JSON.stringify({ [`volume=${own.volume}`]: rows(targetDir).db, [`label=com.docker.compose.project=orbit`]: rows(targetDir).both }),
        FAKE_CONTAINER_IMAGES: JSON.stringify(own.images),
        ORBIT_INSTALL_FOLDER_MOVED: "recreate",
      },
      ["--update"],
    );
    expect(result.status, result.stderr).toBe(0);
    expect(upLine(result.calls)).not.toContain("--force-recreate");
  }, PROCESS_TEST_TIMEOUT_MS);
});

describe("the shell no longer checks labels itself (#1576)", () => {
  it("install.sh has no containers_made_elsewhere and no label-only listing", () => {
    const script = readFileSync(join(repositoryRoot, "scripts", "install.sh"), "utf8");
    expect(script).not.toContain("containers_made_elsewhere");
    expect(script).not.toMatch(/recreating them from this folder/);
  });

  it("docs/operating.md names the variable and no mv command", () => {
    const docs = readFileSync(join(repositoryRoot, "docs", "operating.md"), "utf8");
    expect(docs).toContain("ORBIT_INSTALL_FOLDER_MOVED=recreate");
  });
});
