// scripts/install.sh, the bootstrap shell around the install engine (#1212):
// one part of the suite that used to be scripts/install.test.mjs, split so the
// parts run in parallel (#1377). Fixtures and helpers: install-test-support.mjs.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import {
  repositoryRoot,
  makeTarget,
  makePreprovisionedDeployment,
  targetEntries,
  stagingLeftovers,
  readOptional,
  runInstall,
  recognisedVolume,
  terminalFailure,
  treeSnapshot,
  recoveryFixture,
  allThreeVolumes,
  scratchDir,
  runInstallSignalled,
  privateStateFixture,
  filesNamed,
  directoriesNamed,
  rollbackEntries,
  unwritableHome,
  personNotes,
  expectFolderPutBack,
  expectMovedAside,
  emptyFolderCommit,
  engineWritten,
  committedCanned,
  backupsName,
  stampPattern,
  failClosing,
  interruptClosing,
  expectNoRecoveryField,
  expectNoCommand,
  expectNoForbiddenWords,
  backupsDir,
  backups,
  modeOf,
  onlyStamp,
  ownTree,
  originalsIn,
  closingLine,
  stampAt,
  personNotesWrite,
  r5DownFailedKnobs,
  expectNothingPrivate,
} from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

describe("install.sh: an interrupt while the engine runs (O-R4)", () => {
  it("SIGTERM after the engine committed a fresh install: the folder is put back, the engine's files are removed rather than moved aside, the copy is released, and the next run is a fresh install", async () => {
    // Redesign r1 test 3: privateStateFixture, so the state root is known.
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_ENGINE_HANG_AFTER: "1" },
      { signal: "SIGTERM", marker: "hung-engine" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.status).not.toBe(0);
    expect(result.status).toBe(143);
    expect(targetEntries(targetDir)).toEqual([".env-orbit", ".orbit-secrets"]);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(result.stderr).not.toContain("did not write");
    expect(directoriesNamed(stateRoot, "added")).toEqual([]);
    expect(filesNamed(stateRoot, [".env-orbit"])).toEqual([]);

    const retried = runInstall(targetDir, environment);
    expect(retried.stderr).not.toMatch(/not empty|Refusing to install here|requires a recognized/u);
    expect(retried.status).toBe(0);
    expect(retried.stdout).toContain("Orbit is ready.");
  });

  it("SIGTERM while the engine runs, before it commits: the folder and the original files are unchanged", async () => {
    const { targetDir, environment, before } = recoveryFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_ENGINE_HANG_BEFORE: "1" },
      { signal: "SIGTERM", marker: "hung-engine" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.status).not.toBe(0);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(runInstall(targetDir, environment).status).toBe(0);
  });
});

// O-S4 as redesigned (r1): the rollback runs when the engine dies without a
// result, restores from the copy, then releases it (keeping the copy for ever
// after a verified restore was O-S4-FR1).
describe("install.sh: an engine killed hard on a fresh install is rolled back (O-S4, redesign r1)", () => {
  // Redesign r2 T6 (replaces r1's half-commit test): the engine's journal names what it may have written, and a person's file is moved aside.
  it("engine exits 137 with no outcome after a half commit: the folder is put back, staging and lock removed, the person's file moved aside and the copy released (redesign r5)", () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_ENGINE_EXIT: "137",
      FAKE_ENGINE_WRITTEN: engineWritten,
      FAKE_ENGINE_LEAVES: JSON.stringify({
        ".orbit-install-staging.test/x": "half-written staging file\n",
        ".orbit-engine.lock": "",
        "docker-compose.yml": "services: {}\n",
        "scripts/orbit-ops.sh": "#!/bin/sh\n",
        ".env-orbit": "APP_URL=https://overwritten-by-a-half-commit.internal\n",
      }),
      FAKE_ENGINE_PERSON_WRITES: JSON.stringify({ path: "notes.txt", content: personNotes }),
    });
    expect(result.status).toBe(1);
    expectFolderPutBack(result, targetDir, before);
    expect(stagingLeftovers(targetDir)).toEqual([]);
    expect(existsSync(join(targetDir, ".orbit-engine.lock"))).toBe(false);
    const kept = expectMovedAside(result, targetDir, "notes.txt", personNotes);
    expect(result.stderr).toContain("stopped without reporting a result (docker run exit status 137)");
    expect(result.stderr).toContain("This install was rolled back");
    expect(result.stderr).not.toContain("staging directory");
    // Redesign r5: the copy is released after a verified restore; the engine's files are removed, not kept.
    const stamp = dirname(dirname(kept));
    expect(existsSync(join(stamp, "originals"))).toBe(false);
    expect(filesNamed(backupsDir(targetDir), [".env-orbit", "oidc-client-secret", "docker-compose.yml", "orbit-ops.sh"])).toEqual([]);
    expect(filesNamed(stateRoot, [".env-orbit", "notes.txt"])).toEqual([]);
  });

  it("engine exits 137 with no outcome, nothing written: the folder is unchanged and the copy released", () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, { ...environment, FAKE_ENGINE_EXIT: "137" });
    expect(result.status).toBe(1);
    expect(treeSnapshot(targetDir)).toEqual(before);
    // Redesign r5: the copy lived in the folder and is gone with its folders.
    expect(backups(targetDir)).toEqual([]);
    expect(filesNamed(stateRoot, [".env-orbit", "oidc-client-secret"])).toEqual([]);
    expect(result.stderr).not.toContain("staging directory");
  });

  it("guard: engine exits 137 with no outcome on an update: the folder is unchanged and nothing claims a rollback", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    const before = treeSnapshot(targetDir);
    const own = recognisedVolume("orbit");
    const result = runInstall(
      targetDir,
      { FAKE_VOLUMES: own.volume, FAKE_PS: JSON.stringify(own.ps), FAKE_CONTAINER_IMAGES: JSON.stringify(own.images), FAKE_ENGINE_EXIT: "137" },
      ["--update"],
    );
    expect(result.status).toBe(1);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(result.stderr).toContain("A hard interruption leaves its staging directory for review");
    expect(result.stderr).not.toContain("rolled back");
  });
});

describe("install.sh: an interrupt while the engine runs, empty folder (redesign r1)", () => {
  it("SIGTERM after the engine committed: the folder is empty again, the output says it was rolled back, and a rerun installs", async () => {
    const targetDir = makeTarget();
    const stateDir = scratchDir("state");
    const xdg = scratchDir("xdg");
    const stateRoot = join(xdg, "orbit");
    const result = await runInstallSignalled(
      targetDir,
      { ...emptyFolderCommit(), FAKE_STATE_DIR: stateDir, XDG_STATE_HOME: xdg, FAKE_ENGINE_HANG_AFTER: "1" },
      { signal: "SIGTERM", marker: "hung-engine" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.status).not.toBe(0);
    expect(targetEntries(targetDir)).toEqual([]);
    expect(result.stderr).toContain("was rolled back");
    expect(result.stderr).toContain("You can install again");
    expect(result.stderr).not.toContain("did not write");
    expect(result.stderr).not.toContain("Move these out");
    expect(result.stderr).not.toContain("could not be fully rolled back");
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /u);
    expect(rollbackEntries(stateRoot)).toEqual([]);

    const retried = runInstall(targetDir, { ...emptyFolderCommit(), XDG_STATE_HOME: xdg });
    expect(retried.status).toBe(0);
    expect(retried.stdout).toContain("Orbit is ready.");
  });

  it("guard: SIGTERM before the engine committed: the folder stays empty and a rerun installs", async () => {
    const targetDir = makeTarget();
    const stateDir = scratchDir("state");
    const xdg = scratchDir("xdg");
    const result = await runInstallSignalled(
      targetDir,
      { ...emptyFolderCommit(), FAKE_STATE_DIR: stateDir, XDG_STATE_HOME: xdg, FAKE_ENGINE_HANG_BEFORE: "1" },
      { signal: "SIGTERM", marker: "hung-engine" },
    );
    expect(result.signalSent).toBe(true);
    expect(targetEntries(targetDir)).toEqual([]);
    expect(runInstall(targetDir, { ...emptyFolderCommit(), XDG_STATE_HOME: xdg }).status).toBe(0);
  });
});

describe("install.sh: a file saved while the engine runs survives an interrupt (redesign r2)", () => {
  const personWrites = { FAKE_ENGINE_PERSON_WRITES: JSON.stringify({ path: "notes.txt", content: personNotes }) };

  it("B22 (T1 re-homed): SIGTERM after the real engine committed: the folder is put back, the person's file moved into <stamp>/moved, the engine's files removed, the copy released, and a rerun installs", async () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, ...personWrites, FAKE_ENGINE_HANG_AFTER: "1" },
      { signal: "SIGTERM", marker: "hung-engine" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.status).toBe(143);
    expectFolderPutBack(result, targetDir, before);
    const kept = expectMovedAside(result, targetDir, "notes.txt", personNotes);
    expect(existsSync(join(dirname(dirname(kept)), "originals"))).toBe(false);
    // Section 13.2: the EXIT trap's closing line, on an interrupt.
    const closing = result.stderr.split("\n").find((line) => line.includes("The install stopped before it finished (interrupted"));
    expect(closing).toBeDefined();
    expect(closing).toContain("and was rolled back: the folder is as it was before");
    expect(closing.endsWith(interruptClosing)).toBe(true);
    expect(result.stderr).not.toContain(failClosing);
    expect(filesNamed(backupsDir(targetDir), ["docker-compose.yml", "orbit-ops.sh"])).toEqual([]);
    expect(filesNamed(stateRoot, ["notes.txt", "docker-compose.yml", "scripts"])).toEqual([]);

    const retried = runInstall(targetDir, environment);
    expect(retried.status).toBe(0);
    expect(retried.stdout).toContain("Orbit is ready.");
  });

  it("T2: SIGTERM before the real engine commits: the person's file is moved aside, the folder put back, and a rerun installs", async () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, ...personWrites, FAKE_ENGINE_HANG_BEFORE: "1" },
      { signal: "SIGTERM", marker: "hung-engine" },
    );
    expect(result.signalSent).toBe(true);
    expectMovedAside(result, targetDir, "notes.txt", personNotes);
    expectFolderPutBack(result, targetDir, before);
    expect(filesNamed(stateRoot, ["notes.txt"])).toEqual([]);
    expect(runInstall(targetDir, environment).status).toBe(0);
  });

});

describe("install.sh: a file saved while the engine ran survives a failed start (redesign r2)", () => {
  it("T5: the real engine completes, the person saves a file, compose up fails: the folder is put back, the file moved aside, the engine's files removed", () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_ENGINE_PERSON_WRITES: JSON.stringify({ path: "notes.txt", content: personNotes }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    expectFolderPutBack(result, targetDir, before);
    expectMovedAside(result, targetDir, "notes.txt", personNotes);
    expect(filesNamed(backupsDir(targetDir), ["docker-compose.yml", "orbit-ops.sh"])).toEqual([]);
    expect(filesNamed(stateRoot, ["notes.txt", "docker-compose.yml", "scripts"])).toEqual([]);
  });
});

describe("install.sh: an engine killed hard, by what its journal says (redesign r2)", () => {
  it("T7: no journal, only staging and the lock left: both removed by their fixed names, the folder put back, nothing moved, the copy released", () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_ENGINE_EXIT: "137",
      FAKE_ENGINE_LEAVES: JSON.stringify({
        ".orbit-install-staging.test/x": "half-written staging file\n",
        ".orbit-engine.lock": "",
      }),
    });
    expect(result.status).toBe(1);
    expect(stagingLeftovers(targetDir)).toEqual([]);
    expect(existsSync(join(targetDir, ".orbit-engine.lock"))).toBe(false);
    expectFolderPutBack(result, targetDir, before);
    // Redesign r5: nothing moved and the copy released, so no orbit-install-backups is left.
    expect(existsSync(backupsDir(targetDir))).toBe(false);
    expect(filesNamed(stateRoot, [".env-orbit"])).toEqual([]);
    expect(result.stderr).toContain("This install was rolled back");
  });

  it.each([
    ["a name that climbs out of the folder", "../x\ndocker-compose.yml"],
    // Redesign r5 (section 2): a slash is now allowed (full relative paths), so this row is a `.` component instead.
    ["a `.` component", "./docker-compose.yml\ndocker-compose.yml"],
  ])("T8: a journal with %s is rejected: docker-compose.yml is moved aside, not deleted, and the folder put back", (_label, written) => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_ENGINE_EXIT: "137",
      FAKE_ENGINE_WRITTEN: written,
      FAKE_ENGINE_LEAVES: JSON.stringify({ "docker-compose.yml": "services: {}\n" }),
    });
    expect(result.status).toBe(1);
    expectMovedAside(result, targetDir, "docker-compose.yml", "services: {}\n");
    expectFolderPutBack(result, targetDir, before);
    expect(filesNamed(stateRoot, ["docker-compose.yml"])).toEqual([]);
    // Redesign r3 U6, in r4 N11's wording: the missing (here, rejected) journal is named.
    expect(result.stderr).toContain("did not record which files it wrote");
    expectNoRecoveryField(result.stdout);
  });

  it("T9: an older image writes no journal: staging is removed, docker-compose.yml moved aside, the folder put back, and the copy released (redesign r5)", () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_ENGINE_EXIT: "137",
      FAKE_ENGINE_LEAVES: JSON.stringify({
        "docker-compose.yml": "services: {}\n",
        ".orbit-install-staging.test/x": "half-written staging file\n",
      }),
    });
    expect(result.status).toBe(1);
    expect(stagingLeftovers(targetDir)).toEqual([]);
    const kept = expectMovedAside(result, targetDir, "docker-compose.yml", "services: {}\n");
    expectFolderPutBack(result, targetDir, before);
    expect(existsSync(join(dirname(dirname(kept)), "originals"))).toBe(false);
    expect(filesNamed(stateRoot, [".env-orbit", "docker-compose.yml"])).toEqual([]);
    // Redesign r3 U6, in r4 N11's wording: the missing journal is named.
    expect(result.stderr).toContain("did not record which files it wrote");
    expectNoRecoveryField(result.stdout);
  });
});

describe("install.sh: the rollback states its rule for .env-orbit and .orbit-secrets (redesign r3)", () => {
  it("U1: a file added to .orbit-secrets while the engine ran is replaced with the folder, and the rule is stated", () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      ...committedCanned(),
      FAKE_ENGINE_PERSON_WRITES: JSON.stringify({ path: ".orbit-secrets/extra-secret", content: "added while the engine ran\n" }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /u);
    expect(treeSnapshot(targetDir)).toEqual(before);
    // Redesign r4 (N10): the rule now lives in the closing "rolled back" line.
    expect(result.stderr.split("\n").find((line) => line.includes("This install was rolled back"))).toContain("put back as a unit");
    expectNoRecoveryField(result.stdout);
    expect(result.stderr).toContain("This install was rolled back");
    expect(filesNamed(stateRoot, ["extra-secret"])).toEqual([]);
  });

  it("U2: an empty folder had nothing to put back, so the rule is not stated", () => {
    const result = runInstall(makeTarget(), { ...committedCanned(), FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("put back exactly as they were");
  });
});

describe("install.sh: the engine's own scratch names are cleared (redesign r3)", () => {
  const scratchNames = [".env-orbit.migrating.ab12cd", ".env-orbit.installing.ab12cd", ".env-orbit.updating.ab12cd", ".orbit-engine.lock.stale-4242"];

  it.each([["a pre-provisioned folder", true], ["an empty folder", false]])("U5: engine exits 137 leaving its scratch files in %s: the folder is put back and nothing is moved out", (_label, preprovisioned) => {
    const fixture = privateStateFixture();
    const { stateRoot, environment } = fixture;
    const targetDir = preprovisioned ? fixture.targetDir : makeTarget();
    const before = preprovisioned ? fixture.before : undefined;
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_ENGINE_EXIT: "137",
      FAKE_ENGINE_WRITTEN: engineWritten,
      FAKE_ENGINE_LEAVES: JSON.stringify(Object.fromEntries(scratchNames.map((name) => [name, "engine scratch\n"]))),
    });
    expect(result.status).toBe(1);
    expectFolderPutBack(result, targetDir, before);
    expect(filesNamed(stateRoot, scratchNames)).toEqual([]);
    // Redesign r5: scratch names are removed, never moved, so no orbit-install-backups is made.
    expect(existsSync(backupsDir(targetDir))).toBe(false);
    expect(result.stderr).not.toContain("moved, not deleted");
    expect(result.stderr).toContain("This install was rolled back");
    expect(filesNamed(stateRoot, [".env-orbit"])).toEqual([]);
  });
});

describe("install.sh: the rollback names a missing journal (redesign r3)", () => {
  it("U6: no journal and a failed start: docker-compose.yml is moved out, and the output says the engine did not record which files it wrote", () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, { ...environment, ...committedCanned({ journal: false }), FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expectFolderPutBack(result, targetDir, before);
    // Redesign r5: moved into <folder>/orbit-install-backups/<stamp>/moved, never under the state root.
    const kept = filesNamed(backupsDir(targetDir), ["docker-compose.yml"]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/\/orbit-install-backups\/\d{8}T\d{6}Z(-[2-9])?\/moved\/docker-compose\.yml$/u);
    expect(filesNamed(stateRoot, ["docker-compose.yml"])).toEqual([]);
    expect(result.stderr).toContain("did not record which files it wrote");
    expectNoRecoveryField(result.stdout);
    expect(result.stderr).toContain("so everything new was moved, not deleted");
    expect(result.stderr).toContain(dirname(kept[0]));
    expect(result.stderr).not.toContain("Delete that directory");
    expect(result.stderr).not.toContain("Files this install did not write");
  });

  it("U7: with a journal the line names files this install did not write, moved, not deleted", () => {
    const { targetDir, environment } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      ...committedCanned(),
      FAKE_ENGINE_PERSON_WRITES: JSON.stringify({ path: "notes.txt", content: personNotes }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Files this install did not write were moved, not deleted");
    expect(result.stderr).not.toContain("did not say which files");
  });
});

describe("install.sh: a complete rollback, with backups inside the folder (redesign r5)", () => {
  it("B1: nothing of the person's: the folder as found, no orbit-install-backups, nothing under the state root, home or TMPDIR, and the same after a success", () => {
    const { targetDir, environment, before, stateRoot, home, tmp } = privateStateFixture();
    const result = runInstall(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /u);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(backups(targetDir)).toEqual([]);
    expect(existsSync(backupsDir(targetDir))).toBe(false);
    expectNothingPrivate({ stateRoot, home, tmp });
    const closing = closingLine(result.stderr);
    expect(closing).toBeDefined();
    expect(closing).toContain("put back as a unit");
    expect(closing.endsWith(failClosing)).toBe(true);
    expectNoForbiddenWords(result.stderr);
    expectNoCommand(result);

    const fresh = privateStateFixture();
    const succeeded = runInstall(fresh.targetDir, fresh.environment);
    expect(succeeded.status).toBe(0);
    expect(succeeded.stdout).toContain("Orbit is ready.");
    expect(backups(fresh.targetDir)).toEqual([]);
    expectNothingPrivate(fresh);
  });

  it("B2 (and B10's copy modes): while the run is in flight the copy is in orbit-install-backups/<stamp>/originals, every directory 0700, the secret 0600, and none in the state root or TMPDIR", () => {
    const { targetDir, stateDir, stateRoot, tmp, environment } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_SNAPSHOT_ROOTS: JSON.stringify({ tmp, xdg: stateRoot, target: targetDir }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    const during = JSON.parse(readFileSync(join(stateDir, "snapshot.json"), "utf8"));
    const envCopies = during.target.filter((entry) => /\/orbit-install-backups\/\d{8}T\d{6}Z(-[2-9])?\/originals\/\.env-orbit$/u.test(entry.path));
    expect(envCopies).toHaveLength(1);
    const originals = dirname(envCopies[0].path);
    expect(dirname(dirname(originals))).toBe(backupsDir(targetDir));
    const secretCopy = during.target.find((entry) => entry.path === join(originals, ".orbit-secrets", "oidc-client-secret"));
    expect(secretCopy).toBeDefined();
    expect(secretCopy.mode).toBe("600");
    for (const directory of [backupsDir(targetDir), dirname(originals), originals, join(originals, ".orbit-secrets")]) {
      expect(during.target.find((entry) => entry.path === directory)?.mode, directory).toBe("700");
    }
    expect(during.xdg.filter((entry) => entry.name === ".env-orbit")).toEqual([]);
    expect(during.tmp.filter((entry) => entry.name === ".env-orbit")).toEqual([]);
  });

  it("B18: verification is real: an .env-orbit overwritten during `compose up` is put back with the original bytes, and the copy released", () => {
    const { targetDir, environment, before } = privateStateFixture();
    const original = readFileSync(join(targetDir, ".env-orbit"));
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_UP_ADDS_FILE: JSON.stringify({ path: join(targetDir, ".env-orbit"), content: "APP_URL=https://overwritten-during-compose-up.internal\n" }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    expect(readFileSync(join(targetDir, ".env-orbit"))).toEqual(original);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(backups(targetDir)).toEqual([]);
  });

  it("B19: nothing is written under HOME, XDG_STATE_HOME or TMPDIR, whatever the run", () => {
    const home = scratchDir("b19-home");
    const tmp = scratchDir("b19-tmp");
    const xdg = scratchDir("b19-xdg");
    const stateRoot = join(xdg, "orbit");
    const roots = { HOME: home, TMPDIR: tmp, XDG_STATE_HOME: xdg };
    const expectNothingUnder = (label) => {
      expect(existsSync(stateRoot), `${label}: ${stateRoot}`).toBe(false);
      for (const root of [home, tmp]) expect(filesNamed(root, [".env-orbit", ".orbit-secrets", "notes.txt"]), `${label}: ${root}`).toEqual([]);
    };
    try {
      const b3 = recoveryFixture();
      expect(runInstall(b3.targetDir, { ...b3.environment, ...roots, ...committedCanned(), ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1" }).status).toBe(1);
      expectNothingUnder("B3's run");
      const b11 = recoveryFixture();
      expect(runInstall(b11.targetDir, { ...b11.environment, ...roots, ...r5DownFailedKnobs() }).status).toBe(1);
      expectNothingUnder("B11's run");
      expect(runInstall(makeTarget(), { ...roots, ...committedCanned(), ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1" }).status).toBe(1);
      expectNothingUnder("B6's run");
      const success = recoveryFixture();
      expect(runInstall(success.targetDir, { ...success.environment, ...roots }).status).toBe(0);
      expectNothingUnder("a success");
    } finally {
      // Only the roots this test made.
      for (const root of [home, tmp, xdg]) rmSync(root, { recursive: true, force: true });
    }
  });

  it("B26: the rollback never reads, runs, moves or deletes anything in an earlier run's folder; its own folder is a sibling", () => {
    const { targetDir, environment } = recoveryFixture();
    const old = join(backupsDir(targetDir), "20200101T000000Z");
    mkdirSync(join(old, "moved"), { recursive: true, mode: 0o700 });
    chmodSync(backupsDir(targetDir), 0o700);
    writeFileSync(join(old, "moved", "secret.txt"), "PLANTED");
    writeFileSync(join(old, "moved", "run-me.sh"), "echo EXECUTED\n", { mode: 0o755 });
    chmodSync(join(old, "moved", "run-me.sh"), 0o755);
    const oldBefore = treeSnapshot(old);
    const result = runInstall(targetDir, { ...environment, ...committedCanned({ journal: false }), FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(treeSnapshot(old)).toEqual(oldBefore);
    expect(modeOf(join(old, "moved", "run-me.sh"))).toBe(0o755);
    for (const text of [result.stdout, result.stderr, result.calls]) {
      expect(text).not.toContain("PLANTED");
      expect(text).not.toContain("EXECUTED");
    }
    const stamp = onlyStamp(targetDir, ["20200101T000000Z"]);
    expect(dirname(stamp)).toBe(backupsDir(targetDir));
    expect(existsSync(join(stamp, "moved", "docker-compose.yml"))).toBe(true);
  });

  it("N10 (re-homed): the closing line carries the unit clause when there was something to put back, and only then", () => {
    const { targetDir, environment } = privateStateFixture();
    const preprovisioned = runInstall(targetDir, { ...environment, ...committedCanned(), FAKE_COMPOSE_UP_FAIL: "1" });
    expect(preprovisioned.status).toBe(1);
    const closing = preprovisioned.stderr.split("\n").find((line) => line.includes("This install was rolled back"));
    expect(closing).toBeDefined();
    expect(closing).toContain("put back as a unit");
    expectNoRecoveryField(preprovisioned.stdout);

    const empty = runInstall(makeTarget(), { ...committedCanned(), HOME: scratchDir("home"), XDG_STATE_HOME: scratchDir("xdg"), FAKE_COMPOSE_UP_FAIL: "1" });
    expect(empty.status).toBe(1);
    const emptyClosing = empty.stderr.split("\n").find((line) => line.includes("This install was rolled back"));
    expect(emptyClosing).toBeDefined();
    expect(emptyClosing).not.toContain("as a unit");
    expectNoRecoveryField(empty.stdout);
  });
});

describe("install.sh: the closing lines say what to do about the obstacle, and the docs match (round 6, #1456)", () => {
  // R6-1, R6-2, R6-4 and R6-5 make a directory read-only; give it back so the scratch directories can be removed.
  const lockedDirectories = [];
  afterEach(() => {
    for (const directory of lockedDirectories.splice(0)) {
      try {
        chmodSync(directory, 0o700);
      } catch {
        // already gone
      }
    }
  });

  /** The engine leaves its committed tree with scripts/ read-only, so the rollback cannot remove it. */
  function lockedScriptsKnobs(targetDir) {
    const canned = committedCanned();
    const leaves = { ...JSON.parse(canned.FAKE_ENGINE_LEAVES), "scripts/": { mode: 0o500 } };
    lockedDirectories.push(join(targetDir, "scripts"));
    return { ...canned, FAKE_ENGINE_LEAVES: JSON.stringify(leaves), FAKE_COMPOSE_UP_FAIL: "1" };
  }

  const stderrLines = (stderr) => stderr.split("\n");

  it.skipIf(process.geteuid?.() === 0)("R6-1: the folder failed and volumes could not be removed: each volume is named, then `docker volume rm --` alone on a line, `abort`, no recovery field", () => {
    const { targetDir, environment, preexistingVolumes } = recoveryFixture();
    const result = runInstall(targetDir, { ...environment, ...lockedScriptsKnobs(targetDir), FAKE_VOLUME_RM_FAIL: "1" });
    lockedDirectories.push(...directoriesNamed(targetDir, "scripts"));
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    expectNoRecoveryField(result.stdout);
    const lines = stderrLines(result.stderr);
    expect(result.stderr).toContain("Could not remove");
    expect(result.stderr).toContain(join(targetDir, "scripts"));
    for (const volume of allThreeVolumes) expect(lines, volume).toContain(`Orbit installer: The volume ${volume} could not be removed.`);
    for (const volume of preexistingVolumes) expect(result.stderr).not.toContain(`The volume ${volume} could not be removed`);
    const intro = lines.indexOf("Orbit installer: To remove the volumes, run this in a terminal:");
    expect(intro).toBeGreaterThanOrEqual(0);
    const command = lines[intro + 1];
    expect(command).toMatch(/^docker volume rm -- /u);
    expect(command.slice("docker volume rm -- ".length).split(" ").sort()).toEqual(allThreeVolumes);
    for (const volume of preexistingVolumes) expect(command).not.toContain(volume);
    expect(lines.filter((line) => line.startsWith("docker volume rm -- "))).toEqual([command]);
    expectNoForbiddenWords(result.stderr);
  });

  it.skipIf(process.geteuid?.() === 0)("R6-2: the folder failed and the volumes could not be listed: the listing line is printed, and the folder obstacle", () => {
    const targetDir = makeTarget();
    const home = scratchDir("home");
    const xdg = scratchDir("xdg");
    const result = runInstall(targetDir, { ...lockedScriptsKnobs(targetDir), HOME: home, XDG_STATE_HOME: xdg, FAKE_VOLUME_LS_FAIL_AFTER_UP: "1" });
    lockedDirectories.push(...directoriesNamed(targetDir, "scripts"));
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    expectNoRecoveryField(result.stdout);
    expect(result.stderr).toContain("Could not remove");
    expect(result.stderr).toContain(join(targetDir, "scripts"));
    expect(stderrLines(result.stderr)).toContain(
      "Orbit installer: The volumes this install created could not be listed. If the next install names a volume this install left, remove that volume by the name it prints.",
    );
    expect(result.stderr).toContain("could not be listed");
    expect(stderrLines(result.stderr).filter((line) => line.startsWith("docker volume rm -- "))).toEqual([]);
    expectNoForbiddenWords(result.stderr);
  });

  it.skipIf(process.geteuid?.() === 0)("R6-3: an original cannot be put back: one line says to replace the live path with the copy, and nothing says to clear anything", () => {
    const { targetDir, environment } = recoveryFixture();
    const canned = committedCanned();
    const leaves = {
      ...JSON.parse(canned.FAKE_ENGINE_LEAVES),
      ".orbit-secrets/locked/": { mode: 0o500 },
      ".orbit-secrets/locked/x": "a file the rollback cannot remove\n",
    };
    lockedDirectories.push(join(targetDir, ".orbit-secrets", "locked"));
    const result = runInstall(targetDir, { ...environment, ...canned, FAKE_ENGINE_LEAVES: JSON.stringify(leaves), FAKE_COMPOSE_UP_FAIL: "1" });
    lockedDirectories.push(...directoriesNamed(targetDir, "locked"));
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    const stamp = onlyStamp(targetDir);
    expect(stderrLines(result.stderr)).toContain(
      `Orbit installer: Replace ${join(targetDir, ".orbit-secrets")} with the copy in ${join(stamp, "originals", ".orbit-secrets")}, then install again.`,
    );
    expect(result.stderr).not.toContain("Clear");
    expect(result.stderr).not.toContain("Clear what is named above");
    expectNoForbiddenWords(result.stderr);
  });

  it.skipIf(process.geteuid?.() === 0)("R6-4: nothing could be moved because the backups folder could not be made: the containers-and-volumes-removed line, `abort`, no `Clear`", () => {
    // An empty folder; the engine leaves only the person's file and then the folder itself read-only, so orbit-install-backups/ cannot be made.
    const targetDir = makeTarget();
    lockedDirectories.push(targetDir);
    const result = runInstall(targetDir, {
      ...committedCanned(),
      FAKE_ENGINE_LEAVES: JSON.stringify({ "notes.txt": personNotes, "/": { mode: 0o500 } }),
      HOME: scratchDir("home"),
      XDG_STATE_HOME: scratchDir("xdg"),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    expectNoRecoveryField(result.stdout);
    expect(result.stderr).toContain(backupsName);
    expect(stderrLines(result.stderr)).toContain(
      "Orbit installer: The containers and volumes were removed; the files this install wrote are still in the folder. Fix the cause named above, then install again.",
    );
    expect(result.stderr).not.toContain("Clear");
    expectNoForbiddenWords(result.stderr);
  });

  it.skipIf(process.geteuid?.() === 0)("R6-5: an engine entry cannot be removed and the originals were put back: the clear line, with the copy sentence because the copy line is printed", () => {
    const { targetDir, environment } = recoveryFixture();
    const result = runInstall(targetDir, { ...environment, ...lockedScriptsKnobs(targetDir) });
    lockedDirectories.push(...directoriesNamed(targetDir, "scripts"));
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    const lines = stderrLines(result.stderr);
    const stamp = onlyStamp(targetDir);
    const copyLine = lines.find((line) => line.includes("A copy of this folder's original files is kept in"));
    expect(copyLine).toBeDefined();
    expect(copyLine).toContain(join(stamp, "originals"));
    expect(lines).toContain(
      "Orbit installer: Clear the entries this install could not remove, named above, then install again. The copy of your original files can stay where it is.",
    );
    expect(result.stderr).not.toContain("Clear what is named above");
    expectNoForbiddenWords(result.stderr);
  });

  it("R6-6: the docs state the unit rule and which folders are untouched", () => {
    const read = (name) => readFileSync(join(repositoryRoot, "docs", name), "utf8");
    const installing = read("installing.md");
    const events = read("engine-events.md");
    const guarantees = read("installer-guarantees.md");
    expect(installing).toContain("put back whole from the copy");
    expect(events).toContain("put back whole from the copy");
    expect(installing).not.toContain("It never deletes a file it did not write");
    for (const [name, text] of [["installing.md", installing], ["installer-guarantees.md", guarantees]]) {
      expect(text, name).not.toContain("never reads, runs, moves or deletes anything in it");
      expect(text, name).not.toContain("Nothing under `orbit-install-backups/` is read");
      expect(text, name).toContain("earlier run");
      expect(text, name).not.toContain("Clear what is named above");
    }
  });

  it("R6-7: a failed start after the commit leaves an earlier run's folder byte-identical, releases this run's own originals, and keeps its moved files", () => {
    const { targetDir, environment } = recoveryFixture();
    const old = join(backupsDir(targetDir), "20200101T000000Z");
    mkdirSync(join(old, "moved"), { recursive: true, mode: 0o700 });
    chmodSync(backupsDir(targetDir), 0o700);
    writeFileSync(join(old, "moved", "earlier.txt"), "AN EARLIER RUN");
    const oldBefore = treeSnapshot(old);
    const result = runInstall(targetDir, { ...environment, ...committedCanned(), ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(treeSnapshot(old)).toEqual(oldBefore);
    const stamp = onlyStamp(targetDir, ["20200101T000000Z"]);
    expect(existsSync(join(stamp, "originals"))).toBe(false);
    expect(readOptional(join(stamp, "moved", "notes.txt"))).toBe(personNotes);
  });

  it("R6-8: a file the engine planted inside .orbit-secrets is gone after the rollback, the folder is byte-identical, and the closing line says it was put back as a unit", () => {
    const { targetDir, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      ...committedCanned(),
      FAKE_ENGINE_PERSON_WRITES: JSON.stringify({ path: ".orbit-secrets/notes.txt", content: "planted after the commit\n" }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    expect(existsSync(join(targetDir, ".orbit-secrets", "notes.txt"))).toBe(false);
    expect(treeSnapshot(targetDir)).toEqual(before);
    const closing = result.stderr.split("\n").find((line) => line.includes("This install was rolled back"));
    expect(closing).toBeDefined();
    expect(closing).toContain("put back as a unit");
  });

  it.skipIf(process.geteuid?.() === 0)("R6-9: compose down fails and the backups folder cannot be made: the stop command is offered, no removed claim, the files-still-in-folder line, `abort`", () => {
    const targetDir = makeTarget();
    lockedDirectories.push(targetDir);
    const result = runInstall(targetDir, {
      ...committedCanned(),
      // The engine's usual files too, so `compose up` runs and `down` can fail (R6-4's bare fixture never starts Docker).
      FAKE_ENGINE_LEAVES: JSON.stringify({ ...JSON.parse(committedCanned().FAKE_ENGINE_LEAVES), "notes.txt": personNotes, "/": { mode: 0o500 } }),
      HOME: scratchDir("home"),
      XDG_STATE_HOME: scratchDir("xdg"),
      FAKE_COMPOSE_UP_FAIL: "1",
      FAKE_COMPOSE_DOWN_FAIL: "1",
    });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    expect(result.stderr).toContain("To stop the containers, run this in a terminal:");
    expect(result.stderr).not.toContain("The containers and volumes were removed");
    expect(stderrLines(result.stderr)).toContain(
      "Orbit installer: The files this install wrote are still in the folder. Fix the cause named above, then install again.",
    );
    expectNoForbiddenWords(result.stderr);
  });

  it.skipIf(process.geteuid?.() === 0)("R6-10: an original cannot be put back and an engine entry cannot be removed: both lines, with the copy sentence", () => {
    const { targetDir, environment } = recoveryFixture();
    const knobs = lockedScriptsKnobs(targetDir);
    const leaves = {
      ...JSON.parse(knobs.FAKE_ENGINE_LEAVES),
      ".orbit-secrets/locked/": { mode: 0o500 },
      ".orbit-secrets/locked/x": "a file the rollback cannot remove\n",
    };
    lockedDirectories.push(join(targetDir, ".orbit-secrets", "locked"));
    const result = runInstall(targetDir, { ...environment, ...knobs, FAKE_ENGINE_LEAVES: JSON.stringify(leaves) });
    lockedDirectories.push(...directoriesNamed(targetDir, "scripts"), ...directoriesNamed(targetDir, "locked"));
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    const stamp = onlyStamp(targetDir);
    const lines = stderrLines(result.stderr);
    expect(lines).toContain(
      `Orbit installer: Replace ${join(targetDir, ".orbit-secrets")} with the copy in ${join(stamp, "originals", ".orbit-secrets")}, then install again.`,
    );
    expect(lines).toContain(
      "Orbit installer: Clear the entries this install could not remove, named above, then install again. The copy of your original files can stay where it is.",
    );
    expect(result.stderr).not.toContain("Clear what is named above");
    expectNoForbiddenWords(result.stderr);
  });
});

describe("install.sh: the journal lists files, and the person's files are moved, not deleted (redesign r5)", () => {
  it("B3: the person's top-level file is moved into <stamp>/moved, the folder put back, the copy released, and the output says where", () => {
    const { targetDir, environment, before } = recoveryFixture();
    const result = runInstall(targetDir, { ...environment, ...committedCanned(), ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /u);
    const stamp = onlyStamp(targetDir);
    expect(readOptional(join(stamp, "moved", "notes.txt"))).toBe(personNotes);
    expect(existsSync(join(stamp, "originals"))).toBe(false);
    expect(existsSync(join(stamp, "engine"))).toBe(false);
    expect(targetEntries(targetDir)).toEqual([".env-orbit", ".orbit-secrets", backupsName]);
    expect(ownTree(targetDir)).toEqual(before);
    expect(result.stderr).toContain("moved, not deleted");
    expect(result.stderr).toContain(join(stamp, "moved"));
    expect(closingLine(result.stderr)).toContain("apart from the files moved out and named above");
    expect(closingLine(result.stderr).endsWith(failClosing)).toBe(true);
    expectNoForbiddenWords(result.stderr);
  });

  it("B4: a file the person put inside a directory the engine created is moved with its path kept; the engine's own files are removed (O-S1-FR3)", () => {
    const { targetDir, environment, before } = recoveryFixture();
    const helper = "#!/bin/sh\necho the person's own helper\n";
    const result = runInstall(targetDir, {
      ...environment,
      ...committedCanned(),
      FAKE_UP_ADDS_FILE: JSON.stringify({ path: join(targetDir, "scripts", "my-helper.sh"), content: helper }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    const stamp = onlyStamp(targetDir);
    expect(readOptional(join(stamp, "moved", "scripts", "my-helper.sh"))).toBe(helper);
    expect(readdirSync(join(stamp, "moved", "scripts"))).toEqual(["my-helper.sh"]);
    expect(existsSync(join(targetDir, "scripts"))).toBe(false);
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(false);
    expect(modeOf(join(stamp, "moved"))).toBe(0o700);
    expect(modeOf(join(stamp, "moved", "scripts"))).toBe(0o700);
    expect(ownTree(targetDir)).toEqual(before);
  });

  it("B5: an older engine's top-level journal is not trusted: everything new is moved, not deleted, and the output says why", () => {
    const { targetDir, environment, before } = recoveryFixture();
    const result = runInstall(targetDir, {
      ...environment,
      ...committedCanned(),
      FAKE_ENGINE_WRITTEN: [".env-orbit", ".orbit-secrets", "docker-compose.yml", "scripts"].join("\n"),
      FAKE_UP_ADDS_FILE: JSON.stringify({ path: join(targetDir, "scripts", "my-helper.sh"), content: "#!/bin/sh\n" }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    const stamp = onlyStamp(targetDir);
    expect(existsSync(join(stamp, "moved", "scripts", "orbit-ops.sh"))).toBe(true);
    expect(existsSync(join(stamp, "moved", "docker-compose.yml"))).toBe(true);
    expect(result.stderr).toContain("did not record which files it wrote");
    expect(originalsIn(treeSnapshot(targetDir))).toEqual(originalsIn(before));
    expect(filesNamed(join(targetDir, "scripts"), ["orbit-ops.sh"])).toEqual([]);
  });

  it("B6: an empty folder: the person's file is moved, the folder holds only orbit-install-backups, and the next run installs without touching it", () => {
    const targetDir = makeTarget();
    const result = runInstall(targetDir, { ...committedCanned(), ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /u);
    expect(readdirSync(targetDir)).toEqual([backupsName]);
    const stamp = onlyStamp(targetDir);
    expect(readOptional(join(stamp, "moved", "notes.txt"))).toBe(personNotes);
    expect(existsSync(join(stamp, "originals"))).toBe(false);

    const kept = treeSnapshot(backupsDir(targetDir));
    const rerun = runInstall(targetDir, committedCanned());
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain("Orbit is ready.");
    expect(rerun.engineRuns).toHaveLength(1);
    expect(treeSnapshot(backupsDir(targetDir))).toEqual(kept);
  });

  it("B7: an empty folder with nothing to move is empty again, and no orbit-install-backups was made", () => {
    const targetDir = makeTarget();
    const result = runInstall(targetDir, { ...committedCanned(), FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(readdirSync(targetDir)).toEqual([]);
    expect(existsSync(backupsDir(targetDir))).toBe(false);
  });

  it("B8: an earlier run's folder is ignored and untouched, by a success and by a failure", () => {
    const plant = (targetDir) => {
      const old = join(backupsDir(targetDir), "20200101T000000Z");
      mkdirSync(join(old, "moved"), { recursive: true, mode: 0o700 });
      chmodSync(backupsDir(targetDir), 0o700);
      writeFileSync(join(old, "moved", "old.txt"), "from an earlier run\n");
      return { old, oldBefore: treeSnapshot(old) };
    };

    const succeeding = recoveryFixture();
    const kept = plant(succeeding.targetDir);
    const success = runInstall(succeeding.targetDir, succeeding.environment);
    expect(success.status).toBe(0);
    expect(treeSnapshot(kept.old)).toEqual(kept.oldBefore);
    expect(backups(succeeding.targetDir)).toEqual(["20200101T000000Z"]);

    const failing = recoveryFixture();
    const keptToo = plant(failing.targetDir);
    const failure = runInstall(failing.targetDir, { ...failing.environment, ...committedCanned(), ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1" });
    expect(failure.status).toBe(1);
    expect(backups(failing.targetDir)).toHaveLength(2);
    expect(treeSnapshot(keptToo.old)).toEqual(keptToo.oldBefore);
    const stamp = onlyStamp(failing.targetDir, ["20200101T000000Z"]);
    expect(readOptional(join(stamp, "moved", "notes.txt"))).toBe(personNotes);
  });

  it.each([["a symlink"], ["a dangling symlink"], ["a regular file"]])("B9: %s at orbit-install-backups is refused before anything changes", (kind) => {
    const { targetDir, environment } = recoveryFixture();
    const linkTarget = scratchDir("backups-link-target");
    if (kind === "a symlink") symlinkSync(linkTarget, backupsDir(targetDir));
    else if (kind === "a dangling symlink") symlinkSync(join(linkTarget, "missing"), backupsDir(targetDir));
    else writeFileSync(backupsDir(targetDir), "");
    // lstat-based, so a dangling link can be recorded too.
    const state = () => {
      const entry = lstatSync(backupsDir(targetDir));
      return {
        entries: targetEntries(targetDir),
        envOrbit: `${modeOf(join(targetDir, ".env-orbit")).toString(8)}:${readFileSync(join(targetDir, ".env-orbit")).toString("base64")}`,
        secrets: treeSnapshot(join(targetDir, ".orbit-secrets")),
        secretsMode: modeOf(join(targetDir, ".orbit-secrets")),
        backups: entry.isSymbolicLink() ? `link:${readlinkSync(backupsDir(targetDir))}` : `file:${readFileSync(backupsDir(targetDir)).toString("base64")}`,
      };
    };
    const before = state();
    const result = runInstall(targetDir, environment);
    expect(result.status).toBe(1);
    // Section 13.3: `fail_with failure abort` from snapshot_fresh_target, phase and component `host`.
    expect(terminalFailure(result.stdout)).toMatch(/^phase=host component=host state=failed reason=failure action=abort /u);
    expect(result.engineRuns).toHaveLength(0);
    expect(result.calls.split("\n").filter((line) => /^docker compose /u.test(line) && !/^docker compose version\b/u.test(line))).toEqual([]);
    expect(result.stderr).toContain(
      `Orbit installer: ${backupsDir(targetDir)} is not a folder: the installer keeps its backups under that name and cannot use a file or a link there. Rename it, then install again. Nothing was changed.`,
    );
    expect(readdirSync(linkTarget)).toEqual([]);
    expect(state()).toEqual(before);
  });

  it("B10: modes: the backups root is made 0700, the dated folder and moved/ 0700, and the person's file keeps its own 0644", () => {
    const { targetDir, environment } = recoveryFixture();
    mkdirSync(backupsDir(targetDir), { mode: 0o755 });
    chmodSync(backupsDir(targetDir), 0o755);
    const result = runInstall(targetDir, {
      ...environment,
      ...committedCanned(),
      FAKE_ENGINE_PERSON_WRITES: JSON.stringify({ path: "notes.txt", content: personNotes, mode: 0o644 }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    const stamp = onlyStamp(targetDir);
    expect(modeOf(backupsDir(targetDir))).toBe(0o700);
    expect(modeOf(stamp)).toBe(0o700);
    expect(modeOf(join(stamp, "moved"))).toBe(0o700);
    expect(modeOf(join(stamp, "moved", "notes.txt"))).toBe(0o644);
  });

  it("B20: an unwritable home changes nothing: an empty folder's person's file is still moved into the folder's backups", () => {
    const targetDir = makeTarget();
    const home = unwritableHome();
    const result = runInstall(targetDir, { ...committedCanned(), ...home, ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /u);
    expect(readdirSync(targetDir)).toEqual([backupsName]);
    expect(readOptional(join(onlyStamp(targetDir), "moved", "notes.txt"))).toBe(personNotes);
    expect(readdirSync(dirname(home.HOME))).toEqual([]);
  });

  it("B21: dated folder names never collide: an existing name is skipped, never reused or emptied; past -9 the install is refused at the start", () => {
    const premake = (targetDir, suffixes) => {
      mkdirSync(backupsDir(targetDir), { mode: 0o700 });
      chmodSync(backupsDir(targetDir), 0o700);
      const now = Math.floor(Date.now() / 1000) * 1000;
      const names = [];
      for (let second = 0; second <= 180; second += 1) {
        for (const suffix of suffixes) {
          const name = `${stampAt(now + second * 1000)}${suffix}`;
          mkdirSync(join(backupsDir(targetDir), name), { mode: 0o700 });
          names.push(name);
        }
      }
      return names;
    };
    const failingKnobs = { ...committedCanned(), ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1" };

    // (a) every plain stamp taken: the run uses <stamp>-2.
    const first = recoveryFixture();
    const plain = premake(first.targetDir, [""]);
    expect(runInstall(first.targetDir, { ...first.environment, ...failingKnobs }).status).toBe(1);
    const used = onlyStamp(first.targetDir, plain);
    expect(basename(used)).toMatch(/^\d{8}T\d{6}Z-2$/u);
    for (const name of plain) expect(readdirSync(join(backupsDir(first.targetDir), name)), name).toEqual([]);
    expect(readOptional(join(used, "moved", "notes.txt"))).toBe(personNotes);

    // (b) -2 through -9 taken too: refused before the engine, nothing changed.
    const second = recoveryFixture();
    premake(second.targetDir, ["", "-2", "-3", "-4", "-5", "-6", "-7", "-8", "-9"]);
    const premade = treeSnapshot(second.targetDir);
    const refused = runInstall(second.targetDir, { ...second.environment, ...failingKnobs });
    expect(refused.status).toBe(1);
    expect(terminalFailure(refused.stdout)).toMatch(/ action=abort /u);
    expect(refused.engineRuns).toHaveLength(0);
    expect(refused.stderr).toContain("Could not make a backup folder");
    expect(treeSnapshot(second.targetDir)).toEqual(premade);

    // (c) two failing runs, one after the other: two folders, each with its own file.
    const third = recoveryFixture();
    expect(runInstall(third.targetDir, { ...third.environment, ...failingKnobs }).status).toBe(1);
    expect(runInstall(third.targetDir, { ...third.environment, ...failingKnobs }).status).toBe(1);
    const names = backups(third.targetDir);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name).toMatch(stampPattern);
      expect(readOptional(join(backupsDir(third.targetDir), name, "moved", "notes.txt")), name).toBe(personNotes);
    }
  });
});
