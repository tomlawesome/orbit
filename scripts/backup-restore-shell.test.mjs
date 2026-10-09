import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// scripts/backup.sh, restore.sh, export-recovery-bundle.sh and
// import-recovery-bundle.sh after #1211: thin shells that stop and start
// orbit-app and run `orbit backup|restore|export-recovery-bundle|
// import-recovery-bundle` as one `docker compose run --rm --no-deps` one-off
// on the orbit-app service (build notes E3-E5). A fake `docker` (and `curl`)
// on PATH records every call and plays the engine's part as configured, so
// these tests prove the docker invocation and the shell's one rule: stop,
// run the engine, then start the app and wait for health, unless the
// engine left an unfinished-restore journal behind (Orbit stays stopped for
// `restore.sh --recover`) or another backup/restore holds the lock (that run
// owns the app). restore.sh <bundle> and import-recovery-bundle.sh first
// validate the bundle with an engine `--preflight` run while Orbit is still
// up, and stop it only once that passed (#1211 amendment E3a). No test
// reaches a real daemon.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = ["backup.sh", "restore.sh", "export-recovery-bundle.sh", "import-recovery-bundle.sh"];
const ENGINE_LOCKED_EXIT = 75;

const scratchDirs = [];
afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop(), { recursive: true, force: true });
});
function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

// The fake docker. `compose ... run` stands in for the engine: it prints
// FAKE_ENGINE_STDOUT, creates FAKE_ENGINE_JOURNAL (an unfinished restore)
// when set, and exits FAKE_ENGINE_STATUS. A `--preflight` run does none of
// that: it exits FAKE_PREFLIGHT_STATUS (default 0), as the engine's
// preflight leaves no journal and prints nothing on success. Every run
// appends to FAKE_ENGINE_STDIN_KIND_LOG whether its standard input was
// /dev/null.
const FAKE_DOCKER = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(argv) + "\\n");
if (argv[0] === "info") { process.stdout.write("[name=seccomp,profile=builtin name=cgroupns]\\n"); process.exit(0); }
if (argv[0] !== "compose") process.exit(1);
if (argv[1] === "version") process.exit(0);
let verbIndex = 1;
while (argv[verbIndex] === "--project-name" || argv[verbIndex] === "--env-file") verbIndex += 2;
const verb = argv[verbIndex];
if (verb === "stop") process.exit(Number(process.env.FAKE_STOP_STATUS || 0));
if (verb === "start") process.exit(Number(process.env.FAKE_START_STATUS || 0));
if (verb === "run") {
  if (process.env.FAKE_ENGINE_STDIN_KIND_LOG) {
    const { fstatSync, statSync } = require("node:fs");
    const stdin = fstatSync(0);
    const devNull = statSync("/dev/null");
    appendFileSync(process.env.FAKE_ENGINE_STDIN_KIND_LOG, (stdin.isCharacterDevice() && stdin.rdev === devNull.rdev ? "devnull" : "other") + "\\n");
  }
  if (argv.includes("--preflight")) process.exit(Number(process.env.FAKE_PREFLIGHT_STATUS || 0));
  if (process.env.FAKE_ENGINE_STDIN_LOG) {
    let input = "";
    try { input = require("node:fs").readFileSync(0, "utf8"); } catch {}
    writeFileSync(process.env.FAKE_ENGINE_STDIN_LOG, input);
  }
  if (process.env.FAKE_ENGINE_JOURNAL) {
    mkdirSync(dirname(process.env.FAKE_ENGINE_JOURNAL), { recursive: true });
    writeFileSync(process.env.FAKE_ENGINE_JOURNAL, "state=checkpointed\\n");
  }
  if (process.env.FAKE_ENGINE_STDOUT) process.stdout.write(process.env.FAKE_ENGINE_STDOUT);
  process.exit(Number(process.env.FAKE_ENGINE_STATUS || 0));
}
process.exit(1);
`;

const FAKE_CURL = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
exit "\${FAKE_CURL_STATUS:-0}"
`;

function makeDeployment({ envFile = "ORBIT_IMAGE=orbit-local:abcdef123456\n", key = true } = {}) {
  const deployDir = scratchDir("orbit-backup-shell-");
  mkdirSync(join(deployDir, "scripts"));
  for (const script of SCRIPTS) writeFileSync(join(deployDir, "scripts", script), readFileSync(join(scriptsDir, script)));
  writeFileSync(join(deployDir, ".env-orbit"), envFile, { mode: 0o600 });
  mkdirSync(join(deployDir, ".orbit-secrets"), { mode: 0o700 });
  if (key) writeFileSync(join(deployDir, ".orbit-secrets", "document-kek"), `${"a".repeat(64)}\n`, { mode: 0o600 });
  const binDir = join(deployDir, "fakebin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "docker"), FAKE_DOCKER);
  writeFileSync(join(binDir, "curl"), FAKE_CURL);
  chmodSync(join(binDir, "docker"), 0o755);
  chmodSync(join(binDir, "curl"), 0o755);
  return { deployDir, binDir, journal: join(deployDir, "backups", ".orbit-restore", "restore.journal") };
}

function run(deployment, script, args, { env = {}, input = "" } = {}) {
  const dockerLog = join(deployment.binDir, "docker.jsonl");
  const curlLog = join(deployment.binDir, "curl.log");
  rmSync(dockerLog, { force: true });
  rmSync(curlLog, { force: true });
  const result = failOnProcessDeadline(
    spawnSync("bash", [join(deployment.deployDir, "scripts", script), ...args], {
      cwd: deployment.deployDir,
      input,
      encoding: "utf8",
      env: {
        PATH: `${deployment.binDir}:${process.env.PATH}`,
        HOME: process.env.HOME ?? tmpdir(),
        FAKE_DOCKER_LOG: dockerLog,
        FAKE_CURL_LOG: curlLog,
        ...env,
      },
      ...processGuard(),
    }),
    { label: `${script} ${args.join(" ")}` },
  );
  const calls = existsSync(dockerLog) ? readFileSync(dockerLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const probes = existsSync(curlLog) ? readFileSync(curlLog, "utf8").trim().split("\n").filter(Boolean) : [];
  return { ...result, calls, probes };
}

/**
 * One `docker compose` call split into its global options (--project-name,
 * --env-file, in either order), its verb and the rest. The scripts name the
 * Compose project explicitly (#1345), so the verb's position is not fixed.
 */
function composeCall(call) {
  const options = {};
  let index = 1;
  while (call[index] === "--project-name" || call[index] === "--env-file") {
    options[call[index]] = call[index + 1];
    index += 2;
  }
  return { project: options["--project-name"], envFile: options["--env-file"], verb: call[index], rest: call.slice(index + 1) };
}

/** Every docker call that went through the script's compose() wrapper. */
function composeCalls(calls) {
  return calls.filter((call) => call[0] === "compose" && call.includes("--env-file")).map(composeCall);
}

/** The compose verbs in call order: "stop", "run", "start". */
function verbs(calls) {
  return composeCalls(calls).map((call) => call.verb);
}

/** Every `compose run` in call order, parsed by parseRun. */
function engineRuns(calls) {
  return composeCalls(calls).filter((call) => call.verb === "run").map(parseRun);
}

/** The engine run that does the work: the last one (a restore or import first runs a --preflight). */
function engineRun(calls) {
  return engineRuns(calls).at(-1);
}

/** The pieces of a `compose run` argv these tests assert on. */
function parseRun(composed) {
  const call = composed.rest;
  const flags = call.slice(0, call.indexOf("--entrypoint"));
  const env = {};
  const volumes = [];
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index] === "-e") {
      const [name, ...value] = flags[++index].split("=");
      env[name] = value.join("=");
    } else if (flags[index] === "-v") volumes.push(flags[++index]);
  }
  const entrypointIndex = call.indexOf("--entrypoint");
  return {
    envFile: composed.envFile,
    project: composed.project,
    flags: flags.filter((flag) => flag.startsWith("-") && flag !== "-e" && flag !== "-v"),
    env,
    volumes,
    entrypoint: call[entrypointIndex + 1],
    service: call[entrypointIndex + 2],
    command: call.slice(entrypointIndex + 3),
  };
}

describe("the one-off each script becomes (E1/E5)", () => {
  it("backup.sh runs orbit backup as a compose one-off on orbit-app with the deployment at /orbit-deploy", () => {
    const deployment = makeDeployment();
    const result = run(deployment, "backup.sh", [], { env: { FAKE_ENGINE_STDOUT: "Orbit backup created: /srv/x.tar\n" } });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Orbit backup created: /srv/x.tar\n");
    const engine = engineRun(result.calls);
    expect(engine.envFile).toBe(".env-orbit");
    expect(engine.flags).toEqual(["--rm", "--no-deps", "-i", "-T"]);
    expect(engine.volumes).toEqual([`${deployment.deployDir}:/orbit-deploy:rw`]);
    expect(engine.env).toMatchObject({ ORBIT_HOST_UID: String(process.getuid()), ORBIT_HOST_GID: String(process.getgid()), ORBIT_HOST_DEPLOY_DIR: deployment.deployDir });
    expect(engine.entrypoint).toBe("node");
    expect(engine.service).toBe("orbit-app");
    expect(engine.command).toEqual(["/opt/orbit/cli/orbit.js", "backup", "--dir", "/orbit-deploy"]);
  });

  it.each([
    ["backup.sh", ["--verify"], ["backup", "--verify", "/orbit-input/bundle.tar"]],
    ["restore.sh", ["--yes"], ["restore", "--yes", "/orbit-input/bundle.tar"]],
    ["export-recovery-bundle.sh", [], ["export-recovery-bundle", "/orbit-input/bundle.tar"]],
    ["import-recovery-bundle.sh", [], ["import-recovery-bundle", "/orbit-input/bundle.tar"]],
  ])("%s mounts the bundle it is given read-only at /orbit-input/bundle.tar and says where it came from", (script, flags, command) => {
    const deployment = makeDeployment();
    const bundle = join(scratchDir("orbit-bundle-"), "some bundle.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, script, [...flags, bundle]);
    const engine = engineRun(result.calls);
    expect(engine.volumes).toContain(`${bundle}:/orbit-input/bundle.tar:ro`);
    expect(engine.env.ORBIT_HOST_INPUT_FILE).toBe(bundle);
    expect(engine.command).toEqual(["/opt/orbit/cli/orbit.js", ...command, "--dir", "/orbit-deploy"]);
  });

  it.each(SCRIPTS)("%s maps an outside ORBIT_BACKUP_DIR and ORBIT_SECRETS_DIR onto mounts and flags", (script) => {
    const deployment = makeDeployment();
    const outside = scratchDir("orbit-outside-");
    const backups = join(outside, "backups");
    const secrets = join(outside, "secrets");
    mkdirSync(secrets);
    writeFileSync(join(secrets, "document-kek"), `${"a".repeat(64)}\n`, { mode: 0o600 });
    const bundle = join(outside, "bundle.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, script, script === "backup.sh" ? [] : [bundle], { env: { ORBIT_BACKUP_DIR: backups, ORBIT_SECRETS_DIR: secrets } });
    const engine = engineRun(result.calls);
    expect(engine.volumes).toEqual(expect.arrayContaining([`${backups}:/orbit-backups:rw`, `${secrets}:/orbit-secrets:rw`]));
    expect(engine.env).toMatchObject({ ORBIT_HOST_BACKUP_DIR: backups, ORBIT_HOST_SECRETS_DIR: secrets });
    expect(engine.command.slice(-6)).toEqual(["--dir", "/orbit-deploy", "--backup-dir", "/orbit-backups", "--secrets-dir", "/orbit-secrets"]);
    // Created by the shell, as the operator, before docker could create it as root.
    expect(statSync(backups).mode & 0o777).toBe(0o700);
  });

  it("ORBIT_ENV_FILE is the env file compose reads", () => {
    const deployment = makeDeployment();
    writeFileSync(join(deployment.deployDir, "other.env"), "ORBIT_IMAGE=orbit-local:abcdef123456\n");
    const result = run(deployment, "backup.sh", [], { env: { ORBIT_ENV_FILE: "other.env" } });
    expect(composeCalls(result.calls).length).toBeGreaterThan(0);
    expect(composeCalls(result.calls).every((call) => call.envFile === "other.env")).toBe(true);
  });

  it("forwards restore.sh's test switches and ORBIT_NONINTERACTIVE_RESTORE, and nothing unset", () => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const switches = {
      ORBIT_NONINTERACTIVE_RESTORE: "true",
      ORBIT_RESTORE_TEST_MODE: "true",
      ORBIT_RESTORE_TEST_SYNC_FAILURE_STAGE: "journal-file",
      ORBIT_RESTORE_TEST_FAILURE_STAGE: "after-document-replacement",
      ORBIT_RESTORE_TEST_CHECKPOINT_FAILURE: "true",
      ORBIT_RESTORE_TEST_HARD_INTERRUPT_STAGE: "after-checkpoint",
    };
    const engine = engineRun(run(deployment, "restore.sh", ["--yes", bundle], { env: switches }).calls);
    expect(engine.env).toMatchObject(switches);
    const bare = engineRun(run(deployment, "restore.sh", ["--yes", bundle]).calls);
    expect(Object.keys(bare.env).filter((name) => name.startsWith("ORBIT_RESTORE_TEST") || name === "ORBIT_NONINTERACTIVE_RESTORE")).toEqual([]);
  });

  it.each(["export-recovery-bundle.sh", "import-recovery-bundle.sh"])("%s forwards ORBIT_RECOVERY_TEST_MODE and passes standard input straight through", (script) => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "r.tar");
    writeFileSync(bundle, "bundle");
    const stdinLog = join(deployment.binDir, "stdin.txt");
    const passphrase = "orbit-test-recovery-passphrase";
    const result = run(deployment, script, [bundle], { env: { ORBIT_RECOVERY_TEST_MODE: "true", FAKE_ENGINE_STDIN_LOG: stdinLog }, input: `${passphrase}\n${passphrase}\n` });
    expect(engineRun(result.calls).env.ORBIT_RECOVERY_TEST_MODE).toBe("true");
    expect(readFileSync(stdinLog, "utf8")).toBe(`${passphrase}\n${passphrase}\n`);
    // The passphrase only ever travels on standard input.
    expect(JSON.stringify(result.calls)).not.toContain(passphrase);
  });

  it.each(SCRIPTS)("%s passes the engine's exit status through", (script) => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, script, script === "backup.sh" ? [] : [bundle], { env: { FAKE_ENGINE_STATUS: "3" } });
    expect(result.status).toBe(3);
  });
});

describe("refusals that never reach docker", () => {
  it.each([
    ["backup.sh", ["extra"]],
    ["backup.sh", ["--verify"]],
    ["restore.sh", []],
    ["restore.sh", ["--recover", "x.tar"]],
    ["export-recovery-bundle.sh", []],
    ["import-recovery-bundle.sh", []],
  ])("%s %j is a usage error that stops nothing", (script, args) => {
    const deployment = makeDeployment();
    const result = run(deployment, script, args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/[Uu]sage/);
    expect(verbs(result.calls)).toEqual([]);
  });

  it.each(["restore.sh", "import-recovery-bundle.sh", "export-recovery-bundle.sh", "backup.sh"])("%s refuses a bundle that is a symbolic link before stopping anything", (script) => {
    const deployment = makeDeployment();
    const target = join(deployment.deployDir, "real.tar");
    writeFileSync(target, "bundle");
    const link = join(deployment.deployDir, "link.tar");
    spawnSync("ln", ["-s", target, link]);
    const result = run(deployment, script, script === "backup.sh" ? ["--verify", link] : [link]);
    expect(result.status).not.toBe(0);
    expect(verbs(result.calls)).toEqual([]);
  });

  it.each(["backup.sh", "restore.sh", "import-recovery-bundle.sh"])("%s refuses a missing document key before stopping the app, which could not start again without it", (script) => {
    const deployment = makeDeployment({ key: false });
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, script, script === "backup.sh" ? [] : [bundle]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the configured document key is missing");
    expect(verbs(result.calls)).toEqual([]);
  });

  it.each(SCRIPTS)("%s refuses without .env-orbit", (script) => {
    const deployment = makeDeployment();
    rmSync(join(deployment.deployDir, ".env-orbit"));
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, script, script === "backup.sh" ? [] : [bundle]);
    expect(result.status).toBe(1);
    expect(verbs(result.calls)).toEqual([]);
  });
});

// #1345: the scripts must address the Compose project the install created.
// Compose's own order is caller environment, then --env-file, then the compose
// file's name:, so with no --project-name an exported COMPOSE_PROJECT_NAME beat
// the one install wrote to .env-orbit. They derive the name as repair.sh does:
// .env-orbit, then the caller's environment, then docker-compose.yml's name:,
// then the directory.
describe("every compose call names the project (#1345)", () => {
  const composeFile = "name: orbit\n\nservices:\n  orbit-app:\n    image: busybox\n";
  const argsFor = (script, deployment) => {
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    return script === "backup.sh" ? [] : [bundle];
  };

  it.each(SCRIPTS)("%s uses .env-orbit's COMPOSE_PROJECT_NAME over the caller's", (script) => {
    const deployment = makeDeployment({ envFile: "COMPOSE_PROJECT_NAME=hz1345-from-file\n" });
    const result = run(deployment, script, argsFor(script, deployment), { env: { COMPOSE_PROJECT_NAME: "hz1345-from-caller" } });
    expect(result.status).toBe(0);
    const projects = composeCalls(result.calls).map((call) => call.project);
    expect(projects.length).toBeGreaterThan(0);
    expect(new Set(projects)).toEqual(new Set(["hz1345-from-file"]));
  });

  it.each(SCRIPTS)("%s uses the caller's COMPOSE_PROJECT_NAME when .env-orbit names none", (script) => {
    const deployment = makeDeployment();
    writeFileSync(join(deployment.deployDir, "docker-compose.yml"), composeFile);
    const result = run(deployment, script, argsFor(script, deployment), { env: { COMPOSE_PROJECT_NAME: "hz1345-from-caller" } });
    expect(new Set(composeCalls(result.calls).map((call) => call.project))).toEqual(new Set(["hz1345-from-caller"]));
  });

  it.each(SCRIPTS)("%s falls back to docker-compose.yml's name:, not the directory, from a directory not called orbit", (script) => {
    const deployment = makeDeployment();
    writeFileSync(join(deployment.deployDir, "docker-compose.yml"), composeFile);
    expect(deployment.deployDir.split("/").pop()).not.toBe("orbit");
    const result = run(deployment, script, argsFor(script, deployment));
    expect(new Set(composeCalls(result.calls).map((call) => call.project))).toEqual(new Set(["orbit"]));
  });
});

describe("the stop / engine / start rule (E3)", () => {
  it("backup.sh stops orbit-app, runs the engine, and starts it again", () => {
    const deployment = makeDeployment();
    expect(verbs(run(deployment, "backup.sh", []).calls)).toEqual(["stop", "run", "start"]);
  });

  it("backup.sh starts the app again when the backup fails", () => {
    const deployment = makeDeployment();
    const result = run(deployment, "backup.sh", [], { env: { FAKE_ENGINE_STATUS: "1" } });
    expect(result.status).toBe(1);
    expect(verbs(result.calls)).toEqual(["stop", "run", "start"]);
  });

  it("backup.sh --verify and export-recovery-bundle.sh leave the app alone", () => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    expect(verbs(run(deployment, "backup.sh", ["--verify", bundle]).calls)).toEqual(["run"]);
    expect(verbs(run(deployment, "export-recovery-bundle.sh", [bundle]).calls)).toEqual(["run"]);
  });

  it.each([
    ["backup.sh", ["stop", "run"]],
    ["restore.sh", ["run", "stop", "run"]],
    ["import-recovery-bundle.sh", ["run", "stop", "run"]],
  ])("%s leaves the app to the run that holds the backup/restore lock (engine exit 75)", (script, expected) => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, script, script === "backup.sh" ? [] : [bundle], { env: { FAKE_ENGINE_STATUS: String(ENGINE_LOCKED_EXIT) } });
    expect(result.status).toBe(ENGINE_LOCKED_EXIT);
    expect(verbs(result.calls)).toEqual(expected);
    expect(result.probes).toEqual([]);
  });

  // A bundle is validated while Orbit runs (E3a); --recover has none, so it stops first as before.
  const RESTORE_CASES = [
    ["restore.sh", ["--yes"], ["run", "stop", "run"]],
    ["restore.sh", ["--recover"], ["stop", "run"]],
    ["import-recovery-bundle.sh", [], ["run", "stop", "run"]],
  ];

  it.each(RESTORE_CASES)("%s %j: success starts the app and waits for health", (script, flags, engineVerbs) => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, script, flags[0] === "--recover" ? flags : [...flags, bundle]);
    expect(result.status).toBe(0);
    expect(verbs(result.calls)).toEqual([...engineVerbs, "start"]);
    expect(result.probes).toEqual(["--fail --silent --max-time 2 http://127.0.0.1:3000/api/health"]);
  });

  it.each(RESTORE_CASES)("%s %j: a failure with no journal starts the app and waits for health", (script, flags, engineVerbs) => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, script, flags[0] === "--recover" ? flags : [...flags, bundle], { env: { FAKE_ENGINE_STATUS: "1" } });
    expect(result.status).toBe(1);
    expect(verbs(result.calls)).toEqual([...engineVerbs, "start"]);
    expect(result.probes.length).toBeGreaterThan(0);
  });

  it.each(RESTORE_CASES)("%s %j: an unfinished-restore journal keeps Orbit stopped and points at --recover", (script, flags, engineVerbs) => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, script, flags[0] === "--recover" ? flags : [...flags, bundle], {
      env: { FAKE_ENGINE_STATUS: "1", FAKE_ENGINE_JOURNAL: deployment.journal },
    });
    expect(result.status).toBe(1);
    expect(verbs(result.calls)).toEqual(engineVerbs);
    expect(result.probes).toEqual([]);
    expect(result.stderr).toContain("bash scripts/restore.sh --recover");
  });

  it("restore.sh: a hard-killed engine (exit 137) that left its journal keeps Orbit stopped", () => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, "restore.sh", ["--yes", bundle], { env: { FAKE_ENGINE_STATUS: "137", FAKE_ENGINE_JOURNAL: deployment.journal } });
    expect(result.status).toBe(137);
    expect(verbs(result.calls)).toEqual(["run", "stop", "run"]);
  });

  it("restore.sh reports a restore that never became healthy, and fails", () => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, "restore.sh", ["--yes", bundle], { env: { FAKE_CURL_STATUS: "7", ORBIT_RESTORE_HEALTH_SECONDS: "1" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Orbit did not become healthy");
  });

  it("restore.sh refuses before the full engine run when orbit-app cannot be stopped", () => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, "restore.sh", ["--yes", bundle], { env: { FAKE_STOP_STATUS: "1" } });
    expect(result.status).toBe(1);
    expect(verbs(result.calls)).toEqual(["run", "stop"]);
    expect(engineRun(result.calls).command).toContain("--preflight");
  });
});

// Amendment E3a: a bundle Orbit cannot restore must never cost the running
// instance anything, so restore.sh <bundle> and import-recovery-bundle.sh
// validate it with the engine's --preflight while Orbit is still up, and
// only then stop it for the full run.
describe("validate the bundle before stopping Orbit (E3a)", () => {
  const PREFLIGHT_CASES = [
    ["restore.sh", ["--yes"], ["restore", "--preflight", "/orbit-input/bundle.tar"]],
    ["restore.sh", [], ["restore", "--preflight", "/orbit-input/bundle.tar"]],
    ["import-recovery-bundle.sh", [], ["import-recovery-bundle", "--preflight", "/orbit-input/bundle.tar"]],
  ];

  it.each(PREFLIGHT_CASES)("%s %j runs the engine's preflight first, then stops, runs and starts", (script, flags, preflightCommand) => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const stdinKinds = join(deployment.binDir, "stdin-kinds.log");
    const result = run(deployment, script, [...flags, bundle], { env: { FAKE_ENGINE_STDIN_KIND_LOG: stdinKinds } });
    expect(result.status).toBe(0);
    expect(verbs(result.calls)).toEqual(["run", "stop", "run", "start"]);
    const [preflight, full] = engineRuns(result.calls);
    expect(preflight.command).toEqual(["/opt/orbit/cli/orbit.js", ...preflightCommand, "--dir", "/orbit-deploy"]);
    expect(preflight.command).not.toContain("--yes");
    expect(preflight.flags).toContain("-T");
    expect(preflight.flags).not.toContain("-t");
    expect(preflight.volumes).toContain(`${bundle}:/orbit-input/bundle.tar:ro`);
    expect(full.command).not.toContain("--preflight");
    // The preflight never reads the operator's terminal: its standard input
    // is /dev/null, which is also what makes run_engine pick -T. The full
    // run keeps the shell's own standard input for prompts.
    expect(readFileSync(stdinKinds, "utf8")).toBe("devnull\nother\n");
  });

  it.each(PREFLIGHT_CASES)("%s %j: a preflight refusal is the engine run alone; Orbit is never stopped", (script, flags) => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, script, [...flags, bundle], { env: { FAKE_PREFLIGHT_STATUS: "1" } });
    expect(result.status).toBe(1);
    expect(verbs(result.calls)).toEqual(["run"]);
    expect(result.probes).toEqual([]);
  });

  it.each(PREFLIGHT_CASES)("%s %j: a preflight that finds the lock held (exit 75) touches nothing", (script, flags) => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, script, [...flags, bundle], { env: { FAKE_PREFLIGHT_STATUS: String(ENGINE_LOCKED_EXIT) } });
    expect(result.status).toBe(ENGINE_LOCKED_EXIT);
    expect(verbs(result.calls)).toEqual(["run"]);
    expect(result.probes).toEqual([]);
  });

  it("restore.sh --recover has no bundle to validate: it stops, runs and starts as before", () => {
    const deployment = makeDeployment();
    const result = run(deployment, "restore.sh", ["--recover"]);
    expect(verbs(result.calls)).toEqual(["stop", "run", "start"]);
    expect(engineRuns(result.calls).map((engine) => engine.command)).toEqual([["/opt/orbit/cli/orbit.js", "restore", "--recover", "--dir", "/orbit-deploy"]]);
  });

  it("import-recovery-bundle.sh asks for the passphrase once, in the full run", () => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "r.tar");
    writeFileSync(bundle, "bundle");
    const stdinLog = join(deployment.binDir, "stdin.txt");
    const passphrase = "orbit-test-recovery-passphrase";
    const result = run(deployment, "import-recovery-bundle.sh", [bundle], { env: { FAKE_ENGINE_STDIN_LOG: stdinLog }, input: `${passphrase}\n` });
    expect(result.status).toBe(0);
    expect(engineRuns(result.calls)).toHaveLength(2);
    expect(readFileSync(stdinLog, "utf8")).toBe(`${passphrase}\n`);
  });
});

// restore.sh's health_probe_url (#383 finding 3, #1241): the probe follows
// the address and port docker-compose.yml publishes orbit-app on.
describe("restore.sh and import-recovery-bundle.sh health probe", () => {
  it.each([
    ["no keys", "", {}, "http://127.0.0.1:3000/api/health"],
    ["explicit default bind address", "ORBIT_BIND_ADDRESS=0.0.0.0\nORBIT_PORT=3000\n", {}, "http://127.0.0.1:3000/api/health"],
    ["custom bind address, default port", "ORBIT_BIND_ADDRESS=192.0.2.50\n", {}, "http://192.0.2.50:3000/api/health"],
    ["default bind address, custom port", "ORBIT_PORT=8443\n", {}, "http://127.0.0.1:8443/api/health"],
    ["custom bind address and port among unrelated lines", "\nCOMPOSE_PROFILES=mail\nORBIT_PORT=4000\n\nORBIT_BIND_ADDRESS=198.51.100.1\n", {}, "http://198.51.100.1:4000/api/health"],
    ["an exported value wins over the file, as for compose (#1241)", "ORBIT_PORT=4000\n", { ORBIT_PORT: "4100" }, "http://127.0.0.1:4100/api/health"],
  ])("%s", (_label, keys, env, url) => {
    for (const script of ["restore.sh", "import-recovery-bundle.sh"]) {
      const deployment = makeDeployment({ envFile: `ORBIT_IMAGE=orbit-local:abcdef123456\n${keys}` });
      const bundle = join(deployment.deployDir, "b.tar");
      writeFileSync(bundle, "bundle");
      const result = run(deployment, script, script === "restore.sh" ? ["--yes", bundle] : [bundle], { env });
      expect(result.probes, script).toEqual([`--fail --silent --max-time 2 ${url}`]);
    }
  });
});

describe("shared shapes", () => {
  function functionText(source, name) {
    const start = source.indexOf(`${name}() {`);
    if (start < 0) return undefined;
    return source.slice(start, source.indexOf("\n}\n", start) + 2);
  }

  it.each(SCRIPTS)("%s decides the operator's identity with configure.sh's own engine_host_identity, word for word (D5)", (script) => {
    const configure = readFileSync(join(scriptsDir, "configure.sh"), "utf8");
    const source = readFileSync(join(scriptsDir, script), "utf8");
    expect(functionText(source, "engine_host_identity")).toBe(functionText(configure, "engine_host_identity"));
  });

  // The functions every one of the four carries verbatim (#1345) sit between
  // two marker lines and are pinned identical by
  // compose-project-name-resolution.test.mjs; the cap is on what is each
  // script's own, which is what "thin" has always been about.
  it.each(SCRIPTS)("%s stays a thin shell (at most 120 lines of its own, outside the shared functions)", (script) => {
    const source = readFileSync(join(scriptsDir, script), "utf8");
    const start = source.indexOf("# --- Shared by ");
    const end = source.indexOf("# --- End of the shared functions.");
    expect(start, "the shared-functions start marker").toBeGreaterThanOrEqual(0);
    expect(end, "the shared-functions end marker").toBeGreaterThan(start);
    const own = source.slice(0, start) + source.slice(source.indexOf("\n", end) + 1);
    expect(own.split("\n").length).toBeLessThanOrEqual(121);
  });

  it("under rootless Docker the engine is told 0:0, since container root is the operator", () => {
    const deployment = makeDeployment();
    writeFileSync(
      join(deployment.binDir, "docker"),
      FAKE_DOCKER.replace("[name=seccomp,profile=builtin name=cgroupns]", "[name=seccomp,profile=builtin name=rootless name=cgroupns]"),
    );
    const engine = engineRun(run(deployment, "backup.sh", []).calls);
    expect(engine.env).toMatchObject({ ORBIT_HOST_UID: "0", ORBIT_HOST_GID: "0" });
  });
});
