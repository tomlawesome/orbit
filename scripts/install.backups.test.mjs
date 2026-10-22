// scripts/install.sh, the bootstrap shell around the install engine (#1212):
// one part of the suite that used to be scripts/install.test.mjs, split so the
// parts run in parallel (#1377). Fixtures and helpers: install-test-support.mjs.

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PTY_TEST_TIMEOUT_MS } from "./pty-deadline.mjs";
import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import {
  fakeDockerScript,
  fakeCurlScript,
  fakeCosignScript,
  targetEntries,
  readOptional,
  runInstall,
  runInstallOnTerminal,
  eventLines,
  realPath,
  terminalFailure,
  treeSnapshot,
  volumesLeftBehind,
  recoveryFixture,
  allThreeVolumes,
  runInstallSignalled,
  privateStateFixture,
  recoveryCommands,
  containersLeft,
  directoriesNamed,
  personNotes,
  committedCanned,
  backupsName,
  recoveryPrefix,
  r5DownCommand,
  volumesPart,
  noVolumesLine,
  expectRecoveryCommand,
  expectNoCommand,
  expectNoForbiddenWords,
  backupsDir,
  backups,
  onlyStamp,
  ownTree,
  originalsIn,
  stampAt,
  r5DownFailedKnobs,
  runPasted,
} from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

describe("install.sh: a refused backup folder names its cause and the way back", () => {
  /** A bin directory ahead of the fake one: the same fakes, plus `tools` (name to shell body) that shadow real commands. */
  function toolsPath(tools) {
    const dir = mkdtempSync(join(tmpdir(), "orbit-install-shadow-"));
    for (const [name, source] of [
      ["docker", fakeDockerScript],
      ["curl", fakeCurlScript],
      ["cosign", fakeCosignScript],
    ]) {
      writeFileSync(join(dir, name), source);
      chmodSync(join(dir, name), 0o755);
    }
    for (const [name, body] of Object.entries(tools)) {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    }
    return `${dir}:${process.env.PATH}`;
  }

  function refusal(targetDir, environment, tools) {
    const result = runInstall(targetDir, { ...environment, PATH: toolsPath(tools) });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    expect(result.engineRuns).toHaveLength(0);
    return result.stderr;
  }

  const generic = "Could not make a backup folder under";

  it("the run's timestamp cannot be read: says the clock could not be read and to try again", () => {
    const { targetDir, environment } = recoveryFixture();
    const before = treeSnapshot(targetDir);
    const text = refusal(targetDir, environment, { date: "exit 1" });
    expect(text).toMatch(/(clock|date|time)/iu);
    expect(text).toMatch(/(try again|run it again|install again|retry)/iu);
    expect(text).not.toMatch(new RegExp(`${generic} \\S+; nothing was changed\\.`, "u"));
    expect(treeSnapshot(targetDir)).toEqual(before);
  });

  it("the backups folder cannot be made private (not ours, or chmod fails): names the folder, says it is not usable by this user, and to change its owner, rename it or remove it", () => {
    const { targetDir, environment } = recoveryFixture();
    mkdirSync(backupsDir(targetDir), { mode: 0o755 });
    const text = refusal(targetDir, environment, { chmod: 'case "$*" in *orbit-install-backups*) exit 1;; esac\nexec /bin/chmod "$@"' });
    expect(text).toContain(backupsDir(targetDir));
    expect(text).toMatch(/(owned by|another user|permission|private|0700|700)/iu);
    expect(text).toMatch(/(chown|rename|remove)/iu);
    expect(text).not.toMatch(new RegExp(`${generic} \\S+; nothing was changed\\.`, "u"));
  });

  it("a dated folder cannot be created: says it could not be created and names the folder to check", () => {
    const { targetDir, environment } = recoveryFixture();
    const text = refusal(targetDir, environment, { mkdir: 'case "$*" in *orbit-install-backups*) exit 1;; esac\nexec /bin/mkdir "$@"' });
    expect(text).toContain(backupsName);
    expect(text).toMatch(/could not create/iu);
    expect(text).toMatch(/(space|permission|writable|check)/iu);
    expect(text).not.toMatch(new RegExp(`${generic} \\S+; nothing was changed\\.`, "u"));
  });

  it("all nine same-second names are taken: says so and to remove old dated folders", () => {
    const { targetDir, environment } = recoveryFixture();
    const now = Date.now();
    for (let second = -2; second <= 180; second += 1) {
      for (const suffix of ["", "-2", "-3", "-4", "-5", "-6", "-7", "-8", "-9"]) {
        mkdirSync(join(backupsDir(targetDir), `${stampAt(now + second * 1000)}${suffix}`), { recursive: true, mode: 0o700 });
      }
    }
    chmodSync(backupsDir(targetDir), 0o700);
    const text = refusal(targetDir, environment, {});
    expect(text).toMatch(/(taken|already exist|in use)/iu);
    expect(text).toMatch(/remove (the )?old/iu);
    expect(text).toContain(backupsName);
    expect(text).not.toMatch(new RegExp(`${generic} \\S+; nothing was changed\\.`, "u"));
  });
});

describe("install.sh: the containers could not be stopped (redesign r5)", () => {
  it("B11: the folder is put back, the engine's files kept whole in <stamp>/engine, and one command, last and alone, run from there, `retry`", () => {
    const { targetDir, stateDir, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, { ...environment, ...r5DownFailedKnobs() });
    expect(result.status).toBe(1);
    const offered = result.stdout.split("\n").filter((line) => line.startsWith(recoveryPrefix));
    expect(offered).toHaveLength(1);
    const command = offered[0].slice(recoveryPrefix.length);
    expectRecoveryCommand(result, command, "retry");
    expect(recoveryCommands(result.stderr).map((entry) => entry.command)).toEqual([command]);
    expect(command).toMatch(r5DownCommand);
    const lines = result.stderr.split("\n").filter((line) => line.trim() !== "");
    expect(lines.at(-1)).toBe(command);
    expect(lines.at(-2).endsWith("then install again:")).toBe(true);
    expect(result.stderr).toContain("the containers could not be stopped");
    expect(result.stderr).toContain("kept in");

    expect(targetEntries(targetDir)).toEqual([".env-orbit", ".orbit-secrets", backupsName]);
    expect(ownTree(targetDir)).toEqual(before);
    const stamp = onlyStamp(targetDir);
    expect(command).toContain(`/${basename(stamp)}/engine && `);
    // Section 13.1: this attempt's volumes, by exact name, and no other.
    expect(command).toContain(volumesPart);
    expect(command.slice(command.indexOf(volumesPart) + volumesPart.length).split(" ").sort()).toEqual(allThreeVolumes);
    expect(result.stderr).not.toContain(noVolumesLine);
    const engine = join(stamp, "engine");
    for (const path of ["docker-compose.yml", "scripts/orbit-ops.sh", ".env-orbit"]) expect(existsSync(join(engine, path)), path).toBe(true);
    expect(readOptional(join(engine, ".env-orbit"))).toContain("COMPOSE_PROJECT_NAME=");
    expect(lstatSync(join(engine, ".orbit-secrets")).isDirectory()).toBe(true);
    expect(readOptional(join(stamp, "moved", "notes.txt"))).toBe(personNotes);
    expect(existsSync(join(stamp, "originals"))).toBe(false);
    expectNoForbiddenWords(result.stderr);
    expect(volumesLeftBehind(stateDir)).not.toEqual([]);
  });

  /** B11 with the strict Compose fake, then the one command run as printed from elsewhere (B12). */
  function downFailedThenPasted() {
    const fixture = privateStateFixture();
    const environment = { ...fixture.environment, ...r5DownFailedKnobs(), FAKE_COMPOSE_STRICT: "1" };
    const failed = runInstall(fixture.targetDir, environment);
    expect(failed.status).toBe(1);
    const commands = recoveryCommands(failed.stderr).map((entry) => entry.command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(r5DownCommand);
    const stamp = onlyStamp(fixture.targetDir);
    expect(containersLeft(fixture.stateDir)).not.toEqual([]);
    expect(volumesLeftBehind(fixture.stateDir)).not.toEqual([]);
    return { ...fixture, environment, failed, stamp, command: commands[0], pasted: runPasted(commands[0], fixture.stateDir) };
  }

  it("B12: the printed command works from another directory: it finds the compose file in engine/ and stops the containers", () => {
    const { stateDir, stamp, command, pasted } = downFailedThenPasted();
    expect(`${command} -> ${pasted.ran.status} ${pasted.ran.stderr}`).toMatch(/-> 0 /u);
    expect(pasted.loaded?.found).toBe(true);
    expect(pasted.loaded?.cwd.endsWith("/engine")).toBe(true);
    expect(pasted.loaded?.cwd).toBe(realPath(join(stamp, "engine")));
    expect(readdirSync(pasted.scratch)).toEqual([]);
    expect(containersLeft(stateDir)).toEqual([]);
    // Section 13.1: the same command removed this attempt's volumes once the containers were gone.
    expect(volumesLeftBehind(stateDir)).toEqual([]);
  });

  it("B13: once the command has run, installing again is a fresh install that leaves the earlier dated folder as it was", () => {
    const { targetDir, environment, stamp, pasted } = downFailedThenPasted();
    expect(pasted.ran.status).toBe(0);
    const kept = treeSnapshot(stamp);
    const rerunEnvironment = Object.fromEntries(Object.entries(environment).filter(([key]) => !["FAKE_COMPOSE_UP_FAIL", "FAKE_COMPOSE_DOWN_FAIL"].includes(key)));
    const rerun = runInstall(targetDir, rerunEnvironment);
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain("Orbit is ready.");
    expect(rerun.engineRuns).toHaveLength(1);
    expect(treeSnapshot(stamp)).toEqual(kept);
    expect(backups(targetDir)).toEqual([basename(stamp)]);
  });

  it("B14: no journal and `down` failed: everything new is kept together in engine/, nothing deleted, and the command works from there", () => {
    const { targetDir, stateDir, environment } = privateStateFixture();
    const result = runInstall(targetDir, { ...environment, ...r5DownFailedKnobs({ journal: false }), FAKE_COMPOSE_STRICT: "1" });
    expect(result.status).toBe(1);
    const stamp = onlyStamp(targetDir);
    expect(existsSync(join(stamp, "engine", "docker-compose.yml"))).toBe(true);
    expect(readOptional(join(stamp, "engine", "notes.txt"))).toBe(personNotes);
    expect(existsSync(join(stamp, "moved"))).toBe(false);
    expect(result.stderr).toContain("did not record which files it wrote");
    expect(result.stderr).toContain("kept together");
    expectNoForbiddenWords(result.stderr);
    const commands = recoveryCommands(result.stderr).map((entry) => entry.command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(r5DownCommand);
    expect(commands[0]).toContain(volumesPart);
    expect(volumesLeftBehind(stateDir)).not.toEqual([]);
    const pasted = runPasted(commands[0], stateDir);
    expect(`${commands[0]} -> ${pasted.ran.status} ${pasted.ran.stderr}`).toMatch(/-> 0 /u);
    expect(pasted.loaded?.found).toBe(true);
    expect(pasted.loaded?.cwd).toBe(realPath(join(stamp, "engine")));
    expect(volumesLeftBehind(stateDir)).toEqual([]);
  });

  it("B11 (section 13.1): when the attempt created no volume, the command ends after --remove-orphans and one line says what to do if the next install names a volume", () => {
    const { targetDir, environment } = privateStateFixture();
    const { FAKE_UP_CREATES_ALL_VOLUMES: _created, ...noVolumes } = { ...environment, ...r5DownFailedKnobs() };
    const result = runInstall(targetDir, noVolumes);
    expect(result.status).toBe(1);
    const commands = recoveryCommands(result.stderr).map((entry) => entry.command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(r5DownCommand);
    expect(commands[0].endsWith(" down --remove-orphans")).toBe(true);
    expectRecoveryCommand(result, commands[0], "retry");
    const lines = result.stderr.split("\n");
    expect(lines[lines.indexOf(commands[0]) + 1]).toContain(noVolumesLine);
  });

  it("B25: on a terminal no `recovery-command:` line is printed; the command is still shown once", async () => {
    const { targetDir, environment } = privateStateFixture();
    const result = await runInstallOnTerminal(targetDir, { ...environment, ...r5DownFailedKnobs() });
    expect(result.status).toBe(1);
    // On a terminal stdout and stderr share the pty: strip carriage returns and colour before reading lines.
    const lines = result.stdout.split("\n").map((line) => line.replace(/\r/gu, "").replace(/\u001b\[[0-9;]*[A-Za-z]/gu, ""));
    expect(lines.filter((line) => line.startsWith(recoveryPrefix))).toEqual([]);
    expect(lines.filter((line) => r5DownCommand.test(line))).toHaveLength(1);
  }, PTY_TEST_TIMEOUT_MS);
});

describe("install.sh: a rollback that cannot finish names what is left (redesign r5)", () => {
  // B16 and B17 make a directory read-only; give it back so the scratch directories can be removed.
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

  it("B15: a volume that could not be removed: the folder is put back and the one command is `docker volume rm --` with this attempt's volumes, `retry`", () => {
    const { targetDir, environment, before, preexistingVolumes } = recoveryFixture();
    const result = runInstall(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1", FAKE_VOLUME_RM_FAIL: "1" });
    expect(result.status).toBe(1);
    const commands = recoveryCommands(result.stderr).map((entry) => entry.command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/^docker volume rm -- /u);
    expect(commands[0].slice("docker volume rm -- ".length).split(" ").sort()).toEqual(allThreeVolumes);
    for (const volume of preexistingVolumes) expect(commands[0]).not.toContain(volume);
    expectRecoveryCommand(result, commands[0], "retry");
    expect(result.stderr).toContain("could not be removed");
    for (const volume of allThreeVolumes) expect(result.stderr).toContain(volume);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(backups(targetDir)).toEqual([]);
  });

  it.skipIf(process.geteuid?.() === 0)("B16: an engine entry that cannot be removed is named, the originals are put back, and the run ends `abort` with no command", () => {
    const { targetDir, environment, before } = recoveryFixture();
    const canned = committedCanned();
    const leaves = { ...JSON.parse(canned.FAKE_ENGINE_LEAVES), "scripts/": { mode: 0o500 } };
    lockedDirectories.push(join(targetDir, "scripts"));
    const result = runInstall(targetDir, { ...environment, ...canned, FAKE_ENGINE_LEAVES: JSON.stringify(leaves), FAKE_COMPOSE_UP_FAIL: "1" });
    lockedDirectories.push(...directoriesNamed(targetDir, "scripts"));
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    expectNoCommand(result);
    expect(result.stderr).toContain("Could not remove");
    expect(result.stderr).toContain(join(targetDir, "scripts"));
    expect(result.stderr).toContain("then install again");
    expect(originalsIn(treeSnapshot(targetDir))).toEqual(originalsIn(before));
    expectNoForbiddenWords(result.stderr);
  });

  it.skipIf(process.geteuid?.() === 0)("B17: an original that cannot be put back keeps its copy in <stamp>/originals, named, `abort`", () => {
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
    expect(result.stderr).toContain("Could not put back");
    expect(result.stderr).toContain(join(targetDir, ".orbit-secrets"));
    expect(result.stderr).toContain("originals");
    const stamp = onlyStamp(targetDir);
    expect(readOptional(join(stamp, "originals", ".orbit-secrets", "oidc-client-secret"))).toBe("preprovisioned-oidc-secret");
    expect(existsSync(join(stamp, "originals", ".env-orbit"))).toBe(true);
  });
});

describe("install.sh: the rollback lists first, stops briefly and names the real cause (R1)", () => {
  // A hung Docker daemon must not hold the rollback past the launcher's 15 s stop grace. Order: list the volumes,
  // then `down --timeout 2`, then remove each volume. The three Docker calls are capped at 5, 6 and 5 s inside an
  // 8 s deadline. The rollback is measured from the `phase=rollback state=running` event to the terminal `failed`
  // event (whole seconds). The fake hangs for 120 s.
  const rollbackBudgetSeconds = 10;
  const causeLine =
    "Docker did not finish within 8 s, so the rollback stopped waiting for it; what it could not do is named below. Once Docker is answering again (check that it is running and its disk is not full), run the command below.";
  const containersLine = "the containers could not be stopped";
  const listedLine = "could not be listed";
  const stopCommand = /docker compose .* down --remove-orphans/u;

  function rollbackSeconds(stdout) {
    const start = /^phase=rollback .* state=running .* elapsed=(\d+)s$/mu.exec(stdout);
    const end = /^phase=[a-z-]+ .* state=failed .* elapsed=(\d+)s(?: .*)?$/mu.exec(stdout);
    expect(start, "a phase=rollback state=running event").not.toBeNull();
    expect(end, "a terminal failed event").not.toBeNull();
    return Number(end[1]) - Number(start[1]);
  }

  function timedFailure(knobs) {
    const { targetDir, environment } = recoveryFixture();
    return runInstall(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1", ...knobs }, ["--plain"]);
  }

  const occurrences = (text, needle) => text.split(needle).length - 1;
  const callLines = (result) => result.calls.split("\n").filter(Boolean);
  const isUp = (line) => /^docker compose .* up( |$)/u.test(line);
  const isDown = (line) => /^docker compose .* down( |$)/u.test(line);
  const isVolumeLs = (line) => /^docker volume ls( |$)/u.test(line);
  const isVolumeRm = (line) => /^docker volume rm( |$)/u.test(line);
  const afterUp = (result) => {
    const calls = callLines(result);
    return calls.slice(calls.findLastIndex(isUp) + 1);
  };

  it("a slow but healthy `compose down` (4 s) is not a timeout: the rollback completes, no cause line, all three volumes removed (guards FR2)", () => {
    const result = timedFailure({ FAKE_DOWN_DELAY: "4" });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("Docker did not finish within");
    expect(result.stderr).not.toContain(containersLine);
    expect(result.stderr).not.toContain(listedLine);
    expect(recoveryCommands(result.stderr)).toEqual([]);
    const removed = afterUp(result).filter(isVolumeRm).join(" ");
    for (const volume of allThreeVolumes) expect(removed).toContain(volume);
  });

  it("a hung `compose down`: the cause line says \"did not finish within 8 s\", once, before the obstacle, within 10 s", () => {
    const result = timedFailure({ FAKE_HANG_DOWN: "1" });
    expect(result.status).toBe(1);
    expect(rollbackSeconds(result.stdout)).toBeLessThanOrEqual(rollbackBudgetSeconds);
    expect(result.stderr).toContain(containersLine);
    expect(occurrences(result.stderr, causeLine)).toBe(1);
    expect(result.stderr.indexOf(causeLine)).toBeLessThan(result.stderr.indexOf(containersLine));
  });

  it("a hung `compose down`: the one stop command ends in `docker volume rm` naming all three volumes", () => {
    const result = timedFailure({ FAKE_HANG_DOWN: "1" });
    const commands = recoveryCommands(result.stderr).map((entry) => entry.command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(stopCommand);
    expect(commands[0]).toContain(volumesPart);
    expect(commands[0].slice(commands[0].indexOf(volumesPart) + volumesPart.length).split(" ").sort()).toEqual(allThreeVolumes);
  });

  it("a hung `compose down`: exactly one `volume ls` after the up and before the `down`, and nothing after the `down`", () => {
    const result = timedFailure({ FAKE_HANG_DOWN: "1" });
    const calls = afterUp(result);
    const down = calls.findIndex(isDown);
    expect(down).toBeGreaterThanOrEqual(0);
    expect(calls.slice(0, down).filter(isVolumeLs)).toHaveLength(1);
    expect(calls.slice(down + 1)).toEqual([]);
  });

  it("a hung `volume ls`: no `down` and no `volume rm` is run; the containers line, the listing line, the stop command, the next-install line and the cause line once", () => {
    const result = timedFailure({ FAKE_HANG_VOLUME_LS_AFTER_UP: "1" });
    expect(result.status).toBe(1);
    expect(rollbackSeconds(result.stdout)).toBeLessThanOrEqual(rollbackBudgetSeconds);
    const calls = afterUp(result);
    expect(calls.filter(isDown)).toEqual([]);
    expect(calls.filter(isVolumeRm)).toEqual([]);
    expect(result.stderr).toContain(containersLine);
    expect(result.stderr).toContain(listedLine);
    const commands = recoveryCommands(result.stderr).map((entry) => entry.command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(stopCommand);
    expect(commands[0]).not.toContain(volumesPart);
    expect(result.stderr).toContain(noVolumesLine);
    expect(occurrences(result.stderr, causeLine)).toBe(1);
  });

  it("a hung `volume rm`: every volume is named, the `docker volume rm` command is given, no stop command, cause once", () => {
    const result = timedFailure({ FAKE_HANG_VOLUME_RM: "1" });
    expect(result.status).toBe(1);
    expect(rollbackSeconds(result.stdout)).toBeLessThanOrEqual(rollbackBudgetSeconds);
    expect(result.stderr).toContain("could not be removed");
    for (const volume of allThreeVolumes) expect(result.stderr).toContain(volume);
    const commands = recoveryCommands(result.stderr).map((entry) => entry.command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/^docker volume rm -- /u);
    expect(result.stderr).not.toMatch(stopCommand);
    expect(occurrences(result.stderr, causeLine)).toBe(1);
  });

  it("a rollback in which Docker answers (even with a failure) carries no cause line", () => {
    const result = timedFailure({ FAKE_COMPOSE_DOWN_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("Docker did not finish within");
  });

  it("SIGTERM during a hung `down`: the process exits within 15 s of the signal with one terminal failed event", async () => {
    const { targetDir, environment } = recoveryFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_COMPOSE_UP_FAIL: "1", FAKE_HANG_DOWN: "1" },
      { signal: "SIGTERM", marker: "hung-down" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.signalToExitMs).toBeLessThan(15_000);
    expect(eventLines(result.stdout).filter((line) => / state=failed /u.test(line))).toHaveLength(1);
  }, PTY_TEST_TIMEOUT_MS);

  it("SIGTERM during a hung readiness probe with `volume ls` also hung: the process exits within 15 s of the signal with one terminal failed event", async () => {
    const { targetDir, environment } = recoveryFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_HANG_PROBE: "orbit-db", FAKE_HANG_VOLUME_LS_AFTER_UP: "1", ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60" },
      { signal: "SIGTERM", marker: "hung-probe" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.signalToExitMs).toBeLessThan(15_000);
    expect(eventLines(result.stdout).filter((line) => / state=failed /u.test(line))).toHaveLength(1);
  }, PTY_TEST_TIMEOUT_MS);
});
