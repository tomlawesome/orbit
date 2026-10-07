import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../../scripts/process-budget.mjs";
import { DEPLOYMENT_ASSETS } from "../lib/deployment-assets";

// The CLI wiring of the install engine (#1212): `orbit install|update` as
// install.sh runs it inside the image -- environment in, events on stdout,
// the outcome file install.sh reads back, exit codes 0/1/130/2/3. The
// engine's own decisions are proven in src/lib/install-orchestrator.test.ts;
// this proves the command around them, as a real subprocess, with a
// booby-trapped `docker` first on PATH so a passing run also proves the
// engine never reached for Docker (#295).

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliEntry = fileURLToPath(new URL("./orbit.ts", import.meta.url));
const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const DIGEST = `sha256:${"a".repeat(64)}`;
const REFERENCE = `ghcr.io/tomlawesome/orbit@${DIGEST}`;

const sandboxes: string[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function newSandbox(prefix: string): string {
  const sandbox = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(sandbox);
  return sandbox;
}

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

function hostFacts(): string {
  return JSON.stringify({
    targetBasename: b64("household"),
    cosignUsable: false,
    imageVersion: "v1.2.3",
    imageRevision: "b".repeat(40),
    appliedDigest: DIGEST,
    volumeList: b64(""),
    volumes: [],
    projects: [],
    images: [],
  });
}

function assetsRoot(): string {
  const root = newSandbox("orbit-cli-install-assets-");
  for (const asset of DEPLOYMENT_ASSETS) {
    mkdirSync(dirname(join(root, asset)), { recursive: true });
    copyFileSync(join(repoRoot, asset), join(root, asset));
  }
  return root;
}

/** A target the unattended path accepts (guarantee #6). */
function preprovisioned(env = "APP_URL=https://orbit.example.invalid\nORBIT_AUTH_OIDC=false\n"): string {
  const target = newSandbox("orbit-cli-install-target-");
  writeFileSync(join(target, ".env-orbit"), env, { mode: 0o600 });
  mkdirSync(join(target, ".orbit-secrets"), { mode: 0o700 });
  writeFileSync(join(target, ".orbit-secrets", "oidc-client-secret"), "s3cr3t", { mode: 0o600 });
  return target;
}

function trappedDocker(): { bin: string; log: string } {
  const bin = newSandbox("orbit-cli-install-bin-");
  const log = join(bin, "docker-calls.log");
  writeFileSync(log, "");
  writeFileSync(join(bin, "docker"), ["#!/usr/bin/env bash", `printf 'TRAPPED: docker %s\\n' "$*" >> '${log}'`, "exit 99", ""].join("\n"));
  chmodSync(join(bin, "docker"), 0o755);
  return { bin, log };
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; status: number; dockerCalls: string } {
  const docker = trappedDocker();
  const result = failOnProcessDeadline(
    spawnSync("node", [tsx, cliEntry, ...args], {
      encoding: "utf8",
      env: {
        PATH: `${docker.bin}:${process.env.PATH}`,
        HOME: process.env.HOME,
        ORBIT_ENGINE_CONTEXT: "container",
        ORBIT_IMAGE: REFERENCE,
        ORBIT_INSTALL_HOST_FACTS: hostFacts(),
        ORBIT_INSTALL_TEST_ASSETS_ROOT: assetsRoot(),
        ...env,
      },
      ...processGuard(),
    }),
    { label: "runCli" },
  );
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? -1, dockerCalls: readFileSync(docker.log, "utf8") };
}

function outcomeFile(): string {
  return join(newSandbox("orbit-cli-install-outcome-"), "outcome");
}

describe("orbit install: arguments and the shell's environment", () => {
  it("refuses without --dir", () => {
    expect(runCli(["install"])).toMatchObject({ status: 1, stderr: expect.stringContaining("orbit: install requires --dir <deployment>") });
  });

  it("refuses an unknown option as a usage error", () => {
    const result = runCli(["install", "--dir", preprovisioned(), "--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("orbit: usage: orbit install --dir <deployment>");
  });

  it.each([
    ["a mutable image tag", { ORBIT_IMAGE: "ghcr.io/tomlawesome/orbit:latest" }, "orbit: ORBIT_IMAGE must be the immutable digest reference install.sh resolved."],
    ["no image at all", { ORBIT_IMAGE: "" }, "orbit: ORBIT_IMAGE must be the immutable digest reference install.sh resolved."],
    ["malformed Docker facts", { ORBIT_INSTALL_HOST_FACTS: "{" }, "orbit: The installer's Docker facts are missing or malformed; refusing to continue."],
    ["no Docker facts", { ORBIT_INSTALL_HOST_FACTS: "" }, "orbit: The installer's Docker facts are missing or malformed; refusing to continue."],
    ["an invalid channel", { ORBIT_CHANNEL: "not a channel!" }, "orbit: ORBIT_CHANNEL is invalid."],
  ])("refuses %s before touching the target", (_label, env, message) => {
    const target = preprovisioned();
    const before = readdirSync(target).sort();
    const result = runCli(["install", "--dir", target], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(readdirSync(target).sort()).toEqual(before);
  });
});

describe("orbit install: a run, as install.sh starts it", () => {
  it("installs, prints the plain event stream, writes the outcome for the shell, and never runs docker", () => {
    const target = preprovisioned();
    const outcome = outcomeFile();
    const result = runCli(["install", "--action", "auto", "--dir", target, "--outcome", outcome], { ORBIT_INSTALLER_ELAPSED: "7" });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.dockerCalls).toBe("");
    expect(result.stdout).toMatch(/^phase=configuration component=configuration state=starting reason=configuration-migration action=configure elapsed=([7-9]|[1-9][0-9])s$/m);
    expect(result.stdout).toContain("phase=oidc component=oidc state=skipped reason=provider-discovery action=skip");
    expect(readFileSync(outcome, "utf8")).toBe("status=ok\nfresh=1\nprofile=standard\nmodel-pull=0\ndatabase-volume=\n");
    expect(statSync(outcome).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(target, ".env-orbit"), "utf8")).toContain(`ORBIT_IMAGE=${REFERENCE}\n`);
  });

  it("leaves a failure's terminal event to the shell, handing it the reason in the outcome, with the guidance on stderr", () => {
    const target = preprovisioned("ORBIT_AUTH_OIDC=false\n");
    const outcome = outcomeFile();
    const result = runCli(["install", "--dir", target, "--outcome", outcome]);

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("state=failed");
    expect(result.stderr).toContain("Orbit installer: configuration fields requiring attention: APP_URL.");
    expect(readFileSync(outcome, "utf8")).toBe(
      [
        "status=failed",
        "phase=configuration",
        "component=configuration",
        "reason=configuration-failure",
        "action=retry",
        "message=Required configuration fields require attention; refusing to start Compose.",
        "",
      ].join("\n"),
    );
  });

  it("prints the terminal event itself when no outcome file was asked for", () => {
    const result = runCli(["update", "--dir", newSandbox("orbit-cli-install-empty-")]);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^phase=host component=host state=failed reason=docker-host action=retry elapsed=\d+s$/m);
    expect(result.stderr).toContain("Orbit installer: Update requires a recognized existing Orbit deployment.");
  });
});

describe("orbit install: the launcher's configure tree on a configuration-failure (#1225)", () => {
  function launcherTree(): string {
    const tree = join(newSandbox("orbit-cli-install-launcher-"), "tree");
    mkdirSync(tree, { mode: 0o700 });
    chmodSync(tree, 0o700);
    return tree;
  }

  it("writes the image's tree and pin before rolling the target back", () => {
    const target = preprovisioned("ORBIT_AUTH_OIDC=false\n");
    const before = readFileSync(join(target, ".env-orbit"), "utf8");
    const tree = launcherTree();
    const result = runCli(["install", "--dir", target, "--outcome", outcomeFile()], { ORBIT_LAUNCHER_CONFIG_TREE: tree });

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("ORBIT_LAUNCHER_CONFIG_TREE");
    expect(readdirSync(tree).sort()).toEqual([".env-orbit.example", ".orbit-image", "scripts"]);
    expect(readFileSync(join(tree, "scripts", "configure.sh"))).toEqual(readFileSync(join(repoRoot, "scripts", "configure.sh")));
    expect(readFileSync(join(tree, ".orbit-image"), "utf8")).toBe(`${REFERENCE}\n`);
    expect(readFileSync(join(target, ".env-orbit"), "utf8")).toBe(before);
    expect(readdirSync(target).sort()).toEqual([".env-orbit", ".orbit-secrets"]);
  });

  it("says why when the shell could not mount the launcher's directory", () => {
    const result = runCli(["install", "--dir", preprovisioned("ORBIT_AUTH_OIDC=false\n"), "--outcome", outcomeFile()], {
      ORBIT_LAUNCHER_CONFIG_TREE_UNAVAILABLE: "it is a symlink",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Orbit installer: ORBIT_LAUNCHER_CONFIG_TREE was not written because it is a symlink.\n");
  });

  it("writes nothing on a failure whose reason is not configuration-failure", () => {
    const tree = launcherTree();
    const result = runCli(["update", "--dir", newSandbox("orbit-cli-install-empty-"), "--outcome", outcomeFile()], {
      ORBIT_LAUNCHER_CONFIG_TREE: tree,
    });
    expect(result.status).toBe(1);
    expect(readdirSync(tree)).toEqual([]);
  });
});

describe("orbit install: the interruption drill's kill point (guarantee #31)", () => {
  it("kills itself right after the transaction begins: staging is owner-only and .env-orbit is untouched", () => {
    const target = preprovisioned();
    const before = readFileSync(join(target, ".env-orbit"));
    const outcome = outcomeFile();
    const docker = trappedDocker();
    const result = failOnProcessDeadline(
      spawnSync("node", [tsx, cliEntry, "install", "--dir", target, "--outcome", outcome], {
        encoding: "utf8",
        env: {
          PATH: `${docker.bin}:${process.env.PATH}`,
          HOME: process.env.HOME,
          ORBIT_ENGINE_CONTEXT: "container",
          ORBIT_IMAGE: REFERENCE,
          ORBIT_INSTALL_HOST_FACTS: hostFacts(),
          ORBIT_INSTALL_TEST_ASSETS_ROOT: assetsRoot(),
          ORBIT_INSTALL_TEST_HARD_INTERRUPT_STAGE: "transaction-begun",
        },
        ...processGuard(),
      }),
      { label: "hard interrupt" },
    );
    // tsx relays the child's death as its own exit status or signal.
    expect(result.signal === "SIGKILL" || result.status === 137).toBe(true);
    const staging = readdirSync(target).filter((entry) => entry.startsWith(".orbit-install-staging."));
    expect(staging).toHaveLength(1);
    expect(statSync(join(target, staging[0])).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(target, ".env-orbit"))).toEqual(before);
    expect(() => readFileSync(outcome)).toThrow();
  });
});
