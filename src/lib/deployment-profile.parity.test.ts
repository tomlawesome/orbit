import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { readGolden } from "./__fixtures__/golden";
import { currentDeploymentProfile, isValidLocalModel } from "./deployment-profile";

// Decision parity between scripts/install.sh's is_valid_local_model /
// current_deployment_profile and this module (issue #295 slice 5), against
// what the bash produced, captured from 9757e42f before #1212 deleted it
// (src/lib/__fixtures__/README.md). Golden-file characterization: the
// fixtures are bash's, never regenerated from this module.

const FLOW = "deployment-profile";

const models = readGolden<{ cases: Array<{ candidate: string; bash: { status: number } }> }>(FLOW, "is valid local model");
const profiles = readGolden<{ cases: Array<{ name: string; envOrbit: string | null; bash: { stdout: string } }> }>(
  FLOW,
  "current deployment profile",
);

describe("is_valid_local_model parity (golden)", () => {
  it("has every captured candidate", () => {
    expect(models.cases.length).toBe(8);
  });

  for (const testCase of models.cases) {
    const label = testCase.candidate.length > 40 ? `${testCase.candidate.slice(0, 8)}... (${testCase.candidate.length} chars)` : testCase.candidate;
    it(`agrees for ${JSON.stringify(label)}`, () => {
      expect(isValidLocalModel(testCase.candidate)).toBe(testCase.bash.status === 0);
    });
  }
});

describe("current_deployment_profile parity, guarantee #23 (golden)", () => {
  const sandboxes: string[] = [];
  afterAll(() => {
    for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
  });

  it("has every captured fixture", () => {
    expect(profiles.cases.length).toBe(9);
  });

  for (const testCase of profiles.cases) {
    it(`agrees: ${testCase.name}`, () => {
      const dir = mkdtempSync(join(tmpdir(), "orbit-deployment-profile-parity-"));
      sandboxes.push(dir);
      if (testCase.envOrbit !== null) writeFileSync(join(dir, ".env-orbit"), testCase.envOrbit, { mode: 0o600 });
      const result = currentDeploymentProfile(dir, testCase.envOrbit !== null);

      if (result.ok) {
        expect(`status=0 profile=${result.profile}`).toBe(testCase.bash.stdout);
      } else {
        expect(testCase.bash.stdout).toMatch(/^status=[1-9]/);
      }
    });
  }
});
