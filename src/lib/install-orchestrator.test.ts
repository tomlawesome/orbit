import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Clock } from "./health-wait";
import type { EngineEvent } from "./engine-event";
import type { ConfigurationScriptAdapter, ConfigurationScriptResult } from "./configuration-migration";
import type { OidcDiscoveryFetchAdapter, OidcFetchResult } from "./oidc-discovery";
import type { ConfigureScriptResult, GuidedConfigurationAdapter, MachinePromptAnswerProvider, MachinePromptSessionResult } from "./guided-configuration";
import { type InstallOrchestratorAdapters, type InstallOrchestratorContext, runInstall } from "./install-orchestrator";

// Driven-flow coverage for issue #295 slice 5's install/update orchestrator
// (install.sh:1259-1556's main flow). Unlike every parity test in this port,
// install.sh has no standalone entry point for its *main* flow at all (it is
// the whole script), so there is nothing to awk-extract or spawn here —
// slices 1-4's own modules and this slice's image-resolution.ts/
// deployment-assets.ts/deployment-profile.ts/health-wait.ts already each
// have their own parity coverage against the real script. This suite instead
// proves runInstall *sequences and wires* those already-proven pieces
// correctly: the happy path end-to-end against fake adapters standing in for
// docker/curl/configure.sh/configuration.sh, and each stage's fail-closed
// short-circuit. Every fake adapter method resolves synchronously/
// immediately (no real subprocess, no real sleep — a fake Clock drives
// health-wait deterministically, mirroring health-wait.test.ts's own
// fakeClock) so this whole suite runs with no blocking I/O and no timeouts
// of its own to configure.

const IMAGE_REPOSITORY = "ghcr.io/tomlawesome/orbit";
const RESOLVED_DIGEST = "sha256:" + "a".repeat(64);
const RESOLVED_REFERENCE = `${IMAGE_REPOSITORY}@${RESOLVED_DIGEST}`;
const REVISION = "b".repeat(40);
const VERSION = "v1.2.3";
const VALID_BASH_SCRIPT = "#!/usr/bin/env bash\ntrue\n";

const sandboxes: string[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function newTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), "orbit-orchestrator-target-"));
  sandboxes.push(dir);
  return dir;
}

function fakeClock(): Clock {
  // Advances virtual time by exactly however long `sleep` was asked to
  // wait — no real setTimeout, so a multi-round polling test still runs
  // instantly, matching health-wait.test.ts's own fakeClock pattern.
  let seconds = 0;
  return {
    nowSeconds: () => seconds,
    sleep: async (duration) => {
      seconds += duration;
    },
  };
}

/** Writes a strict guarantee-#6 pre-provisioned target: is_preprovisioned_input's exact shape, so validateTarget reports targetWasEmpty=true even though `.env-orbit`/`.orbit-secrets` already exist. */
function writePreprovisionedTarget(
  targetDir: string,
  overrides: Partial<Record<"APP_URL" | "OIDC_ISSUER" | "OIDC_CLIENT_ID" | "OIDC_CALLBACK_URL" | "COMPOSE_PROFILES" | "TIKA_URL" | "OLLAMA_MODEL", string>> = {},
): void {
  const fields = {
    APP_URL: "https://orbit.example",
    OIDC_ISSUER: "https://issuer.example",
    OIDC_CLIENT_ID: "orbit-client",
    OIDC_CALLBACK_URL: "https://orbit.example/api/auth/callback",
    ...overrides,
  };
  const lines = [
    `APP_URL=${fields.APP_URL}`,
    `OIDC_ISSUER=${fields.OIDC_ISSUER}`,
    `OIDC_CLIENT_ID=${fields.OIDC_CLIENT_ID}`,
    "OIDC_CLIENT_SECRET=",
    "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret",
    `OIDC_CALLBACK_URL=${fields.OIDC_CALLBACK_URL}`,
  ];
  if (overrides.COMPOSE_PROFILES !== undefined) lines.push(`COMPOSE_PROFILES=${overrides.COMPOSE_PROFILES}`);
  if (overrides.TIKA_URL !== undefined) lines.push(`TIKA_URL=${overrides.TIKA_URL}`);
  if (overrides.OLLAMA_MODEL !== undefined) lines.push(`OLLAMA_MODEL=${overrides.OLLAMA_MODEL}`);
  writeFileSync(join(targetDir, ".env-orbit"), lines.join("\n") + "\n", { mode: 0o600 });
  mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
  writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "s3cr3t", { mode: 0o600 });
}

/** Writes a recognized-existing-deployment target (validate_target's other truthy branch): docker-compose.yml + .env-orbit + .orbit-secrets, none of them symlinks — targetWasEmpty=false, so only `update` accepts it. */
function writeRecognizedDeploymentTarget(targetDir: string, profileFields: Record<string, string> = {}): void {
  writeFileSync(join(targetDir, "docker-compose.yml"), "services: {}\n");
  const lines = [
    "APP_URL=https://orbit.example",
    "OIDC_ISSUER=https://issuer.example",
    "OIDC_CLIENT_ID=orbit-client",
    "OIDC_CLIENT_SECRET=",
    "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret",
    "OIDC_CALLBACK_URL=https://orbit.example/api/auth/callback",
    `ORBIT_IMAGE=${RESOLVED_REFERENCE}`,
    ...Object.entries(profileFields).map(([key, value]) => `${key}=${value}`),
  ];
  writeFileSync(join(targetDir, ".env-orbit"), lines.join("\n") + "\n", { mode: 0o600 });
  mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
  writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "s3cr3t", { mode: 0o600 });
  writeFileSync(join(targetDir, ".orbit-secrets", "postgres-password"), "pgpass", { mode: 0o600 });
}

interface FakeDockerCall {
  method: string;
  args: unknown[];
}

interface FakeDockerOptions {
  pullOk?: boolean;
  repoDigestsOutput?: string | null;
  revisionLabel?: string | null;
  versionLabel?: string | null;
  bannerOk?: boolean;
  volumesByKeySubstring?: string | null;
  volumeLabels?: string | null;
  containersByVolume?: string | null;
  containersByProject?: string | null;
  containerImage?: string | null;
  volumeProjectLabel?: string | null;
  volumesExactName?: string | null;
  dockerAvailable?: boolean;
  oidcSandboxOk?: boolean;
  composePullOk?: boolean;
  composeUpOk?: boolean;
  composeConfigValidateOk?: boolean;
  probeDatabaseOk?: boolean;
  probeApplicationOk?: boolean;
  probeApplicationLivenessOk?: boolean;
  probeClamavOk?: boolean;
  probeTikaOk?: boolean;
  probeOllamaOk?: boolean;
  pullOllamaModelOk?: boolean;
  onCall?: (call: FakeDockerCall) => void;
  throwOnListVolumesByKeySubstring?: Error;
}

function createFakeDockerAdapter(options: FakeDockerOptions = {}) {
  const calls: FakeDockerCall[] = [];
  let composeProjectName = "";
  function record(method: string, ...args: unknown[]): void {
    calls.push({ method, args });
    options.onCall?.({ method, args });
  }
  return {
    calls,
    composeProjectNameAtCall(method: string): string | undefined {
      // Snapshot approach: since composeProjectName is read live at call
      // time by the real adapter, this fake records it alongside the call.
      return calls.find((call) => call.method === method)?.args[0] as string | undefined;
    },
    adapter: {
      pull: (...args: unknown[]) => {
        record("pull", ...args);
        return options.pullOk ?? true;
      },
      inspectRepoDigests: (...args: unknown[]) => {
        record("inspectRepoDigests", ...args);
        return options.repoDigestsOutput !== undefined ? options.repoDigestsOutput : RESOLVED_REFERENCE;
      },
      inspectRevisionLabel: (...args: unknown[]) => {
        record("inspectRevisionLabel", ...args);
        return options.revisionLabel !== undefined ? options.revisionLabel : REVISION;
      },
      inspectVersionLabel: (...args: unknown[]) => {
        record("inspectVersionLabel", ...args);
        return options.versionLabel !== undefined ? options.versionLabel : VERSION;
      },
      runBanner: (...args: unknown[]) => {
        record("runBanner", ...args);
        return options.bannerOk ?? true;
      },
      inspectVolumeLabels: (...args: unknown[]) => {
        record("inspectVolumeLabels", ...args);
        return options.volumeLabels ?? null;
      },
      listContainersByVolume: (...args: unknown[]) => {
        record("listContainersByVolume", ...args);
        return options.containersByVolume ?? null;
      },
      listContainersByProject: (...args: unknown[]) => {
        record("listContainersByProject", ...args);
        return options.containersByProject ?? null;
      },
      inspectContainerImage: (...args: unknown[]) => {
        record("inspectContainerImage", ...args);
        return options.containerImage ?? null;
      },
      listVolumesExactName: (...args: unknown[]) => {
        record("listVolumesExactName", ...args);
        return options.volumesExactName ?? null;
      },
      listVolumesByKeySubstring: (...args: unknown[]) => {
        record("listVolumesByKeySubstring", ...args);
        if (options.throwOnListVolumesByKeySubstring) throw options.throwOnListVolumesByKeySubstring;
        return options.volumesByKeySubstring !== undefined ? options.volumesByKeySubstring : "";
      },
      inspectVolumeProjectLabel: (...args: unknown[]) => {
        record("inspectVolumeProjectLabel", ...args);
        return options.volumeProjectLabel ?? null;
      },
      checkDockerAvailable: () => {
        record("checkDockerAvailable");
        return options.dockerAvailable ?? true;
      },
      validateOidcDiscoverySandbox: (...args: unknown[]) => {
        record("validateOidcDiscoverySandbox", ...args);
        return options.oidcSandboxOk ?? true;
      },
      composePull: (...args: unknown[]) => {
        record("composePull", composeProjectName, ...args);
        return options.composePullOk ?? true;
      },
      composeUp: (...args: unknown[]) => {
        record("composeUp", composeProjectName, ...args);
        return options.composeUpOk ?? true;
      },
      composeDown: (...args: unknown[]) => {
        record("composeDown", composeProjectName, ...args);
      },
      composeConfigValidate: (...args: unknown[]) => {
        record("composeConfigValidate", composeProjectName, ...args);
        return options.composeConfigValidateOk ?? true;
      },
      probeDatabaseHealth: () => {
        record("probeDatabaseHealth");
        return options.probeDatabaseOk ?? true;
      },
      probeApplicationHealth: () => {
        record("probeApplicationHealth");
        return options.probeApplicationOk ?? true;
      },
      probeClamavHealth: () => {
        record("probeClamavHealth");
        return options.probeClamavOk ?? true;
      },
      probeTikaHealth: () => {
        record("probeTikaHealth");
        return options.probeTikaOk ?? true;
      },
      probeOllamaHealth: () => {
        record("probeOllamaHealth");
        return options.probeOllamaOk ?? true;
      },
      probeApplicationLiveness: () => {
        record("probeApplicationLiveness");
        return options.probeApplicationLivenessOk ?? true;
      },
      pullOllamaModel: (...args: unknown[]) => {
        record("pullOllamaModel", ...args);
        return options.pullOllamaModelOk ?? true;
      },
      setComposeProjectName: (name: string) => {
        composeProjectName = name;
        record("setComposeProjectName", name);
      },
    },
  };
}

/** fetchAsset never mkdir's its own destination's parent — mirroring install-curl-adapter.ts's real createInstallAssetFetchAdapter exactly, so this suite would fail loudly if install-orchestrator.ts's own per-asset mkdir (install.sh:1406-1407) regressed. */
function fakeFetchAsset(overrides: { failFor?: string; emptyFor?: string; scriptContentFor?: Record<string, string> } = {}) {
  return (url: string, destinationPath: string): { ok: boolean } => {
    // Strips "https://raw.githubusercontent.com/<owner>/<repo>/<revision>/"
    // — 6 segments once split on "/" ("https:", "", "raw.githubusercontent.com",
    // "<owner>", "<repo>", "<revision>"), since the owner/repo pair (this
    // suite's own "tomlawesome/orbit") itself contains a slash.
    const assetName = url.split("/").slice(6).join("/");
    if (overrides.failFor && assetName.endsWith(overrides.failFor)) return { ok: false };
    let content = `content-for-${assetName}`;
    if (assetName.startsWith("scripts/")) {
      content = overrides.scriptContentFor?.[assetName] ?? VALID_BASH_SCRIPT;
    }
    if (overrides.emptyFor && assetName.endsWith(overrides.emptyFor)) content = "";
    writeFileSync(destinationPath, content);
    return { ok: true };
  };
}

function fakeOidcFetch(overrides: { httpStatus?: string; curlExitCode?: number; writeContent?: string } = {}): OidcDiscoveryFetchAdapter {
  return {
    fetch: (_discoveryUrl: string, destinationPath: string): OidcFetchResult => {
      writeFileSync(destinationPath, overrides.writeContent ?? '{"issuer":"https://issuer.example"}');
      return { curlExitCode: overrides.curlExitCode ?? 0, httpStatus: overrides.httpStatus ?? "200" };
    },
  };
}

function fakeConfigurationScript(overrides: { preflightOk?: boolean; migrateOk?: boolean; migrateOutput?: string } = {}): ConfigurationScriptAdapter {
  return {
    runPreflight: (): ConfigurationScriptResult => ({ status: overrides.preflightOk === false ? 1 : 0, stdout: "" }),
    runMigrate: (): ConfigurationScriptResult => ({
      status: overrides.migrateOk === false ? 1 : 0,
      stdout: overrides.migrateOutput ?? "Orbit configuration: already current schema v1 version v1.2.3\n",
    }),
  };
}

interface FakeGuidedOptions {
  runDefaultOk?: boolean;
  runCheckOk?: boolean;
  runCheckStdout?: string;
  runInitOk?: boolean;
  runSetOidcSecretOk?: boolean;
  confirmApply?: "apply" | "cancel";
  writeGuidedOutputs?: boolean;
}

/** Stands in for scripts/configure.sh: for the guided (stage_guided_install_configuration) path, writes a minimal valid .env-orbit/.orbit-secrets to the staged paths it is handed — the same real-filesystem side effects the real subprocess adapter (install-script-adapters.ts) has, driving guided-configuration.ts's own post-conditions instead of a hand-copied stand-in. */
function createFakeGuidedConfigurationAdapter(options: FakeGuidedOptions = {}): GuidedConfigurationAdapter {
  return {
    runInit: async (configureScript: string): Promise<MachinePromptSessionResult> => {
      if (options.runInitOk === false) return { ok: false, events: [] };
      if (options.writeGuidedOutputs) {
        const scratchRoot = join(configureScript, "..", "..");
        writeFileSync(
          join(scratchRoot, ".env-orbit"),
          ["APP_URL=https://guided.example", "OIDC_ISSUER=https://issuer.example", "OIDC_CLIENT_ID=guided-client", "OIDC_CALLBACK_URL=https://guided.example/api/auth/callback", ""].join("\n"),
          { mode: 0o600 },
        );
      }
      return { ok: true, events: [] };
    },
    runDefault: (): ConfigureScriptResult => ({ status: options.runDefaultOk === false ? 1 : 0, stdout: "" }),
    runSetOidcSecret: async (configureScript: string): Promise<MachinePromptSessionResult> => {
      if (options.runSetOidcSecretOk === false) return { ok: false, events: [] };
      if (options.writeGuidedOutputs) {
        const scratchRoot = join(configureScript, "..", "..");
        mkdirSync(join(scratchRoot, ".orbit-secrets"), { mode: 0o700, recursive: true });
        writeFileSync(join(scratchRoot, ".orbit-secrets", "oidc-client-secret"), "s3cr3t-guided", { mode: 0o600 });
      }
      return { ok: true, events: [] };
    },
    runSetDeploymentProfile: (): ConfigureScriptResult => ({ status: 0, stdout: "" }),
    // Defaults to non-empty stdout on success: stageGuidedInstallConfiguration
    // (guarantee #32) treats an empty readiness summary as a failure in its
    // own right, distinct from a non-zero exit status.
    runCheck: (): ConfigureScriptResult => ({
      status: options.runCheckOk === false ? 1 : 0,
      stdout: options.runCheckStdout ?? (options.runCheckOk === false ? "" : "ready\n"),
    }),
    confirmApply: async () => options.confirmApply ?? "apply",
  };
}

const throwingAnswers: MachinePromptAnswerProvider = {
  answer: () => {
    throw new Error("orbit-orchestrator-test: unreachable — hasControllingTerminal is always false in this scenario");
  },
};

interface ScenarioOptions {
  docker?: FakeDockerOptions;
  fetchAsset?: Parameters<typeof fakeFetchAsset>[0];
  oidcFetch?: Parameters<typeof fakeOidcFetch>[0];
  configurationScript?: Parameters<typeof fakeConfigurationScript>[0];
  guided?: FakeGuidedOptions;
  curlAvailable?: boolean;
  answers?: MachinePromptAnswerProvider;
  context?: Partial<InstallOrchestratorContext>;
}

function buildScenario(targetDir: string, options: ScenarioOptions = {}) {
  const docker = createFakeDockerAdapter(options.docker);
  const events: EngineEvent[] = [];
  const adapters: InstallOrchestratorAdapters = {
    docker: docker.adapter,
    fetchAsset: fakeFetchAsset(options.fetchAsset),
    checkCurlAvailable: () => options.curlAvailable ?? true,
    oidcFetch: fakeOidcFetch(options.oidcFetch),
    configurationScript: fakeConfigurationScript(options.configurationScript),
    guidedConfiguration: createFakeGuidedConfigurationAdapter(options.guided),
    answers: options.answers ?? throwingAnswers,
    clock: fakeClock(),
  };
  const context: InstallOrchestratorContext = {
    targetDir,
    requestedAction: "install",
    repository: "tomlawesome/orbit",
    registry: "ghcr.io",
    channel: "latest",
    fallbackBasename: "orbit",
    hasControllingTerminal: false,
    readinessTimeoutSeconds: 5,
    readinessPollSeconds: 1,
    ...options.context,
  };
  return {
    docker,
    events,
    run: () => runInstall(context, adapters, (event) => events.push(event)),
  };
}

describe("runInstall — success paths", () => {
  it("installs against a fresh, pre-provisioned target end-to-end (guarantee #6's is_preprovisioned_input contract)", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const scenario = buildScenario(targetDir, { context: { requestedAction: "install" } });

    const outcome = await scenario.run();

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.resolvedReference).toBe(RESOLVED_REFERENCE);
      expect(outcome.revision).toBe(REVISION);
      expect(outcome.imageVersion).toBe(VERSION);
      expect(outcome.selectedProfile).toBe("standard");
    }
    // Nested nested-directory assets (config/, scripts/) actually landed —
    // regression coverage for install-orchestrator.ts's own per-asset mkdir
    // fix (install.sh:1406-1407): fakeFetchAsset never creates its
    // destination's parent directory itself.
    expect(existsSync(join(targetDir, "config", "tika-config.xml"))).toBe(true);
    expect(existsSync(join(targetDir, "scripts", "configure.sh"))).toBe(true);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain(`ORBIT_IMAGE=${RESOLVED_REFERENCE}`);
    // The .orbit-install-scratch.* working directory is always removed,
    // success or failure.
    expect(existsSync(targetDir)).toBe(true);
    const leftovers = readdirSync(targetDir).filter((name: string) => name.startsWith(".orbit-install-scratch."));
    expect(leftovers).toEqual([]);
  });

  it("updates an already-recognized deployment, preserving its existing profile (resolve_installer_action's non-interactive update branch)", async () => {
    const targetDir = newTarget();
    writeRecognizedDeploymentTarget(targetDir, { COMPOSE_PROFILES: "processing,ai", TIKA_URL: "http://orbit-tika:9998", OLLAMA_MODEL: "llama3" });
    const scenario = buildScenario(targetDir, { context: { requestedAction: "update" } });

    const outcome = await scenario.run();

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.selectedProfile).toBe("full");
    }
    // Profile preserved on update => tika and ollama images/health are both exercised.
    const calledMethods = scenario.docker.calls.map((call) => call.method);
    expect(calledMethods).toContain("probeTikaHealth");
    expect(calledMethods).toContain("probeOllamaHealth");
  });

  it("resolves the Docker Compose project name from a pre-existing volume's own label and uses it for every compose call, even though it differs from the fallback basename (install.sh:573)", async () => {
    const targetDir = newTarget();
    writeRecognizedDeploymentTarget(targetDir);
    const scenario = buildScenario(targetDir, {
      context: { requestedAction: "update", fallbackBasename: "wrong-fallback-name" },
      docker: {
        volumesByKeySubstring: "renamed-project_orbit-db-data",
        volumeLabels: "renamed-project|orbit-db-data",
        containersByVolume: "aaaaaaaaaaaa|renamed-project|orbit-db",
        containersByProject: "bbbbbbbbbbbb|renamed-project|orbit-app",
        containerImage: RESOLVED_REFERENCE,
        volumeProjectLabel: "renamed-project",
        volumesExactName: "renamed-project_orbit-db-data",
      },
    });

    const outcome = await scenario.run();

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.composeProjectName).toBe("renamed-project");
    const composePullCall = scenario.docker.calls.find((call) => call.method === "composePull");
    expect(composePullCall?.args[0]).toBe("renamed-project");
    const composeUpCall = scenario.docker.calls.find((call) => call.method === "composeUp");
    expect(composeUpCall?.args[0]).toBe("renamed-project");
  });

  it("stages and applies a real guided install for a fresh, empty target with a controlling terminal", async () => {
    const targetDir = newTarget();
    const scenario = buildScenario(targetDir, {
      context: { requestedAction: "install", hasControllingTerminal: true },
      guided: { writeGuidedOutputs: true },
    });

    const outcome = await scenario.run();

    expect(outcome.status).toBe("ok");
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain("APP_URL=https://guided.example");
    expect(readFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "utf8")).toBe("s3cr3t-guided");
  });
});

describe("runInstall — target/action guards (guarantee #21)", () => {
  it("refuses a non-empty, unrecognizable target before any docker/curl/network step", async () => {
    const targetDir = newTarget();
    writeFileSync(join(targetDir, "unexpected-file.txt"), "not an orbit deployment");
    const scenario = buildScenario(targetDir);

    const outcome = await scenario.run();

    expect(outcome).toMatchObject({ status: "failed", phase: "host", component: "host" });
    expect(scenario.docker.calls).toEqual([]);
  });

  it("refuses `install` against a non-empty, recognized-existing deployment", async () => {
    const targetDir = newTarget();
    writeRecognizedDeploymentTarget(targetDir);
    const scenario = buildScenario(targetDir, { context: { requestedAction: "install" } });

    const outcome = await scenario.run();

    expect(outcome).toMatchObject({ status: "failed", phase: "host" });
    if (outcome.status === "failed") expect(outcome.message).toContain("Install requires an empty target");
  });

  it("refuses `update` against an empty target", async () => {
    const targetDir = newTarget();
    const scenario = buildScenario(targetDir, { context: { requestedAction: "update" } });

    const outcome = await scenario.run();

    expect(outcome).toMatchObject({ status: "failed", phase: "host" });
    if (outcome.status === "failed") expect(outcome.message).toContain("Update requires a recognized existing Orbit deployment");
  });
});

describe("runInstall — host tool availability (guarantee #40)", () => {
  it("fails closed when docker/compose is unavailable", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const scenario = buildScenario(targetDir, { docker: { dockerAvailable: false } });

    const outcome = await scenario.run();
    expect(outcome).toMatchObject({ status: "failed", phase: "host", message: "Docker and Docker Compose v2 are required." });
  });

  it("fails closed when curl is unavailable", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const scenario = buildScenario(targetDir, { curlAvailable: false });

    const outcome = await scenario.run();
    expect(outcome).toMatchObject({ status: "failed", phase: "host", message: "curl is required." });
  });
});

describe("runInstall — database volume safety wiring (guarantees #13-18)", () => {
  it("fails closed (not silently) when multiple candidate database volumes are found", async () => {
    const targetDir = newTarget();
    writeRecognizedDeploymentTarget(targetDir);
    const scenario = buildScenario(targetDir, {
      context: { requestedAction: "update" },
      docker: { volumesByKeySubstring: "a_orbit-db-data\nb_orbit-db-data" },
    });

    const outcome = await scenario.run();
    expect(outcome).toMatchObject({ status: "failed", phase: "host" });
    if (outcome.status === "failed") expect(outcome.message).toContain("Multiple Orbit database volumes were found");
  });

  it("propagates a genuine programming error rather than swallowing it into a 'failed' outcome (only DatabaseVolumeSafetyRefusal is caught)", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const scenario = buildScenario(targetDir, {
      docker: { throwOnListVolumesByKeySubstring: new TypeError("simulated adapter bug, not a characterized refusal") },
    });

    await expect(scenario.run()).rejects.toThrow("simulated adapter bug");
  });

  it("fails closed gracefully (not an unhandled rejection) when derive_compose_project_name's own refusal fires from inside verify_database_volume_safety's first call (guarantee #12)", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    // Not a safe Compose project name (uppercase, install.sh:443's own
    // `^[a-z0-9][a-z0-9_-]*$` requirement) — deriveComposeProjectName
    // throws ComposeProjectNameRefusal, which
    // verifyDatabaseVolumeSafety's own first call does not wrap in a
    // DatabaseVolumeSafetyRefusal of its own (database-volume-safety.ts:228).
    const scenario = buildScenario(targetDir, { context: { requestedComposeProjectName: "Not-A-Safe-Name" } });

    const outcome = await scenario.run();
    expect(outcome).toMatchObject({ status: "failed", phase: "host" });
    if (outcome.status === "failed") expect(outcome.message).toContain("Could not determine a safe Docker Compose project name");
  });
});

describe("runInstall — image identity resolution (guarantees #41-44)", () => {
  it("fails closed when the channel cannot be pulled", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const scenario = buildScenario(targetDir, { docker: { pullOk: false } });

    const outcome = await scenario.run();
    expect(outcome).toMatchObject({ status: "failed", phase: "identity", component: "image" });
    if (outcome.status === "failed") expect(outcome.message).toContain("Could not pull");
  });

  it("fails closed when the resolved image cannot render its canonical banner (guarantee #44)", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const scenario = buildScenario(targetDir, { docker: { bannerOk: false } });

    const outcome = await scenario.run();
    expect(outcome).toMatchObject({ status: "failed", phase: "identity", component: "image" });
    if (outcome.status === "failed") expect(outcome.message).toContain("canonical banner");
  });
});

describe("runInstall — asset fetch and syntax check (guarantee #45)", () => {
  it("fails closed when a nested asset (config/tika-config.xml) cannot be fetched", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const scenario = buildScenario(targetDir, { fetchAsset: { failFor: "config/tika-config.xml" } });

    const outcome = await scenario.run();
    expect(outcome).toMatchObject({ status: "failed", phase: "assets", component: "assets" });
    if (outcome.status === "failed") expect(outcome.message).toContain("Could not fetch config/tika-config.xml");
  });

  it("fails closed when a fetched asset is empty", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const scenario = buildScenario(targetDir, { fetchAsset: { emptyFor: "docker-compose.yml" } });

    const outcome = await scenario.run();
    expect(outcome).toMatchObject({ status: "failed", phase: "assets", component: "assets" });
    if (outcome.status === "failed") expect(outcome.message).toContain("is empty");
  });

  it("fails closed when a fetched script fails `bash -n`", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const scenario = buildScenario(targetDir, {
      fetchAsset: { scriptContentFor: { "scripts/configure.sh": "if not valid bash then(" } },
    });

    const outcome = await scenario.run();
    expect(outcome).toMatchObject({ status: "failed", phase: "assets", component: "assets" });
    if (outcome.status === "failed") expect(outcome.message).toContain("failed a syntax check");
  });

  it("installs deployment assets at mode 0644, not the secret-file 0600 default (issue #383: Compose-mounted config/tika-config.xml must stay readable by the non-root orbit-tika container)", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const scenario = buildScenario(targetDir);

    const outcome = await scenario.run();

    expect(outcome.status).toBe("ok");
    for (const asset of ["docker-compose.yml", "config/tika-config.xml", "scripts/configure.sh", "scripts/backup.sh"]) {
      const mode = statSync(join(targetDir, asset)).mode & 0o777;
      expect(mode, `${asset} mode`).toBe(0o644);
    }
    // The secret-bearing environment file/secrets tree are unaffected.
    expect(statSync(join(targetDir, ".env-orbit")).mode & 0o777).toBe(0o600);
  });
});

describe("runInstall — guided configuration wiring (guarantees #30-32)", () => {
  it("returns 'cancelled' (not 'failed') when the final apply/cancel review is declined", async () => {
    const targetDir = newTarget();
    const scenario = buildScenario(targetDir, {
      context: { requestedAction: "install", hasControllingTerminal: true },
      guided: { confirmApply: "cancel" },
    });

    const outcome = await scenario.run();
    expect(outcome).toEqual({ status: "cancelled" });
  });

  it("fails closed when guided --init is cancelled or invalid, leaving the target untouched", async () => {
    const targetDir = newTarget();
    const scenario = buildScenario(targetDir, {
      context: { requestedAction: "install", hasControllingTerminal: true },
      guided: { runInitOk: false },
    });

    const outcome = await scenario.run();
    expect(outcome).toMatchObject({ status: "failed", phase: "configuration", component: "configuration" });
    if (outcome.status === "failed") expect(outcome.message).toContain("target remains unchanged");
    expect(existsSync(join(targetDir, ".env-orbit"))).toBe(false);
  });
});

describe("runInstall — prepare_configuration wiring (guarantee #24)", () => {
  it("fails closed with install.sh's exact remediation guidance when required fields are missing and there is no controlling terminal", async () => {
    const targetDir = newTarget();
    writeRecognizedDeploymentTarget(targetDir);
    const scenario = buildScenario(targetDir, {
      context: { requestedAction: "update", hasControllingTerminal: false },
      guided: { runCheckOk: false, runCheckStdout: "missing OIDC_CLIENT_SECRET\n" },
    });

    const outcome = await scenario.run();
    expect(outcome).toMatchObject({ status: "failed", phase: "configuration", component: "configuration" });
    if (outcome.status === "failed") {
      expect(outcome.guidance).toBeDefined();
      expect(outcome.guidance?.[0]).toContain("configuration fields requiring attention: OIDC_CLIENT_SECRET");
      expect(outcome.guidance?.length).toBe(4);
    }
  });
});

describe("runInstall — OIDC discovery wiring (guarantees #25-27)", () => {
  it("fails closed on a non-2xx discovery response", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const scenario = buildScenario(targetDir, { oidcFetch: { httpStatus: "500" } });

    const outcome = await scenario.run();
    expect(outcome).toMatchObject({ status: "failed", phase: "oidc", component: "oidc" });
  });

  it("fails closed when the sandboxed discovery-document validator rejects the response", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const scenario = buildScenario(targetDir, { docker: { oidcSandboxOk: false } });

    const outcome = await scenario.run();
    expect(outcome).toMatchObject({ status: "failed", phase: "oidc", component: "oidc" });
  });
});

describe("runInstall — transactional commit (guarantee #56) and rollback safety", () => {
  it("rolls back every staged file change when Compose config validation fails after staging but before commit", async () => {
    const targetDir = newTarget();
    writeRecognizedDeploymentTarget(targetDir);
    const before = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    const scenario = buildScenario(targetDir, {
      context: { requestedAction: "update" },
      docker: { composeConfigValidateOk: false },
    });

    const outcome = await scenario.run();

    expect(outcome).toMatchObject({ status: "failed", phase: "compose", component: "compose" });
    // Rolled back: the pre-run .env-orbit content is restored verbatim (no
    // ORBIT_IMAGE line was left behind), and no deployment_assets were left
    // installed in the target.
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(before);
    expect(existsSync(join(targetDir, "docker-compose.mail.yml"))).toBe(false);
    // No leftover recovery-staging evidence: rollback succeeded.
    const remaining = readdirSync(targetDir).filter(
      (name: string) => name.startsWith(".orbit-install-staging.") || name.startsWith(".orbit-install-scratch."),
    );
    expect(remaining).toEqual([]);
  });

  it("does not roll back already-committed file changes when a later service-preparation step fails (guarantee #56: outside the file transaction's rollback scope)", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const scenario = buildScenario(targetDir, { docker: { composePullOk: false } });

    const outcome = await scenario.run();

    expect(outcome).toMatchObject({ status: "failed", phase: "preparation", component: "database" });
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain(`ORBIT_IMAGE=${RESOLVED_REFERENCE}`);
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(true);
  });
});

describe("runInstall — service start and bounded health-wait wiring (guarantees #33-39)", () => {
  it("tears down freshly-created services (only) when `compose up` fails on a fresh install", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const scenario = buildScenario(targetDir, { docker: { composeUpOk: false } });

    const outcome = await scenario.run();
    expect(outcome).toMatchObject({ status: "failed", phase: "host" });
    expect(scenario.docker.calls.some((call) => call.method === "composeDown")).toBe(true);
  });

  it("never tears down services when `compose up` fails on an update against a pre-existing deployment", async () => {
    const targetDir = newTarget();
    writeRecognizedDeploymentTarget(targetDir);
    const scenario = buildScenario(targetDir, { context: { requestedAction: "update" }, docker: { composeUpOk: false } });

    const outcome = await scenario.run();
    expect(outcome).toMatchObject({ status: "failed", phase: "host" });
    expect(scenario.docker.calls.some((call) => call.method === "composeDown")).toBe(false);
  });

  it("fails closed when the database never becomes healthy within the bounded window", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const scenario = buildScenario(targetDir, { docker: { probeDatabaseOk: false } });

    const outcome = await scenario.run();
    expect(outcome).toMatchObject({ status: "failed", phase: "database", component: "database" });
  });

  it("distinguishes 'stopped before ready' from 'timed out but still running' using the liveness probe (guarantee #38)", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const stillRunning = buildScenario(targetDir, { docker: { probeApplicationOk: false, probeApplicationLivenessOk: true } });
    const stillRunningOutcome = await stillRunning.run();
    expect(stillRunningOutcome).toMatchObject({ status: "failed", phase: "application" });
    if (stillRunningOutcome.status === "failed") expect(stillRunningOutcome.message).toContain("did not report ready");

    const targetDir2 = newTarget();
    writePreprovisionedTarget(targetDir2);
    const stopped = buildScenario(targetDir2, { docker: { probeApplicationOk: false, probeApplicationLivenessOk: false } });
    const stoppedOutcome = await stopped.run();
    expect(stoppedOutcome).toMatchObject({ status: "failed", phase: "application" });
    if (stoppedOutcome.status === "failed") expect(stoppedOutcome.message).toContain("stopped before it could report ready");
  });

  it("fails closed when the private scanner (clamav, always-on) never becomes healthy", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const scenario = buildScenario(targetDir, { docker: { probeClamavOk: false } });

    const outcome = await scenario.run();
    expect(outcome).toMatchObject({ status: "failed", phase: "optional", component: "clamav" });
  });

  it("skips tika/ollama pull and health entirely for the standard profile, never calling their adapter methods", async () => {
    const targetDir = newTarget();
    writePreprovisionedTarget(targetDir);
    const scenario = buildScenario(targetDir, {});

    const outcome = await scenario.run();
    expect(outcome.status).toBe("ok");
    const calledMethods = scenario.docker.calls.map((call) => call.method);
    expect(calledMethods).not.toContain("probeTikaHealth");
    expect(calledMethods).not.toContain("probeOllamaHealth");
    expect(calledMethods).not.toContain("pullOllamaModel");
  });
});
