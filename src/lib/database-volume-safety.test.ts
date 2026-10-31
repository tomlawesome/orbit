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

  // #1570: Compose's working_dir label may hold the path as the operator typed
  // it (logical) while the installer's `pwd -P` is the physical path, so the
  // update folder is one string or a list of acceptable spellings.
  const PHYSICAL_FOLDER = "/mnt/data/orbit";
  const LOGICAL_FOLDER = "/srv/orbit";
  const labelled = (folder: string) =>
    makeAdapter({
      listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|orbit-db|${folder}`,
      listContainersByProject: () => `${APP_CONTAINER_ID}|${PROJECT}|orbit-app|${folder}`,
    });

  it.each([
    ["the logical path while the physical one differs", LOGICAL_FOLDER, [PHYSICAL_FOLDER, LOGICAL_FOLDER]],
    ["the physical path", PHYSICAL_FOLDER, [PHYSICAL_FOLDER, LOGICAL_FOLDER]],
    ["the logical path, listed first", LOGICAL_FOLDER, [LOGICAL_FOLDER, PHYSICAL_FOLDER]],
    ["the folder with a trailing slash on the label", `${LOGICAL_FOLDER}/`, [PHYSICAL_FOLDER, LOGICAL_FOLDER]],
    ["the folder with a trailing slash on the update folder", LOGICAL_FOLDER, [PHYSICAL_FOLDER, `${LOGICAL_FOLDER}/`]],
    ["the single update folder with a trailing slash on the label", `${UPDATE_FOLDER}/`, UPDATE_FOLDER],
    ["the single update folder with a trailing slash on it", UPDATE_FOLDER, `${UPDATE_FOLDER}/`],
  ])("is proven when the label is %s (#1570)", (_name, label, folders) => {
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, labelled(label), folders)).toEqual({ status: "proven", project: PROJECT });
  });

  it("is not-proven as another folder when the label matches none of the acceptable paths (#1570)", () => {
    const result = evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, labelled(OLD_FOLDER), [PHYSICAL_FOLDER, LOGICAL_FOLDER]);
    expect(result).toMatchObject({ status: "not-proven", reason: "other-folder", folder: OLD_FOLDER });
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

// #1570 (review of the fix, 2026-10-31): a folder that was moved or renamed is
// not another folder. The installer reports, for each distinct
// `com.docker.compose.project.working_dir` label among the project's
// containers, whether that folder exists and its physical path; the adapter
// answers it as `inspectWorkingDir(label)`. A null answer (no such fact) is
// treated as a folder that exists elsewhere, the earlier behaviour.
describe("moved folder versus another folder (#1570)", () => {
  type WorkingDirFact = { exists: boolean; physical: string | null };
  const PHYSICAL = "/mnt/data/orbit";
  const LINK_A = "/srv/link-a";
  const LINK_B = "/srv/link-b";
  const GONE = "/srv/orbit-before-the-move";
  const ELSEWHERE = "/srv/old-orbit";
  const SPELLINGS = [PHYSICAL, LINK_A];
  const COMPOSE_COMMAND = /docker[ -]compose|compose (?:up|down|rm|stop|start|restart|pull)/i;

  const facts = (known: Record<string, WorkingDirFact>) => (label: string): WorkingDirFact | null => known[label] ?? null;
  const missing: WorkingDirFact = { exists: false, physical: null };
  const exists = (physical: string): WorkingDirFact => ({ exists: true, physical });

  /** An adapter whose containers all carry `folder` as their working_dir label. */
  function inFolder(folder: string, known: Record<string, WorkingDirFact>, overrides: Record<string, unknown> = {}) {
    return makeAdapter({
      listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|orbit-db|${folder}`,
      listContainersByProject: () => `${APP_CONTAINER_ID}|${PROJECT}|orbit-app|${folder}`,
      inspectWorkingDir: facts(known),
      ...overrides,
    } as AdapterFixture);
  }

  const evaluate = (adapter: VolumeOwnershipAdapter, folders: string | readonly string[] = SPELLINGS) =>
    evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter, folders);

  describe("a label naming a folder that no longer exists", () => {
    it("does not refuse when the other proofs pass", () => {
      expect(evaluate(inFolder(GONE, { [GONE]: missing }))).toEqual({ status: "proven", project: PROJECT });
    });

    it("does not refuse when only the application container carries the missing label", () => {
      const adapter = inFolder(GONE, { [GONE]: missing }, { listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|orbit-db|${PHYSICAL}` });
      expect(evaluate(adapter)).toEqual({ status: "proven", project: PROJECT });
    });

    it.each([
      ["a container that is not the database mounts the volume", "foreign-container", { listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|some-other-service|${GONE}` }],
      ["no orbit-db container uses the volume", "no-database-container", { listContainersByVolume: () => "" }],
      [
        "two orbit-db containers use the volume",
        "several-database-containers",
        { listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|orbit-db|${GONE}\n${"c".repeat(12)}|${PROJECT}|orbit-db|${GONE}` },
      ],
      ["the project has no orbit-app container", "no-app-container", { listContainersByProject: () => "" }],
      [
        "the project has two orbit-app containers",
        "several-app-containers",
        { listContainersByProject: () => `${APP_CONTAINER_ID}|${PROJECT}|orbit-app|${GONE}\n${"d".repeat(12)}|${PROJECT}|orbit-app|${GONE}` },
      ],
      ["the app container runs another image", "image-mismatch", { inspectContainerImage: () => "ghcr.io/tomlawesome/orbit@sha256:" + "f".repeat(64) }],
    ])("still refuses on its own proof when %s", (_name, reason, overrides) => {
      const result = evaluate(inFolder(GONE, { [GONE]: missing }, overrides));
      expect(result).toMatchObject({ status: "not-proven", reason });
    });

    it("still refuses as another folder when a second container's label names a folder that exists elsewhere", () => {
      const adapter = inFolder(GONE, { [GONE]: missing, [ELSEWHERE]: exists(ELSEWHERE) }, {
        listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|orbit-db|${ELSEWHERE}`,
      });
      expect(evaluate(adapter)).toMatchObject({ status: "not-proven", reason: "other-folder", folder: ELSEWHERE });
    });
  });

  describe("a label whose physical path is the update folder's physical path", () => {
    it("is this folder, though it is a different symlink to it than the update folder's own spelling", () => {
      const adapter = inFolder(LINK_B, { [LINK_B]: exists(PHYSICAL) });
      expect(evaluate(adapter)).toEqual({ status: "proven", project: PROJECT });
    });

    it("is this folder when only the physical path is known for the update", () => {
      const adapter = inFolder(LINK_B, { [LINK_B]: exists(PHYSICAL) });
      expect(evaluate(adapter, [PHYSICAL])).toEqual({ status: "proven", project: PROJECT });
    });

    it("is this folder when the label has a trailing slash and the physical path matches", () => {
      const adapter = inFolder(`${LINK_B}/`, { [`${LINK_B}/`]: exists(PHYSICAL) });
      expect(evaluate(adapter)).toEqual({ status: "proven", project: PROJECT });
    });

    it.each([
      ["the physical spelling", PHYSICAL],
      ["the logical spelling", LINK_A],
    ])("is this folder, as before, when the label equals %s", (_name, label) => {
      expect(evaluate(inFolder(label, { [label]: exists(PHYSICAL) }))).toEqual({ status: "proven", project: PROJECT });
    });

    it("is not this folder when its physical path differs", () => {
      const adapter = inFolder(LINK_B, { [LINK_B]: exists(ELSEWHERE) });
      expect(evaluate(adapter)).toMatchObject({ status: "not-proven", reason: "other-folder" });
    });
  });

  describe("a label naming a folder that exists elsewhere", () => {
    it("refuses with other-folder, naming that folder", () => {
      const adapter = inFolder(ELSEWHERE, { [ELSEWHERE]: exists(ELSEWHERE) });
      expect(evaluate(adapter)).toEqual({ status: "not-proven", reason: "other-folder", folder: ELSEWHERE });
    });

    it("refuses with other-folder even though every other proof passes", () => {
      const adapter = inFolder(ELSEWHERE, { [ELSEWHERE]: exists(ELSEWHERE) }, { inspectContainerImage: () => EXPECTED_IMAGE });
      expect(evaluate(adapter)).toMatchObject({ reason: "other-folder", folder: ELSEWHERE });
    });

    it("refuses with other-folder before the other proofs when they fail too", () => {
      const adapter = inFolder(ELSEWHERE, { [ELSEWHERE]: exists(ELSEWHERE) }, { inspectContainerImage: () => "ghcr.io/tomlawesome/orbit@sha256:" + "f".repeat(64) });
      expect(evaluate(adapter)).toMatchObject({ reason: "other-folder", folder: ELSEWHERE });
    });

    it("is treated the same when the installer sent no fact about the label", () => {
      const adapter = inFolder(ELSEWHERE, {});
      expect(evaluate(adapter)).toMatchObject({ status: "not-proven", reason: "other-folder", folder: ELSEWHERE });
    });
  });

  describe("the refusal the operator reads", () => {
    let targetDir: string;
    beforeEach(() => {
      targetDir = mkdtempSync(join(tmpdir(), "orbit-moved-folder-"));
      writeFileSync(join(targetDir, ".env-orbit"), `ORBIT_IMAGE=${EXPECTED_IMAGE}\n`, { mode: 0o600 });
    });
    afterEach(() => {
      rmSync(targetDir, { recursive: true, force: true });
    });

    const verify = (adapter: VolumeOwnershipAdapter) =>
      verifyDatabaseVolumeSafety(
        targetDir,
        undefined,
        "fallback",
        freshState(),
        readyPassword,
        makeFullAdapter(adapter),
        SPELLINGS,
      );

    it("attaches to the volume of a moved folder when the other proofs pass", () => {
      const result = verify(inFolder(GONE, { [GONE]: missing }));
      expect(result.databaseVolumeSeen).toBe(true);
      expect(result.databaseVolumeName).toBe(CANDIDATE_VOLUME);
    });

    it("attaches to the volume when the label is another symlink to the update folder", () => {
      const result = verify(inFolder(LINK_B, { [LINK_B]: exists(PHYSICAL) }));
      expect(result.databaseVolumeSeen).toBe(true);
    });

    it("names a folder that exists elsewhere and sends the operator there, with no Compose command", () => {
      let message = "";
      try {
        verify(inFolder(ELSEWHERE, { [ELSEWHERE]: exists(ELSEWHERE) }));
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseVolumeSafetyRefusal);
        message = (error as DatabaseVolumeSafetyRefusal).message;
        expect((error as DatabaseVolumeSafetyRefusal).reason).toBe("other-folder");
      }
      expect(message).toContain(ELSEWHERE);
      expect(message).toMatch(/run the update (?:there|in)/i);
      expect(message).not.toMatch(COMPOSE_COMMAND);
    });

    it("says, for an image mismatch, to compare the running container's image with ORBIT_IMAGE in .env-orbit, without a Compose command or a claim that stopping recreates it", () => {
      let message = "";
      try {
        verify(makeAdapter({ inspectContainerImage: () => "ghcr.io/tomlawesome/orbit@sha256:" + "f".repeat(64) }));
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseVolumeSafetyRefusal);
        message = (error as DatabaseVolumeSafetyRefusal).message;
        expect((error as DatabaseVolumeSafetyRefusal).reason).toBe("image-mismatch");
      }
      expect(message).toMatch(/compare[^.]*image[^.]*ORBIT_IMAGE[^.]*\.env-orbit/i);
      expect(message).not.toMatch(/recreat/i);
      expect(message).not.toMatch(COMPOSE_COMMAND);
    });
  });
});

// A deployment taken down keeps its volume and loses both containers: the
// refusal that follows must name the way back, in words and never as a
// Compose command (the standing #1570 rule).
describe("a refusal after the containers were taken down names the way back", () => {
  const COMPOSE_COMMAND = /docker[ -]compose|compose (?:up|down|rm|stop|start|restart|pull)/i;
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "orbit-taken-down-"));
    writeFileSync(join(targetDir, ".env-orbit"), `ORBIT_IMAGE=${EXPECTED_IMAGE}\n`, { mode: 0o600 });
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  function refusalFor(overrides: Partial<DatabaseVolumeSafetyAdapter>): DatabaseVolumeSafetyRefusal {
    try {
      verifyDatabaseVolumeSafety(targetDir, undefined, "fallback", freshState(), readyPassword, makeFullAdapter(overrides));
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseVolumeSafetyRefusal);
      return error as DatabaseVolumeSafetyRefusal;
    }
    throw new Error("no refusal");
  }

  it("says, when no orbit-db container uses the volume, to start the deployment again from its own folder", () => {
    const refusal = refusalFor({ listContainersByVolume: () => "" });
    expect(refusal.reason).toBe("no-database-container");
    expect(refusal.action).toBeTruthy();
    expect(refusal.action).not.toBe("retry");
    expect(refusal.message).toMatch(/start (?:the|this) deployment again/i);
    expect(refusal.message).toMatch(/folder it was installed in/i);
    expect(refusal.message).not.toMatch(COMPOSE_COMMAND);
    expect(refusal.message).not.toMatch(/docker volume rm/);
    expect(refusal.message).toMatch(/orbit-db/);
    expect(refusal.message).toContain(CANDIDATE_VOLUME);
  });

  it.each([
    ["has no containers at all", ""],
    ["has only the database container", `${DB_CONTAINER_ID}|${PROJECT}|orbit-db`],
  ])("says, when the project %s, to start the deployment again from its own folder", (_name, projectLines) => {
    const refusal = refusalFor({ listContainersByProject: () => projectLines });
    expect(refusal.reason).toBe("no-app-container");
    expect(refusal.action).toBeTruthy();
    expect(refusal.action).not.toBe("retry");
    expect(refusal.message).toMatch(/start (?:the|this) deployment again/i);
    expect(refusal.message).toMatch(/folder it was installed in/i);
    expect(refusal.message).not.toMatch(COMPOSE_COMMAND);
    expect(refusal.message).not.toMatch(/docker volume rm/);
    expect(refusal.message).toMatch(/orbit-app/);
  });

  it("keeps the two messages distinct, each still saying it refuses to start Compose", () => {
    const noDatabase = refusalFor({ listContainersByVolume: () => "" });
    const noApp = refusalFor({ listContainersByProject: () => "" });
    expect(noDatabase.message).not.toBe(noApp.message);
    expect(noDatabase.message).toMatch(/refusing to start Compose/);
    expect(noApp.message).toMatch(/refusing to start Compose/);
  });
});

// A plain `docker run` container has no Compose service label; its id is the
// only name the operator can use to find it.
describe("a foreign container on the volume is named by what it has", () => {
  const SERVICELESS_ID = "e".repeat(12);
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "orbit-foreign-container-"));
    writeFileSync(join(targetDir, ".env-orbit"), `ORBIT_IMAGE=${EXPECTED_IMAGE}\n`, { mode: 0o600 });
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  function messageFor(lines: string): string {
    try {
      verifyDatabaseVolumeSafety(targetDir, undefined, "fallback", freshState(), readyPassword, makeFullAdapter({ listContainersByVolume: () => lines }));
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseVolumeSafetyRefusal);
      expect((error as DatabaseVolumeSafetyRefusal).reason).toBe("foreign-container");
      return (error as DatabaseVolumeSafetyRefusal).message;
    }
    throw new Error("no refusal");
  }

  it("carries the container id in the outcome when the container has no service label", () => {
    const adapter = makeAdapter({ listContainersByVolume: () => `${SERVICELESS_ID}|${PROJECT}||` });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toEqual({
      status: "not-proven",
      reason: "foreign-container",
      service: "",
      container: SERVICELESS_ID,
    });
  });

  it("renders the id, not an empty service name, in the refusal", () => {
    const message = messageFor(`${SERVICELESS_ID}|${PROJECT}||`);
    expect(message).toContain(SERVICELESS_ID);
    expect(message).not.toContain('""');
    expect(message).toMatch(/orbit-db/);
    expect(message).toContain("docker ps -a --filter volume=");
  });

  it("still renders the service of a labelled foreign container, and now carries its id too", () => {
    const adapter = makeAdapter({ listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|some-other-service` });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toMatchObject({
      status: "not-proven",
      reason: "foreign-container",
      service: "some-other-service",
      container: DB_CONTAINER_ID,
    });
    expect(messageFor(`${DB_CONTAINER_ID}|${PROJECT}|some-other-service`)).toContain('a container of service "some-other-service"');
  });

  it("keeps the unlabelled and the labelled foreign messages distinct", () => {
    expect(messageFor(`${SERVICELESS_ID}|${PROJECT}||`)).not.toBe(messageFor(`${DB_CONTAINER_ID}|${PROJECT}|some-other-service`));
  });
});

// An update that committed (the saved image now names the new build) and then
// stopped before the containers were replaced leaves the saved image ahead of
// the running one. Its retry is proven on the image recorded beside the saved
// one, not refused.
describe("the proof accepts the image the last committed update replaced", () => {
  const COMPOSE_COMMAND = /docker[ -]compose|compose (?:up|down|rm|stop|start|restart|pull)/i;
  const IMAGE_A = "ghcr.io/tomlawesome/orbit@sha256:" + "1".repeat(64);
  const IMAGE_B = "ghcr.io/tomlawesome/orbit@sha256:" + "2".repeat(64);
  const IMAGE_C = "ghcr.io/tomlawesome/orbit@sha256:" + "3".repeat(64);
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "orbit-previous-image-"));
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  const writeEnvironment = (...lines: string[]) => writeFileSync(join(targetDir, ".env-orbit"), `${lines.join("\n")}\n`, { mode: 0o600 });
  const appRunning = (image: string) => makeFullAdapter({ inspectContainerImage: () => image });
  const verify = (adapter: DatabaseVolumeSafetyAdapter) =>
    verifyDatabaseVolumeSafety(targetDir, undefined, "fallback", freshState(), readyPassword, adapter);
  function refusalFrom(adapter: DatabaseVolumeSafetyAdapter): DatabaseVolumeSafetyRefusal {
    try {
      verify(adapter);
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseVolumeSafetyRefusal);
      return error as DatabaseVolumeSafetyRefusal;
    }
    throw new Error("no refusal");
  }

  it("attaches when the app runs the recorded previous image, and reports the image it accepted", () => {
    writeEnvironment(`ORBIT_IMAGE=${IMAGE_B}`, `ORBIT_PREVIOUS_IMAGE=${IMAGE_A}`);
    const result = verify(appRunning(IMAGE_A));
    expect(result.databaseVolumeSeen).toBe(true);
    expect(result.databaseVolumeName).toBe(CANDIDATE_VOLUME);
    expect(result).toMatchObject({ attachedAppImage: IMAGE_A });
  });

  it("still attaches when the app runs the saved image, and reports that one", () => {
    writeEnvironment(`ORBIT_IMAGE=${IMAGE_B}`, `ORBIT_PREVIOUS_IMAGE=${IMAGE_A}`);
    const result = verify(appRunning(IMAGE_B));
    expect(result.databaseVolumeSeen).toBe(true);
    expect(result).toMatchObject({ attachedAppImage: IMAGE_B });
  });

  it("still refuses a third image, as an image mismatch whose next action is not retry", () => {
    writeEnvironment(`ORBIT_IMAGE=${IMAGE_B}`, `ORBIT_PREVIOUS_IMAGE=${IMAGE_A}`);
    const refusal = refusalFrom(appRunning(IMAGE_C));
    expect(refusal.reason).toBe("image-mismatch");
    expect(refusal.action).not.toBe("retry");
  });

  it("refuses the previous build when nothing recorded it: no record means the earlier behaviour", () => {
    writeEnvironment(`ORBIT_IMAGE=${IMAGE_B}`);
    const refusal = refusalFrom(appRunning(IMAGE_A));
    expect(refusal.reason).toBe("image-mismatch");
    expect(refusal.action).not.toBe("retry");
  });

  it("ignores a record that is not digest-pinned: neither trusted nor a refusal of its own", () => {
    writeEnvironment(`ORBIT_IMAGE=${IMAGE_B}`);
    const withoutRecord = refusalFrom(appRunning(IMAGE_A));
    writeEnvironment(`ORBIT_IMAGE=${IMAGE_B}`, "ORBIT_PREVIOUS_IMAGE=ghcr.io/tomlawesome/orbit:latest");
    const withMalformedRecord = refusalFrom(appRunning(IMAGE_A));
    expect(withMalformedRecord.reason).toBe("image-mismatch");
    expect(withMalformedRecord.message).toBe(withoutRecord.message);
    expect(verify(appRunning(IMAGE_B)).databaseVolumeSeen).toBe(true);
  });

  it("names the interrupted-update cause and the step in the image-mismatch message, without a Compose command", () => {
    writeEnvironment(`ORBIT_IMAGE=${IMAGE_B}`);
    const { message } = refusalFrom(appRunning(IMAGE_A));
    expect(message).toMatch(/earlier update|update that stopped|did not finish/i);
    // "set ORBIT_IMAGE in .env-orbit back to ..." -- the file name carries a dot.
    expect(message).toMatch(/set ORBIT_IMAGE[\s\S]{0,60}?back/i);
    expect(message).toMatch(/compare[^.]*image[^.]*ORBIT_IMAGE[^.]*\.env-orbit/i);
    expect(message).not.toMatch(COMPOSE_COMMAND);
    expect(message).not.toMatch(/recreat/i);
  });

  describe("evaluateVolumeOwnership with a list of accepted images", () => {
    const adapterOn = (image: string) => makeAdapter({ inspectContainerImage: () => image });

    it.each([
      ["the first", IMAGE_A],
      ["the second", IMAGE_B],
    ])("proves the volume, reporting the image that matched, when the app runs %s", (_name, image) => {
      expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, [IMAGE_A, IMAGE_B], adapterOn(image))).toEqual({
        status: "proven",
        project: PROJECT,
        appImage: image,
      });
    });

    it("is not-proven as an image mismatch when the app runs neither", () => {
      expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, [IMAGE_A, IMAGE_B], adapterOn(IMAGE_C))).toMatchObject({
        status: "not-proven",
        reason: "image-mismatch",
      });
    });

    it("behaves as before for a single image given as a string", () => {
      expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, IMAGE_B, adapterOn(IMAGE_B))).toMatchObject({ status: "proven", project: PROJECT });
      expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, IMAGE_B, adapterOn(IMAGE_A))).toMatchObject({
        status: "not-proven",
        reason: "image-mismatch",
      });
    });
  });

  describe("beside another stack's volume (the unrelated-volume skip agrees on what this deployment's image is)", () => {
    const OTHER_PROJECT = "orbit-e2e-local-4242";
    const OTHER_VOLUME = `${OTHER_PROJECT}_orbit-db-data`;
    const OTHER_DB = "d".repeat(12);
    const OTHER_APP = "e".repeat(12);

    function twoStacks(otherAppImage: string, ownAppImage: string): DatabaseVolumeSafetyAdapter {
      return makeFullAdapter({
        listVolumesByKeySubstring: () => `${OTHER_VOLUME}\n${CANDIDATE_VOLUME}`,
        inspectVolumeLabels: (volume) => (volume === OTHER_VOLUME ? `${OTHER_PROJECT}|orbit-db-data` : `${PROJECT}|orbit-db-data`),
        listContainersByVolume: (volume) =>
          volume === OTHER_VOLUME ? `${OTHER_DB}|${OTHER_PROJECT}|orbit-db` : `${DB_CONTAINER_ID}|${PROJECT}|orbit-db`,
        listContainersByProject: (project) =>
          project === OTHER_PROJECT ? `${OTHER_APP}|${OTHER_PROJECT}|orbit-app` : `${APP_CONTAINER_ID}|${PROJECT}|orbit-app`,
        inspectContainerImage: (container) => (container === OTHER_APP ? otherAppImage : ownAppImage),
        inspectVolumeProjectLabel: (volume) => (volume === OTHER_VOLUME ? OTHER_PROJECT : PROJECT),
      });
    }

    beforeEach(() => {
      writeEnvironment(`ORBIT_IMAGE=${IMAGE_B}`, `ORBIT_PREVIOUS_IMAGE=${IMAGE_A}`, `COMPOSE_PROJECT_NAME=${PROJECT}`);
    });

    it("still refuses a genuinely ambiguous pair: the other project's app runs this deployment's previous image", () => {
      expect(() => verify(twoStacks(IMAGE_A, IMAGE_A))).toThrow(/Multiple Orbit database volumes/);
    });

    it("skips the other project's volume when its app runs another image, and attaches to its own on the previous image", () => {
      const result = verify(twoStacks(IMAGE_C, IMAGE_A));
      expect(result.databaseVolumeSeen).toBe(true);
      expect(result.databaseVolumeName).toBe(CANDIDATE_VOLUME);
      expect(result).toMatchObject({ attachedAppImage: IMAGE_A });
    });
  });
});
