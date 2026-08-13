import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  missingConfigurationFields,
  missingGuidedFields,
  missingRequiredFields,
  noninteractiveConfigurationGuidance,
  parseMachinePromptLine,
  prepareConfiguration,
  stageGuidedInstallConfiguration,
  type ConfigureScriptResult,
  type GuidedConfigurationAdapter,
  type MachinePromptAnswerProvider,
  type MachinePromptSessionResult,
  type PrepareConfigurationContext,
  type StageGuidedInstallConfigurationContext,
} from "./guided-configuration";

// Ported from scripts/install.sh's stage_guided_install_configuration
// (install.sh:1031-1077), prepare_configuration (install.sh:947-1008), and
// the missing_*_fields/print_noninteractive_configuration_guidance helpers
// they call (install.sh:843-885). Guarantee numbers below cite
// docs/installer-guarantees.md, Part 1 / install.sh. See
// guided-configuration.parity.test.ts for source-extraction parity against
// the real, unmodified install.sh and a real machine-prompt exchange
// against the real, unmodified scripts/configure.sh.

const sandboxes: string[] = [];
function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "orbit-guided-configuration-"));
  sandboxes.push(dir);
  return dir;
}
afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
});

describe("parseMachinePromptLine", () => {
  it("parses a prompt line (docs/engine-events.md 'Machine prompts (v0)' §Line grammar)", () => {
    expect(parseMachinePromptLine("prompt field=APP_URL kind=url required=true attempt=1")).toEqual({
      type: "prompt",
      field: "APP_URL",
      kind: "url",
      required: "true",
      attempt: 1,
    });
  });

  it("parses a prompt-reject line", () => {
    expect(parseMachinePromptLine("prompt-reject field=APP_URL reason=not-https")).toEqual({
      type: "prompt-reject",
      field: "APP_URL",
      reason: "not-https",
    });
  });

  it("parses a prompt-accept line", () => {
    expect(parseMachinePromptLine("prompt-accept field=OIDC_CLIENT_ID")).toEqual({
      type: "prompt-accept",
      field: "OIDC_CLIENT_ID",
    });
  });

  it("parses a prompt-abort line", () => {
    expect(parseMachinePromptLine("prompt-abort field=OIDC_CLIENT_SECRET")).toEqual({
      type: "prompt-abort",
      field: "OIDC_CLIENT_SECRET",
    });
  });

  it("returns null for an unrecognised line, e.g. configure.sh's closing message", () => {
    expect(parseMachinePromptLine("Orbit guided configuration saved APP_URL, OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CALLBACK_URL.")).toBeNull();
  });

  it("never captures a value token, only the fixed field/kind/reason/attempt vocabulary (docs/engine-events.md §Security)", () => {
    const parsed = parseMachinePromptLine("prompt field=OIDC_CLIENT_SECRET kind=secret required=true attempt=1");
    expect(Object.keys(parsed as object).sort()).toEqual(["attempt", "field", "kind", "required", "type"]);
  });
});

describe("missing_*_fields (install.sh:843-877)", () => {
  const readiness = [
    "ready APP_URL",
    "missing ORBIT_IMAGE",
    "missing OIDC_ISSUER",
    "ready OIDC_CLIENT_ID",
    "missing OIDC_CLIENT_SECRET",
    "ready OIDC_CALLBACK_URL",
    "optional processing",
    "missing ai",
    "optional mail",
  ].join("\n");

  it("missingRequiredFields collects only fields in the required list, in declaration order (install.sh:845)", () => {
    expect(missingRequiredFields(readiness)).toEqual(["ORBIT_IMAGE", "OIDC_ISSUER", "OIDC_CLIENT_SECRET"]);
  });

  it("missingGuidedFields collects only the guided subset (install.sh:857)", () => {
    expect(missingGuidedFields(readiness)).toEqual(["OIDC_ISSUER"]);
  });

  it("missingConfigurationFields includes optional-service fields too (install.sh:869)", () => {
    expect(missingConfigurationFields(readiness)).toEqual(["ORBIT_IMAGE", "OIDC_ISSUER", "OIDC_CLIENT_SECRET", "ai"]);
  });

  it("ignores a line that merely contains, but does not exactly equal, 'missing <field>'", () => {
    expect(missingRequiredFields("missing ORBIT_IMAGE_EXTRA\nmissing_APP_URL")).toEqual([]);
  });
});

describe("noninteractiveConfigurationGuidance (install.sh:879-885, guarantee #24)", () => {
  it("matches install.sh's exact remediation lines, space-joining missing fields", () => {
    expect(noninteractiveConfigurationGuidance(["APP_URL", "OIDC_CLIENT_SECRET"])).toEqual([
      "Orbit installer: configuration fields requiring attention: APP_URL OIDC_CLIENT_SECRET.",
      "Orbit installer: non-interactive use requires a complete .env-orbit and an existing owner-only .orbit-secrets/oidc-client-secret file.",
      "Orbit installer: safe next command in a controlling terminal: curl -fsSL https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/install.sh | bash",
      "Orbit installer: configure with --init, provide the secret with --set-oidc-secret, then verify with --check before rerunning automation.",
    ]);
  });
});

// --- Fake adapter for orchestration tests -----------------------------

const OK_SESSION: MachinePromptSessionResult = { ok: true, events: [] };
const FAIL_SESSION: MachinePromptSessionResult = { ok: false, events: [] };
const OK_RESULT: ConfigureScriptResult = { status: 0, stdout: "" };
const noopAnswers: MachinePromptAnswerProvider = { answer: () => "" };

interface FakeAdapterOptions {
  init?: MachinePromptSessionResult | MachinePromptSessionResult[];
  defaultResult?: ConfigureScriptResult;
  setOidcSecret?: MachinePromptSessionResult;
  setDeploymentProfile?: ConfigureScriptResult;
  check?: ConfigureScriptResult[];
  confirmApply?: "apply" | "cancel";
}

interface FakeAdapterCalls {
  init: Array<{ configureScript: string; orbitImage: string }>;
  default: Array<{ configureScript: string; orbitImage: string }>;
  setOidcSecret: number;
  setDeploymentProfile: Array<{ profile: string; model: string | undefined }>;
  check: number;
  confirmApply: Array<{ selectedProfile: string }>;
}

function fakeAdapter(options: FakeAdapterOptions = {}): { adapter: GuidedConfigurationAdapter; calls: FakeAdapterCalls } {
  const calls: FakeAdapterCalls = {
    init: [],
    default: [],
    setOidcSecret: 0,
    setDeploymentProfile: [],
    check: 0,
    confirmApply: [],
  };
  const initQueue = Array.isArray(options.init) ? [...options.init] : options.init ? [options.init] : [OK_SESSION];
  const checkQueue = options.check ? [...options.check] : [OK_RESULT];

  const adapter: GuidedConfigurationAdapter = {
    async runInit(configureScript, orbitImage) {
      calls.init.push({ configureScript, orbitImage });
      return initQueue.length > 1 ? initQueue.shift()! : initQueue[0];
    },
    runDefault(configureScript, orbitImage) {
      calls.default.push({ configureScript, orbitImage });
      return options.defaultResult ?? OK_RESULT;
    },
    async runSetOidcSecret(configureScript) {
      calls.setOidcSecret += 1;
      void configureScript;
      return options.setOidcSecret ?? OK_SESSION;
    },
    runSetDeploymentProfile(configureScript, orbitImage, profile, model) {
      calls.setDeploymentProfile.push({ profile, model });
      return options.setDeploymentProfile ?? OK_RESULT;
    },
    runCheck() {
      calls.check += 1;
      return checkQueue.length > 1 ? checkQueue.shift()! : checkQueue[0];
    },
    async confirmApply(context) {
      calls.confirmApply.push(context);
      return options.confirmApply ?? "apply";
    },
  };
  return { adapter, calls };
}

// --- stageGuidedInstallConfiguration ------------------------------------

function stageContext(overrides: Partial<StageGuidedInstallConfigurationContext> = {}): StageGuidedInstallConfigurationContext {
  const dir = makeSandbox();
  return {
    installerAction: "install",
    plainMode: false,
    hasControllingTerminal: true,
    environmentFile: join(dir, ".env-orbit"),
    secretsDirectory: join(dir, ".orbit-secrets"),
    configureScript: join(dir, "staging", "scripts", "configure.sh"),
    orbitImage: "ghcr.io/tomlawesome/orbit@sha256:" + "a".repeat(64),
    profileChange: false,
    selectedProfile: "standard",
    selectedModel: undefined,
    ...overrides,
  };
}

describe("stageGuidedInstallConfiguration (install.sh:1031-1077)", () => {
  it("guarantee #30: skips when installerAction is not install", async () => {
    const { adapter } = fakeAdapter();
    const outcome = await stageGuidedInstallConfiguration(stageContext({ installerAction: "update" }), adapter, noopAnswers);
    expect(outcome).toEqual({ status: "skipped" });
  });

  it("skips in plain mode (install.sh:1033)", async () => {
    const { adapter } = fakeAdapter();
    const outcome = await stageGuidedInstallConfiguration(stageContext({ plainMode: true }), adapter, noopAnswers);
    expect(outcome).toEqual({ status: "skipped" });
  });

  it("guarantee #30: skips when .env-orbit already exists, even though empty target/no secrets dir", async () => {
    const context = stageContext();
    writeFileSync(context.environmentFile, "APP_URL=https://example.invalid\n", { mode: 0o600 });
    const { adapter, calls } = fakeAdapter();
    const outcome = await stageGuidedInstallConfiguration(context, adapter, noopAnswers);
    expect(outcome).toEqual({ status: "skipped" });
    expect(calls.init).toHaveLength(0);
  });

  it("guarantee #30: skips when .env-orbit exists only as a symlink (install.sh:1034-1035)", async () => {
    const dir = makeSandbox();
    const real = join(dir, "real-env");
    writeFileSync(real, "APP_URL=https://example.invalid\n");
    const context = stageContext();
    symlinkSync(real, context.environmentFile);
    const { adapter } = fakeAdapter();
    const outcome = await stageGuidedInstallConfiguration(context, adapter, noopAnswers);
    expect(outcome).toEqual({ status: "skipped" });
  });

  it("guarantee #30: skips when .orbit-secrets already exists as a directory", async () => {
    const context = stageContext();
    mkdirSync(context.secretsDirectory, { mode: 0o700 });
    const { adapter } = fakeAdapter();
    const outcome = await stageGuidedInstallConfiguration(context, adapter, noopAnswers);
    expect(outcome).toEqual({ status: "skipped" });
  });

  it("skips without a controlling terminal (install.sh:1036)", async () => {
    const { adapter } = fakeAdapter();
    const outcome = await stageGuidedInstallConfiguration(stageContext({ hasControllingTerminal: false }), adapter, noopAnswers);
    expect(outcome).toEqual({ status: "skipped" });
  });

  it("fails with install.sh's exact message when --init is cancelled or invalid (install.sh:1041-1042)", async () => {
    const { adapter } = fakeAdapter({ init: FAIL_SESSION });
    const outcome = await stageGuidedInstallConfiguration(stageContext(), adapter, noopAnswers);
    expect(outcome).toEqual({
      status: "failed",
      reason: "configuration-failure",
      action: "retry",
      message: "Guided configuration was cancelled or invalid; the target remains unchanged.",
    });
  });

  it("fails with install.sh's exact message when secret generation fails (install.sh:1043-1044)", async () => {
    const { adapter } = fakeAdapter({ defaultResult: { status: 1, stdout: "" } });
    const outcome = await stageGuidedInstallConfiguration(stageContext(), adapter, noopAnswers);
    expect(outcome).toEqual({
      status: "failed",
      reason: "configuration-failure",
      action: "retry",
      message: "Secret generation failed; the target remains unchanged.",
    });
  });

  it("fails with install.sh's exact message when --set-oidc-secret is cancelled or invalid (install.sh:1045-1046)", async () => {
    const { adapter } = fakeAdapter({ setOidcSecret: FAIL_SESSION });
    const outcome = await stageGuidedInstallConfiguration(stageContext(), adapter, noopAnswers);
    expect(outcome).toEqual({
      status: "failed",
      reason: "configuration-failure",
      action: "retry",
      message: "OIDC client secret collection was cancelled or invalid; the target remains unchanged.",
    });
  });

  it("fails with install.sh's exact message when a deployment-profile change fails (install.sh:1050-1056)", async () => {
    const { adapter } = fakeAdapter({ setDeploymentProfile: { status: 1, stdout: "" } });
    const outcome = await stageGuidedInstallConfiguration(
      stageContext({ profileChange: true, selectedProfile: "processing" }),
      adapter,
      noopAnswers,
    );
    expect(outcome).toEqual({
      status: "failed",
      reason: "configuration-failure",
      action: "retry",
      message: "Deployment profile configuration failed; the target remains unchanged.",
    });
  });

  it("passes the selected model only for ai/full profiles, and omits it otherwise (install.sh:1048-1058)", async () => {
    const { adapter: standardAdapter, calls: standardCalls } = fakeAdapter();
    await stageGuidedInstallConfiguration(
      stageContext({ profileChange: true, selectedProfile: "processing", selectedModel: "llama3" }),
      standardAdapter,
      noopAnswers,
    );
    expect(standardCalls.setDeploymentProfile).toEqual([{ profile: "processing", model: undefined }]);

    const { adapter: aiAdapter, calls: aiCalls } = fakeAdapter();
    await stageGuidedInstallConfiguration(
      stageContext({ profileChange: true, selectedProfile: "ai", selectedModel: "llama3" }),
      aiAdapter,
      noopAnswers,
    );
    expect(aiCalls.setDeploymentProfile).toEqual([{ profile: "ai", model: "llama3" }]);
  });

  it("fails with install.sh's exact message when the final readiness check exits non-zero (install.sh:1059-1060)", async () => {
    const { adapter } = fakeAdapter({ check: [{ status: 1, stdout: "" }] });
    const outcome = await stageGuidedInstallConfiguration(stageContext(), adapter, noopAnswers);
    expect(outcome).toEqual({
      status: "failed",
      reason: "configuration-failure",
      action: "retry",
      message: "Guided configuration is incomplete; the target remains unchanged.",
    });
  });

  it("fails with install.sh's exact message when the readiness check returns no summary (install.sh:1061-1062)", async () => {
    const { adapter } = fakeAdapter({ check: [{ status: 0, stdout: "\n" }] });
    const outcome = await stageGuidedInstallConfiguration(stageContext(), adapter, noopAnswers);
    expect(outcome).toEqual({
      status: "failed",
      reason: "configuration-failure",
      action: "retry",
      message: "Guided configuration did not return a readiness summary; the target remains unchanged.",
    });
  });

  it("guarantee #32: reports cancelled when the final review is not 'apply', applying nothing", async () => {
    const { adapter, calls } = fakeAdapter({ check: [{ status: 0, stdout: "ready APP_URL\n" }], confirmApply: "cancel" });
    const outcome = await stageGuidedInstallConfiguration(stageContext(), adapter, noopAnswers);
    expect(outcome).toEqual({ status: "cancelled" });
    expect(calls.confirmApply).toEqual([{ selectedProfile: "standard" }]);
  });

  it("guarantee #31/#32: stages with the trimmed readiness summary once every step succeeds and 'apply' is chosen", async () => {
    const { adapter } = fakeAdapter({ check: [{ status: 0, stdout: "ready APP_URL\nready OIDC_ISSUER\n" }] });
    const outcome = await stageGuidedInstallConfiguration(stageContext(), adapter, noopAnswers);
    expect(outcome).toEqual({ status: "staged", readiness: "ready APP_URL\nready OIDC_ISSUER" });
  });
});

// --- prepareConfiguration -----------------------------------------------

function seedValidDeployment(dir: string): PrepareConfigurationContext {
  const environmentFile = join(dir, ".env-orbit");
  const secretsDirectory = join(dir, ".orbit-secrets");
  writeFileSync(environmentFile, "APP_URL=https://example.invalid\n", { mode: 0o600 });
  mkdirSync(secretsDirectory, { mode: 0o700 });
  return {
    environmentFile,
    secretsDirectory,
    configureScript: join(dir, "scripts", "configure.sh"),
    orbitImage: "ghcr.io/tomlawesome/orbit@sha256:" + "b".repeat(64),
    hasControllingTerminal: false,
    profileChange: false,
    selectedProfile: "standard",
    selectedModel: undefined,
  };
}

describe("prepareConfiguration (install.sh:947-1008)", () => {
  it("fails with install.sh's exact message when the initial configure.sh invocation fails (install.sh:953-955)", async () => {
    const dir = makeSandbox();
    const context = seedValidDeployment(dir);
    const { adapter } = fakeAdapter({ defaultResult: { status: 1, stdout: "" } });
    const outcome = await prepareConfiguration(context, adapter, noopAnswers);
    expect(outcome).toEqual({ status: "failed", message: "Configuration failed; restoring the previous deployment." });
  });

  it("guarantee #28: fails when .env-orbit is missing after the initial invocation", async () => {
    const dir = makeSandbox();
    const context = seedValidDeployment(dir);
    // Simulate configure.sh not leaving a regular .env-orbit behind.
    rmSync(context.environmentFile);
    const { adapter } = fakeAdapter();
    const outcome = await prepareConfiguration(context, adapter, noopAnswers);
    expect(outcome).toEqual({
      status: "failed",
      message: `Configuration did not leave a regular, non-symlink ${context.environmentFile}.`,
    });
  });

  it("guarantee #28: fails when .env-orbit is a symlink after the initial invocation", async () => {
    const dir = makeSandbox();
    const context = seedValidDeployment(dir);
    rmSync(context.environmentFile);
    const real = join(dir, "real-env");
    writeFileSync(real, "APP_URL=https://example.invalid\n");
    symlinkSync(real, context.environmentFile);
    const { adapter } = fakeAdapter();
    const outcome = await prepareConfiguration(context, adapter, noopAnswers);
    expect(outcome).toEqual({
      status: "failed",
      message: `Configuration did not leave a regular, non-symlink ${context.environmentFile}.`,
    });
  });

  it("guarantee #28: fails when .orbit-secrets is not a real directory after the initial invocation", async () => {
    const dir = makeSandbox();
    const context = seedValidDeployment(dir);
    rmSync(context.secretsDirectory, { recursive: true });
    writeFileSync(context.secretsDirectory, "not a directory");
    const { adapter } = fakeAdapter();
    const outcome = await prepareConfiguration(context, adapter, noopAnswers);
    expect(outcome).toEqual({
      status: "failed",
      message: `Configuration did not leave a real, non-symlink ${context.secretsDirectory} directory.`,
    });
  });

  it("fails with install.sh's exact message when a requested profile change fails (install.sh:962-968)", async () => {
    const dir = makeSandbox();
    const context = { ...seedValidDeployment(dir), profileChange: true, selectedProfile: "processing" as const };
    const { adapter } = fakeAdapter({ setDeploymentProfile: { status: 1, stdout: "" } });
    const outcome = await prepareConfiguration(context, adapter, noopAnswers);
    expect(outcome).toEqual({ status: "failed", message: "Deployment profile configuration failed; restoring the previous deployment." });
  });

  it("guarantee #28: re-verifies .env-orbit/.orbit-secrets again after a profile change (install.sh:972-975)", async () => {
    const dir = makeSandbox();
    const context = { ...seedValidDeployment(dir), profileChange: true, selectedProfile: "processing" as const };
    const { adapter } = fakeAdapter({
      setDeploymentProfile: { status: 0, stdout: "" },
    });
    // The profile-change call itself "removes" .env-orbit, standing in for
    // configure.sh leaving a broken state behind.
    rmSync(context.environmentFile);
    const outcome = await prepareConfiguration(context, adapter, noopAnswers);
    expect(outcome).toEqual({
      status: "failed",
      message: `Configuration did not leave a regular, non-symlink ${context.environmentFile}.`,
    });
  });

  it("reports ready when the first readiness check already passes (install.sh:977-979, 999-1005)", async () => {
    const dir = makeSandbox();
    const context = seedValidDeployment(dir);
    const { adapter, calls } = fakeAdapter({ check: [{ status: 0, stdout: "ready APP_URL\n" }, { status: 0, stdout: "ready APP_URL\n" }] });
    const outcome = await prepareConfiguration(context, adapter, noopAnswers);
    expect(outcome).toEqual({ status: "ready" });
    expect(calls.init).toHaveLength(0);
    expect(calls.setOidcSecret).toBe(0);
  });

  it("guarantee #24: non-interactively refuses with install.sh's exact remediation guidance when required fields are missing and there is no controlling terminal (install.sh:993-996)", async () => {
    const dir = makeSandbox();
    const context = { ...seedValidDeployment(dir), hasControllingTerminal: false };
    const { adapter } = fakeAdapter({
      check: [
        { status: 1, stdout: "missing APP_URL\nmissing OIDC_ISSUER\n" },
        { status: 1, stdout: "missing APP_URL\nmissing ORBIT_IMAGE\nmissing OIDC_ISSUER\n" },
      ],
    });
    const outcome = await prepareConfiguration(context, adapter, noopAnswers);
    expect(outcome).toEqual({
      status: "failed",
      message: "Required configuration fields require attention; refusing to start Compose.",
      guidance: noninteractiveConfigurationGuidance(["APP_URL", "OIDC_ISSUER"]),
    });
  });

  it("interactively drives --init when guided fields are missing and a controlling terminal is available (install.sh:981-987)", async () => {
    const dir = makeSandbox();
    const context = { ...seedValidDeployment(dir), hasControllingTerminal: true };
    const { adapter, calls } = fakeAdapter({
      check: [
        { status: 1, stdout: "missing APP_URL\n" },
        { status: 0, stdout: "ready APP_URL\nready everything\n" },
        { status: 0, stdout: "ready APP_URL\n" },
      ],
    });
    const outcome = await prepareConfiguration(context, adapter, noopAnswers);
    expect(calls.init).toHaveLength(1);
    expect(outcome).toEqual({ status: "ready" });
  });

  it("fails with install.sh's exact message when the interactive --init retry is cancelled or invalid (install.sh:984-985)", async () => {
    const dir = makeSandbox();
    const context = { ...seedValidDeployment(dir), hasControllingTerminal: true };
    const { adapter } = fakeAdapter({
      check: [{ status: 1, stdout: "missing APP_URL\n" }],
      init: FAIL_SESSION,
    });
    const outcome = await prepareConfiguration(context, adapter, noopAnswers);
    expect(outcome).toEqual({
      status: "failed",
      message: "Guided configuration was cancelled or invalid; restoring the previous deployment.",
    });
  });

  it("skips --init when only non-guided required fields are missing, but still checks for a missing OIDC secret (install.sh:982-983,988-992)", async () => {
    const dir = makeSandbox();
    const context = { ...seedValidDeployment(dir), hasControllingTerminal: true };
    const { adapter, calls } = fakeAdapter({
      check: [
        { status: 1, stdout: "missing OIDC_CLIENT_SECRET\n" },
        { status: 1, stdout: "missing OIDC_CLIENT_SECRET\n" },
        { status: 0, stdout: "ready everything\n" },
      ],
    });
    const outcome = await prepareConfiguration(context, adapter, noopAnswers);
    expect(calls.init).toHaveLength(0);
    expect(calls.setOidcSecret).toBe(1);
    expect(outcome).toEqual({ status: "ready" });
  });

  it("fails with install.sh's exact message when --set-oidc-secret is cancelled or invalid (install.sh:989-992)", async () => {
    const dir = makeSandbox();
    const context = { ...seedValidDeployment(dir), hasControllingTerminal: true };
    const { adapter } = fakeAdapter({
      check: [{ status: 1, stdout: "missing OIDC_CLIENT_SECRET\n" }],
      setOidcSecret: FAIL_SESSION,
    });
    const outcome = await prepareConfiguration(context, adapter, noopAnswers);
    expect(outcome).toEqual({
      status: "failed",
      message: "OIDC client secret collection was cancelled or invalid; restoring the previous deployment.",
    });
  });

  it("ignores a non-zero status from the post-init recheck and only inspects its stdout (install.sh:988, '|| true')", async () => {
    const dir = makeSandbox();
    const context = { ...seedValidDeployment(dir), hasControllingTerminal: true };
    const { adapter, calls } = fakeAdapter({
      check: [
        { status: 1, stdout: "missing APP_URL\n" },
        { status: 1, stdout: "missing OIDC_CLIENT_SECRET\n" }, // recheck: non-zero status, ignored
        { status: 0, stdout: "ready everything\n" },
      ],
    });
    const outcome = await prepareConfiguration(context, adapter, noopAnswers);
    expect(calls.setOidcSecret).toBe(1);
    expect(outcome).toEqual({ status: "ready" });
  });

  it("fails closed with install.sh's composed field list when the final readiness check still fails (install.sh:1001-1005)", async () => {
    const dir = makeSandbox();
    const context = seedValidDeployment(dir);
    const { adapter } = fakeAdapter({
      check: [
        { status: 0, stdout: "ready everything\n" },
        { status: 1, stdout: "missing APP_URL\nmissing ai\n" },
      ],
    });
    const outcome = await prepareConfiguration(context, adapter, noopAnswers);
    expect(outcome).toEqual({
      status: "failed",
      message: "Configuration fields require attention (APP_URL ai); refusing to start Compose.",
    });
  });

  it("falls back to install.sh's exact default field list when the final check fails with no parsed missing fields (install.sh:1002-1003)", async () => {
    const dir = makeSandbox();
    const context = seedValidDeployment(dir);
    const { adapter } = fakeAdapter({
      check: [
        { status: 0, stdout: "ready everything\n" },
        { status: 1, stdout: "" },
      ],
    });
    const outcome = await prepareConfiguration(context, adapter, noopAnswers);
    expect(outcome).toEqual({
      status: "failed",
      message:
        "Configuration fields require attention (APP_URL ORBIT_IMAGE OIDC_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_CALLBACK_URL); refusing to start Compose.",
    });
  });
});
