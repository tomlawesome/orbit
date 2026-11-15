// #1804 point 6: install.sh's folder facts follow the same rule repair.sh uses
// for "the folder the containers were made in is gone": a label's folder is
// gone only when nothing exists at that path and the nearest existing folder
// above it can be searched.
//   - a path that exists but is not a folder, or cannot be entered, is
//     reported as existing (exists: true);
//   - a path whose nearest existing parent cannot be searched gets no fact,
//     which the engine reads as a folder that exists elsewhere.
// The fact shape is the one install.bootstrap.test.mjs pins (#1570):
// workingDirs: [{ label: b64, exists: boolean, physical: b64 | null }].
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { makePreprovisionedDeployment, makeTarget, recognisedVolume, runInstall } from "./install-test-support.mjs";

function factsFor(label) {
  const targetDir = makeTarget();
  makePreprovisionedDeployment(targetDir);
  expect(runInstall(targetDir).status).toBe(0);
  const own = recognisedVolume("orbit");
  const dbRow = `${"c".repeat(64)}|orbit|orbit-db|${label}\n`;
  const all = `${dbRow}${"d".repeat(64)}|orbit|orbit-app|${label}\n`;
  const result = runInstall(
    targetDir,
    {
      FAKE_VOLUMES: own.volume,
      FAKE_PS: JSON.stringify({ [`volume=${own.volume}`]: dbRow, [`label=com.docker.compose.project=orbit`]: all }),
      FAKE_CONTAINER_IMAGES: JSON.stringify(own.images),
    },
    ["--update"],
  );
  const facts = JSON.parse(result.engineRuns[0].env.ORBIT_INSTALL_HOST_FACTS);
  return facts.workingDirs.map((folder) => ({
    label: Buffer.from(folder.label, "base64").toString(),
    exists: folder.exists,
    physical: folder.physical === null ? null : Buffer.from(folder.physical, "base64").toString(),
  }));
}

describe("install.sh folder facts follow repair.sh's rule for a gone folder (#1804 point 6)", () => {
  const withScratch = (run) => {
    const scratch = mkdtempSync(join(tmpdir(), "orbit-folder-facts-"));
    try {
      return run(scratch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  it("a label naming a file that exists is reported as existing", () => {
    withScratch((scratch) => {
      const file = join(scratch, "a-file");
      writeFileSync(file, "");
      const fact = factsFor(file).find((entry) => entry.label === file);
      expect(fact, "a fact for the file").toBeDefined();
      expect(fact.exists).toBe(true);
    });
  }, PROCESS_TEST_TIMEOUT_MS);

  it("a label naming a folder that cannot be entered is reported as existing (pin)", () => {
    withScratch((scratch) => {
      const locked = join(scratch, "no-entry");
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      try {
        const fact = factsFor(locked).find((entry) => entry.label === locked);
        expect(fact, "a fact for the folder").toBeDefined();
        expect(fact.exists).toBe(true);
      } finally {
        chmodSync(locked, 0o700);
      }
    });
  }, PROCESS_TEST_TIMEOUT_MS);

  it("a label whose nearest existing parent cannot be searched gets no fact", () => {
    withScratch((scratch) => {
      const parent = join(scratch, "locked-parent");
      mkdirSync(parent);
      const label = join(parent, "old-orbit-folder");
      chmodSync(parent, 0o000);
      try {
        const facts = factsFor(label);
        expect(facts.find((entry) => entry.label === label)).toBeUndefined();
      } finally {
        chmodSync(parent, 0o700);
      }
    });
  }, PROCESS_TEST_TIMEOUT_MS);

  it("a label with nothing at the path under a searchable parent is still reported gone (pin)", () => {
    withScratch((scratch) => {
      const label = join(scratch, "moved-away");
      const fact = factsFor(label).find((entry) => entry.label === label);
      expect(fact).toEqual({ label, exists: false, physical: null });
    });
  }, PROCESS_TEST_TIMEOUT_MS);
});
