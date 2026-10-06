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
// owns the app). No test reaches a real daemon.

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
// when set, and exits FAKE_ENGINE_STATUS.
const FAKE_DOCKER = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(argv) + "\\n");
if (argv[0] === "info") { process.stdout.write("[name=seccomp,profile=builtin name=cgroupns]\\n"); process.exit(0); }
if (argv[0] !== "compose") process.exit(1);
if (argv[1] === "version") process.exit(0);
const verb = argv[3];
if (verb === "stop") process.exit(Number(process.env.FAKE_STOP_STATUS || 0));
if (verb === "start") process.exit(Number(process.env.FAKE_START_STATUS || 0));
if (verb === "run") {
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

/** The compose verbs in call order: "stop", "run", "start". */
function verbs(calls) {
  return calls.filter((call) => call[0] === "compose" && call[1] === "--env-file").map((call) => call[3]);
}

/** The pieces of the `compose run` argv these tests assert on. */
function engineRun(calls) {
  const call = calls.find((entry) => entry[0] === "compose" && entry[3] === "run");
  if (!call) return undefined;
  const flags = call.slice(4, call.indexOf("--entrypoint"));
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
    envFile: call[2],
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
    expect(result.calls.filter((call) => call[0] === "compose" && call[1] === "--env-file").every((call) => call[2] === "other.env")).toBe(true);
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

  it.each(["backup.sh", "restore.sh", "import-recovery-bundle.sh"])(
    "%s leaves the app to the run that holds the backup/restore lock (engine exit 75)",
    (script) => {
      const deployment = makeDeployment();
      const bundle = join(deployment.deployDir, "b.tar");
      writeFileSync(bundle, "bundle");
      const result = run(deployment, script, script === "backup.sh" ? [] : [bundle], { env: { FAKE_ENGINE_STATUS: String(ENGINE_LOCKED_EXIT) } });
      expect(result.status).toBe(ENGINE_LOCKED_EXIT);
      expect(verbs(result.calls)).toEqual(["stop", "run"]);
      expect(result.probes).toEqual([]);
    },
  );

  it.each([
    ["restore.sh", ["--yes"]],
    ["restore.sh", ["--recover"]],
    ["import-recovery-bundle.sh", []],
  ])("%s %j: success starts the app and waits for health", (script, flags) => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, script, flags[0] === "--recover" ? flags : [...flags, bundle]);
    expect(result.status).toBe(0);
    expect(verbs(result.calls)).toEqual(["stop", "run", "start"]);
    expect(result.probes).toEqual(["--fail --silent --max-time 2 http://127.0.0.1:3000/api/health"]);
  });

  it.each([
    ["restore.sh", ["--yes"]],
    ["restore.sh", ["--recover"]],
    ["import-recovery-bundle.sh", []],
  ])("%s %j: a failure with no journal starts the app and waits for health", (script, flags) => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, script, flags[0] === "--recover" ? flags : [...flags, bundle], { env: { FAKE_ENGINE_STATUS: "1" } });
    expect(result.status).toBe(1);
    expect(verbs(result.calls)).toEqual(["stop", "run", "start"]);
    expect(result.probes.length).toBeGreaterThan(0);
  });

  it.each([
    ["restore.sh", ["--yes"]],
    ["restore.sh", ["--recover"]],
    ["import-recovery-bundle.sh", []],
  ])("%s %j: an unfinished-restore journal keeps Orbit stopped and points at --recover", (script, flags) => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, script, flags[0] === "--recover" ? flags : [...flags, bundle], {
      env: { FAKE_ENGINE_STATUS: "1", FAKE_ENGINE_JOURNAL: deployment.journal },
    });
    expect(result.status).toBe(1);
    expect(verbs(result.calls)).toEqual(["stop", "run"]);
    expect(result.probes).toEqual([]);
    expect(result.stderr).toContain("bash scripts/restore.sh --recover");
  });

  it("restore.sh: a hard-killed engine (exit 137) that left its journal keeps Orbit stopped", () => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, "restore.sh", ["--yes", bundle], { env: { FAKE_ENGINE_STATUS: "137", FAKE_ENGINE_JOURNAL: deployment.journal } });
    expect(result.status).toBe(137);
    expect(verbs(result.calls)).toEqual(["stop", "run"]);
  });

  it("restore.sh reports a restore that never became healthy, and fails", () => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, "restore.sh", ["--yes", bundle], { env: { FAKE_CURL_STATUS: "7", ORBIT_RESTORE_HEALTH_SECONDS: "1" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Orbit did not become healthy");
  });

  it("restore.sh refuses before running the engine when orbit-app cannot be stopped", () => {
    const deployment = makeDeployment();
    const bundle = join(deployment.deployDir, "b.tar");
    writeFileSync(bundle, "bundle");
    const result = run(deployment, "restore.sh", ["--yes", bundle], { env: { FAKE_STOP_STATUS: "1" } });
    expect(result.status).toBe(1);
    expect(verbs(result.calls)).toEqual(["stop"]);
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

  it.each(SCRIPTS)("%s stays a thin shell (at most 120 lines)", (script) => {
    expect(readFileSync(join(scriptsDir, script), "utf8").split("\n").length).toBeLessThanOrEqual(121);
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
