// scripts/install.sh, the bootstrap shell around the install engine (#1212):
// one part of the suite that used to be scripts/install.test.mjs, split so the
// parts run in parallel (#1377). Fixtures and helpers: install-test-support.mjs.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import {
  runInstall,
  eventLines,
  recognisedVolume,
  realPath,
  dockerErrorBound,
  dockerReason,
  controlCharacters,
  terminalFailure,
  longestRun,
  treeSnapshot,
  volumesLeftBehind,
  recoveryFixture,
  wellFormedEvent,
  allThreeVolumes,
  privateStateFixture,
  dockerExcerptBound,
  addressInUse,
  dockerSaid,
  composeProgress,
  freeSpaceLine,
  componentEvents,
  expectNoLogsRequested,
  recoveryCommands,
  recoveryPrefix,
  r5DownCommand,
  volumesPart,
  onlyStamp,
  r5DownFailedKnobs,
  runPasted,
} from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

describe("install.sh: printed recovery commands are safe to paste (#1456)", () => {
  // Redesign r5 B24 (was r4 N12): a failed `down` prints one command; with a hostile folder name it parses, is safe, and reaches the engine/ folder.
  it.each([
    ["a space in the folder name", "orbit target folder"],
    ["a command substitution in the folder name", "orbit $(touch PWNED) folder"],
    ["a backquote and semicolon in the folder name", "orbit `touch PWNED`;touch PWNED"],
  ])("B24: with %s, the single command a failed `down` prints parses, creates no stray file run from elsewhere, and finds the Compose file in engine/", (_name, folderName) => {
    const { targetDir, stateDir, environment } = privateStateFixture(folderName);
    const result = runInstall(targetDir, { ...environment, ...r5DownFailedKnobs() });
    expect(result.status).toBe(1);
    const commands = recoveryCommands(result.stderr);
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toMatch(r5DownCommand);
    // The recovery-command contract: one stdout line, the command whole on it, the same bytes as the stderr line.
    const offered = result.stdout.split("\n").filter((line) => line.startsWith(recoveryPrefix));
    expect(offered).toHaveLength(1);
    const command = offered[0].slice(recoveryPrefix.length);
    expect(command).toBe(commands[0].command);
    expect(command).toContain(volumesPart);
    expect(spawnSync("bash", ["-n"], { input: command, encoding: "utf8" }).status).toBe(0);

    // Run as printed, from another directory, with the strict fake.
    const engine = join(onlyStamp(targetDir), "engine");
    const { ran, scratch, loaded } = runPasted(command, stateDir);
    expect(`${command} -> ${ran.status} ${ran.stderr}`).toMatch(/-> 0 /u);
    for (const directory of [scratch, dirname(targetDir), targetDir, engine]) expect(existsSync(join(directory, "PWNED"))).toBe(false);
    expect(loaded?.found).toBe(true);
    expect(loaded?.cwd).toBe(realPath(engine));
  });
});

describe("install.sh: an engine that reports success but exits non-zero (#1456)", () => {
  it("rolls the committed fresh install back instead of advising retry on a committed folder", () => {
    const { targetDir, stateDir, environment, before } = recoveryFixture();
    const result = runInstall(targetDir, { ...environment, FAKE_ENGINE_REAL_THEN_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reported success but exited with status 1");
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(volumesLeftBehind(stateDir)).toEqual([]);
    expect(runInstall(targetDir, environment).status).toBe(0);
  });
});

describe("install.sh: a failed image pull shows Docker's own words (#1455)", () => {
  const pullStderr = [
    `pull access denied: first sighting, ${dockerReason}`,
    `\u001b[31mError response from daemon: ${dockerReason}\u001b[0m\u0007 progress\rrewritten`,
    "Z".repeat(5000),
    `failed to pull: ${dockerReason}`,
    "",
  ].join("\n");

  it.each([
    ["a service image (compose pull)", { FAKE_COMPOSE_PULL_FAIL: "orbit-db", FAKE_COMPOSE_PULL_STDERR: pullStderr }],
    ["the release image (docker pull)", { FAKE_PULL_FAIL: "1", FAKE_PULL_STDERR: pullStderr }],
  ])("for %s: bounded, control characters stripped", (_name, failure) => {
    const { targetDir, environment } = recoveryFixture();
    const result = runInstall(targetDir, { ...environment, ...failure });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain(dockerReason);
    expect(output).not.toMatch(controlCharacters);
    expect(longestRun(output, "Z")).toBeLessThanOrEqual(dockerErrorBound);
    for (const line of eventLines(result.stdout)) expect(line).toMatch(wellFormedEvent);
  });
});

describe("install.sh: the Docker said line carries the error, not the progress, and stays short (#1485)", () => {
  it("compose up: drops Compose progress lines, keeps the address-in-use error, at most 500 characters", () => {
    const { targetDir, environment } = recoveryFixture();
    const stderr = [...composeProgress(), addressInUse, ""].join("\n");
    const result = runInstall(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1", FAKE_COMPOSE_UP_STDERR: stderr });
    expect(result.status).toBe(1);
    const { count, excerpt } = dockerSaid(result.stderr);
    expect(count).toBe(1);
    expect(excerpt).toContain("address already in use");
    expect(excerpt).toContain("0.0.0.0:3000/tcp");
    for (const progress of ["Creating", "Created", "Starting", "Started", "Waiting", "Healthy", "Pulling", "Pulled", "Network", "Volume", "Container orbit"]) {
      expect(excerpt).not.toContain(progress);
    }
    expect(excerpt.length).toBeLessThanOrEqual(dockerExcerptBound);
    expect(excerpt).not.toMatch(controlCharacters);
  });

  it("compose up: keeps every failure line (error, failed, denied) and joins them with ' | '", () => {
    const { targetDir, environment } = recoveryFixture();
    const stderr = [
      ...composeProgress().slice(0, 12),
      "Error response from daemon: pull access denied for orbit/app",
      " Container orbit-postgres  Healthy",
      "failed to solve: no space left on device",
      " Container orbit  Starting",
      "",
    ].join("\n");
    const result = runInstall(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1", FAKE_COMPOSE_UP_STDERR: stderr });
    const { count, excerpt } = dockerSaid(result.stderr);
    expect(count).toBe(1);
    expect(excerpt).toBe("Error response from daemon: pull access denied for orbit/app | failed to solve: no space left on device");
  });

  it.each([
    ["compose up", { FAKE_COMPOSE_UP_FAIL: "1" }, "FAKE_COMPOSE_UP_STDERR"],
    ["compose pull", { FAKE_COMPOSE_PULL_FAIL: "orbit-db" }, "FAKE_COMPOSE_PULL_STDERR"],
    ["the release image pull", { FAKE_PULL_FAIL: "1" }, "FAKE_PULL_STDERR"],
  ])("%s: long error text is cut to 500 characters, keeping the end, marked with a leading '...'", (_name, failure, stderrVariable) => {
    const { targetDir, environment } = recoveryFixture();
    const longError = `Error response from daemon: ${"very long explanation of the failure ".repeat(40)}final cause: ${dockerReason} END-MARKER`;
    expect(longError.length).toBeGreaterThan(dockerExcerptBound);
    const result = runInstall(targetDir, { ...environment, ...failure, [stderrVariable]: `${longError}\n` });
    expect(result.status).not.toBe(0);
    const { count, excerpt } = dockerSaid(result.stderr);
    expect(count).toBe(1);
    expect(excerpt.length).toBeLessThanOrEqual(dockerExcerptBound);
    expect(excerpt.startsWith("...")).toBe(true);
    expect(excerpt.endsWith(`final cause: ${dockerReason} END-MARKER`)).toBe(true);
  });

  it("compose up: output that only looks like progress keeps its last line, so a cause is never lost", () => {
    const { targetDir, environment } = recoveryFixture();
    const stderr = [...composeProgress(), "something unexpected happened", ""].join("\n");
    const result = runInstall(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1", FAKE_COMPOSE_UP_STDERR: stderr });
    expect(result.status).toBe(1);
    const { count, excerpt } = dockerSaid(result.stderr);
    expect(count).toBe(1);
    expect(excerpt).toBe("something unexpected happened");
  });

  it("compose up: progress-only output keeps its last line rather than printing an empty excerpt", () => {
    const { targetDir, environment } = recoveryFixture();
    const stderr = [...composeProgress(), ""].join("\n");
    const result = runInstall(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1", FAKE_COMPOSE_UP_STDERR: stderr });
    expect(result.status).toBe(1);
    const { excerpt } = dockerSaid(result.stderr);
    expect(excerpt.trim()).not.toBe("");
    expect(excerpt).toContain("Container orbit  Starting");
  });
});

describe("install.sh: a service that is not running at the deadline rolls a fresh install back (#1456 decision)", () => {
  const exited = { status: "exited", exitCode: 1, restarts: 3, oom: false };
  it.each([
    ["the database exited", "orbit-db", exited, ["status=exited", "exit-code=1", "oom-killed=false", "restarts=3"]],
    ["the database is restarting", "orbit-db", { status: "restarting", restarts: 5 }, ["status=restarting", "restarts=5"]],
    ["the database container is missing", "orbit-db", { status: "missing" }, []],
    ["the application exited", "orbit-app", exited, ["status=exited", "exit-code=1", "oom-killed=false", "restarts=3"]],
    ["the application is restarting", "orbit-app", { status: "restarting", restarts: 5 }, ["status=restarting", "restarts=5"]],
    ["the application container is missing", "orbit-app", { status: "missing" }, []],
  ])("when %s: rolls back, advises retry, names the container facts and free space, shows no logs, and a retry installs", (_name, service, facts, expectedFacts) => {
    const { targetDir, stateDir, environment, before } = recoveryFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_PROBE_FAIL: service,
      FAKE_CONTAINERS: JSON.stringify({ [service]: facts }),
    });

    expect(result.status).toBe(1);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(volumesLeftBehind(stateDir)).toEqual([]);
    const failure = terminalFailure(result.stdout);
    expect(failure).toMatch(/ action=retry /);
    expect(result.stderr).toContain(service);
    for (const fact of expectedFacts) expect(result.stderr).toContain(fact);
    expect(result.stderr).toMatch(freeSpaceLine);
    expectNoLogsRequested(result);

    const retried = runInstall(targetDir, environment);
    expect(retried.status).toBe(0);
  });
});

describe("install.sh: a service still running at the deadline is left in place (#1456 decision)", () => {
  it.each([
    ["the database", "orbit-db"],
    ["the application", "orbit-app"],
  ])("%s running with its probe still failing: no rollback, `repair`, left running, and an Update is accepted", (_name, service) => {
    const { targetDir, stateDir, environment } = recoveryFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_PROBE_FAIL: service,
      FAKE_CONTAINERS: JSON.stringify({ [service]: { status: "running", health: "starting" } }),
    });

    expect(result.status).toBe(1);
    // The folder is a deployment, and nothing was torn down.
    for (const file of ["docker-compose.yml", ".env-orbit", ".orbit-secrets"]) expect(existsSync(join(targetDir, file))).toBe(true);
    expect(volumesLeftBehind(stateDir).sort()).toEqual(allThreeVolumes);
    expect(result.calls).not.toContain("volume rm");
    expect(result.calls).not.toContain(" down ");
    expect(terminalFailure(result.stdout)).toMatch(/ action=repair /);
    expect(result.stderr).toMatch(/did not report ready within \d+ ?s/);
    expect(result.stderr).toMatch(/left running/);
    expect(result.stderr).toMatch(/docker compose .* ps/);
    expect(result.stderr).toMatch(/Repair/);
    expectNoLogsRequested(result);

    // The next step is Update, never a refused Install.
    const own = recognisedVolume("orbit");
    const updated = runInstall(
      targetDir,
      { FAKE_VOLUMES: own.volume, FAKE_PS: JSON.stringify(own.ps), FAKE_CONTAINER_IMAGES: JSON.stringify(own.images) },
      ["--update"],
    );
    expect(updated.stderr).not.toMatch(/not empty|Refusing to install here|requires a recognized/);
    expect(updated.status).toBe(0);
  });
});

describe("install.sh: an optional service never fails the install (#1456 decision)", () => {
  it.each([
    ["the scanner is still starting", "clamav", undefined, { status: "running", health: "starting" }, /Scanner: still starting/],
    ["the scanner exited", "clamav", undefined, { status: "exited", exitCode: 2 }, /Scanner: stopped \(exit 2\)/],
    ["document processing is still starting", "tika", "processing", { status: "running", health: "starting" }, /(Document processing|Tika|Processing)[^\n]*still starting/i],
    ["document processing exited", "tika", "processing", { status: "exited", exitCode: 2 }, /(Document processing|Tika|Processing)[^\n]*stopped \(exit 2\)/i],
    ["the local model service is still starting", "ollama", "ai", { status: "running", health: "starting" }, /(Local model|Ollama|Model)[^\n]*still starting/i],
    ["the local model service exited", "ollama", "ai", { status: "exited", exitCode: 2 }, /(Local model|Ollama|Model)[^\n]*stopped \(exit 2\)/i],
  ])("when %s: the install exits 0, the component's last event is waiting/optional-status/continue, and a completion line names it", (_name, component, profile, facts, line) => {
    const { targetDir, stateDir, environment } = recoveryFixture();
    const result = runInstall(targetDir, {
      ...environment,
      ...(profile ? { FAKE_OUTCOME_PATCH: JSON.stringify({ profile }) } : {}),
      FAKE_PROBE_FAIL: `orbit-${component}`,
      FAKE_CONTAINERS: JSON.stringify({ [`orbit-${component}`]: facts }),
    });
    expect(result.status).toBe(0);
    expect(componentEvents(result.stdout, component).at(-1)).toMatch(/ state=waiting reason=optional-status action=continue /);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(line);
    expect(eventLines(result.stdout).some((event) => / state=failed /.test(event))).toBe(false);
    // Nothing was rolled back: the stack stays.
    expect(result.calls).not.toContain("volume rm");
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(true);
    expect(volumesLeftBehind(stateDir).sort()).toEqual(allThreeVolumes);
    expectNoLogsRequested(result);
  });
});
