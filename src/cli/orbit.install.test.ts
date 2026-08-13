import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// CLI wiring coverage for `orbit install`/`orbit update` (issue #295 slice
// 5). This suite does not re-prove install-orchestrator.ts's own
// sequencing/decision logic (src/lib/install-orchestrator.test.ts already
// covers that exhaustively against fake adapters, in-process) or any single
// shipped adapter's exact argv shape (install-docker-adapter.docker-adapter.
// test.ts / install-curl-adapter.test.ts / install-script-adapters.test.ts
// already cover those). It proves the CLI layer itself: argument parsing
// (explicit invocation only — refuses without --dir, unlike `check`),
// environment-variable validation (install.sh's own top-of-script checks,
// ported to this CLI's own env-var gathering), and that the real command
// actually constructs and drives a real runInstall() end to end as a
// subprocess, observable via its documented exit codes and plain-mode event
// stream. Every spawn below has an explicit `timeout` and no stdin is ever
// left open (spawnSync's default `stdio` already closes/pipes it), matching
// this port's "no spawn without a bound" discipline.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliEntry = fileURLToPath(new URL("./orbit.ts", import.meta.url));
const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const SPAWN_TIMEOUT_MS = 20_000;

const sandboxes: string[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function newSandbox(prefix: string): string {
  const sandbox = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(sandbox);
  return sandbox;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("node", [tsx, cliEntry, ...args], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    env,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? -1 };
}

/**
 * A fake `docker` (bash script, not Node — install-docker-adapter.docker-
 * adapter.test.ts's own comment explains why a Node stand-in corrupts
 * `--env-file` argv) put first on PATH, so this suite never depends on a
 * real registry or daemon. Everything succeeds (with empty stdout, so
 * `docker volume ls` reports zero candidate database volumes and
 * verify_database_volume_safety's first call cleanly reports "none found"
 * rather than a refusal) except `docker pull`, which always fails — a
 * deterministic, fast, single-point failure at the identity-resolution
 * stage, reached only after every earlier host-tools/volume-safety step
 * has already succeeded.
 */
function makeFakeDockerOnlyBin(): string {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-cli-install-fakebin-"));
  sandboxes.push(binDir);
  writeFileSync(join(binDir, "docker"), ["#!/usr/bin/env bash", 'if [[ "$1" == "pull" ]]; then exit 1; fi', "exit 0", ""].join("\n"));
  chmodSync(join(binDir, "docker"), 0o755);
  return binDir;
}

function pathWithFakeDockerFirst(binDir: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
}

describe("orbit install / orbit update — explicit invocation only", () => {
  it("refuses `install` without --dir", () => {
    const result = runCli(["install"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("orbit: install requires --dir <deployment>");
  });

  it("refuses `update` without --dir", () => {
    const result = runCli(["update"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("orbit: update requires --dir <deployment>");
  });

  it("refuses an unrecognised option", () => {
    const sandbox = newSandbox("orbit-cli-install-unknown-opt-");
    const result = runCli(["install", "--dir", sandbox, "--bogus"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("orbit: unknown option --bogus");
  });

  it("refuses an unrecognised command", () => {
    const result = runCli(["repair"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("orbit: supported commands");
  });
});

describe("orbit install / orbit update — environment validation (install.sh's own top-of-script checks)", () => {
  const sandboxEnvTests: Array<{ name: string; env: Partial<NodeJS.ProcessEnv>; message: string }> = [
    { name: "ORBIT_CHANNEL", env: { ORBIT_CHANNEL: "not a valid channel!" }, message: "orbit: ORBIT_CHANNEL is invalid." },
    { name: "ORBIT_REPOSITORY", env: { ORBIT_REPOSITORY: "no-slash-here" }, message: "orbit: ORBIT_REPOSITORY is invalid." },
    { name: "ORBIT_REGISTRY", env: { ORBIT_REGISTRY: "not a valid registry!" }, message: "orbit: ORBIT_REGISTRY is invalid." },
    {
      name: "ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS (over 900)",
      env: { ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "901" },
      message: "orbit: ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS must be between 1 and 900.",
    },
    {
      name: "ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS (non-numeric)",
      env: { ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "abc" },
      message: "orbit: ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS must be between 1 and 900.",
    },
    {
      name: "ORBIT_INSTALLER_POLL_INTERVAL_SECONDS (two digits)",
      env: { ORBIT_INSTALLER_POLL_INTERVAL_SECONDS: "10" },
      message: "orbit: ORBIT_INSTALLER_POLL_INTERVAL_SECONDS must be between 1 and 9.",
    },
  ];

  for (const { name, env, message } of sandboxEnvTests) {
    it(`fails closed with install.sh's exact message when ${name} is invalid`, () => {
      const sandbox = newSandbox("orbit-cli-install-envvar-");
      const result = runCli(["install", "--dir", sandbox], { ...process.env, ...env });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    });
  }
});

describe("orbit install / orbit update — target directory and end-to-end wiring", () => {
  it("creates the target directory when it does not already exist", () => {
    const parent = newSandbox("orbit-cli-install-mkdir-parent-");
    const target = join(parent, "nested", "deployment");
    const binDir = makeFakeDockerOnlyBin();

    const result = runCli(["install", "--dir", target], pathWithFakeDockerFirst(binDir));

    expect(existsSync(target)).toBe(true);
    // The run still fails past that point (fake docker never succeeds a
    // real pull) — this test is only about directory creation, not a full
    // successful install.
    expect(result.status).toBe(1);
  });

  it("drives a real runInstall() end to end against a fake docker on PATH, printing the documented plain-mode event stream and failing closed with the right message", () => {
    const target = newSandbox("orbit-cli-install-e2e-");
    const binDir = makeFakeDockerOnlyBin();

    const result = runCli(["install", "--dir", target], pathWithFakeDockerFirst(binDir));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("phase=host component=host state=starting reason=host-tools action=check");
    expect(result.stdout).toContain("phase=host component=host state=completed reason=host-tools action=check");
    expect(result.stdout).toContain("phase=identity component=image state=starting reason=image-identity action=pull");
    expect(result.stdout).toContain("phase=identity component=image state=failed reason=image-registry action=retry");
    expect(result.stderr).toContain("Could not pull");
  });

  it("refuses `update` against an empty target with install.sh's own guarantee-#21 message, proving the target/action guard is wired ahead of any docker/curl call", () => {
    const target = newSandbox("orbit-cli-install-update-empty-");
    // No fake docker bin on PATH here at all — if the CLI's own wiring
    // reached checkDockerAvailable() before install-orchestrator.ts's
    // guarantee-#21 target/action guard, a real, unmocked `docker compose
    // version` would still be attempted, but the assertion below is on the
    // exact refusal message, not just the exit code, so it would fail
    // loudly on either a docker-unavailable message or (with real docker
    // present) any later-stage message instead of this specific one.
    const result = runCli(["update", "--dir", target]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Update requires a recognized existing Orbit deployment.");
  });
});
