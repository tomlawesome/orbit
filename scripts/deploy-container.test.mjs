import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/**
 * #1316: scripts/deploy-container.sh builds or pulls the application image and
 * then runs scripts/configure.sh, which runs inside that image. configure.sh
 * only accepts a locally built or digest-pinned image when the caller says it
 * trusts it, by exporting ORBIT_CONFIGURE_TRUST_ORBIT_IMAGE=1. The deploy
 * script is the one that has just built (or pulled by digest) that image, so
 * it must set the variable, along with the ORBIT_IMAGE it deployed.
 *
 * The script is copied into a throwaway checkout beside stub build and
 * configure scripts and a fake docker and git, so nothing real is built,
 * pulled or started.
 */
const repoRoot = resolve(import.meta.dirname, "..");
const fakeSha = "0123456789abcdef0123456789abcdef01234567";
const digestImage = `registry.example.test/orbit/orbit@sha256:${"a".repeat(64)}`;

let checkout;
let binDir;
let configureLog;

function write(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "orbit-deploy-container-"));
  checkout = join(root, "checkout");
  binDir = join(root, "bin");
  configureLog = join(root, "configure.env");
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  mkdirSync(binDir);

  copyFileSync(join(repoRoot, "scripts", "deploy-container.sh"), join(checkout, "scripts", "deploy-container.sh"));
  write(join(checkout, "scripts", "build-container.sh"), "#!/usr/bin/env bash\nexit 0\n");
  write(
    join(checkout, "scripts", "configure.sh"),
    [
      "#!/usr/bin/env bash",
      `printf 'TRUST=%s\\n' "\${ORBIT_CONFIGURE_TRUST_ORBIT_IMAGE-<unset>}" >> ${JSON.stringify(configureLog)}`,
      `printf 'IMAGE=%s\\n' "\${ORBIT_IMAGE-<unset>}" >> ${JSON.stringify(configureLog)}`,
      "exit 0",
      "",
    ].join("\n"),
  );
  writeFileSync(join(checkout, ".env-orbit"), "ORBIT_PLACEHOLDER=1\n");

  // `docker compose ps --status running --quiet orbit-db` prints nothing, so
  // the script treats this as a first deployment and skips the backup.
  write(join(binDir, "docker"), "#!/bin/sh\nexit 0\n");
  write(join(binDir, "git"), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(fakeSha.slice(0, 12))}\n`);
});

afterEach(() => {
  rmSync(join(checkout, ".."), { recursive: true, force: true });
});

function runDeploy(mode, extraEnv = {}) {
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...extraEnv };
  delete env.ORBIT_CONFIGURE_TRUST_ORBIT_IMAGE;
  if (!("ORBIT_IMAGE" in extraEnv)) delete env.ORBIT_IMAGE;
  const result = spawnSync("bash", [join(checkout, "scripts", "deploy-container.sh"), mode], {
    ...processGuard(),
    cwd: checkout,
    env,
    encoding: "utf8",
  });
  return failOnProcessDeadline(result, { label: `deploy-container.sh ${mode}` });
}

function configureEnv() {
  expect(existsSync(configureLog), "configure.sh was never run").toBe(true);
  const lines = readFileSync(configureLog, "utf8").trim().split("\n");
  return Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

describe("deploy-container.sh trusts the image it has just built or pulled (#1316)", () => {
  it("--build runs configure.sh with the trust variable and the local image tag", () => {
    const result = runDeploy("--build");
    expect(result.status, result.stderr).toBe(0);
    expect(configureEnv()).toEqual({
      TRUST: "1",
      IMAGE: `orbit-local:${fakeSha.slice(0, 12)}`,
    });
  });

  it("--pull with a digest ORBIT_IMAGE runs configure.sh with the trust variable and that digest", () => {
    const result = runDeploy("--pull", { ORBIT_IMAGE: digestImage });
    expect(result.status, result.stderr).toBe(0);
    expect(configureEnv()).toEqual({ TRUST: "1", IMAGE: digestImage });
  });
});
