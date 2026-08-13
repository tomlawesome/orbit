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
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toEqual({ status: "not-proven" });
  });

  it("is not-proven when the container attached to the volume is not the orbit-db service", () => {
    const adapter = makeAdapter({ listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|some-other-service` });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toEqual({ status: "not-proven" });
  });

  it("is not-proven when two containers are attached to the volume (ambiguous)", () => {
    const adapter = makeAdapter({
      listContainersByVolume: () => `${DB_CONTAINER_ID}|${PROJECT}|orbit-db\n${"c".repeat(12)}|${PROJECT}|orbit-db`,
    });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toEqual({ status: "not-proven" });
  });

  it("is a verify-error when a db-container id fails the hex-id bounds check (#14)", () => {
    const adapter = makeAdapter({ listContainersByVolume: () => `not-a-hex-id|${PROJECT}|orbit-db` });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toEqual({ status: "verify-error" });
  });

  it("is not-proven when no orbit-app container exists in the project", () => {
    const adapter = makeAdapter({ listContainersByProject: () => "" });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toEqual({ status: "not-proven" });
  });

  it("is not-proven when two orbit-app containers exist in the project (ambiguous)", () => {
    const adapter = makeAdapter({
      listContainersByProject: () =>
        `${APP_CONTAINER_ID}|${PROJECT}|orbit-app\n${"d".repeat(12)}|${PROJECT}|orbit-app`,
    });
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toEqual({ status: "not-proven" });
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
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, adapter)).toEqual({ status: "not-proven" });
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

  it("refuses when ownership cannot be proven", () => {
    const adapter = makeFullAdapter({ listContainersByVolume: () => "" });
    expect(() =>
      verifyDatabaseVolumeSafety(targetDir, undefined, "fallback", freshState(), readyPassword, adapter),
    ).toThrow(/Could not prove/);
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
    });
  });

  it("preserves an already-explicit compose project name (from a matching requested override) through a successful attach", () => {
    const adapter = makeFullAdapter();
    const result = verifyDatabaseVolumeSafety(targetDir, PROJECT, "fallback", freshState(), readyPassword, adapter);
    expect(result.composeProjectNameExplicit).toBe(true);
    expect(result.composeProjectName).toBe(PROJECT);
  });
});
