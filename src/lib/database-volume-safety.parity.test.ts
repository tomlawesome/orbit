import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { readGolden } from "./__fixtures__/golden";
import {
  DatabaseVolumeSafetyRefusal,
  type DatabaseVolumeSafetyAdapter,
  type DatabaseVolumeSafetyState,
  type PostgresPasswordFacts,
  evaluateVolumeOwnership,
  verifyDatabaseVolumeSafety,
} from "./database-volume-safety";

// Decision parity between scripts/install.sh's volume_belongs_to_deployment
// / verify_database_volume_safety and this module (issue #295 slice 2),
// against what the bash produced, captured from 9757e42f before #1212
// deleted it (src/lib/__fixtures__/README.md). Golden-file
// characterization: the fixtures are bash's, never regenerated from this
// module.
//
// At capture time bash shelled out to a stub `docker` that answered every
// call from the case's scenario JSON. The adapter below answers each
// DatabaseVolumeSafetyAdapter method straight from that same scenario: a key
// absent from the scenario, or null, means "this docker call failed"; ""
// means "succeeded with empty output". The target directory is always named
// `parity-target`, so bash's basename fallback is deterministic and the
// engine gets the same fallback.

const FLOW = "database-volume-safety";
const TARGET_BASENAME = "parity-target";

interface DockerScenario {
  volumeLabels?: Record<string, string | null>;
  volumeProjectLabel?: Record<string, string | null>;
  containersByVolume?: Record<string, string | null>;
  containersByProject?: Record<string, string | null>;
  containerImage?: Record<string, string | null>;
  volumeLsExact?: Record<string, string | null>;
  volumeLsSubstring?: Record<string, string | null>;
}

interface BashResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface OwnershipGolden {
  kind: "ownership";
  candidate: string;
  expectedImage: string;
  scenario: DockerScenario;
  bash: BashResult;
}

interface VerifyGolden {
  kind: "verify";
  target: { envOrbit: string; composeFile: string | null; postgresPassword: string | null };
  targetWasEmpty: boolean;
  requested: string | null;
  scenario: DockerScenario;
  bash: BashResult;
}

interface RecheckGolden {
  kind: "verify-recheck";
  databaseVolumeName: string;
  databaseVolumeSeen: boolean;
  scenario: DockerScenario;
  bash: BashResult;
}

function scenarioAdapter(scenario: DockerScenario): DatabaseVolumeSafetyAdapter {
  const answer = (table: Record<string, string | null> | undefined, key: string): string | null => table?.[key] ?? null;
  return {
    inspectVolumeLabels: (candidateVolume) => answer(scenario.volumeLabels, candidateVolume),
    listContainersByVolume: (candidateVolume) => answer(scenario.containersByVolume, candidateVolume),
    listContainersByProject: (project) => answer(scenario.containersByProject, project),
    inspectContainerImage: (containerId) => answer(scenario.containerImage, containerId),
    listVolumesExactName: (name) => answer(scenario.volumeLsExact, name),
    listVolumesByKeySubstring: (key) => answer(scenario.volumeLsSubstring, key),
    inspectVolumeProjectLabel: (name) => answer(scenario.volumeProjectLabel, name),
  };
}

/** bash's driver printed the globals as `key=value` lines. */
function parseGlobals(stdout: string): Record<string, string> {
  const globals: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) globals[line.slice(0, index)] = line.slice(index + 1);
  }
  return globals;
}

const sandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
});

function makeTarget(): string {
  const parent = mkdtempSync(join(tmpdir(), "orbit-database-volume-safety-parity-"));
  sandboxes.push(parent);
  const dir = join(parent, TARGET_BASENAME);
  mkdirSync(dir);
  return dir;
}

function seedTarget(dir: string, target: VerifyGolden["target"]): PostgresPasswordFacts {
  writeFileSync(join(dir, ".env-orbit"), target.envOrbit, { mode: 0o600 });
  if (target.composeFile !== null) writeFileSync(join(dir, "docker-compose.yml"), target.composeFile);
  if (target.postgresPassword === null) return { isRegularNonSymlinkFile: false, mode: null };
  mkdirSync(join(dir, ".orbit-secrets"), { mode: 0o700 });
  const passwordPath = join(dir, ".orbit-secrets", "postgres-password");
  writeFileSync(passwordPath, target.postgresPassword, { mode: 0o600 });
  return { isRegularNonSymlinkFile: true, mode: lstatSync(passwordPath).mode & 0o777 };
}

function freshState(overrides: Partial<DatabaseVolumeSafetyState> = {}): DatabaseVolumeSafetyState {
  return {
    databaseVolumeChecked: false,
    databaseVolumeSeen: false,
    databaseVolumeName: "",
    targetWasEmpty: false,
    composeProjectNameExplicit: false,
    composeProjectName: "",
    composeProjectNameProvisional: false,
    ...overrides,
  };
}

function refusalMessage(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (!(error instanceof DatabaseVolumeSafetyRefusal)) throw error;
    return error.message;
  }
}

const OWNERSHIP_STATUS = { 0: "proven", 1: "not-proven", 2: "verify-error" } as const;

describe("volume_belongs_to_deployment parity (golden)", () => {
  for (const name of [
    "ownership proven",
    "ownership non-orbit-db container",
    "ownership malformed volume labels",
    "ownership failed volume inspect",
  ]) {
    it(`agrees: ${name}`, () => {
      const golden = readGolden<OwnershipGolden>(FLOW, name);
      const outcome = evaluateVolumeOwnership(golden.candidate, golden.expectedImage, scenarioAdapter(golden.scenario));
      expect(outcome.status).toBe(OWNERSHIP_STATUS[golden.bash.status as 0 | 1 | 2]);
      if (outcome.status === "proven") {
        // bash's driver reported only the status; the project it recorded is
        // the volume's own compose label.
        const labels = golden.scenario.volumeLabels?.[golden.candidate] ?? "";
        expect(outcome.project).toBe(labels.split("|")[0]);
      }
    });
  }
});

describe("verify_database_volume_safety parity — fresh check (golden)", () => {
  for (const name of [
    "verify no candidate volumes",
    "verify proven volume attaches",
    // #1043: the target's docker-compose.yml name: is what both sides report.
    "verify compose name with no candidate volume",
    "verify existing volume on empty target refuses",
    // #1239: another project's volume is skipped on an empty target, an
    // explicit project's own volume refuses.
    "verify empty target skips another project volume",
    "verify empty target explicit project own volume refuses",
    "verify proven volume without postgres password refuses",
  ]) {
    it(`agrees: ${name}`, () => {
      const golden = readGolden<VerifyGolden>(FLOW, name);
      const dir = makeTarget();
      const password = seedTarget(dir, golden.target);
      const run = () =>
        verifyDatabaseVolumeSafety(
          dir,
          golden.requested ?? undefined,
          TARGET_BASENAME,
          freshState({ targetWasEmpty: golden.targetWasEmpty }),
          password,
          scenarioAdapter(golden.scenario),
        );

      if (golden.bash.status !== 0) {
        expect(golden.bash.status).toBe(1);
        expect(refusalMessage(run)).toBe(golden.bash.stderr);
        return;
      }
      const globals = parseGlobals(golden.bash.stdout);
      expect(run()).toEqual({
        databaseVolumeChecked: globals.database_volume_checked === "1",
        databaseVolumeSeen: globals.database_volume_seen === "1",
        databaseVolumeName: globals.database_volume_name,
        targetWasEmpty: golden.targetWasEmpty,
        composeProjectNameExplicit: globals.compose_project_name_explicit === "1",
        composeProjectName: globals.compose_project_name,
        composeProjectNameProvisional: globals.compose_project_name_provisional === "1",
      });
    });
  }
});

describe("verify_database_volume_safety parity — re-check, guarantee #17 TOCTOU (golden)", () => {
  for (const name of ["recheck same volume still exists", "recheck volume disappeared refuses"]) {
    it(`agrees: ${name}`, () => {
      const golden = readGolden<RecheckGolden>(FLOW, name);
      const state = freshState({
        databaseVolumeChecked: true,
        databaseVolumeSeen: golden.databaseVolumeSeen,
        databaseVolumeName: golden.databaseVolumeName,
      });
      const password: PostgresPasswordFacts = { isRegularNonSymlinkFile: true, mode: 0o600 };
      const run = () =>
        verifyDatabaseVolumeSafety(makeTarget(), undefined, TARGET_BASENAME, state, password, scenarioAdapter(golden.scenario));

      if (golden.bash.status !== 0) {
        expect(golden.bash.status).toBe(1);
        expect(refusalMessage(run)).toBe(golden.bash.stderr);
        return;
      }
      const globals = parseGlobals(golden.bash.stdout);
      expect(run()).toEqual({
        ...state,
        databaseVolumeChecked: globals.database_volume_checked === "1",
        databaseVolumeSeen: globals.database_volume_seen === "1",
        databaseVolumeName: globals.database_volume_name,
      });
    });
  }
});
