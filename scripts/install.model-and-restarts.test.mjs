// scripts/install.sh, the bootstrap shell around the install engine (#1212):
// one part of the suite that used to be scripts/install.test.mjs, split so the
// parts run in parallel (#1377). Fixtures and helpers: install-test-support.mjs.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";
import {
  installScript,
  makePasteBin,
  makeFakeBin,
  makeTarget,
  makePreprovisionedDeployment,
  readOptional,
  baseEnvironment,
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
  allThreeVolumes,
  scratchDir,
  runInstallSignalled,
  privateStateFixture,
  filesNamed,
  componentEvents,
  recoveryCommands,
  modelUpdateFixture,
} from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

describe("install.sh: the confirmed model download (#1456 decision, #1474)", () => {
  const pullWords = [`pull failed: first sighting, ${dockerReason}`, `\u001b[31mError: ${dockerReason}\u001b[0m\u0007 progress\rrewritten`, "Z".repeat(5000), `failed: ${dockerReason}`, ""].join("\n");
  // The profile triple cannot be pre-provisioned on a fresh target, so, as the
  // existing model test does, the deployment is installed first and the model
  // download is requested on the next run (an update).
  function modelFixture() {
    const fixture = recoveryFixture();
    expect(runInstall(fixture.targetDir, fixture.environment).status).toBe(0);
    appendFileSync(join(fixture.targetDir, ".env-orbit"), "OLLAMA_MODEL=llama3.2:1b\n");
    const own = recognisedVolume("orbit");
    return {
      ...fixture,
      environment: {
        FAKE_VOLUMES: own.volume,
        FAKE_PS: JSON.stringify(own.ps),
        FAKE_CONTAINER_IMAGES: JSON.stringify(own.images),
      },
    };
  }
  const withModelPull = { FAKE_ENGINE_EXIT: "0", FAKE_ENGINE_OUTCOME: "status=ok\nfresh=0\nprofile=ai\nmodel-pull=1\ndatabase-volume=\n" };

  it("when the download fails: the install exits 0, the component continues, and the pull's words are shown bounded and stripped", () => {
    const { targetDir, environment } = modelFixture();
    const result = runInstall(targetDir, { ...environment, ...withModelPull, FAKE_MODEL_PULL_FAIL: "1", FAKE_MODEL_PULL_STDERR: pullWords });
    expect(result.status).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(eventLines(result.stdout).some((line) => /component=(ollama|model)[a-z-]* .* action=continue /.test(line))).toBe(true);
    expect(output).toContain(dockerReason);
    expect(output).not.toMatch(controlCharacters);
    expect(longestRun(output, "Z")).toBeLessThanOrEqual(dockerErrorBound);
    expect(eventLines(result.stdout).some((line) => / state=failed /.test(line))).toBe(false);
  });

  it.each([
    ["succeeds", {}],
    ["fails", { FAKE_MODEL_PULL_FAIL: "1", FAKE_MODEL_PULL_STDERR: pullWords }],
  ])("when the download %s: it runs through the orbit-ollama-model-pull service, never `exec … ollama pull`", (_name, outcome) => {
    const { targetDir, environment } = modelFixture();
    const result = runInstall(targetDir, { ...environment, ...withModelPull, ...outcome });
    expect(result.status).toBe(0);
    expect(result.calls).toMatch(/--profile ai-model-pull .*orbit-ollama-model-pull/);
    expect(result.calls).not.toMatch(/exec .*orbit-ollama .*ollama pull/);
  });

  it("G7-FR1: the failed-download note carries the `docker compose ... run --rm orbit-ollama-model-pull` command to try again and not the leftover container's name", () => {
    const { targetDir, environment } = modelFixture();
    const result = runInstall(targetDir, { ...environment, ...withModelPull, FAKE_MODEL_PULL_FAIL: "1" });
    expect(result.status).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toMatch(/To try again: docker compose .*--profile ai-model-pull run --rm orbit-ollama-model-pull/u);
    expect(output).not.toContain("orbit-orbit-ollama-model-pull-install");
  });
});

describe("install.sh: an update's failures are unchanged by the decision (#1456 decision)", () => {
  it.each([
    ["the database exited", "orbit-db", { status: "exited", exitCode: 1, restarts: 3 }],
    ["the application is still running but not ready", "orbit-app", { status: "running", health: "starting" }],
  ])("when %s during an update: no rollback, files kept, `repair`", (_name, service, facts) => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    const before = treeSnapshot(targetDir);
    const own = recognisedVolume("orbit");
    const result = runInstall(
      targetDir,
      {
        FAKE_VOLUMES: own.volume,
        FAKE_PS: JSON.stringify(own.ps),
        FAKE_CONTAINER_IMAGES: JSON.stringify(own.images),
        FAKE_PROBE_FAIL: service,
        FAKE_CONTAINERS: JSON.stringify({ [service]: facts }),
      },
      ["--update"],
    );
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=repair /);
    expect(result.calls).not.toContain("volume rm");
    expect(result.calls).not.toContain(" down ");
    expect(Object.keys(treeSnapshot(targetDir))).toEqual(expect.arrayContaining(Object.keys(before)));
    expect(eventLines(result.stdout).some((line) => /^phase=rollback /.test(line))).toBe(false);
  });
});

describe("install.sh: printed recovery commands work as printed (#1456 round 2)", () => {
  it("the `ps` check printed after `left running` names the folder and works from another directory", () => {
    const { targetDir, stateDir, environment } = recoveryFixture("orbit target folder");
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_COMPOSE_STRICT: "1",
      FAKE_PROBE_FAIL: "orbit-db",
      FAKE_CONTAINERS: JSON.stringify({ "orbit-db": { status: "running", health: "starting" } }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/left running/u);
    const check = recoveryCommands(result.stderr).find((entry) => /\bps\b/u.test(entry.command));
    expect(check).toBeDefined();

    const scratch = scratchDir("elsewhere");
    const ran = failOnProcessDeadline(
      spawnSync("bash", ["-c", check.command], {
        cwd: scratch,
        env: { PATH: `${makePasteBin()}:${process.env.PATH}`, HOME: scratch, FAKE_STATE_DIR: stateDir, FAKE_COMPOSE_STRICT: "1", FAKE_CALL_LOG: join(scratch, "calls.log") },
        encoding: "utf8",
        ...processGuard(),
      }),
      { label: "printed ps check" },
    );
    expect(`${check.command} -> ${ran.status} ${ran.stderr}`).toMatch(/-> 0 /u);
    // Compose really loaded this deployment, not an empty directory.
    const loaded = JSON.parse(readOptional(join(stateDir, "strict-log")).split("\n").filter(Boolean).at(-1));
    expect(loaded.found).toBe(true);
    expect(loaded.cwd === realPath(targetDir) || loaded.argv.some((arg) => arg.includes(realPath(targetDir)))).toBe(true);
  });
});

describe("install.sh: a crash-looping required container counts as stopped (#1456 round 2)", () => {
  it.each([
    ["the database", "orbit-db"],
    ["the application", "orbit-app"],
  ])("%s reporting `running` with a rising restart count: rolled back, retry, and the facts show restarts and the exit code", (_name, service) => {
    const { targetDir, stateDir, environment, before } = recoveryFixture();
    const result = runInstall(targetDir, {
      ...environment,
      ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "6",
      FAKE_PROBE_FAIL: service,
      // Three restarts between any two reads: a crash loop by the 3-or-more threshold (O-S2).
      FAKE_CONTAINERS: JSON.stringify({ [service]: { status: "running", health: "starting", restartsRising: true, restartsStep: 3, exitCode: 137 } }),
    });
    expect(result.status).toBe(1);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(volumesLeftBehind(stateDir)).toEqual([]);
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /);
    expect(result.stderr).toMatch(/restarts=\d+/u);
    expect(result.stderr).toContain("exit-code=137");
  });
});

describe("install.sh: the local model service never ready (#1456 round 2)", () => {
  it("even when the confirmed model download succeeds, the service's last event is waiting/optional-status/continue and the completion line agrees", () => {
    const { targetDir, environment } = modelUpdateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_PROBE_FAIL: "orbit-ollama",
      FAKE_CONTAINERS: JSON.stringify({ "orbit-ollama": { status: "running", health: "starting" } }),
    });
    expect(result.status).toBe(0);
    expect(componentEvents(result.stdout, "ollama").at(-1)).toMatch(/ state=waiting reason=optional-status action=continue /);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/(Local model|Ollama|Model)[^\n]*still starting/i);
    expect(eventLines(result.stdout).some((line) => / state=failed /.test(line))).toBe(false);
  });
});

describe("install.sh: the rollback copy failing part-way (#1456 round 2)", () => {
  it("leaves no partial copy of the secrets under the state directory, and the folder unchanged", () => {
    const fixture = privateStateFixture();
    const { targetDir, stateRoot, tmp, environment } = fixture;
    // A secret too big for the file-size limit below: the copy dies after the first file.
    writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "x".repeat(20000), { mode: 0o600 });
    const before = treeSnapshot(targetDir);

    const binDir = makeFakeBin();
    const logDir = scratchDir("log");
    const result = failOnProcessDeadline(
      spawnSync("bash", ["-c", 'ulimit -c 0; ulimit -f 8; exec bash "$0" --plain', installScript], {
        cwd: targetDir,
        encoding: "utf8",
        env: { ...baseEnvironment(binDir, logDir), ...environment },
        ...processGuard(),
      }),
      { label: "limited install" },
    );

    expect(result.status).not.toBe(0);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(filesNamed(stateRoot, [".env-orbit", ".orbit-secrets", "oidc-client-secret"])).toEqual([]);
    expect(filesNamed(tmp, [".env-orbit", ".orbit-secrets", "oidc-client-secret"])).toEqual([]);
  });
});

describe("install.sh: once the database and application are ready the rollback is disarmed (#1456 round 2)", () => {
  function expectLeftInPlace(result, { targetDir, stateDir }) {
    expect(result.signalSent).toBe(true);
    expect(result.status).toBe(0);
    const events = eventLines(result.stdout);
    expect(events.some((line) => /^phase=rollback /.test(line))).toBe(false);
    expect(events.some((line) => /^phase=complete .* state=completed /.test(line))).toBe(true);
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(true);
    expect(result.calls).not.toContain("volume rm");
    expect(volumesLeftBehind(stateDir).sort()).toEqual(allThreeVolumes);
    expect(result.hungAlive).toBe(false);
  }

  it("SIGTERM during the optional scanner wait: exits 0, scanner still starting, completes", async () => {
    const { targetDir, stateDir, environment } = recoveryFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_HANG_PROBE: "orbit-clamav", ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60" },
      { signal: "SIGTERM", marker: "hung-probe" },
    );
    expectLeftInPlace(result, { targetDir, stateDir });
    expect(componentEvents(result.stdout, "clamav").at(-1)).toMatch(/ state=waiting reason=optional-status action=continue /);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Scanner: still starting/u);
  });

  it("SIGTERM during the confirmed model download: exits 0, the model not downloaded, completes", async () => {
    const { targetDir, environment } = modelUpdateFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_HANG_MODEL_PULL: "1", ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60" },
      { signal: "SIGTERM", marker: "hung-modelpull" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.status).toBe(0);
    const events = eventLines(result.stdout);
    expect(events.some((line) => /^phase=rollback /.test(line))).toBe(false);
    expect(events.some((line) => /^phase=complete .* state=completed /.test(line))).toBe(true);
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(true);
    expect(result.calls).not.toContain("volume rm");
    expect(result.hungAlive).toBe(false);
    expect(events.filter((line) => /^phase=\S+ component=(ollama|model)/.test(line)).at(-1)).toMatch(/ state=waiting reason=optional-status action=continue /);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/(Local model|Model|Ollama)[^\n]*(not downloaded|still starting|still downloading)/i);
  });
});

describe("install.sh: a model-pull container left behind by an earlier run", () => {
  const leftover = "orbit-orbit-ollama-model-pull-install";
  const confirmed = { FAKE_ENGINE_EXIT: "0", FAKE_ENGINE_OUTCOME: "status=ok\nfresh=0\nprofile=ai\nmodel-pull=1\ndatabase-volume=\n" };

  it("the name is already held: the installer removes that container before the run, and the download succeeds", () => {
    const { targetDir, stateDir, environment } = modelUpdateFixture();
    writeFileSync(join(stateDir, "model-pull-running"), leftover + "\n");
    const result = runInstall(targetDir, { ...environment, ...confirmed });
    expect(result.status).toBe(0);
    const calls = result.calls.split("\n");
    const removal = calls.findIndex((line) => /^docker rm /.test(line) && / -f /.test(line) && line.split(" ").includes(leftover));
    const run = calls.findIndex((line) => /compose .* run .*orbit-ollama-model-pull/.test(line));
    expect(removal).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThan(removal);
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/confirmed download did not complete/);
  });

  it("a download that does not complete: the retry hint does not name the container, which the next run removes itself", () => {
    const { targetDir, environment } = modelUpdateFixture();
    const result = runInstall(targetDir, { ...environment, ...confirmed, FAKE_MODEL_PULL_FAIL: "1" });
    expect(result.status).toBe(0);
    const note = `${result.stdout}\n${result.stderr}`.split("\n").find((line) => /confirmed download did not complete/.test(line)) ?? "";
    expect(note).toMatch(/To try again: docker compose /u);
    expect(note).not.toContain(leftover);
  });
});

describe("install.sh: an interrupted model download leaves no container running (#1456 round 3)", () => {
  it("SIGTERM during the confirmed model download: the model-pull container the killed client started is removed, and only that one", async () => {
    const { targetDir, stateDir, environment } = modelUpdateFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_HANG_MODEL_PULL: "1", ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60" },
      { signal: "SIGTERM", marker: "hung-modelpull" },
    );
    expect(result.signalSent).toBe(true);
    // The fake did start a model-pull container, and its client's death did not remove it.
    expect(readOptional(join(stateDir, "model-pull-started")).split("\n").filter(Boolean)).toHaveLength(1);
    const started = readOptional(join(stateDir, "model-pull-started")).trim();

    // The installer removed it.
    expect(readOptional(join(stateDir, "model-pull-running")).split("\n").filter(Boolean)).toEqual([]);

    // Scoped: any removal names only the model-pull container or service, never orbit-ollama or the whole project.
    for (const line of result.calls.split("\n")) {
      if (/^docker (rm|stop|kill) /.test(line)) expect(line.split(" ").slice(2).filter((arg) => !arg.startsWith("-"))).toEqual([started]);
      if (/^docker compose .* (rm|stop|kill) /.test(line)) {
        const afterVerb = line.split(/ (?:rm|stop|kill) /)[1].split(" ").filter((arg) => !arg.startsWith("-"));
        expect(afterVerb).toEqual(["orbit-ollama-model-pull"]);
      }
      expect(line).not.toMatch(/^docker compose .* down( |$)/);
    }
  });
});

describe("install.sh: the rollback's shutdown is bounded (O-F6)", () => {
  it("the rollback's `compose down` carries `--timeout 2`", () => {
    const { targetDir, environment } = recoveryFixture();
    const result = runInstall(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    const downs = result.calls.split("\n").filter((line) => /^docker compose .* down( |$)/u.test(line));
    expect(downs.length).toBeGreaterThan(0);
    for (const line of downs) expect(line).toMatch(/ --timeout 2( |$)/u);
  });
});

describe("install.sh: one or two restarts are not a crash loop; three are (O-S2)", () => {
  it("the database running, restart count +2 since the earlier sample: left in place, `repair`, no rollback", () => {
    const { targetDir, stateDir, environment } = recoveryFixture();
    const result = runInstall(targetDir, {
      ...environment,
      ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "6",
      FAKE_PROBE_FAIL: "orbit-db",
      FAKE_CONTAINERS: JSON.stringify({ "orbit-db": { status: "running", health: "starting", restarts: 1, restartsJump: 2 } }),
    });
    expect(result.status).toBe(1);
    for (const file of ["docker-compose.yml", ".env-orbit", ".orbit-secrets"]) expect(existsSync(join(targetDir, file))).toBe(true);
    expect(volumesLeftBehind(stateDir).sort()).toEqual(allThreeVolumes);
    expect(result.calls).not.toContain("volume rm");
    expect(result.calls).not.toContain(" down ");
    expect(terminalFailure(result.stdout)).toMatch(/ action=repair /);
    expect(result.stderr).toMatch(/left running/u);
  });

  it("the database running, restart count +3 since the earlier sample: a crash loop, rolled back, `retry`", () => {
    const { targetDir, stateDir, environment, before } = recoveryFixture();
    const result = runInstall(targetDir, {
      ...environment,
      ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "6",
      FAKE_PROBE_FAIL: "orbit-db",
      FAKE_CONTAINERS: JSON.stringify({ "orbit-db": { status: "running", health: "starting", restarts: 1, restartsJump: 3 } }),
    });
    expect(result.status).toBe(1);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(volumesLeftBehind(stateDir)).toEqual([]);
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /);
  });
});
