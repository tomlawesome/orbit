import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { readGolden } from "./__fixtures__/golden";
import {
  ComposeProjectNameRefusal,
  TargetValidationRefusal,
  deriveComposeProjectName,
  isPreprovisionedInput,
  validateTarget,
} from "./target-identity";

// Decision parity between scripts/install.sh's is_preprovisioned_input,
// validate_target and derive_compose_project_name and this module (issue
// #295 slice 2), against what the bash produced, captured from 9757e42f
// before #1212 deleted it (src/lib/__fixtures__/README.md). Golden-file
// characterization: the fixtures are bash's, never regenerated from this
// module.
//
// Each golden holds the target directory's setup (files, directories,
// symlinks, modes) and bash's status/stdout/stderr. The target is always
// named `_Parity.Target`, so bash's basename fallback is deterministic and
// exercises the sanitizer (lowercase, `.` to `-`, leading `_` stripped).

const FLOW = "target-identity";

interface Entry {
  path: string;
  file?: string;
  dir?: boolean;
  symlinkTo?: string;
  mode?: number;
}

interface TargetGolden {
  mode: "preprovisioned" | "validate" | "derive";
  setup: Entry[];
  requested: string | null;
  targetBasename: string;
  bash: { status: number; stdout: string; stderr: string };
}

const sandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
});

function makeTarget(golden: TargetGolden): string {
  const parent = mkdtempSync(join(tmpdir(), "orbit-target-identity-parity-"));
  sandboxes.push(parent);
  const dir = join(parent, golden.targetBasename);
  mkdirSync(dir);
  for (const entry of golden.setup) {
    const absolute = join(dir, entry.path);
    if (entry.symlinkTo !== undefined) symlinkSync(entry.symlinkTo, absolute);
    else if (entry.dir) mkdirSync(absolute, { mode: entry.mode });
    else writeFileSync(absolute, entry.file ?? "", { mode: entry.mode });
  }
  return dir;
}

function refusalMessage(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (!(error instanceof TargetValidationRefusal) && !(error instanceof ComposeProjectNameRefusal)) throw error;
    return error.message;
  }
}

describe("is_preprovisioned_input parity (golden)", () => {
  for (const name of [
    "preprovisioned exact contract",
    "preprovisioned extraneous file",
    "preprovisioned symlinked secrets directory",
    "preprovisioned empty secret file",
  ]) {
    it(`agrees: ${name}`, () => {
      const golden = readGolden<TargetGolden>(FLOW, name);
      expect(golden.bash.status).toBe(0);
      expect(String(isPreprovisionedInput(makeTarget(golden)))).toBe(golden.bash.stdout);
    });
  }
});

describe("validate_target parity (golden)", () => {
  for (const name of [
    "validate empty target",
    "validate recognized existing deployment",
    "validate preprovisioned input",
    "validate unrecognizable non-empty directory",
  ]) {
    it(`agrees: ${name}`, () => {
      const golden = readGolden<TargetGolden>(FLOW, name);
      const dir = makeTarget(golden);
      if (golden.bash.status !== 0) {
        expect(golden.bash.status).toBe(1);
        expect(refusalMessage(() => validateTarget(dir))).toBe(golden.bash.stderr);
        return;
      }
      const result = validateTarget(dir);
      expect(`target_was_empty=${result.targetWasEmpty ? 1 : 0}`).toBe(golden.bash.stdout);
    });
  }
});

describe("derive_compose_project_name parity (golden)", () => {
  for (const name of [
    "derive fallback basename",
    "derive configured env value",
    "derive conflicting requested name refuses",
    "derive requested name with no configured file",
    // #1043: the target's own docker-compose.yml name: outranks the
    // fallback basename; a name Compose would not accept falls through.
    "derive compose name outranks fallback",
    "derive invalid compose name falls through",
    "derive configured env outranks compose name",
  ]) {
    it(`agrees: ${name}`, () => {
      const golden = readGolden<TargetGolden>(FLOW, name);
      const dir = makeTarget(golden);
      const run = () => deriveComposeProjectName(dir, golden.requested ?? undefined, golden.targetBasename);
      if (golden.bash.status !== 0) {
        expect(golden.bash.status).toBe(1);
        expect(refusalMessage(run)).toBe(golden.bash.stderr);
        return;
      }
      const result = run();
      expect(
        `compose_project_name=${result.composeProjectName} explicit=${result.explicit ? 1 : 0} provisional=${result.provisional ? 1 : 0}`,
      ).toBe(golden.bash.stdout);
    });
  }
});
