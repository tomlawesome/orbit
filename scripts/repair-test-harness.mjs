// Shared harness for the #1804 / #1798 repair tests. Same idea as
// repair-start-services.test.mjs: repair.sh runs from a copied fixture with a
// fake `docker` ahead of the real one on PATH. The base shim is lifted from
// repair.test.mjs (importing that file would register its tests), and a thin
// stateful wrapper sits in front of it: one state file per service (absent =
// no container; "running", "stopped" or "restarting"), which `compose up`
// flips to running as a Compose reconcile would. Unlike the older wrapper it
// models a restarting container the way Docker reports it: `status=running`
// does not list it, `{{.State.Status}}` says restarting, `{{.State.Running}}`
// says true, and `docker exec` into it fails.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

import { writeEngineDockerShim } from "./engine-docker-shim.mjs";
import { PROCESS_DEADLINE_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

export const scriptsDir = dirname(fileURLToPath(import.meta.url));
export const repoDir = join(scriptsDir, "..");
const repairScriptSource = readFileSync(join(scriptsDir, "repair.sh"), "utf8");
const configureScriptSource = readFileSync(join(scriptsDir, "configure.sh"), "utf8");
const installerUiSource = readFileSync(join(scriptsDir, "installer-ui.sh"), "utf8");
const environmentExampleSource = readFileSync(join(repoDir, ".env-orbit.example"), "utf8");

const baseHarnessSource = readFileSync(join(scriptsDir, "repair.test.mjs"), "utf8");
const shimStart = baseHarnessSource.indexOf("function dockerShimScript(");
const shimEnd = baseHarnessSource.indexOf("\nfunction makeFakeBin(");
if (shimStart < 0 || shimEnd < shimStart) throw new Error("repair.test.mjs no longer defines dockerShimScript");
export const FIXTURE_IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
export const FIXTURE_IMAGE = `ghcr.io/tomlawesome/orbit@${FIXTURE_IMAGE_DIGEST}`;
const dockerShimScript = new Function(
  "recoveryCryptoScriptPath",
  "FIXTURE_IMAGE",
  `${baseHarnessSource.slice(shimStart, shimEnd)}\nreturn dockerShimScript;`,
)(join(scriptsDir, "recovery-crypto.mjs"), FIXTURE_IMAGE);

export const DB_ID = "1111aaaa2222";
export const APP_ID = "3333bbbb4444";

const scratchDirs = [];
afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop(), { recursive: true, force: true, maxRetries: 2 });
});

export function scratchDir(prefix = "orbit-repair-1804-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

export function makeFixture() {
  const targetDir = scratchDir();
  mkdirSync(join(targetDir, "scripts"));
  writeFileSync(join(targetDir, "scripts", "repair.sh"), repairScriptSource);
  chmodSync(join(targetDir, "scripts", "repair.sh"), 0o755);
  writeFileSync(join(targetDir, "scripts", "configure.sh"), configureScriptSource);
  chmodSync(join(targetDir, "scripts", "configure.sh"), 0o755);
  writeFileSync(join(targetDir, "scripts", "installer-ui.sh"), installerUiSource);
  chmodSync(join(targetDir, "scripts", "installer-ui.sh"), 0o755);
  writeFileSync(join(targetDir, ".env-orbit.example"), environmentExampleSource);
  writeFileSync(join(targetDir, "docker-compose.yml"), "services:\n  orbit-app:\n    image: busybox\n");
  writeFileSync(
    join(targetDir, ".env-orbit"),
    [
      "APP_URL=https://orbit.repair-test.internal",
      `ORBIT_IMAGE=${FIXTURE_IMAGE}`,
      "ORBIT_CONFIG_APPLIED_VERSION=v0.3.0",
      `ORBIT_CONFIG_APPLIED_DIGEST=${FIXTURE_IMAGE_DIGEST}`,
      "OIDC_ISSUER=https://auth.repair-test.internal/application/o/orbit/",
      "OIDC_CLIENT_ID=repair-test-client",
      "OIDC_CLIENT_SECRET=repair-test-secret",
      "OIDC_CALLBACK_URL=https://orbit.repair-test.internal/api/auth/callback",
      "COMPOSE_PROJECT_NAME=repairtest",
      "",
    ].join("\n"),
  );
  chmodSync(join(targetDir, ".env-orbit"), 0o600);
  mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
  for (const name of ["session-secret", "postgres-password", "document-kek", "oidc-client-secret"]) {
    writeFileSync(join(targetDir, ".orbit-secrets", name), "a".repeat(64) + "\n");
    chmodSync(join(targetDir, ".orbit-secrets", name), 0o600);
  }
  return targetDir;
}

export function treeSnapshot(targetDir) {
  return spawnSync("bash", ["-c", 'find . -mindepth 1 -printf "%p %m %s %y\\n" | LC_ALL=C sort'], {
    cwd: targetDir,
    encoding: "utf8",
  }).stdout;
}

const WRAPPER = readFileSync(join(scriptsDir, "repair-test-docker-wrapper.sh"), "utf8");

// Builds the fake bin directory and the environment for one repair.sh run.
// `db` / `app`: "absent" | "stopped" | "running" | "restarting".
export function prepareRepair(
  targetDir,
  { db = "absent", app = "absent", dbReady = true, upFails = false, upStderr = "", docker = {}, env, restartingProbeFails = false, multiRestarting = false, mailStatus, mailStatusExit } = {},
) {
  const binDir = scratchDir("orbit-repair-1804-bin-");
  const engineDir = scratchDir("orbit-repair-1804-engine-");
  const stateDir = scratchDir("orbit-repair-1804-state-");
  const engineDockerPath = writeEngineDockerShim(engineDir);
  writeFileSync(join(binDir, "docker-base"), dockerShimScript({ engineDockerPath, ...docker }));
  chmodSync(join(binDir, "docker-base"), 0o755);
  for (const [name, state] of [["orbit-db", db], ["orbit-app", app]]) {
    if (state !== "absent") writeFileSync(join(stateDir, name), state);
  }
  if (!dbReady) writeFileSync(join(stateDir, "db-not-ready"), "");
  if (upFails) writeFileSync(join(stateDir, "up-fails"), "");
  writeFileSync(join(stateDir, "up-stderr"), upStderr);
  if (docker.unavailable) writeFileSync(join(stateDir, "passthrough"), "");
  if (restartingProbeFails) writeFileSync(join(stateDir, "restarting-probe-fails"), "");
  if (multiRestarting) writeFileSync(join(stateDir, "multi-restarting"), "");
  // #1817: the answer of `orbit mail-sending-status` (undefined: the command does not exist) and its exit status.
  if (mailStatus !== undefined) writeFileSync(join(stateDir, "mail-status"), `${mailStatus}\n`);
  if (mailStatusExit !== undefined) writeFileSync(join(stateDir, "mail-status-exit"), String(mailStatusExit));
  // Records every `timeout` invocation, then runs the real one.
  writeFileSync(join(binDir, "timeout"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${join(stateDir, "timeout.log")}'\nexec /usr/bin/timeout "$@"\n`);
  chmodSync(join(binDir, "timeout"), 0o755);
  writeFileSync(
    join(binDir, "docker"),
    `#!/usr/bin/env bash\nS='${stateDir}'\nBASE='${join(binDir, "docker-base")}'\nDB_ID='${DB_ID}'\nAPP_ID='${APP_ID}'\n${WRAPPER.split("\n").slice(1).join("\n")}`,
  );
  chmodSync(join(binDir, "docker"), 0o755);
  // A restarting container makes the app-secret readability retry wait out its real 75s budget.
  const merged = { HOME: process.env.HOME ?? tmpdir(), ORBIT_REPAIR_APP_SECRET_BUDGET: "1", ...env };
  merged.PATH = `${binDir}:${merged.PATH ?? process.env.PATH}`;
  const read = (name) => (existsSync(join(stateDir, name)) ? readFileSync(join(stateDir, name), "utf8") : "");
  const decorate = (result) => ({
    ...result,
    argv: read("argv.log").split("\n").filter(Boolean),
    stateOf: (service) => read(service) || "absent",
    timeoutCalls: read("timeout.log").split("\n").filter(Boolean),
    // One "<smtp lines> <overlay listed> <secret present>" per `compose up`, in order (#1817).
    upTrace: read("up-trace.log").split("\n").filter(Boolean),
  });
  return { merged, decorate, stateDir };
}

export function runRepair(targetDir, args, options = {}) {
  const { merged, decorate } = prepareRepair(targetDir, options);
  const result = failOnProcessDeadline(
    spawnSync("bash", [join(targetDir, "scripts", "repair.sh"), ...args], {
      cwd: targetDir,
      encoding: "utf8",
      input: options.input,
      env: merged,
      ...processGuard(),
    }),
    { label: "runRepair" },
  );
  return decorate(result);
}

// Runs repair.sh in machine-prompt mode, so the execution waits on a
// confirmation after the plan is printed. `between` runs once the prompt has
// appeared on stdout (diagnosis and planning are over, nothing has been
// executed yet; it gets { stateDir }, where creating `volumes-vanished` makes
// `docker volume ls` list nothing from then on) and before "y" is sent, so a test can change the world
// between the plan and the act.
export function runRepairBetweenPlanAndExecute(targetDir, args, options, between) {
  const { merged, decorate, stateDir } = prepareRepair(targetDir, { ...options, env: { ...options.env, ORBIT_REPAIR_PROMPTS: "machine" } });
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [join(targetDir, "scripts", "repair.sh"), ...args], { cwd: targetDir, env: merged });
    let stdout = "";
    let stderr = "";
    let released = false;
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`repair.sh did not finish within ${PROCESS_DEADLINE_MS}ms; stdout so far:\n${stdout}`));
    }, PROCESS_DEADLINE_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!released && /^prompt field=\S+ kind=confirm/mu.test(stdout)) {
        released = true;
        Promise.resolve(between({ stateDir })).then(
          () => {
            child.stdin.write("y\n");
            child.stdin.end();
          },
          (error) => {
            child.kill("SIGKILL");
            reject(error);
          },
        );
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve(decorate({ status, stdout, stderr }));
    });
  });
}

export const composeUpCalls = (r) => r.argv.filter((line) => /\bcompose\b/u.test(line) && /\bup\b/u.test(line));
export const stderrLines = (r) => r.stderr.split("\n");
