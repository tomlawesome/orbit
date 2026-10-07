import { isValidLocalModel } from "./config-contract";
import { readFileSync, statfsSync } from "node:fs";
import { availableParallelism } from "node:os";

import { type InstallTerminal, InstallPromptStop, declined, selectChoice } from "./install-terminal";
import { readEnvironmentValue } from "./target-identity";

// Deployment profiles for install/update, ported from scripts/install.sh's
// `current_deployment_profile` (issue #295 slice 5) and, since #1212 (build
// note F4), its `choose_deployment_profile`, `check_local_ai_capacity` and
// `show_update_identity`: the wizard is asked by the engine on the operator's
// terminal (src/lib/install-terminal.ts). Guarantee numbers cite
// docs/installer-guarantees.md, Part 1 / install.sh, and are re-asserted in
// src/lib/deployment-profile.test.ts. A run with no terminal (the launcher's
// `--plain` engine run, automation) keeps the non-interactive selection:
// preserve the existing profile on update, "standard" on a fresh install.

// is_valid_local_model (install.sh:617-621): the single rule now lives in
// config-contract.ts (O1-Q6), shared with configure-engine.ts's own
// --set-deployment-profile restatement of the identical check.
export { isValidLocalModel } from "./config-contract";

export type DeploymentProfile = "standard" | "processing" | "ai" | "full";

export type CurrentDeploymentProfileResult =
  | { ok: true; profile: DeploymentProfile }
  | { ok: false };

/**
 * current_deployment_profile (install.sh:632-661, guarantee #23): requires
 * the existing `COMPOSE_PROFILES`/`TIKA_URL`/`OLLAMA_MODEL` triple to exactly
 * match one of exactly four known-good combinations; any other combination —
 * including a missing `.env-orbit` (bash: `printf 'standard'` unconditionally
 * when the file doesn't exist) is handled below, but any other malformed
 * triple — is reported as `{ ok: false }` (bash: `return 1`), the same
 * "unsupported or ambiguous" signal `resolve_installer_action` fails closed
 * on (install.sh:826-829).
 */
export function currentDeploymentProfile(targetDir: string, environmentFileExists: boolean): CurrentDeploymentProfileResult {
  if (!environmentFileExists) return { ok: true, profile: "standard" };

  const profiles = readEnvironmentValue(targetDir, "COMPOSE_PROFILES") ?? "";
  const tikaUrl = readEnvironmentValue(targetDir, "TIKA_URL") ?? "";
  const model = readEnvironmentValue(targetDir, "OLLAMA_MODEL") ?? "";

  switch (profiles) {
    case "":
      return tikaUrl === "" && model === "" ? { ok: true, profile: "standard" } : { ok: false };
    case "processing":
      return tikaUrl === "http://orbit-tika:9998" && model === "" ? { ok: true, profile: "processing" } : { ok: false };
    case "ai":
      return tikaUrl === "" && isValidLocalModel(model) ? { ok: true, profile: "ai" } : { ok: false };
    case "processing,ai":
      return tikaUrl === "http://orbit-tika:9998" && isValidLocalModel(model) ? { ok: true, profile: "full" } : { ok: false };
    default:
      return { ok: false };
  }
}

export interface ProfileSelection {
  selectedProfile: DeploymentProfile;
  profileChange: boolean;
}

/**
 * The non-interactive branch of resolve_installer_action (install.sh:826-841,
 * the only branch reached when `terminal_fd` was never opened): preserve the
 * existing profile on `update` (`profile_change` stays 0); always "standard"
 * on `install` (`profile_change=1`). See the module comment above for why
 * this is the only branch install-orchestrator.ts drives.
 */
export function resolveNonInteractiveProfileSelection(
  installerAction: "install" | "update",
  existingProfile: DeploymentProfile,
): ProfileSelection {
  if (installerAction === "install") {
    return { selectedProfile: "standard", profileChange: true };
  }
  return { selectedProfile: existingProfile, profileChange: false };
}

/** check_local_ai_capacity's three answers: 0, 1 and 2 in install.sh. */
export type LocalAiCapacity = "sufficient" | "below" | "unknown";

/**
 * check_local_ai_capacity: at least 2 CPUs, 6 GiB of memory and some free
 * space where the deployment lives. Read inside the engine container, which
 * a one-off runs with no cgroup limit, so these are the host's numbers.
 */
export function checkLocalAiCapacity(deployDir: string): LocalAiCapacity {
  try {
    const cpuCount = availableParallelism();
    const memoryMatch = /^MemTotal:\s+([0-9]+)/m.exec(readFileSync("/proc/meminfo", "utf8"));
    const stats = statfsSync(deployDir);
    if (!memoryMatch) return "unknown";
    const memoryKib = Number(memoryMatch[1]);
    const availableKib = (stats.bavail * stats.bsize) / 1024;
    return cpuCount >= 2 && memoryKib >= 6_291_456 && availableKib > 0 ? "sufficient" : "below";
  } catch {
    return "unknown";
  }
}

export interface UpdateTarget {
  version: string;
  digest: string;
  channel: string;
}

/** show_update_identity: what is deployed now and what this update installs, from recorded values only. */
export function updateIdentityLines(targetDir: string, existingProfile: DeploymentProfile, target: UpdateTarget): string[] {
  const schema = readEnvironmentValue(targetDir, "ORBIT_CONFIG_SCHEMA_VERSION") === "1" ? "v1" : "legacy/unknown";
  const appliedVersion = readEnvironmentValue(targetDir, "ORBIT_CONFIG_APPLIED_VERSION") ?? "";
  const version = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(appliedVersion) ? appliedVersion : "legacy/unknown";
  const appliedDigest = readEnvironmentValue(targetDir, "ORBIT_CONFIG_APPLIED_DIGEST") ?? "";
  let digest = "legacy/unknown";
  if (/^sha256:[0-9a-f]{64}$/.test(appliedDigest)) {
    digest = appliedDigest;
  } else {
    const imageDigest = /@(sha256:[0-9a-f]{64})$/.exec(readEnvironmentValue(targetDir, "ORBIT_IMAGE") ?? "");
    if (imageDigest) digest = imageDigest[1];
  }
  return [
    `Current: schema=${schema} version=${version} digest=${digest} optional-profile=${existingProfile}`,
    `Target: schema=v1 version=${target.version} digest=${target.digest} channel=${target.channel}`,
  ];
}

export interface ProfileWizardContext {
  installerAction: "install" | "update";
  existingProfile: DeploymentProfile;
  capacity: () => LocalAiCapacity;
  /** updateIdentityLines' output, shown before an update's first question. */
  identityLines?: readonly string[];
}

export interface ProfileWizardResult extends ProfileSelection {
  selectedModel: string | undefined;
  /** Guarantee #20: true only after the separate download confirmation. */
  modelPullRequested: boolean;
}

const CAPACITY_LINES: Record<LocalAiCapacity, string> = {
  sufficient: "Host capacity check: the configured local-service CPU and memory envelope is available; model storage remains model-dependent.",
  below: "Host capacity check: this host is below the configured local-service CPU or memory envelope; model preparation may fail.",
  unknown: "Host capacity check: CPU, memory or available storage could not be verified; model preparation remains operator-controlled.",
};

/**
 * choose_deployment_profile: on an update, preserve the current profile
 * (the default) or choose another; otherwise a preset or one of the four
 * custom combinations, a local model for ai/full with the capacity advisory
 * and a separate download confirmation (guarantee #20), then a review.
 * Back, Cancel and Ctrl-C decline (exit 130); end of input is an input
 * failure (exit 1); an invalid model is refused (exit 2).
 */
export function chooseDeploymentProfile(terminal: InstallTerminal, context: ProfileWizardContext): ProfileWizardResult {
  if (context.installerAction === "update") {
    terminal.write(`\n${(context.identityLines ?? []).join("\n")}\n`);
    terminal.write("\nCurrent optional-service configuration is valid. Preserve it unless you deliberately choose to change it.\n");
    const choice = selectChoice(terminal, "Optional services", "preserve", [
      ["preserve", "Preserve current profile (recommended)"],
      ["change", "Choose a different supported profile"],
      ["back", "Back"],
    ]);
    if (choice === "back") throw declined();
    if (choice === "preserve") {
      const review = selectChoice(terminal, `Review: preserve the current ${context.existingProfile} profile and OIDC configuration.`, "apply", [
        ["apply", "Continue without changing optional-service choices"],
        ["cancel", "Cancel without changing files or services"],
      ]);
      if (review !== "apply") throw declined();
      return { selectedProfile: context.existingProfile, selectedModel: undefined, profileChange: false, modelPullRequested: false };
    }
  }

  terminal.write("\nProfiles keep data inside the private Compose network. Resource classes are fixed relative labels: standard, medium, and high; they are not hardware guarantees.\n");
  terminal.write("Required Orbit core and private scanning stay enabled; document processing and local AI are optional services.\n");
  terminal.write("Sign-in is chosen separately: local accounts always work, and an identity provider (OIDC) is optional (configure.sh --init).\n");
  terminal.write("Ollama is optional local infrastructure and is not yet consumed by Orbit product workflows.\n");
  let choice = selectChoice(terminal, "Choose a deployment profile", "standard", [
    ["standard", "Standard Orbit - required core and private scanning; standard relative resources"],
    ["processing", "Document processing - optional local Tika; medium relative resources"],
    ["full", "Full local stack - optional Tika and local Ollama; high relative resources"],
    ["custom", "Custom - choose one fixed supported optional-service combination"],
    ["back", "Back"],
  ]);
  if (choice === "back") throw declined();
  if (choice === "custom") {
    choice = selectChoice(terminal, "Custom optional services", "standard", [
      ["standard", "No optional service"],
      ["processing", "Document processing only"],
      ["ai", "Local Ollama infrastructure only"],
      ["full", "Document processing and local Ollama infrastructure"],
      ["back", "Back"],
    ]);
    if (choice === "back") throw declined();
  }
  const selectedProfile = choice as DeploymentProfile;

  let selectedModel: string | undefined;
  let modelPullRequested = false;
  if (selectedProfile === "ai" || selectedProfile === "full") {
    terminal.write("\nA model choice is saved now. Model preparation will require a separate confirmation before any large download.\n");
    const model = terminal.readLine("Bounded local model identifier: ");
    if (model === undefined) throw new InstallPromptStop(1, "The terminal closed before a local model was named; no deployment files or services were changed.");
    if (!isValidLocalModel(model)) throw new InstallPromptStop(2, "The local model identifier is not valid; no deployment files or services were changed.");
    selectedModel = model;
    terminal.write(`${CAPACITY_LINES[context.capacity()]}\n`);
    const download = selectChoice(terminal, "Prepare the selected local model after Ollama becomes healthy? This can be a large download.", "skip", [
      ["skip", "Save the model choice without downloading it now"],
      ["pull", "Confirm the separate model download step"],
      ["cancel", "Cancel without changing files or services"],
    ]);
    if (download === "cancel") throw declined();
    modelPullRequested = download === "pull";
  }

  const review = selectChoice(
    terminal,
    "Review: profile only; sign-in mode is unchanged, and provider discovery (when OIDC is on) does not prove client authentication or a completed sign-in.",
    "apply",
    [
      ["apply", `Continue with the selected ${selectedProfile} profile`],
      ["cancel", "Cancel without changing files or services"],
    ],
  );
  if (review !== "apply") throw declined();
  return { selectedProfile, selectedModel, profileChange: true, modelPullRequested };
}
