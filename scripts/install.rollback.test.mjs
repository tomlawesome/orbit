// scripts/install.sh, the bootstrap shell around the install engine (#1212):
// one part of the suite that used to be scripts/install.test.mjs, split so the
// parts run in parallel (#1377). Fixtures and helpers: install-test-support.mjs.

import { spawn } from "node:child_process";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PTY_TEST_TIMEOUT_MS } from "./pty-deadline.mjs";
import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import {
  installScript,
  repositoryRoot,
  assetsRoot,
  makeTarget,
  makePreprovisionedDeployment,
  targetEntries,
  readOptional,
  runInstall,
  runInstallOnTerminal,
  eventLines,
  recognisedVolume,
  dockerErrorBound,
  dockerReason,
  controlCharacters,
  terminalFailure,
  longestRun,
  treeSnapshot,
  volumeRemovals,
  volumesLeftBehind,
  recoveryFixture,
  wellFormedEvent,
  allThreeVolumes,
  runInstallSignalled,
  runInstallWithClosedPipes,
  privateStateFixture,
  filesNamed,
  backupsDir,
  ownTree,
} from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

describe("install.sh: the UI helper it sources after the commit (guarantee #5)", () => {
  it.each([
    ["a symlink", (path) => {
      rmSync(path);
      symlinkSync(join(assetsRoot, "scripts", "installer-ui.sh"), path);
    }],
    ["not valid bash", (path) => writeFileSync(path, "installer_ui_init() {\n")],
  ])("refuses to source a committed installer-ui.sh that is %s, and starts nothing", (_label, damage) => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    damage(join(targetDir, "scripts", "installer-ui.sh"));
    const result = runInstall(targetDir, {
      FAKE_ENGINE_EXIT: "0",
      FAKE_ENGINE_OUTCOME: "status=ok\nfresh=0\nprofile=standard\nmodel-pull=0\ndatabase-volume=\n",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The deployment's installer UI helper is unavailable.");
    expect(result.stdout).toMatch(/state=failed reason=failure action=retry/);
    expect(result.calls).not.toContain("compose --project-name");
  });
});

describe("install.sh: the application readiness probe (guarantee #34)", () => {
  // The probe is the exact text install.sh runs in the application
  // container; only its fixed address is pointed at a local server here.
  function probeSource() {
    const match = /^readonly app_readiness_probe='([\s\S]*?)'$/mu.exec(readFileSync(installScript, "utf8"));
    expect(match).not.toBeNull();
    return match[1];
  }

  async function probeAgainst(status, body) {
    const { createServer } = await import("node:http");
    const server = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" }).end(body);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      const source = probeSource().replace("http://127.0.0.1:3000/", `http://127.0.0.1:${port}/`);
      return await new Promise((resolve) => {
        const child = spawn("node", ["-e", source]);
        child.on("close", (code) => resolve(code));
      });
    } finally {
      server.close();
    }
  }

  it.each([
    ["ready, from orbit", 200, '{"status":"ready","service":"orbit"}', 0],
    ["ready, from another service", 200, '{"status":"ready","service":"other"}', 1],
    ["starting", 200, '{"status":"starting","service":"orbit"}', 1],
    ["a 503", 503, '{"status":"ready","service":"orbit"}', 1],
    ["not JSON", 200, "ready", 1],
    ["a JSON array", 200, "[]", 1],
  ])("answers %s with exit %#", async (_label, status, body, code) => {
    expect(await probeAgainst(status, body)).toBe(code);
  });
});

describe("install.sh: what it holds by its source", () => {
  it("bounds every Compose health probe with timeout, stdin closed (guarantee #33)", () => {
    const source = readFileSync(installScript, "utf8");
    expect(source).toMatch(/timeout --signal=TERM --kill-after=1s 5s \\\n\s+docker compose --project-name "\$compose_project_name" --env-file "\$environment_file" "\$@" <\/dev\/null/u);
    for (const probe of ["probe_database_health", "probe_application_health", "probe_clamav_health", "probe_tika_health", "probe_ollama_health"]) {
      const body = new RegExp(`^${probe}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}`, "mu").exec(source)?.[1] ?? "";
      expect(body, probe).toContain("bounded_compose_probe exec -T");
    }
  });

  it("uses literal delimiters for every Docker template it parses, the formats the engine's volume check documents", () => {
    const source = readFileSync(installScript, "utf8");
    const engineSide = readFileSync(join(repositoryRoot, "src", "lib", "database-volume-safety.ts"), "utf8");
    for (const format of [
      '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}',
      '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}',
      "{{.Config.Image}}",
    ]) {
      expect(source).toContain(`--format '${format}'`);
      expect(engineSide).toContain(format);
    }
    expect(source).not.toMatch(/--format '[^']*\\t/u);
  });

  // #1345: they now pass the project explicitly -- derived, .env-orbit's own
  // COMPOSE_PROJECT_NAME first -- because without --project-name an exported
  // COMPOSE_PROJECT_NAME beat the persisted one. Never a hard-coded name.
  it("keeps backup and restore commands on the persisted env-file project", () => {
    for (const script of ["backup.sh", "restore.sh"]) {
      const source = readFileSync(join(repositoryRoot, "scripts", script), "utf8");
      expect(source).toContain('docker compose --project-name "$project" --env-file "$environment_file"');
      expect(source).toContain("read_environment_value COMPOSE_PROJECT_NAME");
      expect(source).not.toContain("--project-name orbit");
    }
  });

  it("documents the configuration and database recovery identity contract", () => {
    const procedure = readFileSync(join(repositoryRoot, "docs", "installer-guarantees.md"), "utf8");
    expect(procedure).toContain('preupgrade_config="$preupgrade_dir/orbit-pre-upgrade.env"');
    expect(procedure).toContain('chmod 600 "$preupgrade_config"');
    expect(procedure).toContain("configuration or pre-start failure automatically restores");
    expect(procedure).toContain(".orbit-install-staging.*");
    expect(procedure).toContain('cp -- "$preupgrade_config" .env-orbit');
    expect(procedure).toContain('bash scripts/restore.sh "$backup_path"');
    expect(procedure).toContain('rm -f -- "$preupgrade_config"');
    expect(procedure).toContain("validated `COMPOSE_PROJECT_NAME`");
  });
});

describe("install.sh --simulate on a terminal", () => {
  it("cancels the interactive simulation with a lone Escape at the profile menu", async () => {
    const targetDir = makeTarget();
    const result = await runInstallOnTerminal(
      targetDir,
      {},
      [
        { after: "Simulation: Greetings, what can we do for you today?", input: "\r" },
        { after: "Simulation: choose a deployment profile", input: "\x1b" },
      ],
      ["--simulate"],
    );
    expect(result.status).toBe(130);
    expect(result.promptedInteractions).toBe(2);
    expect(result.calls).toBe("");
    expect(targetEntries(targetDir)).toEqual([]);
  }, PTY_TEST_TIMEOUT_MS);
});

describe("install.sh: a failed compose up reports Docker's reason (#1455)", () => {
  const dockerStderr = [
    `Container orbit-orbit-db-1  Error: first sighting, ${dockerReason}`,
    `\u001b[31mError response from daemon: ${dockerReason}\u001b[0m\u0007 progress\rrewritten`,
    "Z".repeat(5000),
    `dependency failed to start: container orbit-orbit-db-1 exited (1): ${dockerReason}`,
    "",
  ].join("\n");
  let cached;
  /** One failed fresh start, shared by the tests below: they read different parts of the same failure. */
  function failedStart() {
    if (!cached) {
      const fixture = recoveryFixture();
      const result = runInstall(fixture.targetDir, { ...fixture.environment, FAKE_COMPOSE_UP_FAIL: "1", FAKE_COMPOSE_UP_STDERR: dockerStderr });
      cached = { ...fixture, result, output: `${result.stdout}\n${result.stderr}` };
    }
    return cached;
  }

  it("shows Docker's own error output in the failure the launcher shows", () => {
    const { result, output } = failedStart();
    expect(result.status).toBe(1);
    expect(output).toContain(dockerReason);
  });

  it("strips control characters from Docker's text and keeps every event line well-formed", () => {
    const { result, output } = failedStart();
    expect(output).toContain(dockerReason);
    expect(output).not.toMatch(controlCharacters);
    for (const line of eventLines(result.stdout)) {
      expect(line).toMatch(/^phase=[a-z-]+ component=[a-z-]+ state=[a-z-]+ reason=[a-z-]+ action=[a-z-]+ elapsed=[0-9]+s$/);
    }
  });

  it(`bounds Docker's text to ${dockerErrorBound} characters, however long its lines`, () => {
    const { output } = failedStart();
    expect(output).toContain(dockerReason);
    expect(longestRun(output, "Z")).toBeLessThanOrEqual(dockerErrorBound);
  });

  it("keeps the failure code docker-host but does not call the start step `database`", () => {
    const { result } = failedStart();
    const failure = terminalFailure(result.stdout);
    expect(failure).toBeDefined();
    expect(failure).toMatch(/reason=docker-host /);
    expect(failure).not.toMatch(/^phase=database /);
    expect(eventLines(result.stdout).some((line) => /^phase=database .* state=failed /.test(line))).toBe(false);
  });

  it("removes every volume the failed start created, by exact name and never by wildcard or prune", () => {
    const { result, stateDir, preexistingVolumes } = failedStart();
    expect(volumeRemovals(result.calls)).toEqual(["orbit_orbit-clamav-data", "orbit_orbit-db-data", "orbit_orbit-documents-data"]);
    expect(result.calls).not.toMatch(/volume prune|system prune|\*/u);
    for (const volume of preexistingVolumes) expect(result.calls).not.toMatch(new RegExp(`volume rm.*${volume}`, "u"));
    expect(volumesLeftBehind(stateDir)).toEqual([]);
  });

  it("brings the containers down while the Compose file still exists, and only then removes volumes", () => {
    const { result, stateDir } = failedStart();
    expect(readOptional(join(stateDir, "down-log")).split("\n").filter(Boolean)).toEqual(["compose-file-present"]);
    const calls = result.calls.split("\n");
    expect(calls.findIndex((line) => line.includes(" down "))).toBeGreaterThan(-1);
    expect(calls.findIndex((line) => line.includes(" down "))).toBeLessThan(calls.findIndex((line) => line.startsWith("docker volume rm")));
  });
});

describe("install.sh: a failed fresh install leaves its folder as it found it (#1456)", () => {
  // Each row fails one step after the files were written. All of them create
  // the stack's volumes when `up` runs, so a rollback that forgets them shows.
  it.each([
    ["Compose rejects the written configuration", { FAKE_COMPOSE_CONFIG_FAIL: "1" }],
    ["the database image cannot be pulled", { FAKE_COMPOSE_PULL_FAIL: "orbit-db" }],
    ["the scanner image cannot be pulled", { FAKE_COMPOSE_PULL_FAIL: "orbit-clamav" }],
    ["compose up fails", { FAKE_COMPOSE_UP_FAIL: "1", FAKE_COMPOSE_UP_STDERR: `Error: ${dockerReason}\n` }],
    ["the database stops before it is healthy", { FAKE_PROBE_FAIL: "orbit-db", FAKE_CONTAINERS: JSON.stringify({ "orbit-db": { status: "exited", exitCode: 1 } }) }],
    ["the application stops before it reports ready", { FAKE_PROBE_FAIL: "orbit-app", FAKE_CONTAINERS: JSON.stringify({ "orbit-app": { status: "exited", exitCode: 1 } }) }],
  ])("when %s: rolls the folder and Docker back, then a retry in the same folder installs", (_step, failure) => {
    const { targetDir, stateDir, environment, preexistingVolumes, before } = recoveryFixture();

    const failed = runInstall(targetDir, { ...environment, ...failure });
    expect(failed.status).toBe(1);
    // The folder is exactly what it was: its own files byte for byte, nothing the install wrote.
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(targetEntries(targetDir)).toEqual([".env-orbit", ".orbit-secrets"]);
    // Everything this attempt created in Docker is gone; nothing else was touched.
    expect(volumesLeftBehind(stateDir)).toEqual([]);
    for (const volume of volumeRemovals(failed.calls)) expect(preexistingVolumes).not.toContain(volume);
    expect(failed.calls).not.toMatch(/volume prune|system prune/u);

    // A rollback that succeeded leaves a retry that can succeed.
    const retried = runInstall(targetDir, environment);
    expect(retried.stderr).toBe("");
    expect(retried.status).toBe(0);
    expect(retried.stdout).toContain("Orbit is ready.");
  });

  it("control: a failed image pull, before any file is written, leaves the folder as it was", () => {
    const { targetDir, environment, before } = recoveryFixture();
    const failed = runInstall(targetDir, { ...environment, FAKE_PULL_FAIL: "1" });
    expect(failed.status).not.toBe(0);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(runInstall(targetDir, environment).status).toBe(0);
  });

  it("never rolls back an update: a failed start keeps the committed deployment and its files", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    const before = treeSnapshot(targetDir);
    const own = recognisedVolume("orbit");
    const result = runInstall(
      targetDir,
      { FAKE_COMPOSE_UP_FAIL: "1", FAKE_VOLUMES: own.volume, FAKE_PS: JSON.stringify(own.ps), FAKE_CONTAINER_IMAGES: JSON.stringify(own.images) },
      ["--update"],
    );
    expect(result.status).toBe(1);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(result.calls).not.toContain("volume rm");
  });

});

describe("install.sh: an interrupt rolls a fresh install back (#1456)", () => {
  it.each([
    ["SIGTERM", "SIGTERM", { FAKE_HANG_PROBE: "orbit-db" }, "hung-probe", true],
    ["SIGINT", "SIGINT", { FAKE_HANG_PROBE: "orbit-db" }, "hung-probe", true],
    ["SIGHUP", "SIGHUP", { FAKE_HANG_PROBE: "orbit-db" }, "hung-probe", true],
    ["SIGTERM during the image pull", "SIGTERM", { FAKE_HANG_PULL: "orbit-db" }, "hung-pull", false],
  ])("on %s: exits non-zero, restores the folder, removes the attempt's volumes by exact name, and a retry installs", async (_name, signal, hang, marker, createsVolumes) => {
    const { targetDir, stateDir, environment, preexistingVolumes, before } = recoveryFixture();

    const result = await runInstallSignalled(
      targetDir,
      { ...environment, ...hang, ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60" },
      { signal, marker },
    );

    expect(result.signalSent).toBe(true);
    expect(result.status).not.toBe(0);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(volumeRemovals(result.calls)).toEqual(createsVolumes ? allThreeVolumes : []);
    expect(volumesLeftBehind(stateDir)).toEqual([]);
    for (const volume of preexistingVolumes) expect(volumeRemovals(result.calls)).not.toContain(volume);

    const retried = runInstall(targetDir, environment);
    expect(retried.status).toBe(0);
    expect(retried.stdout).toContain("Orbit is ready.");
  });

  it("emits one well-formed terminal `failed` event after the rollback events, even though the exit was not a planned failure", async () => {
    const { targetDir, environment } = recoveryFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_HANG_PROBE: "orbit-db", ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60" },
      { signal: "SIGTERM", marker: "hung-probe" },
    );
    const events = eventLines(result.stdout);
    for (const line of events) expect(line).toMatch(wellFormedEvent);
    const rollbackDone = events.findIndex((line) => /^phase=rollback component=installer state=completed /.test(line));
    expect(rollbackDone).toBeGreaterThan(-1);
    const terminal = events.at(-1);
    expect(terminal).toMatch(/ state=failed /);
    expect(events.indexOf(terminal)).toBeGreaterThan(rollbackDone);
    expect(events.filter((line) => / state=failed /.test(line))).toHaveLength(1);
  });

  it("B23: keeps the copy of the user's original files in the folder, and names it, when a second SIGTERM lands during the rollback", async () => {
    const fixture = privateStateFixture();
    const { targetDir, environment, stateRoot, before } = fixture;
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_COMPOSE_UP_FAIL: "1", FAKE_HANG_DOWN: "1" },
      { signal: "SIGTERM", marker: "hung-down" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.status).not.toBe(0);
    if (JSON.stringify(ownTree(targetDir)) !== JSON.stringify(before)) {
      // Redesign r5: the folder was not put back, so the only copy of the originals is the start record inside the folder.
      const copies = filesNamed(backupsDir(targetDir), [".env-orbit"]);
      expect(copies).toHaveLength(1);
      expect(readFileSync(copies[0], "utf8")).toContain("APP_URL=https://orbit.preprovisioned-install.internal");
      expect(result.stderr).toContain(dirname(copies[0]));
    }
    expect(filesNamed(stateRoot, [".env-orbit"])).toEqual([]);
  });
});

describe("install.sh: the launcher going away does not stop the rollback (#1456)", () => {
  it.each([
    ["stdout and stderr both closed", "both"],
    ["stderr closed", "stderr"],
  ])("with %s: a failure after the commit still restores the folder and removes the volumes", async (_name, closed) => {
    const { targetDir, stateDir, environment, before } = recoveryFixture();
    const result = await runInstallWithClosedPipes(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1" }, closed);
    expect(result.status === 0).toBe(false);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(volumesLeftBehind(stateDir)).toEqual([]);
    expect(volumeRemovals(result.calls)).toEqual(allThreeVolumes);
  });
});
