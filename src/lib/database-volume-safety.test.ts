import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DatabaseVolumeSafetyRefusal,
  type DatabaseVolumeSafetyAdapter,
  type DatabaseVolumeSafetyState,
  type PostgresPasswordFacts,
  type VolumeOwnershipAdapter,
  evaluateVolumeOwnership,
  verifyDatabaseVolumeSafety,
} from "./database-volume-safety";

// Ported from scripts/install.sh's volume_belongs_to_deployment and
// verify_database_volume_safety (docs/installer-guarantees.md, Part 1 /
// install.sh, guarantees #13-18 — cited by number in test names below). See
// docs/adr-notes/295-install-port-plan.md for the slice this belongs to and
// byte-for-byte decision parity coverage (against a stub docker binary
// shared with the real script) in database-volume-safety.parity.test.ts.

const EXPECTED_IMAGE = "ghcr.io/tomlawesome/orbit@sha256:" + "a".repeat(64);
const CANDIDATE_VOLUME = "orbit_orbit-db-data";
const PROJECT = "orbit";
const DB_CONTAINER_ID = "a".repeat(12);
const APP_CONTAINER_ID = "b".repeat(12);

type AdapterFixture = Partial<VolumeOwnershipAdapter>;

function makeAdapter(overrides: AdapterFixture = {}): VolumeOwnershipAdapter {
  return {
    inspectVolumeLabels: () => `${PROJECT}|orbit-db-data`,
    listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|orbit-db`,
    listContainersByProject: () => `${APP_CONTAINER_ID}|${PROJECT}|orbit-app`,
    inspectContainerImage: () => EXPECTED_IMAGE,
    ...overrides,
  };
}

describe("evaluateVolumeOwnership (guarantees #13, #14)", () => {
  it("proves ownership when every independent check passes", () => {
    const result = evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, makeAdapter());
    expect(result).toEqual({ status: "proven", project: PROJECT });
  });

  it("is a verify-error when the volume-inspect docker call itself fails (#14)", () => {
    const adapter = makeAdapter({ inspectVolumeLabels: () => null });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toEqual({ status: "verify-error" });
  });

  it("is a verify-error when volume labels carry an unexpected extra field (#14 bounds-checking)", () => {
    const adapter = makeAdapter({ inspectVolumeLabels: () => `${PROJECT}|orbit-db-data|unexpected` });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toEqual({ status: "verify-error" });
  });

  it("is a verify-error when the volume key label does not match the expected database volume key", () => {
    const adapter = makeAdapter({ inspectVolumeLabels: () => `${PROJECT}|some-other-volume` });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toEqual({ status: "verify-error" });
  });

  it("is a verify-error when the candidate volume name doesn't equal <project>_<key>", () => {
    const adapter = makeAdapter({ inspectVolumeLabels: () => `other-project|orbit-db-data` });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toEqual({ status: "verify-error" });
  });

  it("is not-proven when no container is attached to the volume", () => {
    const adapter = makeAdapter({ listContainersByVolume: () => "" });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toMatchObject({ status: "not-proven", reason: "no-database-container" });
  });

  it("is not-proven when the container attached to the volume is not the orbit-db service", () => {
    const adapter = makeAdapter({ listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|some-other-service` });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toMatchObject({ status: "not-proven", reason: "foreign-container" });
  });

  it("is not-proven when two containers are attached to the volume (ambiguous)", () => {
    const adapter = makeAdapter({
      listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|orbit-db\n${"c".repeat(12)}|${PROJECT}|orbit-db`,
    });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toMatchObject({ status: "not-proven", reason: "several-database-containers" });
  });

  it("is a verify-error when a db-container id fails the hex-id bounds check (#14)", () => {
    const adapter = makeAdapter({ listContainersByVolume: () => `not-a-hex-id|${PROJECT}|orbit-db` });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toEqual({ status: "verify-error" });
  });

  it("is not-proven when no orbit-app container exists in the project", () => {
    const adapter = makeAdapter({ listContainersByProject: () => "" });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toMatchObject({ status: "not-proven", reason: "no-app-container" });
  });

  it("is not-proven when two orbit-app containers exist in the project (ambiguous)", () => {
    const adapter = makeAdapter({
      listContainersByProject: () =>
        `${APP_CONTAINER_ID}|${PROJECT}|orbit-app\n${"d".repeat(12)}|${PROJECT}|orbit-app`,
    });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toMatchObject({ status: "not-proven", reason: "several-app-containers" });
  });

  it("is a verify-error when the app container's image inspect call fails", () => {
    const adapter = makeAdapter({ inspectContainerImage: () => null });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toEqual({ status: "verify-error" });
  });

  it("is a verify-error when the app container's image is not digest-pinned", () => {
    const adapter = makeAdapter({ inspectContainerImage: () => "ghcr.io/tomlawesome/orbit:latest" });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toEqual({ status: "verify-error" });
  });

  it("is not-proven when the app container's image does not match the expected image", () => {
    const adapter = makeAdapter({
      inspectContainerImage: () => "ghcr.io/tomlawesome/orbit@sha256:" + "f".repeat(64),
    });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toMatchObject({ status: "not-proven", reason: "image-mismatch" });
  });

  // #1570: the working_dir label is an optional fourth field on the container
  // lines (`{{.Label "com.docker.compose.project.working_dir"}}`); the folder
  // the update runs in is an optional fourth argument.
  const UPDATE_FOLDER = "/srv/orbit";
  const OLD_FOLDER = "/srv/old-orbit";

  it("proves ownership when the containers' working_dir label names the folder the update runs in", () => {
    const adapter = makeAdapter({
      listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|orbit-db|${UPDATE_FOLDER}`,
      listContainersByProject: () => `${APP_CONTAINER_ID}|${PROJECT}|orbit-app|${UPDATE_FOLDER}`,
    });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter, UPDATE_FOLDER)).toEqual({ status: "proven", project: PROJECT });
  });

  it.each([
    ["database", { listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|orbit-db|${OLD_FOLDER}` }],
    ["application", { listContainersByProject: () => `${APP_CONTAINER_ID}|${PROJECT}|orbit-app|${OLD_FOLDER}` }],
  ] as const)("is not-proven, naming the other folder, when the %s container belongs to another folder", (_which, overrides) => {
    const result = evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, makeAdapter(overrides), UPDATE_FOLDER);
    expect(result).toMatchObject({ status: "not-proven", reason: "other-folder", folder: OLD_FOLDER });
  });

  it("only inspects the image of the single proven orbit-app container, never a non-matching one", () => {
    const inspected: string[] = [];
    const adapter = makeAdapter({
      inspectContainerImage: (id) => {
        inspected.push(id);
        return EXPECTED_IMAGE;
      },
    });
    evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter);
    expect(inspected).toEqual([APP_CONTAINER_ID]);
  });
});

function makeFullAdapter(overrides: Partial<DatabaseVolumeSafetyAdapter> = {}): DatabaseVolumeSafetyAdapter {
  return {
    ...makeAdapter(),
    listVolumesExactName: () => CANDIDATE_VOLUME,
    listVolumesByKeySubstring: () => CANDIDATE_VOLUME,
    inspectVolumeProjectLabel: () => PROJECT,
    ...overrides,
  };
}

const readyPassword: PostgresPasswordFacts = { isRegularNonSymlinkFile: true, mode: 0o600 };

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

describe("verifyDatabaseVolumeSafety re-check path (guarantee #17, TOCTOU)", () => {
  it("is a no-op once checked if no volume was ever seen", () => {
    const state = freshState({ databaseVolumeChecked: true, databaseVolumeSeen: false });
    let called = false;
    const adapter = makeFullAdapter({ listVolumesExactName: () => ((called = true), CANDIDATE_VOLUME) });
    const result = verifyDatabaseVolumeSafety(
      "/unused",
      undefined,
      "unused",
      state,
      readyPassword,
      adapter,
    );
    expect(result).toEqual(state);
    expect(called).toBe(false);
  });

  it("re-verifies the exact same single volume still exists once seen", () => {
    const state = freshState({
      databaseVolumeChecked: true,
      databaseVolumeSeen: true,
      databaseVolumeName: CANDIDATE_VOLUME,
    });
    const adapter = makeFullAdapter();
    const result = verifyDatabaseVolumeSafety("/unused", undefined, "unused", state, readyPassword, adapter);
    expect(result).toEqual(state);
  });

  it("refuses if the recognized volume disappeared or changed mid-run", () => {
    const state = freshState({
      databaseVolumeChecked: true,
      databaseVolumeSeen: true,
      databaseVolumeName: CANDIDATE_VOLUME,
    });
    const adapter = makeFullAdapter({ listVolumesExactName: () => "" });
    expect(() => verifyDatabaseVolumeSafety("/unused", undefined, "unused", state, readyPassword, adapter)).toThrow(
      /changed during installation/,
    );
  });

  it("refuses if the re-check docker call itself fails", () => {
    const state = freshState({
      databaseVolumeChecked: true,
      databaseVolumeSeen: true,
      databaseVolumeName: CANDIDATE_VOLUME,
    });
    const adapter = makeFullAdapter({ listVolumesExactName: () => null });
    expect(() => verifyDatabaseVolumeSafety("/unused", undefined, "unused", state, readyPassword, adapter)).toThrow(
      DatabaseVolumeSafetyRefusal,
    );
  });
});

describe("verifyDatabaseVolumeSafety fresh-check path (guarantees #15, #16, #18)", () => {
  // Scenarios that reach install.sh's `old_image="$(read_environment_value
  // ORBIT_IMAGE)"` step need a real target directory with a readable
  // .env-orbit carrying the expected (previously recorded) digest-pinned
  // image; scenarios that refuse before that step (empty target, multiple
  // candidates, malformed candidate name) don't and use a placeholder path.
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "orbit-database-volume-safety-"));
    writeFileSync(join(targetDir, ".env-orbit"), `ORBIT_IMAGE=${EXPECTED_IMAGE}\n`, { mode: 0o600 });
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("marks checked with no refusal when no candidate volumes exist", () => {
    const adapter = makeFullAdapter({ listVolumesByKeySubstring: () => "" });
    const result = verifyDatabaseVolumeSafety("/unused", undefined, "fallback", freshState(), readyPassword, adapter);
    expect(result.databaseVolumeChecked).toBe(true);
    expect(result.databaseVolumeSeen).toBe(false);
  });

  it("refuses an existing volume against an otherwise-empty target (#15)", () => {
    const adapter = makeFullAdapter();
    expect(() =>
      verifyDatabaseVolumeSafety(
        "/unused",
        undefined,
        "fallback",
        freshState({ targetWasEmpty: true }),
        readyPassword,
        adapter,
      ),
    ).toThrow(/preserved database credentials/);
  });

  it("refuses when more than one candidate volume is found (#16)", () => {
    const adapter = makeFullAdapter({
      listVolumesByKeySubstring: () => `${CANDIDATE_VOLUME}\nother_orbit-db-data`,
    });
    expect(() =>
      verifyDatabaseVolumeSafety("/unused", undefined, "fallback", freshState(), readyPassword, adapter),
    ).toThrow(/Multiple Orbit database volumes/);
  });

  it("refuses when a candidate volume name fails the naming/suffix bounds check", () => {
    const adapter = makeFullAdapter({ listVolumesByKeySubstring: () => "not a valid name_orbit-db-data" });
    expect(() =>
      verifyDatabaseVolumeSafety("/unused", undefined, "fallback", freshState(), readyPassword, adapter),
    ).toThrow(DatabaseVolumeSafetyRefusal);
  });

  // #1570: each failed proof refuses with its own plain message that names the
  // fact that did not match and what the operator can do, and with a next
  // action other than "retry" (a retry cannot change any of these facts).
  const GENERIC_NOT_PROVEN =
    "Could not prove that the existing Orbit database volume belongs to this Orbit deployment; refusing to start Compose.";
  const UPDATE_FOLDER = "/srv/orbit";
  const OLD_FOLDER = "/srv/old-orbit";
  const REMEDY = /\b(?:run|check|remove|stop|restore|set|use|start|inspect|detach)\b/i;
  const SECOND_DB = `${"c".repeat(12)}|${PROJECT}|orbit-db`;
  const SECOND_APP = `${"d".repeat(12)}|${PROJECT}|orbit-app`;

  interface ProofCase {
    name: string;
    reason: string;
    overrides: Partial<DatabaseVolumeSafetyAdapter>;
    updateFolder?: string;
    facts: RegExp[];
  }
  const proofCases: ProofCase[] = [
    {
      name: "a container that is not the database mounts the volume",
      reason: "foreign-container",
      overrides: { listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|some-other-service` },
      facts: [/some-other-service/, /orbit-db/],
    },
    {
      name: "no orbit-db container uses the volume",
      reason: "no-database-container",
      overrides: { listContainersByVolume: () => "" },
      facts: [/orbit-db/],
    },
    {
      name: "more than one orbit-db container uses the volume",
      reason: "several-database-containers",
      overrides: { listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|orbit-db\n${SECOND_DB}` },
      facts: [/orbit-db/, /more than one|several|two|2/i],
    },
    {
      name: "the project has no orbit-app container",
      reason: "no-app-container",
      overrides: { listContainersByProject: () => "" },
      facts: [/orbit-app/],
    },
    {
      name: "the project has more than one orbit-app container",
      reason: "several-app-containers",
      overrides: { listContainersByProject: () => `${APP_CONTAINER_ID}|${PROJECT}|orbit-app\n${SECOND_APP}` },
      facts: [/orbit-app/, /more than one|several|two|2/i],
    },
    {
      name: "the app container's image differs from ORBIT_IMAGE in .env-orbit",
      reason: "image-mismatch",
      overrides: { inspectContainerImage: () => "ghcr.io/tomlawesome/orbit@sha256:" + "f".repeat(64) },
      facts: [/ORBIT_IMAGE/, /\.env-orbit/],
    },
    {
      name: "the containers belong to another folder",
      reason: "other-folder",
      overrides: {
        listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|orbit-db|${OLD_FOLDER}`,
        listContainersByProject: () => `${APP_CONTAINER_ID}|${PROJECT}|orbit-app|${OLD_FOLDER}`,
      },
      updateFolder: UPDATE_FOLDER,
      facts: [new RegExp(OLD_FOLDER), /run the update (?:there|in)/i],
    },
  ];

  function refusalFor(testCase: ProofCase): DatabaseVolumeSafetyRefusal {
    try {
      verifyDatabaseVolumeSafety(
        targetDir,
        undefined,
        "fallback",
        freshState(),
        readyPassword,
        makeFullAdapter(testCase.overrides),
        testCase.updateFolder,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseVolumeSafetyRefusal);
      return error as DatabaseVolumeSafetyRefusal;
    }
    throw new Error(`no refusal for: ${testCase.name}`);
  }

  it.each(proofCases)("refuses with its own message and a next action that is not retry when $name (#1570)", (testCase) => {
    const refusal = refusalFor(testCase);
    expect(refusal.message).not.toBe(GENERIC_NOT_PROVEN);
    expect(refusal.message).toMatch(/refusing to start Compose/);
    for (const fact of testCase.facts) expect(refusal.message).toMatch(fact);
    expect(refusal.message).toMatch(REMEDY);
    expect(refusal.reason).toBe(testCase.reason);
    expect(refusal.action).toBeTruthy();
    expect(refusal.action).not.toBe("retry");
  });

  it("gives every failed proof a message and a reason of its own (#1570)", () => {
    const refusals = proofCases.map(refusalFor);
    expect(new Set(refusals.map((refusal) => refusal.message)).size).toBe(proofCases.length);
    expect(new Set(refusals.map((refusal) => refusal.reason)).size).toBe(proofCases.length);
  });

  it("names the other folder, tells the operator to run the update there, and never suggests a Compose command (#1570)", () => {
    const message = refusalFor(proofCases[proofCases.length - 1]).message;
    expect(message).toContain(OLD_FOLDER);
    expect(message).not.toMatch(/docker[ -]compose/i);
    expect(message).not.toMatch(/compose (?:up|down|rm|stop|start|restart|pull)/i);
  });

  it("still attaches when the containers' working_dir label names the folder the update runs in (#1570)", () => {
    const adapter = makeFullAdapter({
      listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|orbit-db|${UPDATE_FOLDER}`,
      listContainersByProject: () => `${APP_CONTAINER_ID}|${PROJECT}|orbit-app|${UPDATE_FOLDER}`,
    });
    const result = verifyDatabaseVolumeSafety(targetDir, undefined, "fallback", freshState(), readyPassword, adapter, UPDATE_FOLDER);
    expect(result.databaseVolumeSeen).toBe(true);
    expect(result.databaseVolumeName).toBe(CANDIDATE_VOLUME);
  });

  it("refuses when ownership verification itself fails", () => {
    const adapter = makeFullAdapter({ inspectVolumeLabels: () => null });
    expect(() =>
      verifyDatabaseVolumeSafety(targetDir, undefined, "fallback", freshState(), readyPassword, adapter),
    ).toThrow(/Could not verify the existing Orbit database volume ownership/);
  });

  it("refuses when the discovered project label is unreadable or malformed", () => {
    const adapter = makeFullAdapter({ inspectVolumeProjectLabel: () => null });
    expect(() =>
      verifyDatabaseVolumeSafety(targetDir, undefined, "fallback", freshState(), readyPassword, adapter),
    ).toThrow(/Could not verify the existing Orbit database volume ownership/);
  });

  it("refuses when the discovered project conflicts with an explicitly requested Compose project", () => {
    // requestedComposeProjectName flows through deriveComposeProjectName
    // (guarantee #12) to become this call's compose_project_name_explicit=1
    // — verifyDatabaseVolumeSafety only ever derives it fresh, matching
    // install.sh's single call site (see database-volume-safety.ts's
    // module comment on derive_compose_project_name's dead re-entry branch).
    const adapter = makeFullAdapter();
    expect(() =>
      verifyDatabaseVolumeSafety(targetDir, "different-project", "fallback", freshState(), readyPassword, adapter),
    ).toThrow(/does not match the recognized database volume/);
  });

  it("refuses when the preserved postgres-password secret is missing or loosely permissioned (#18)", () => {
    const adapter = makeFullAdapter();
    expect(() =>
      verifyDatabaseVolumeSafety(
        targetDir,
        undefined,
        "fallback",
        freshState(),
        { isRegularNonSymlinkFile: false, mode: null },
        adapter,
      ),
    ).toThrow(/preserved POSTGRES_PASSWORD_FILE/);
  });

  it("attaches successfully when every check passes, recording the discovered project and volume name", () => {
    // install.sh:573 assigns compose_project_name from the discovered
    // volume label but never sets compose_project_name_explicit=1 there —
    // with no configured file value or requested override, derive's own
    // fallback-basename branch already left it 0, and attaching does not
    // change that.
    const adapter = makeFullAdapter();
    const result = verifyDatabaseVolumeSafety(targetDir, undefined, "fallback", freshState(), readyPassword, adapter);
    expect(result).toEqual({
      databaseVolumeChecked: true,
      databaseVolumeSeen: true,
      databaseVolumeName: CANDIDATE_VOLUME,
      targetWasEmpty: false,
      composeProjectNameExplicit: false,
      composeProjectName: PROJECT,
      // install.sh:659: the project that owns a proven volume is the
      // deployment's real identity, so #999's later re-derivation must never
      // replace it -- it is never provisional, however it was derived.
      composeProjectNameProvisional: false,
    });
  });

  it("preserves an already-explicit compose project name (from a matching requested override) through a successful attach", () => {
    const adapter = makeFullAdapter();
    const result = verifyDatabaseVolumeSafety(targetDir, PROJECT, "fallback", freshState(), readyPassword, adapter);
    expect(result.composeProjectNameExplicit).toBe(true);
    expect(result.composeProjectName).toBe(PROJECT);
  });
});

describe("verifyDatabaseVolumeSafety on an update beside another stack's volume (#1261)", () => {
  // An update keeps the host-wide search (#1239): a renamed project is only
  // provable by the volume's labels. But a volume labelled with another
  // Compose project, which the ownership proof does not tie to this
  // deployment, is another stack's and must not block the update -- the
  // 2026-10-06 lifecycle run refused on a leftover local e2e volume.
  const OTHER_PROJECT = "orbit-e2e-local-4242";
  const OTHER_VOLUME = `${OTHER_PROJECT}_orbit-db-data`;
  const OTHER_IMAGE = "ghcr.io/tomlawesome/orbit@sha256:" + "f".repeat(64);
  const OTHER_DB = "d".repeat(12);
  const OTHER_APP = "e".repeat(12);
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "orbit-database-volume-safety-1261-"));
    writeFileSync(join(targetDir, ".env-orbit"), `ORBIT_IMAGE=${EXPECTED_IMAGE}\nCOMPOSE_PROJECT_NAME=${PROJECT}\n`, { mode: 0o600 });
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  /** Two stacks on one host: this deployment's, and another project's whose app runs `otherImage`. */
  function twoStacks(otherImage: string, overrides: Partial<DatabaseVolumeSafetyAdapter> = {}): DatabaseVolumeSafetyAdapter {
    return makeFullAdapter({
      listVolumesByKeySubstring: () => `${OTHER_VOLUME}\n${CANDIDATE_VOLUME}`,
      inspectVolumeLabels: (volume) => (volume === OTHER_VOLUME ? `${OTHER_PROJECT}|orbit-db-data` : `${PROJECT}|orbit-db-data`),
      listContainersByVolume: (volume) =>
        volume === OTHER_VOLUME ? `${OTHER_DB}|${OTHER_PROJECT}|orbit-db` : `${DB_CONTAINER_ID}|${PROJECT}|orbit-db`,
      listContainersByProject: (project) =>
        project === OTHER_PROJECT ? `${OTHER_APP}|${OTHER_PROJECT}|orbit-app` : `${APP_CONTAINER_ID}|${PROJECT}|orbit-app`,
      inspectContainerImage: (container) => (container === OTHER_APP ? otherImage : EXPECTED_IMAGE),
      inspectVolumeProjectLabel: (volume) => (volume === OTHER_VOLUME ? OTHER_PROJECT : PROJECT),
      ...overrides,
    });
  }

  it("skips another project's volume that the proof does not tie to this deployment, and attaches to its own", () => {
    const result = verifyDatabaseVolumeSafety(targetDir, undefined, "fallback", freshState(), readyPassword, twoStacks(OTHER_IMAGE));
    expect(result.databaseVolumeSeen).toBe(true);
    expect(result.databaseVolumeName).toBe(CANDIDATE_VOLUME);
    expect(result.composeProjectName).toBe(PROJECT);
  });

  it("proceeds with no volume when the only one on the host is another project's", () => {
    const adapter = twoStacks(OTHER_IMAGE, { listVolumesByKeySubstring: () => OTHER_VOLUME });
    const result = verifyDatabaseVolumeSafety(targetDir, undefined, "fallback", freshState(), readyPassword, adapter);
    expect(result.databaseVolumeChecked).toBe(true);
    expect(result.databaseVolumeSeen).toBe(false);
  });

  it("still refuses a genuinely ambiguous pair: the other project's app runs this deployment's own image", () => {
    expect(() =>
      verifyDatabaseVolumeSafety(targetDir, undefined, "fallback", freshState(), readyPassword, twoStacks(EXPECTED_IMAGE)),
    ).toThrow(/Multiple Orbit database volumes/);
  });

  it("still counts a volume whose labels cannot be read", () => {
    const adapter = twoStacks(OTHER_IMAGE, {
      inspectVolumeLabels: (volume) => (volume === OTHER_VOLUME ? null : `${PROJECT}|orbit-db-data`),
    });
    expect(() => verifyDatabaseVolumeSafety(targetDir, undefined, "fallback", freshState(), readyPassword, adapter)).toThrow(
      /Multiple Orbit database volumes/,
    );
  });

  it("keeps the broad search when the deployment's project name is only a guess", () => {
    writeFileSync(join(targetDir, ".env-orbit"), `ORBIT_IMAGE=${EXPECTED_IMAGE}\n`, { mode: 0o600 });
    expect(() =>
      verifyDatabaseVolumeSafety(targetDir, undefined, "fallback", freshState(), readyPassword, twoStacks(OTHER_IMAGE)),
    ).toThrow(/Multiple Orbit database volumes/);
  });
});
