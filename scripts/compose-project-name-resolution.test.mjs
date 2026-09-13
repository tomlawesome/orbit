import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// #921: scripts/end-maintenance.sh, scripts/engine-check.sh and
// scripts/repair.sh each derived the Compose project name as .env-orbit's
// own COMPOSE_PROJECT_NAME, then the caller's environment, then -- with
// neither set -- straight to a sanitized guess from the CURRENT DIRECTORY'S
// BASENAME, never docker-compose.yml's own `name: orbit` (line 1). In CI the
// checkout is called "orbit", so the guess happened to agree; from a
// worktree (whose directory is named after its branch, e.g.
// "m10-compose-project" -- exactly this file's own checkout) or any
// operator directory not literally called "orbit", the guess was wrong and
// the script addressed a Compose project that was never created (see
// scripts/test-backup-restore.sh's 2026-09-09 failure quoted on #921).
//
// The fix inserts one shared step -- read_compose_project_name(), reading
// docker-compose.yml's own top-level `name:` -- ahead of the directory-
// basename fallback in all three scripts, while leaving the two explicit
// COMPOSE_PROJECT_NAME overrides winning exactly as before. This suite
// proves two things: that the three scripts carry the identical function
// (not three diverging reimplementations -- these scripts are deliberately
// standalone and source-less, so "shared" here means "the same text",
// verified rather than assumed), and that end-to-end derivation now prefers
// docker-compose.yml's `name:` over the directory basename, exercised from
// a scratch directory whose basename is never "orbit".
//
// Run standalone (excluded from the vitest suite, like
// scripts/lockfile-no-pnpm-exe.test.mjs): `node --test
// scripts/compose-project-name-resolution.test.mjs`.

const SCRIPTS = ["end-maintenance.sh", "engine-check.sh", "repair.sh"];

function extractFunction(source, name) {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "mu"));
  assert.ok(match, `${name}() not found`);
  return match[0];
}

const scratchDirs = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function scratchDir(prefix) {
  // mkdtemp's own generated suffix guarantees the basename is never
  // literally "orbit" -- exactly the real-world condition (a worktree, an
  // operator's own directory) the reported defect needed.
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

describe("read_compose_project_name is the same function in all three scripts", () => {
  const bodies = SCRIPTS.map((name) => extractFunction(readFileSync(join(import.meta.dirname, name), "utf8"), "read_compose_project_name"));

  it("is present, identical, in end-maintenance.sh, engine-check.sh and repair.sh", () => {
    assert.equal(bodies[1], bodies[0]);
    assert.equal(bodies[2], bodies[0]);
  });

  it("reads docker-compose.yml's top-level name:, from a directory whose basename is not orbit", () => {
    const dir = scratchDir("orbit-compose-name-fn-");
    writeFileSync(join(dir, "docker-compose.yml"), "name: orbit\n\nservices:\n  orbit-app:\n    image: busybox\n");
    assert.notEqual(dir.split("/").pop(), "orbit");

    const script = `${bodies[0]}\nread_compose_project_name "$1"\n`;
    const result = failOnProcessDeadline(
      spawnSync("bash", ["-c", script, "bash", join(dir, "docker-compose.yml")], { encoding: "utf8", ...processGuard() }),
      { label: "read_compose_project_name" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "orbit");
  });

  it("returns nothing (exit 1) when docker-compose.yml has no name: line, leaving the caller's directory-basename fallback to run", () => {
    const dir = scratchDir("orbit-compose-name-fn-none-");
    writeFileSync(join(dir, "docker-compose.yml"), "services:\n  orbit-app:\n    image: busybox\n");

    const script = `${bodies[0]}\nread_compose_project_name "$1"\n`;
    const result = spawnSync("bash", ["-c", script, "bash", join(dir, "docker-compose.yml")], { encoding: "utf8", ...processGuard() });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  });
});

// A fake `docker` that logs its exact argv (one argument per line) to
// argvLogPath and exits 0 -- never touching a real daemon. Bash, not Node:
// `docker compose --env-file <path>` collides with Node 20.6+'s own
// `--env-file` CLI-flag interception (scripts/engine-check.test.mjs's
// makeFakeDockerBin notes the same thing).
function makeFakeDockerBin(argvLogPath) {
  const binDir = scratchDir("orbit-compose-name-fakebin-");
  const script = ["#!/usr/bin/env bash", `printf '%s\\n' "$@" > '${argvLogPath}'`, "exit 0", ""].join("\n");
  writeFileSync(join(binDir, "docker"), script);
  chmodSync(join(binDir, "docker"), 0o755);
  return binDir;
}

function runScript(scriptName, targetDir, { binDir, env = {} } = {}) {
  const pathValue = binDir ? `${binDir}:${process.env.PATH}` : process.env.PATH;
  return failOnProcessDeadline(
    spawnSync("bash", [join(targetDir, "scripts", scriptName)], {
      cwd: targetDir,
      encoding: "utf8",
      env: { PATH: pathValue, HOME: process.env.HOME ?? tmpdir(), ...env },
      ...processGuard(),
    }),
    { label: `run ${scriptName}` },
  );
}

function makeMinimalDeployment(scriptName) {
  const dir = scratchDir("orbit-compose-name-e2e-");
  assert.notEqual(dir.split("/").pop(), "orbit");
  mkdirSync(join(dir, "scripts"));
  const source = readFileSync(join(import.meta.dirname, scriptName), "utf8");
  writeFileSync(join(dir, "scripts", scriptName), source);
  chmodSync(join(dir, "scripts", scriptName), 0o755);
  writeFileSync(join(dir, "docker-compose.yml"), "name: orbit\n\nservices:\n  orbit-app:\n    image: busybox\n");
  // No COMPOSE_PROJECT_NAME anywhere -- neither override present -- so the
  // resolution must fall through to docker-compose.yml's own `name:` and
  // never reach the directory-basename guess.
  writeFileSync(join(dir, ".env-orbit"), "APP_URL=https://orbit.compose-name-test.internal\n");
  chmodSync(join(dir, ".env-orbit"), 0o600);
  return dir;
}

describe("end-maintenance.sh resolves the project from docker-compose.yml's name:, not the directory basename", () => {
  it("composes --project-name orbit from a scratch directory named after this test, not \"orbit\"", () => {
    const dir = makeMinimalDeployment("end-maintenance.sh");
    const argvLogPath = join(dir, "docker-argv.log");
    const binDir = makeFakeDockerBin(argvLogPath);

    const result = runScript("end-maintenance.sh", dir, { binDir });

    assert.equal(result.status, 0, result.stderr);
    const argv = readFileSync(argvLogPath, "utf8").split("\n").filter((line) => line.length > 0);
    const projectNameIndex = argv.indexOf("--project-name");
    assert.ok(projectNameIndex >= 0, argv.join(" "));
    assert.equal(argv[projectNameIndex + 1], "orbit");
  });
});

describe("engine-check.sh (ORBIT_ENGINE_CHECK=container) resolves the project from docker-compose.yml's name:, not the directory basename", () => {
  it("composes --project-name orbit from a scratch directory named after this test, not \"orbit\"", () => {
    const dir = makeMinimalDeployment("engine-check.sh");
    const argvLogPath = join(dir, "docker-argv.log");
    const binDir = makeFakeDockerBin(argvLogPath);

    const result = runScript("engine-check.sh", dir, { binDir, env: { ORBIT_ENGINE_CHECK: "container" } });

    assert.equal(result.status, 0, result.stderr);
    const argv = readFileSync(argvLogPath, "utf8").split("\n").filter((line) => line.length > 0);
    const projectNameIndex = argv.indexOf("--project-name");
    assert.ok(projectNameIndex >= 0, argv.join(" "));
    assert.equal(argv[projectNameIndex + 1], "orbit");
  });
});
