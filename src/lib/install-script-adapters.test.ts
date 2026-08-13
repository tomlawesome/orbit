import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createInstallConfigurationScriptAdapter,
  createInstallGuidedConfigurationAdapter,
} from "./install-script-adapters";
import { runConfigurationMigration, runConfigurationPreflight } from "./configuration-migration";
import { prepareConfiguration, stageGuidedInstallConfiguration } from "./guided-configuration";

// Whole-script coverage for issue #295 slice 5's shipped subprocess
// adapters — the production implementations the plan deferred from slice 3
// (ConfigurationScriptAdapter) and slice 4 (GuidedConfigurationAdapter).
// Both spawn the real, unmodified scripts/configuration.sh and
// scripts/configure.sh directly (the same "spawn the real script" strategy
// configuration-migration.parity.test.ts and guided-configuration.parity.
// test.ts already established for these two scripts specifically, since
// both have real, independently-invocable entry points), proving this
// slice's own shipped adapters — not a local, unshipped reference adapter —
// actually drive configuration-migration.ts's/guided-configuration.ts's pure
// orchestration functions to a real, correct result.

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
  it("drives the real configuration.sh --preflight/--migrate to a successful migration", () => {
    const sandbox = newSandbox("orbit-install-config-adapter-");
    mkdirSync(join(sandbox, "scripts"));
    const scriptPath = join(sandbox, "scripts", "configuration.sh");
    writeFileSync(scriptPath, readFileSync(join(repoRoot, "scripts", "configuration.sh")));
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
    mkdirSync(join(sandbox, "scripts"));
    const scriptPath = join(sandbox, "scripts", "configuration.sh");
    writeFileSync(scriptPath, readFileSync(join(repoRoot, "scripts", "configuration.sh")));
    const environmentFile = join(sandbox, ".env-orbit");
    writeFileSync(environmentFile, "this is not valid\n", { mode: 0o600 });

    const adapter = createInstallConfigurationScriptAdapter({ cwd: sandbox });
    const preflight = runConfigurationPreflight(scriptPath, environmentFile, adapter);
    expect(preflight).toEqual({ ok: false, message: "Configuration preflight failed; restoring the previous deployment." });
  });
});

describe("createInstallGuidedConfigurationAdapter (issue #295 slice 4 deferral)", () => {
  // Every configure.sh path this suite exercises passes through the bare
  // default invocation at least once (guided-configuration.ts's own
  // stageGuidedInstallConfiguration/prepareConfiguration both call
  // adapter.runDefault), which reaches ensure_vapid_keys
  // (configure.sh:879-916). That function only avoids a real `docker build`
  // (and, from a plain tmp-dir sandbox outside any git worktree, a `git
  // rev-parse` that fails) when ORBIT_IMAGE is already a locally-inspectable
  // image. Rather than pre-seed a fake vapid-private-key file (which would
  // make `.orbit-secrets` already exist and falsely trip guarded-
  // configuration's own guarantee-#30 "no pre-existing .orbit-secrets"
  // precondition for the staged-guided-install test), this suite builds the
  // repo's own `vapid-generator` Dockerfile target once — the same minimal
  // image ensure_vapid_keys's primary path already expects to run
  // `/opt/orbit/scripts/generate-vapid.mjs` inside — and tags it as a valid
  // `orbit-local:<12 hex>` reference so `docker image inspect` finds it
  // locally with no registry pull and no git dependency.
  const VAPID_FIXTURE_TAG = "orbit-local:0f00d00face1";
  let vapidFixtureAvailable = false;

  beforeAll(() => {
    const build = spawnSync("docker", ["build", "--target", "vapid-generator", "--tag", VAPID_FIXTURE_TAG, "."], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    vapidFixtureAvailable = build.status === 0;
  }, 60_000);

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
        "APP_URL=https://guided.adapter.test",
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

    const adapter = createInstallGuidedConfigurationAdapter({ cwd: sandbox });
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
    const adapter = createInstallGuidedConfigurationAdapter({ cwd: sandbox });
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
    const adapter = createInstallGuidedConfigurationAdapter({ cwd: sandbox });
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
