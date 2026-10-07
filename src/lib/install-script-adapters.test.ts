import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { writeEngineDockerShim } from "../../scripts/engine-docker-shim.mjs";
import { PROCESS_TEST_TIMEOUT_MS } from "../../scripts/process-budget.mjs";
import {
  createInstallConfigurationScriptAdapter,
  createInstallGuidedConfigurationAdapter,
  runMachinePromptSession,
} from "./install-script-adapters";
import { runConfigurationMigration, runConfigurationPreflight } from "./configuration-migration";
import { type MachinePromptAnswerProvider, prepareConfiguration, stageGuidedInstallConfiguration } from "./guided-configuration";

// Coverage for the install engine's shipped configuration adapters (issue
// #295 slice 5). The configuration adapter runs the configuration contract
// port in-process since #1210; the guided adapter spawns the real
// scripts/configure.sh, which runs the engine as a container one-off -- here
// through scripts/engine-docker-shim.mjs, a fake docker that runs this
// checkout's CLI instead, so no daemon or image is needed.

// This file spawns the real configure.sh and CLI; a spawn that takes 0.7s
// quiet took 4.3s on a starved core (#698). Budget and reasoning:
// scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const sandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function newSandbox(prefix: string): string {
  const sandbox = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(sandbox);
  return sandbox;
}

const IMAGE = "ghcr.io/tomlawesome/orbit@sha256:" + "c".repeat(64);
const DIGEST = "sha256:" + "c".repeat(64);

describe("createInstallConfigurationScriptAdapter (issue #295 slice 3 deferral)", () => {
  it("drives the configuration contract's preflight and migration to a successful migration", () => {
    const sandbox = newSandbox("orbit-install-config-adapter-");
    const scriptPath = join(sandbox, "scripts", "configure.sh");
    const environmentFile = join(sandbox, ".env-orbit");
    writeFileSync(environmentFile, [`ORBIT_IMAGE=${IMAGE}`, ""].join("\n"), { mode: 0o600 });

    const adapter = createInstallConfigurationScriptAdapter({ cwd: sandbox });

    const preflight = runConfigurationPreflight(scriptPath, environmentFile, adapter);
    expect(preflight).toEqual({ ok: true });

    const migration = runConfigurationMigration(
      scriptPath,
      { environmentFile, orbitImage: IMAGE, appliedVersion: "v1.0.0", appliedDigest: DIGEST, composeProjectName: "orbit" },
      adapter,
    );
    expect(migration.ok).toBe(true);
    expect(migration.message).toContain("migrated from schema v0");

    const content = readFileSync(environmentFile, "utf8");
    expect(content).toContain("ORBIT_CONFIG_SCHEMA_VERSION=1");
    expect(content).toContain(`ORBIT_CONFIG_APPLIED_DIGEST=${DIGEST}`);
  });

  it("fails closed on a structurally invalid configuration file", () => {
    const sandbox = newSandbox("orbit-install-config-adapter-invalid-");
    const scriptPath = join(sandbox, "scripts", "configure.sh");
    const environmentFile = join(sandbox, ".env-orbit");
    writeFileSync(environmentFile, "this is not valid\n", { mode: 0o600 });

    const adapter = createInstallConfigurationScriptAdapter({ cwd: sandbox });
    const preflight = runConfigurationPreflight(scriptPath, environmentFile, adapter);
    expect(preflight).toEqual({ ok: false, message: "Configuration preflight failed; restoring the previous deployment." });
  });
});

describe("createInstallGuidedConfigurationAdapter (issue #295 slice 4 deferral)", () => {
  // configure.sh needs an image it can run; the fake docker answers that a
  // local tag is present and runs the engine for it.
  const VAPID_FIXTURE_TAG = "orbit-local:0f00d00face1";
  let shimBin = "";
  const vapidFixtureAvailable = true;

  beforeAll(() => {
    shimBin = newSandbox("orbit-install-guided-adapter-docker-");
    writeEngineDockerShim(shimBin);
  });

  const adapterEnv = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: `${shimBin}:${process.env.PATH}` });

  function makeConfigureSandbox(): string {
    const sandbox = newSandbox("orbit-install-guided-adapter-");
    mkdirSync(join(sandbox, "scripts"));
    writeFileSync(join(sandbox, "scripts", "configure.sh"), readFileSync(join(repoRoot, "scripts", "configure.sh")));
    writeFileSync(join(sandbox, ".env-orbit.example"), readFileSync(join(repoRoot, ".env-orbit.example")));
    return sandbox;
  }

  it("prepareConfiguration completes end-to-end against the real, unmodified configure.sh with a fully pre-provisioned deployment", async () => {
    expect(vapidFixtureAvailable).toBe(true);
    const sandbox = makeConfigureSandbox();
    // Pre-provision a complete .env-orbit up front so the non-interactive
    // path (this adapter's own hasControllingTerminal:false posture, see
    // install-orchestrator.ts) reaches "ready" without needing any prompt.
    writeFileSync(
      join(sandbox, ".env-orbit"),
      [
        // install.sh migrates an existing file before it configures (#1210:
        // configure's preflight always runs now, so the fixture is a migrated one).
        "ORBIT_CONFIG_SCHEMA_VERSION=1",
        "APP_URL=https://guided.adapter.test",
        "ORBIT_AUTH_OIDC=true",
        "OIDC_ISSUER=https://issuer.adapter.test",
        "OIDC_CLIENT_ID=adapter-client",
        "OIDC_CLIENT_SECRET=",
        // The value run_check requires is the fixed canonical *runtime*
        // path (configure.sh:11's $oidc_secret_file_path), not the on-disk
        // host path — configure.sh:1078-1086.
        "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret",
        "OIDC_CALLBACK_URL=https://guided.adapter.test/api/auth/callback",
        `ORBIT_IMAGE=${VAPID_FIXTURE_TAG}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    mkdirSync(join(sandbox, ".orbit-secrets"), { mode: 0o700 });
    writeFileSync(join(sandbox, ".orbit-secrets", "oidc-client-secret"), "s3cr3t-adapter-value", { mode: 0o600 });

    const adapter = createInstallGuidedConfigurationAdapter({ cwd: sandbox, env: adapterEnv() });
    const configureScript = join(sandbox, "scripts", "configure.sh");

    const result = await prepareConfiguration(
      {
        environmentFile: join(sandbox, ".env-orbit"),
        secretsDirectory: join(sandbox, ".orbit-secrets"),
        configureScript,
        orbitImage: VAPID_FIXTURE_TAG,
        hasControllingTerminal: false,
        profileChange: false,
        selectedProfile: "standard",
        selectedModel: undefined,
      },
      adapter,
      { answer: () => "unused" },
    );
    expect(result.status).toBe("ready");
  });

  it("prepareConfiguration refuses closed with install.sh's exact guidance when required fields are missing and there is no controlling terminal (guarantee #24)", async () => {
    expect(vapidFixtureAvailable).toBe(true);
    const sandbox = makeConfigureSandbox();
    const adapter = createInstallGuidedConfigurationAdapter({ cwd: sandbox, env: adapterEnv() });
    const configureScript = join(sandbox, "scripts", "configure.sh");

    const result = await prepareConfiguration(
      {
        environmentFile: join(sandbox, ".env-orbit"),
        secretsDirectory: join(sandbox, ".orbit-secrets"),
        configureScript,
        orbitImage: VAPID_FIXTURE_TAG,
        hasControllingTerminal: false,
        profileChange: false,
        selectedProfile: "standard",
        selectedModel: undefined,
      },
      adapter,
      { answer: () => "unused" },
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.guidance).toBeDefined();
      expect(result.guidance?.[0]).toContain("configuration fields requiring attention");
    }
  });

  it("stageGuidedInstallConfiguration completes a real machine-prompt-driven guided init and stages a fresh .env-orbit/.orbit-secrets", async () => {
    expect(vapidFixtureAvailable).toBe(true);
    const sandbox = makeConfigureSandbox();
    const stagingEnvironmentFile = join(sandbox, ".env-orbit");
    const stagingSecretsDirectory = join(sandbox, ".orbit-secrets");
    const adapter = createInstallGuidedConfigurationAdapter({ cwd: sandbox, env: adapterEnv() });
    const configureScript = join(sandbox, "scripts", "configure.sh");

    const answers = {
      answer: (request: { field: string }) => {
        switch (request.field) {
          case "APP_URL":
            return "https://guided.adapter.test";
          case "OIDC_ISSUER":
            return "https://issuer.adapter.test";
          case "OIDC_CLIENT_ID":
            return "adapter-client";
          case "OIDC_CLIENT_SECRET":
            return "s3cr3t-adapter-value";
          default:
            return "";
        }
      },
    };

    const result = await stageGuidedInstallConfiguration(
      {
        installerAction: "install",
        plainMode: false,
        hasControllingTerminal: true,
        environmentFile: stagingEnvironmentFile,
        secretsDirectory: stagingSecretsDirectory,
        targetEnvironmentFile: join(sandbox, "target", ".env-orbit"),
        targetSecretsDirectory: join(sandbox, "target", ".orbit-secrets"),
        configureScript,
        orbitImage: VAPID_FIXTURE_TAG,
        profileChange: false,
        selectedProfile: "standard",
        selectedModel: undefined,
      },
      adapter,
      answers,
    );

    expect(result.status).toBe("staged");
    const envOrbit = readFileSync(stagingEnvironmentFile, "utf8");
    expect(envOrbit).toContain("APP_URL=https://guided.adapter.test");
    expect(envOrbit).not.toContain("s3cr3t-adapter-value");
    const secretFile = readFileSync(join(stagingSecretsDirectory, "oidc-client-secret"), "utf8");
    expect(secretFile).toBe("s3cr3t-adapter-value");
  });

  it("confirmApply always resolves 'apply' (unreachable from the shipped CLI path — see this module's header comment)", async () => {
    const adapter = createInstallGuidedConfigurationAdapter();
    await expect(adapter.confirmApply({ selectedProfile: "standard" })).resolves.toBe("apply");
  });
});

// O1-R9: a real (but fast, docker-free) child process stands in for
// configure.sh here — only the race matters: the child must already have
// exited, with Node not yet having marked its stdin stream destroyed, at
// the exact moment the write happens. That window is a couple of
// milliseconds wide at most (confirmed by hand: 1ms after a child exits,
// child.stdin.writable is still true and a write there emits an 'error'
// (EPIPE); by 5ms the stream is already destroyed and the same write is a
// silent no-op) and is inherently racy — `answers.answer()` is async per
// MachinePromptAnswerProvider, so a real answer provider can land the
// write at any point in that window. Before the fix, hitting it with no
// 'error' listener on child.stdin crashed the whole Node process (verified
// by hand: 3 of 5 bare repro runs with no listener terminated the process
// with an unhandled EPIPE); this loop repeats the exact shape enough times
// that the window would be hit at least once if the guard were missing.
describe("runMachinePromptSession — a child that exits before an answer can be written (#1151 O1-R9)", () => {
  it("does not crash the process across many attempts at the exact exit/write race; resolves ok:false each time", async () => {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const answers: MachinePromptAnswerProvider = {
        answer: () => new Promise((resolve) => setTimeout(() => resolve("https://example.test"), 1)),
      };

      const result = await runMachinePromptSession(
        "bash",
        ["-c", "printf 'prompt field=APP_URL kind=url required=true attempt=1\\n'; exit 7"],
        undefined,
        process.env,
        answers,
      );

      expect(result.ok).toBe(false);
      expect(result.events).toEqual([{ type: "prompt", field: "APP_URL", kind: "url", required: "true", attempt: 1 }]);
    }
  });

  it("still delivers the answer normally when the child outlives the write (no regression to the ordinary path)", async () => {
    const answers: MachinePromptAnswerProvider = {
      answer: () => "https://example.test",
    };

    const result = await runMachinePromptSession(
      "bash",
      [
        "-c",
        "printf 'prompt field=APP_URL kind=url required=true attempt=1\\n'; read -r answer; " +
          "if [[ \"$answer\" == \"https://example.test\" ]]; then exit 0; else exit 1; fi",
      ],
      undefined,
      process.env,
      answers,
    );

    expect(result.ok).toBe(true);
  });
});
