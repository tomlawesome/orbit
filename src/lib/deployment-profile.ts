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
// ORBIT_INSTALL_PROFILE when the launcher sets it (#1504, #1542), else
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

export interface ProfileRequestRefusal {
  refused: true;
  message: string;
}

/** The profiles a launcher may request on a fresh install (#1504); local AI stays a terminal choice. */
const REQUESTABLE_INSTALL_PROFILES: readonly DeploymentProfile[] = ["standard", "processing"];

/**
 * The non-interactive branch of resolve_installer_action (install.sh:826-841,
 * the only branch reached when `terminal_fd` was never opened). On `install`
 * (`profile_change=1`): the launcher's ORBIT_INSTALL_PROFILE if it names one
 * of REQUESTABLE_INSTALL_PROFILES, a refusal for any other value, and
 * "standard" when unset (#1504). On `update` (#1542): unset keeps the existing
 * profile; a requestable value changes a standard or processing deployment
 * (`profileChange` only when it differs) and is refused over a local-model
 * deployment, whose model choice needs the terminal; any other value is
 * refused as on install. See the module comment above for why this is the
 * only branch install-orchestrator.ts drives.
 */
export function resolveNonInteractiveProfileSelection(
  installerAction: "install" | "update",
  existingProfile: DeploymentProfile,
  requestedProfile?: string,
): ProfileSelection | ProfileRequestRefusal {
  if (installerAction === "update" && requestedProfile === undefined) {
    return { selectedProfile: existingProfile, profileChange: false };
  }
  if (requestedProfile === undefined) {
    return { selectedProfile: "standard", profileChange: true };
  }
  const requested = REQUESTABLE_INSTALL_PROFILES.find((profile) => profile === requestedProfile);
  if (requested === undefined) {
    return { refused: true, message: `ORBIT_INSTALL_PROFILE must be ${REQUESTABLE_INSTALL_PROFILES.join(" or ")}.` };
  }
  if (installerAction === "install") return { selectedProfile: requested, profileChange: true };
  if (existingProfile === "ai" || existingProfile === "full") {
    return { refused: true, message: "ORBIT_INSTALL_PROFILE cannot change a deployment that uses a local model; use the installer at a terminal." };
  }
  return { selectedProfile: requested, profileChange: requested !== existingProfile };
}

/** The optional Compose services each profile runs (docker-compose.yml `profiles:`). */
const PROFILE_SERVICES: Record<DeploymentProfile, readonly string[]> = {
  standard: [],
  processing: ["orbit-tika"],
  ai: ["orbit-ollama"],
  full: ["orbit-tika", "orbit-ollama"],
};

/**
 * The optional services a profile change leaves behind (#1542). Compose does
 * not treat a service behind a now-inactive profile as an orphan, so
 * `up -d --remove-orphans` leaves it running (checked with Compose v5.7.0);
 * install.sh stops and removes each one named here explicitly.
 */
export function droppedProfileServices(previous: DeploymentProfile, selected: DeploymentProfile): string[] {
  return PROFILE_SERVICES[previous].filter((service) => !PROFILE_SERVICES[selected].includes(service));
}

/** ClamAV on or off (#1170); on is the default and the recommendation. */
export type ScannerChoice = "on" | "off";

export interface ScannerSelection {
  /** undefined: keep what the deployment's DOCUMENT_SCAN_MODE says (an update, or nothing requested). */
  scanner: ScannerChoice | undefined;
}

/**
 * ORBIT_INSTALL_SCANNER, read exactly as ORBIT_INSTALL_PROFILE is (#1170):
 * ignored on an update, `on` or `off` on a fresh install, any other value
 * refused. Unset leaves the choice to the deployment's own DOCUMENT_SCAN_MODE,
 * which is unset (scanning on) on a fresh target and respected in a
 * handed-in .env-orbit.
 */
export function resolveNonInteractiveScannerSelection(
  installerAction: "install" | "update",
  requestedScanner?: string,
): ScannerSelection | ProfileRequestRefusal {
  if (installerAction === "update" || requestedScanner === undefined) return { scanner: undefined };
  if (requestedScanner === "on" || requestedScanner === "off") return { scanner: requestedScanner };
  return { refused: true, message: "ORBIT_INSTALL_SCANNER must be on or off." };
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
  const schema = readEnvironmentValue(targetDir, "ORBIT_CONFIG_SCHEMA_VERSION") === "1" ? "v1" : "none";
  const appliedVersion = readEnvironmentValue(targetDir, "ORBIT_CONFIG_APPLIED_VERSION") ?? "";
  const version = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(appliedVersion) ? appliedVersion : "none";
  const appliedDigest = readEnvironmentValue(targetDir, "ORBIT_CONFIG_APPLIED_DIGEST") ?? "";
  let digest = "none";
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
  /** The deployment's current scanner choice (#1170); unset means on. The scanner step's default keeps it. */
  existingScanner?: ScannerChoice;
  capacity: () => LocalAiCapacity;
  /** updateIdentityLines' output, shown before an update's first question. */
  identityLines?: readonly string[];
}

export interface ProfileWizardResult extends ProfileSelection {
  selectedModel: string | undefined;
  /** The scanner step's answer (#1170); undefined when the update wizard preserved the current configuration. */
  scanner?: ScannerChoice;
  /** Guarantee #20: true only after the separate download confirmation. */
  modelPullRequested: boolean;
}

const CAPACITY_LINES: Record<LocalAiCapacity, string> = {
  sufficient: "Host capacity check: the configured local-service CPU and memory envelope is available; model storage remains model-dependent.",
  below: "Host capacity check: this host is below the configured local-service CPU or memory envelope; model preparation may fail.",
  unknown: "Host capacity check: CPU, memory or available storage could not be verified; model preparation remains operator-controlled.",
};

/**
 * The local-AI step of a chosen ai or full profile, however it was chosen
 * (the wizard, or a handed-in profile kept, #1536 G2-R2): the host capacity
 * advisory, then the separate download confirmation (guarantee #20) where a
 * terminal can answer it. With no terminal nothing confirms a download, so
 * none is requested. Any other profile has no local-AI step. Cancel declines.
 */
export function prepareLocalAiModel(
  profile: DeploymentProfile,
  capacity: () => LocalAiCapacity,
  write: (line: string) => void,
  terminal: InstallTerminal | undefined,
): boolean {
  if (profile !== "ai" && profile !== "full") return false;
  write(CAPACITY_LINES[capacity()]);
  if (!terminal) return false;
  const download = selectChoice(terminal, "Prepare the selected local model after Ollama becomes healthy? This can be a large download.", "skip", [
    ["skip", "Save the model choice without downloading it now"],
    ["pull", "Confirm the separate model download step"],
    ["cancel", "Cancel without changing files or services"],
  ]);
  if (download === "cancel") throw declined();
  return download === "pull";
}

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
  terminal.write("Required Orbit core stays enabled; private scanning (ClamAV) is on by default and optional; document processing and local AI are optional services.\n");
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
    modelPullRequested = prepareLocalAiModel(selectedProfile, context.capacity, (line) => terminal.write(`${line}\n`), terminal);
  }

  // #1170: the default keeps the deployment's current choice -- on for a
  // new install, and off for one already running without ClamAV, which is
  // never turned back on by Enter ("never forced").
  const scanner: ScannerChoice =
    context.existingScanner === "off"
      ? selectChoice(terminal, "Private document scanner (ClamAV)", "keep", [
          ["keep", "Keep running without ClamAV (current): documents are not virus-scanned"],
          ["on", "Turn ClamAV on (recommended): uploaded and mailed documents are virus-scanned (about CLAMAV_MEMORY_LIMIT of memory)"],
        ]) === "on" ? "on" : "off"
      : selectChoice(terminal, "Private document scanner (ClamAV)", "keep", [
          ["keep", "Keep ClamAV (recommended): uploaded and mailed documents are virus-scanned (about CLAMAV_MEMORY_LIMIT of memory)"],
          ["off", "Run without ClamAV: documents are not virus-scanned. Turn it back on later with scripts/configure.sh --set-scanner on"],
        ]) === "off" ? "off" : "on";

  const review = selectChoice(
    terminal,
    "Review: profile only; sign-in mode is unchanged, and provider discovery (when OIDC is on) does not prove client authentication or a completed sign-in.",
    "apply",
    [
      ["apply", `Continue with the selected ${selectedProfile} profile${scanner === "off" ? ", without ClamAV" : ""}`],
      ["cancel", "Cancel without changing files or services"],
    ],
  );
  if (review !== "apply") throw declined();
  return { selectedProfile, selectedModel, profileChange: true, modelPullRequested, scanner };
}
