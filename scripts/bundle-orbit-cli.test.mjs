import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// Bundle-build smoke test for the engine-delivery slice (issue #295): proves
// scripts/bundle-orbit-cli.mjs (the exact step the Dockerfile's cli-builder
// stage runs) produces a working, dependency-free /opt/orbit/cli/orbit.js
// stand-in, and that the shipped artifact — not just the TypeScript source
// tsx runs directly — genuinely never attempts to spawn `docker`, including
// under the in-container fail-closed guard documented in docs/
// engine-events.md, "In-container engine invocation (v0)".

// Every spawnSync call here runs the built CLI or a real tool under it; a
// spawn that takes tens of milliseconds quiet takes seconds on a starved
// core (#698). Budget and reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoDir = join(scriptsDir, "..");
const bundlePath = join(repoDir, "dist", "cli", "orbit.js");

// Every spawnSync call in this file gets an explicit, closed/piped stdio
// config (never "inherit"), so a wedged child (or one whose piped stdio
// never sees EOF) fails this test loudly rather than hanging. processGuard()
// (scripts/process-budget.mjs) supplies the actual deadline and kill signal.
const SPAWN_OPTS = { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...processGuard() };

const scratchDirs = [];
afterAll(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-bundle-smoke-"));
  scratchDirs.push(dir);
  return dir;
}

// A `check`-ready fixture deploy directory: mirrors
// src/lib/config-contract.parity.test.ts's own fixture shape.
// CANONICAL_OIDC_SECRET_FILE_PATH (config-contract.ts) is the only
// OIDC_CLIENT_SECRET_FILE value `check` accepts as ready.
const CANONICAL_OIDC_SECRET_FILE_PATH = "/run/orbit-secrets/orbit-oidc-client-secret";

function makeReadyFixture() {
  const dir = scratchDir();
  mkdirSync(join(dir, ".orbit-secrets"), { mode: 0o700 });
  writeFileSync(join(dir, ".orbit-secrets", "oidc-client-secret"), "fixture-secret\n", { mode: 0o600 });
  const record = [
    "APP_URL=https://orbit.bundle-smoke.invalid",
    "ORBIT_AUTH_OIDC=true",
    "OIDC_ISSUER=https://oidc.bundle-smoke.invalid/application/o/orbit/",
    "OIDC_CLIENT_ID=orbit-bundle-smoke",
    `OIDC_CLIENT_SECRET_FILE=${CANONICAL_OIDC_SECRET_FILE_PATH}`,
    "OIDC_CALLBACK_URL=https://orbit.bundle-smoke.invalid/api/auth/callback",
    `ORBIT_IMAGE=registry.bundle-smoke.invalid/acceptance/orbit@sha256:${"a".repeat(64)}`,
    "",
  ].join("\n");
  writeFileSync(join(dir, ".env-orbit"), record, { mode: 0o600 });
  return dir;
}

// A `docker` that, if ever executed, fails the test outright — proving a
// code path never even attempts the spawn, not merely that the spawn fails
// gracefully. Bash, not Node — see scripts/engine-check.test.mjs's own
// makeFakeDockerBin comment for why. Never reads stdin (so it is inert
// regardless of how its own stdin is wired by a caller), and exits
// immediately — no risk of it becoming the thing that hangs.
function makeBoobyTrappedDockerBinDir(callLogPath) {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-bundle-smoke-trap-"));
  scratchDirs.push(binDir);
  const script = ["#!/usr/bin/env bash", `printf 'TRAPPED: docker %s\\n' "$*" >> '${callLogPath}'`, "exit 99", ""].join("\n");
  writeFileSync(join(binDir, "docker"), script);
  chmodSync(join(binDir, "docker"), 0o755);
  return binDir;
}

function resolveTool(tool) {
  return failOnProcessDeadline(spawnSync("which", [tool], SPAWN_OPTS), { label: "resolveTool" }).stdout.trim();
}

// PATH with no docker at all (see scripts/engine-check.test.mjs's own
// makeDockerlessBinDir comment for why a real system directory can't be
// used directly: docker shares /usr/bin with bash/coreutils here).
function makeDockerlessBinDir() {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-bundle-smoke-nodocker-"));
  scratchDirs.push(binDir);
  for (const tool of ["node", "bash"]) {
    const realPath = resolveTool(tool);
    if (realPath) symlinkSync(realPath, join(binDir, tool));
  }
  return binDir;
}

describe("scripts/bundle-orbit-cli.mjs", () => {
  it("runs the real bundling step and produces a single, working dist/cli/orbit.js", () => {
    const result = failOnProcessDeadline(spawnSync("node", [join(scriptsDir, "bundle-orbit-cli.mjs")], { cwd: repoDir, ...SPAWN_OPTS }), { label: "runs the real bundling step" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("wrote");
    const bundleSource = readFileSync(bundlePath, "utf8");
    expect(bundleSource.length).toBeGreaterThan(0);
    // Single-file: no bundled reference back into node_modules/src at runtime.
    expect(bundleSource).not.toMatch(/require\(["']\.\.?\//);
  });

  // ADR-0015 decision 3. The CLI now bundles application domain code — the
  // `end-maintenance` command reaches src/server/maintenance.ts — and that
  // code must stay free of any runtime framework import. `next` is marked
  // external in the bundle step, so a stray runtime import cannot quietly
  // disappear into the output: it survives as a literal `require("next/...")`
  // and fails here. This test, not vigilance, is what holds the boundary for
  // the next operator command too.
  it("links no Next runtime, so the operator boundary holds", () => {
    const bundleSource = readFileSync(bundlePath, "utf8");
    expect(bundleSource).not.toMatch(/require\(["']next(\/[^"']*)?["']\)/);
  });

  it("`node <bundle>` with no arguments refuses with a usage message (nonzero exit)", () => {
    const result = failOnProcessDeadline(spawnSync("node", [bundlePath], SPAWN_OPTS), { label: "bundle with no arguments" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("orbit:");
    expect(result.stderr).toContain("supported commands");
  });

  it("`node <bundle> check --dir <fixture>` works with no docker binary on PATH at all", () => {
    const fixture = makeReadyFixture();
    const dockerlessBinDir = makeDockerlessBinDir();
    const result = failOnProcessDeadline(spawnSync("node", [bundlePath, "check", "--dir", fixture], {
      ...SPAWN_OPTS,
      env: { PATH: dockerlessBinDir },
    }), { label: "check with no docker binary on PATH" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ready APP_URL");
    expect(result.stdout).toContain("ready OIDC_CLIENT_SECRET");
  });

  it("`check` never even attempts to spawn docker, proven with a booby-trapped docker on PATH", () => {
    const fixture = makeReadyFixture();
    const callLogPath = join(scratchDir(), "docker-calls.log");
    writeFileSync(callLogPath, "");
    const trapBinDir = makeBoobyTrappedDockerBinDir(callLogPath);
    const nodeDir = dirname(resolveTool("node"));

    const result = failOnProcessDeadline(spawnSync("node", [bundlePath, "check", "--dir", fixture], {
      ...SPAWN_OPTS,
      env: { PATH: `${trapBinDir}:${nodeDir}` },
    }), { label: "check never attempts to spawn docker" });

    expect(result.status).toBe(0);
    expect(readFileSync(callLogPath, "utf8")).toBe("");
  });

  it("fail-closed: a docker-needing command run in-container-mode refuses before ever spawning docker", () => {
    const targetDir = scratchDir();
    const callLogPath = join(scratchDir(), "docker-calls.log");
    writeFileSync(callLogPath, "");
    const trapBinDir = makeBoobyTrappedDockerBinDir(callLogPath);
    const nodeDir = dirname(resolveTool("node"));

    const result = failOnProcessDeadline(spawnSync("node", [bundlePath, "install", "--dir", targetDir], {
      ...SPAWN_OPTS,
      env: { PATH: `${trapBinDir}:${nodeDir}`, ORBIT_ENGINE_CONTEXT: "container" },
    }), { label: "docker-needing command refuses before spawning docker" });

    expect(result.status).toBe(9);
    expect(result.stderr).toContain("reason=docker-command-forbidden-in-container");
    expect(result.stderr).toContain("command=install");
    expect(readFileSync(callLogPath, "utf8")).toBe("");
  });

  it("fail-closed guard covers every Docker-backed command (install, update, backup, restore, export-recovery-bundle, import-recovery-bundle)", () => {
    const targetDir = scratchDir();
    const dockerlessBinDir = makeDockerlessBinDir();
    const dockerNeedingCommands = ["install", "update", "backup", "restore", "export-recovery-bundle", "import-recovery-bundle"];

    for (const command of dockerNeedingCommands) {
      const result = failOnProcessDeadline(spawnSync("node", [bundlePath, command, "--dir", targetDir], {
        ...SPAWN_OPTS,
        env: { PATH: dockerlessBinDir, ORBIT_ENGINE_CONTEXT: "container" },
      }), { label: `fail-closed guard command=${command}` });
      expect(result.status, `command=${command}`).toBe(9);
      expect(result.stderr, `command=${command}`).toContain(`reason=docker-command-forbidden-in-container`);
      expect(result.stderr, `command=${command}`).toContain(`command=${command}`);
    }
  });

  // #912: `auth recovery-link` reaches `issueSetupToken` in
  // `local-credentials.ts`, which imports `password.ts` for its other
  // exports. Before `password.ts` loaded `@node-rs/argon2` lazily, that
  // chain pulled the package's compiled `.node` native binding into this
  // very bundling step, and esbuild cannot inline a `.node` file at all —
  // reproduced by hand while diagnosing this: `node scripts/bundle-orbit-cli.mjs`
  // failed outright with "No loader is configured for '.node' files", never
  // producing dist/cli/orbit.js in the first place. `--external:@node-rs/argon2`
  // (scripts/bundle-orbit-cli.mjs) is the same boundary `--external:next`
  // already holds above; this test is what holds it, the same way.
  it("does not inline the Argon2 native binding — @node-rs/argon2 stays external, loaded lazily only where a password is actually hashed or verified", () => {
    const bundleSource = readFileSync(bundlePath, "utf8");
    // The compiled binding's own generated text — this is what would appear
    // here if esbuild had managed to inline it, which it never can.
    expect(bundleSource).not.toMatch(/argon2\.(linux|darwin|win32)/);
    // password.ts's lazy load survives as a literal, deferred `import()`
    // rather than being resolved at bundle time.
    expect(bundleSource).toMatch(/import\(["']@node-rs\/argon2["']\)/u);
  });

  it("`auth recovery-link` loads and runs with no node_modules anywhere in reach — the Argon2 binding it never uses is never required", () => {
    // Copied outside the repo tree, unlike bundlePath itself: this is the
    // isolation the shipped image actually has (only /opt/orbit/web/node_modules
    // exists there, and it is not an ancestor of /opt/orbit/cli/), so Node's
    // own upward node_modules search has nothing to find.
    const isolatedDir = scratchDir();
    const isolatedBundle = join(isolatedDir, "orbit.js");
    writeFileSync(isolatedBundle, readFileSync(bundlePath));
    const isolatedEnv = { PATH: dirname(resolveTool("node")) };

    const usage = failOnProcessDeadline(spawnSync("node", [isolatedBundle, "auth", "bogus"], {
      ...SPAWN_OPTS,
      env: isolatedEnv,
    }), { label: "auth usage with no node_modules" });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("usage: orbit auth recovery-link");

    // No DATABASE_URL/POSTGRES_PASSWORD in this environment either: the
    // command reaches its own bounded database-failure message, never an
    // Argon2 module-load error — proving the binding is genuinely unreached
    // on this path, not just absent from the bundle text above.
    const recoveryLink = failOnProcessDeadline(spawnSync("node", [isolatedBundle, "auth", "recovery-link"], {
      ...SPAWN_OPTS,
      env: isolatedEnv,
    }), { label: "auth recovery-link with no node_modules" });
    expect(recoveryLink.status).toBe(1);
    expect(recoveryLink.stdout).toBe("");
    expect(recoveryLink.stderr.trim().split("\n")).toHaveLength(1);
    expect(recoveryLink.stderr).not.toContain("@node-rs/argon2");
    expect(recoveryLink.stderr).not.toContain("Cannot find module");
  });

  it("the guard is inert outside container mode (ORBIT_ENGINE_CONTEXT unset): behavior is unchanged from before this slice", () => {
    const targetDir = scratchDir();
    const callLogPath = join(scratchDir(), "docker-calls.log");
    writeFileSync(callLogPath, "");
    const trapBinDir = makeBoobyTrappedDockerBinDir(callLogPath);
    const nodeDir = dirname(resolveTool("node"));
    // The trap script's own `#!/usr/bin/env bash` shebang needs bash
    // resolvable too, on top of `docker` itself.
    const bashDir = dirname(resolveTool("bash"));

    const result = failOnProcessDeadline(spawnSync("node", [bundlePath, "install", "--dir", targetDir], {
      ...SPAWN_OPTS,
      env: { PATH: `${trapBinDir}:${nodeDir}:${bashDir}` },
    }), { label: "guard inert outside container mode" });

    // No ORBIT_ENGINE_CONTEXT set: the guard never fires, so install
    // proceeds to its own (pre-existing) docker-availability check, which
    // does reach the trapped docker — proving the guard adds a refusal only
    // in container mode, without altering host-mode behavior.
    expect(result.status).not.toBe(9);
    expect(readFileSync(callLogPath, "utf8")).not.toBe("");
  });
});
