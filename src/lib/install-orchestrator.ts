import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { type ConfigurationMigrationTarget, runConfigurationMigration, runConfigurationPreflight } from "./configuration-migration";
import { ConfigureEngineRefusal, type GuidedInitInput, applyGuidedInit, applySetOidcSecret, environmentHasAppliedStamp, runConfigureApply, setDeploymentProfile } from "./configure-engine";
import {
  DEPLOYMENT_ASSET_FILE_MODE,
  DEPLOYMENT_ASSETS,
  ENVIRONMENT_FILE,
  SECRETS_DIRECTORY,
  buildManagedPaths,
  deriveAssetDirectories,
} from "./deployment-assets";
import {
  type DeploymentProfile,
  type LocalAiCapacity,
  type ProfileWizardResult,
  chooseDeploymentProfile,
  checkLocalAiCapacity,
  currentDeploymentProfile,
  prepareLocalAiModel,
  resolveNonInteractiveProfileSelection,
  updateIdentityLines,
} from "./deployment-profile";
import { readinessReport } from "./deployment-readiness";
import {
  type DatabaseVolumeSafetyState,
  DatabaseVolumeSafetyRefusal,
  type PostgresPasswordFacts,
  verifyDatabaseVolumeSafety,
} from "./database-volume-safety";
import { type EngineEvent, defaultFailureAction, defaultFailureReason } from "./engine-event";
import { missingConfigurationFields, missingGuidedFields, missingRequiredFields, noninteractiveConfigurationGuidance } from "./guided-configuration";
import { type HostFacts, hostFactsVolumeAdapter } from "./host-facts";
import { type InstallTerminal, InstallPromptStop, declined, selectChoice } from "./install-terminal";
import { InstallTransaction, InstallTransactionRefusal } from "./install-transaction";
import { LAUNCHER_CONFIG_TREE_ENV, takeHandedInConfiguration, treeHoldsConfiguration, treeHoldsOnlySecrets } from "./launcher-config-tree";
import { verifyOidcDiscovery } from "./oidc-discovery";
import {
  COMPOSE_FILE,
  ComposeProjectNameRefusal,
  TargetValidationRefusal,
  deriveComposeProjectName,
  readEnvironmentValue,
  validateTarget,
} from "./target-identity";

// The install/update engine (#1212): the one TypeScript implementation of
// install.sh's file transaction, run as a disposable one-off from the image
// the bootstrap shell just resolved and verified.
//
// Three phases, two owners (build note F1). scripts/install.sh does what
// touches Docker or the network before an image exists -- tool checks, the
// release manifest and its signatures, the pull, the label reads, the Docker
// facts this engine needs (F3) -- then runs this engine once, then starts
// Compose and waits for readiness. This module does everything between:
// target validation, the install/update choice and the profile wizard on the
// operator's terminal (F4), database-volume safety from the shell's facts,
// copying the deployment assets out of its own image (F2), guided
// configuration, the configuration migration, OIDC discovery (F5), and the
// two-phase stage-then-switch file transaction whose commit marker is the
// switch (F8). It never touches Docker (#295): everything it needs from
// Docker arrives as data, and everything Docker must do afterwards it hands
// back to the shell as an outcome (src/cli/orbit.ts writes it for
// install.sh to read).
//
// Before the commit every failure, and SIGINT/SIGTERM (runInterruptCleanups
// below), rolls the transaction back; a configuration-failure first hands
// the launcher its config tree (onConfigurationFailure, #1225). A failure's
// own terminal `failed` event is the shell's to emit (docs/engine-events.md);
// this module emits the progress events only. A leftover staging directory
// from a hard kill is never rolled back by a later run: validateTarget
// refuses it, beside an otherwise empty target for the operator to remove
// (#383) and beside a deployment for repair.sh to restore or the operator to
// remove, so a rerun never stages over a half-updated tree.

export interface InstallContext {
  /** The deployment directory, as the engine sees it (/orbit-deploy). */
  targetDir: string;
  /** `--install`/`--update`, or undefined to choose (the menu on a terminal, else from the target). */
  requestedAction: "install" | "update" | undefined;
  /** install.sh --plain: no menu, no profile wizard and no staged guided install. */
  plainMode: boolean;
  /** install.sh had a controlling terminal and passed it through (`docker run -t`). */
  interactive: boolean;
  /** The digest-pinned reference the shell resolved and verified (ORBIT_IMAGE). */
  resolvedReference: string;
  /** ORBIT_CHANNEL, shown on an update's identity line. */
  channel: string;
  /** COMPOSE_PROJECT_NAME from the shell's environment, if any. */
  requestedComposeProjectName?: string;
  /** ORBIT_INSTALL_PROFILE from the launcher; read only on a non-interactive install (#1504). */
  requestedProfile?: string;
  facts: HostFacts;
  /** Where this image keeps its deployment assets (/opt/orbit/deploy, ADR-0019). */
  assetsRoot: string;
  /** ORBIT_LAUNCHER_CONFIG_TREE as mounted: the launcher's tree, which may hand in a configuration (#1519). */
  launcherConfigTree?: string;
}

/** What a guided configuration step needs answered: the configure engine's own sources, in its own order (src/cli/orbit.ts). */
export interface ConfigurationAnswers {
  /** `configure.sh --init`'s answers; the hint is the deployment's existing sign-in mode. Throws to refuse or cancel. */
  guidedInit(authModeHint: "local" | "oidc" | undefined): GuidedInitInput;
  /** `configure.sh --set-oidc-secret`'s secret. Throws to refuse or cancel. */
  oidcSecret(): string;
}

export interface InstallDependencies {
  /** Required when context.interactive. */
  terminal?: InstallTerminal;
  answers: ConfigurationAnswers;
  /** The OIDC discovery transport (the global fetch in production). */
  fetchImpl?: typeof fetch;
  capacity?: (deployDir: string) => LocalAiCapacity;
  /** The configure engine's own advisory lines, printed as configure.sh printed them. */
  say?: (line: string) => void;
  /** One-line notices for stderr (a handed-in configuration ignored, #1519). */
  notice?: (line: string) => void;
  /**
   * Called once on a failure whose reason is configuration-failure, before
   * anything is rolled back: the launcher's configure tree is handed over
   * here (#1225, launcher-config-tree.ts).
   */
  onConfigurationFailure?: () => void;
  /** Test hook: runs right after InstallTransaction.begin, before the first write (ORBIT_INSTALL_TEST_HARD_INTERRUPT_STAGE). */
  afterTransactionBegun?: () => void;
  /** Test hook: runs right after the transaction commits, before the outcome is returned (ORBIT_INSTALL_TEST_HARD_INTERRUPT_STAGE=transaction-committed). */
  afterTransactionCommitted?: () => void;
}

export type OnEvent = (event: EngineEvent) => void;

export interface InstallOutcomeOk {
  status: "ok";
  /** install.sh's target_was_empty: a fresh install, whose failed first start is torn down. */
  fresh: boolean;
  selectedProfile: DeploymentProfile;
  /** Guarantee #20: the separately confirmed model download. */
  modelPullRequested: boolean;
  /** The pre-existing database volume this update attached to, for the shell's re-check before Compose (#17). */
  databaseVolume: string | undefined;
}

export interface InstallOutcomeFailed {
  status: "failed";
  phase: string;
  component: string;
  reason: string;
  action: string;
  message: string;
  /** Remediation lines printed before the refusal (guarantee #24), and the rollback-incomplete line. */
  guidance?: string[];
}

/** The operator stopped (130), the terminal closed (1), or an answer was refused (2); nothing was changed. */
export interface InstallOutcomeStopped {
  status: "stopped";
  exitCode: 130 | 1 | 2;
  message: string;
}

/** The Repair choice: signposted, never run (#533); exit 3. */
export interface InstallOutcomeRepair {
  status: "repair";
}

export type InstallOutcome = InstallOutcomeOk | InstallOutcomeFailed | InstallOutcomeStopped | InstallOutcomeRepair;

export const REPAIR_SIGNPOST =
  'Orbit installer: repair_unavailable; this installer does not perform repair. Run "bash scripts/repair.sh --check" from this directory to diagnose, then "--plan" to see what it would do. No deployment files or services were changed.';

// --- interruption -----------------------------------------------------------

const interruptCleanups = new Set<() => void>();

/**
 * Rolls back whatever this process has in flight -- the transaction, the
 * scratch directory -- for a SIGINT/SIGTERM handler that is about to exit.
 * A signal does not unwind try/finally, so the CLI calls this first.
 */
export function runInterruptCleanups(): void {
  for (const cleanup of [...interruptCleanups].reverse()) {
    try {
      cleanup();
    } catch {
      /* best effort: the next cleanup still runs */
    }
  }
  interruptCleanups.clear();
}

// --- helpers ------------------------------------------------------------------

function isRegularNonSymlinkFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isRealNonSymlinkDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function readPostgresPasswordFacts(targetDir: string): PostgresPasswordFacts {
  const path = join(targetDir, SECRETS_DIRECTORY, "postgres-password");
  return { isRegularNonSymlinkFile: isRegularNonSymlinkFile(path), mode: isRegularNonSymlinkFile(path) ? lstatSync(path).mode & 0o777 : null };
}

/**
 * verify_database_password_preserved (guarantee #19): once this run has
 * attached to a proven pre-existing volume, the live `postgres-password`
 * must still be mode 600 and byte-identical to the transaction's backup.
 */
function verifyDatabasePasswordPreserved(transaction: InstallTransaction, targetDir: string, databaseVolumeSeen: boolean): boolean {
  if (!databaseVolumeSeen) return true;
  const live = join(targetDir, SECRETS_DIRECTORY, "postgres-password");
  const backup = join(transaction.originalDir, SECRETS_DIRECTORY, "postgres-password");
  // One O_NOFOLLOW descriptor: the mode check and the read see the same file.
  let descriptor: number;
  try {
    descriptor = openSync(live, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    if ((fstatSync(descriptor).mode & 0o777) !== 0o600) return false;
    return readFileSync(descriptor).equals(readFileSync(backup));
  } catch {
    return false;
  } finally {
    closeSync(descriptor);
  }
}

function stageSecretsDirectoryTree(transaction: InstallTransaction, sourceDir: string, relativeDir: string): void {
  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, entry);
    // One O_NOFOLLOW descriptor per entry: the type probe and the read see the same file.
    let descriptor: number;
    try {
      descriptor = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      continue;
    }
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) continue;
      transaction.writeStagedFile(join(relativeDir, entry), readFileSync(descriptor), stat.mode & 0o777);
    } finally {
      closeSync(descriptor);
    }
  }
  chmodSync(join(transaction.stagingDir, relativeDir), 0o700);
}

/**
 * The persisted image line (guarantees #53-54): the resolved digest at the
 * first ORBIT_IMAGE line, every later duplicate dropped, appended when
 * absent; written through the transaction, never in place.
 */
function withResolvedImage(content: string, resolvedReference: string): string {
  const line = `ORBIT_IMAGE=${resolvedReference}`;
  const lines = content.split("\n");
  const trailingNewline = content.endsWith("\n");
  if (trailingNewline) lines.pop();
  let written = false;
  const rewritten: string[] = [];
  for (const existing of lines) {
    if (existing.startsWith("ORBIT_IMAGE=")) {
      if (!written) rewritten.push(line);
      written = true;
    } else {
      rewritten.push(existing);
    }
  }
  if (!written) rewritten.push(line);
  return `${rewritten.join("\n")}\n`;
}

function readinessText(deployDir: string): { ok: boolean; text: string } {
  const outcome = readinessReport(deployDir);
  if (outcome.status === "refused") return { ok: false, text: "" };
  return { ok: outcome.ok, text: outcome.lines.join("\n") };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function say(dependencies: InstallDependencies, messages: readonly string[]): void {
  for (const message of messages) dependencies.say?.(message);
}

// --- the run --------------------------------------------------------------------

/**
 * One install or update. Never throws for an expected refusal: every
 * failure is an outcome, and only a programming error propagates.
 */
export async function runInstall(context: InstallContext, dependencies: InstallDependencies, onEvent: OnEvent): Promise<InstallOutcome> {
  let lastFailure: InstallOutcomeFailed | undefined;
  const terminal = context.interactive ? dependencies.terminal : undefined;

  let launcherTreeOffered = false;
  function fail(phase: string, component: string, message: string, reason?: string, action?: string, guidance?: string[]): InstallOutcomeFailed {
    lastFailure = {
      status: "failed",
      phase,
      component,
      reason: reason ?? defaultFailureReason(phase),
      action: action ?? defaultFailureAction(phase),
      message,
      guidance,
    };
    // Before the caller returns and the transaction rolls back (#1225).
    if (lastFailure.reason === "configuration-failure" && !launcherTreeOffered) {
      launcherTreeOffered = true;
      dependencies.onConfigurationFailure?.();
    }
    return lastFailure;
  }

  function stopped(stop: InstallPromptStop): InstallOutcomeStopped {
    return { status: "stopped", exitCode: stop.exitCode, message: stop.message };
  }

  // validate_target (guarantee #7).
  let targetWasEmpty: boolean;
  try {
    ({ targetWasEmpty } = validateTarget(context.targetDir));
  } catch (error) {
    if (!(error instanceof TargetValidationRefusal)) throw error;
    return fail("host", "host", error.message);
  }

  // resolve_installer_action (guarantees #21-22): the menu only for an
  // operator at a terminal who named no action.
  let action = context.requestedAction;
  let menuShown = false;
  if (action === undefined) {
    const defaultAction = targetWasEmpty ? "install" : "update";
    if (!context.plainMode && terminal) {
      let choice: string;
      try {
        choice = selectChoice(terminal, "Greetings, what can we do for you today?", defaultAction, [
          ["install", "Install"],
          ["update", "Update"],
          ["repair", "Repair"],
          ["exit", "Exit"],
        ]);
      } catch (error) {
        if (error instanceof InstallPromptStop) return stopped(error);
        throw error;
      }
      if (choice === "repair") {
        // Signposts repair, never dispatches into it: the two scripts'
        // exit codes collide (#533, docs/engine-events.md "Repair stream").
        onEvent({ phase: "rollback", component: "installer", state: "blocked", reason: "repair-unavailable", action: "repair" });
        return { status: "repair" };
      }
      if (choice === "exit") return stopped(declined());
      action = choice as "install" | "update";
      menuShown = true;
    } else {
      action = defaultAction;
    }
  }
  if (action === "install" && !targetWasEmpty) {
    return fail("host", "host", "Install requires an empty target or safe pre-provisioned bootstrap; use Update for a recognized deployment.");
  }
  if (action === "update" && targetWasEmpty) {
    return fail("host", "host", "Update requires a recognized existing Orbit deployment.");
  }
  // An open document-key rotation runs orbit-app through the kek-rotation
  // overlay; recreating it here would bring it back without the next key,
  // locking every row already rewrapped. Same refusal as restore's.
  const documentKekNext = join(context.targetDir, SECRETS_DIRECTORY, "document-kek-next");
  if (isRegularNonSymlinkFile(documentKekNext)) {
    return fail(
      "host",
      "host",
      `A document-key rotation is open (${documentKekNext} exists). Finish the rotation (complete the rewrap and remove the compose kek-rotation overlay) or abort it before updating.`,
    );
  }

  // verify_database_volume_safety, from the shell's Docker facts (#13-18, F3).
  let volumeState: DatabaseVolumeSafetyState = {
    databaseVolumeChecked: false,
    databaseVolumeSeen: false,
    databaseVolumeName: "",
    targetWasEmpty,
    composeProjectNameExplicit: false,
    composeProjectName: "",
    composeProjectNameProvisional: false,
  };
  try {
    volumeState = verifyDatabaseVolumeSafety(
      context.targetDir,
      context.requestedComposeProjectName,
      context.facts.targetBasename,
      volumeState,
      readPostgresPasswordFacts(context.targetDir),
      hostFactsVolumeAdapter(context.facts),
    );
  } catch (error) {
    if (!(error instanceof DatabaseVolumeSafetyRefusal) && !(error instanceof ComposeProjectNameRefusal)) throw error;
    return fail("host", "host", error.message);
  }

  // The existing optional-service profile (guarantee #23), then the wizard
  // when the operator chose at the menu (F4), else the non-interactive rule.
  const profileResult = currentDeploymentProfile(context.targetDir, existsSync(join(context.targetDir, ENVIRONMENT_FILE)));
  if (!profileResult.ok) {
    return fail("host", "host", "The existing optional-service configuration is unsupported or ambiguous.");
  }
  let profile: ProfileWizardResult;
  const capacity = () => (dependencies.capacity ?? checkLocalAiCapacity)(context.targetDir);
  if (menuShown && terminal) {
    try {
      profile = chooseDeploymentProfile(terminal, {
        installerAction: action,
        existingProfile: profileResult.profile,
        capacity,
        identityLines:
          action === "update"
            ? updateIdentityLines(context.targetDir, profileResult.profile, {
                version: context.facts.imageVersion,
                digest: context.facts.appliedDigest,
                channel: context.channel,
              })
            : undefined,
      });
    } catch (error) {
      if (error instanceof InstallPromptStop) return stopped(error);
      throw error;
    }
  } else {
    const selection = resolveNonInteractiveProfileSelection(action, profileResult.profile, context.requestedProfile);
    if ("refused" in selection) return fail("host", "host", selection.message);
    profile = { ...selection, selectedModel: undefined, modelPullRequested: false };
  }

  // A private scratch directory inside the engine's own container: the
  // assets copied out of the image and a staged guided install live here
  // until the transaction moves them in, so nothing of it can be left in
  // the deployment by a hard kill.
  const scratchDir = mkdtempSync(join(tmpdir(), "orbit-install-scratch-"));
  chmodSync(scratchDir, 0o700);
  const removeScratch = () => rmSync(scratchDir, { recursive: true, force: true });
  interruptCleanups.add(removeScratch);

  try {
    onEvent({ phase: "assets", component: "assets", state: "starting", reason: "assets-verified", action: "fetch" });
    // The deployment assets, copied from this image's own bundle (F2,
    // guarantees #42, #45): only the fixed allowlist, each a non-empty
    // regular file, staged at the deployment's asset mode. Every bundled
    // script is held `bash -n`-clean where the image is built from
    // (deployment-assets.test.ts), and install.sh checks installer-ui.sh
    // again before it sources it.
    for (const asset of DEPLOYMENT_ASSETS) {
      const source = join(context.assetsRoot, asset);
      const staged = join(scratchDir, asset);
      if (!isRegularNonSymlinkFile(source)) return fail("assets", "assets", `Bundled ${asset} is not a regular file.`);
      if (lstatSync(source).size === 0) return fail("assets", "assets", `Bundled ${asset} is empty.`);
      try {
        mkdirSync(dirname(staged), { recursive: true });
        copyFileSync(source, staged);
        chmodSync(staged, DEPLOYMENT_ASSET_FILE_MODE);
      } catch {
        return fail("assets", "assets", `Could not stage ${asset} from the published image.`);
      }
    }
    onEvent({ phase: "assets", component: "assets", state: "completed", reason: "assets-verified", action: "fetch" });

    // The launcher's configuration, handed in through its tree (#1519): taken
    // in on a fresh install, with or without a terminal, and staged as a
    // guided configuration is, so the transaction is the only writer in the
    // folder and both rollbacks remove it. A folder that has a configuration
    // keeps its own.
    let guidedStaged = false;
    const targetConfigured = pathExists(join(context.targetDir, ENVIRONMENT_FILE)) || pathExists(join(context.targetDir, SECRETS_DIRECTORY));
    if (treeHoldsOnlySecrets(context.launcherConfigTree)) {
      dependencies.notice?.(
        `Orbit installer: the .orbit-secrets in ${LAUNCHER_CONFIG_TREE_ENV} was ignored: there is no .env-orbit beside it, so no handed-in configuration was used.`,
      );
    }
    if (treeHoldsConfiguration(context.launcherConfigTree) && (targetConfigured || action !== "install")) {
      dependencies.notice?.(`Orbit installer: the configuration in ${LAUNCHER_CONFIG_TREE_ENV} was ignored: this folder already has one, and it is used.`);
    } else if (action === "install") {
      const unchanged = (message: string, guidance?: string[]) =>
        fail("configuration", "configuration", `${message}; the target remains unchanged.`, "configuration-failure", "retry", guidance);
      const handedIn = takeHandedInConfiguration(context.launcherConfigTree, scratchDir);
      if (handedIn.kind === "refused") return unchanged(`The configuration in ${LAUNCHER_CONFIG_TREE_ENV} was refused: ${handedIn.problem}`);
      if (handedIn.kind === "taken") {
        onEvent({ phase: "configuration", component: "configuration", state: "starting", reason: "configuration-migration", action: "configure" });
        // The launcher's file is a pre-provisioned one: bring it to the current
        // schema, with the project name the transaction will use (the compose
        // file's own `name:` replaces a provisional guess, as below), before
        // configure will accept it.
        let projectName = volumeState.composeProjectName || context.facts.targetBasename;
        if (volumeState.composeProjectNameProvisional) {
          try {
            projectName = deriveComposeProjectName(context.targetDir, context.requestedComposeProjectName, context.facts.targetBasename, join(scratchDir, COMPOSE_FILE)).composeProjectName;
          } catch (error) {
            if (!(error instanceof ComposeProjectNameRefusal)) throw error;
            return fail("compose", "compose", error.message);
          }
        }
        const migration = runConfigurationMigration({
          environmentFile: join(scratchDir, ENVIRONMENT_FILE),
          orbitImage: context.resolvedReference,
          appliedVersion: context.facts.imageVersion,
          appliedDigest: context.facts.appliedDigest,
          composeProjectName: projectName,
        });
        if (!migration.ok) return unchanged(`The configuration in ${LAUNCHER_CONFIG_TREE_ENV} was refused: ${migration.message}`);
        try {
          say(dependencies, runConfigureApply(scratchDir, context.resolvedReference, { trustOrbitImage: true, stampAbsentBeforeMigration: true }).messages);
        } catch {
          return unchanged("Secret generation failed");
        }
        // The launcher's file carries the profile it was configured with, so
        // without a wizard choice an unset ORBIT_INSTALL_PROFILE keeps it
        // rather than resetting it to standard; a set one wins, and says so.
        if (!(menuShown && terminal)) {
          const handedInProfile = currentDeploymentProfile(scratchDir, true);
          if (context.requestedProfile === undefined) {
            // Running the same command again reads the same file, so no retry
            // can clear this: abort, and name the edit (#1536 RG-R5).
            if (!handedInProfile.ok) {
              return fail(
                "configuration",
                "configuration",
                `The configuration in ${LAUNCHER_CONFIG_TREE_ENV} was refused: its optional-service configuration is unsupported or ambiguous; the target remains unchanged.`,
                "configuration-failure",
                "abort",
                [
                  "Orbit installer: edit COMPOSE_PROFILES, TIKA_URL and OLLAMA_MODEL in the handed-in .env-orbit so together they name one supported profile, as .env-orbit.example describes, or set ORBIT_INSTALL_PROFILE to replace them.",
                ],
              );
            }
            // A kept local-AI profile is a chosen one all the same: the
            // wizard's capacity advisory and download step (#1536 G2-R2),
            // the download asked only where a terminal can answer it.
            let modelPullRequested: boolean;
            try {
              modelPullRequested = prepareLocalAiModel(handedInProfile.profile, capacity, (line) => say(dependencies, [line]), context.plainMode ? undefined : terminal);
            } catch (error) {
              if (error instanceof InstallPromptStop) return stopped(error);
              throw error;
            }
            profile = { ...profile, selectedProfile: handedInProfile.profile, profileChange: false, modelPullRequested };
          } else if (handedInProfile.ok && handedInProfile.profile !== profile.selectedProfile) {
            say(dependencies, [`ORBIT_INSTALL_PROFILE=${profile.selectedProfile} replaces the ${handedInProfile.profile} profile in the handed-in configuration`]);
          }
        }
        if (profile.profileChange) {
          try {
            say(dependencies, [setDeploymentProfile(scratchDir, profile.selectedProfile, profile.selectedModel)]);
          } catch {
            return unchanged("Deployment profile configuration failed");
          }
        }
        const readiness = readinessText(scratchDir);
        if (!readiness.ok) {
          const missing = missingConfigurationFields(readiness.text);
          return unchanged(
            `The configuration in ${LAUNCHER_CONFIG_TREE_ENV} is incomplete${missing.length > 0 ? ` (${missing.join(" ")})` : ""}`,
            missing.length > 0 ? noninteractiveConfigurationGuidance(missing) : undefined,
          );
        }
        guidedStaged = true;
        profile = { ...profile, profileChange: false };
        onEvent({ phase: "configuration", component: "configuration", state: "running", reason: "configuration-migration", action: "verify" });
      }
    }

    // stage_guided_install_configuration (guarantees #30-32).
    if (
      !guidedStaged &&
      action === "install" &&
      !context.plainMode &&
      terminal &&
      !pathExists(join(context.targetDir, ENVIRONMENT_FILE)) &&
      !pathExists(join(context.targetDir, SECRETS_DIRECTORY))
    ) {
      onEvent({ phase: "configuration", component: "configuration", state: "starting", reason: "configuration-migration", action: "configure" });
      const unchanged = (message: string) => fail("configuration", "configuration", `${message}; the target remains unchanged.`, "configuration-failure", "retry");
      try {
        say(dependencies, [applyGuidedInit(scratchDir, dependencies.answers.guidedInit(undefined))]);
      } catch {
        return unchanged("Guided configuration was cancelled or invalid");
      }
      try {
        say(dependencies, runConfigureApply(scratchDir, context.resolvedReference, { trustOrbitImage: true }).messages);
      } catch {
        return unchanged("Secret generation failed");
      }
      // --init just asked the sign-in mode (ADR-0023 section 1); anything
      // but the literal "false" is OIDC, guided_init's own fail-safe default.
      if (readEnvironmentValue(scratchDir, "ORBIT_AUTH_OIDC") !== "false") {
        try {
          say(dependencies, [applySetOidcSecret(scratchDir, dependencies.answers.oidcSecret())]);
        } catch {
          return unchanged("OIDC client secret collection was cancelled or invalid");
        }
      }
      if (profile.profileChange) {
        try {
          say(dependencies, [setDeploymentProfile(scratchDir, profile.selectedProfile, profile.selectedModel)]);
        } catch {
          return unchanged("Deployment profile configuration failed");
        }
      }
      const readiness = readinessText(scratchDir);
      if (!readiness.ok) return unchanged("Guided configuration is incomplete");
      if (readiness.text === "") return unchanged("Guided configuration did not return a readiness summary");
      try {
        const choice = selectChoice(terminal, `Final review: apply the collected core settings and selected ${profile.selectedProfile} profile.`, "apply", [
          ["apply", "Install the reviewed configuration"],
          ["cancel", "Cancel without changing files or services"],
        ]);
        if (choice !== "apply") return stopped(declined());
      } catch (error) {
        if (error instanceof InstallPromptStop) return stopped(error);
        throw error;
      }
      guidedStaged = true;
      profile = { ...profile, profileChange: false };
      onEvent({ phase: "configuration", component: "configuration", state: "running", reason: "configuration-migration", action: "verify" });
    }

    // preflight_final_paths + prepare_rollback_area (#46-49), with the deploy lock.
    let transaction: InstallTransaction;
    try {
      transaction = InstallTransaction.begin(context.targetDir, buildManagedPaths(DEPLOYMENT_ASSETS));
    } catch (error) {
      if (!(error instanceof InstallTransactionRefusal) && !(error instanceof Error && error.name === "HostOwnershipError")) throw error;
      return fail("compose", "compose", messageOf(error));
    }
    const disposeTransaction = () => {
      transaction.dispose();
    };
    interruptCleanups.add(disposeTransaction);
    dependencies.afterTransactionBegun?.();

    let committed = false;
    try {
      // The bundled compose file's own `name:` (#999), read from the staged
      // copy before anything writes a project name down. Only a provisional
      // (directory-name) guess is replaced.
      if (volumeState.composeProjectNameProvisional) {
        try {
          const rederived = deriveComposeProjectName(context.targetDir, context.requestedComposeProjectName, context.facts.targetBasename, join(scratchDir, COMPOSE_FILE));
          volumeState = {
            ...volumeState,
            composeProjectName: rederived.composeProjectName,
            composeProjectNameExplicit: rederived.explicit,
            composeProjectNameProvisional: rederived.provisional,
          };
        } catch (error) {
          if (!(error instanceof ComposeProjectNameRefusal)) throw error;
          return fail("compose", "compose", error.message);
        }
      }

      const environmentFile = join(context.targetDir, ENVIRONMENT_FILE);
      const migrationTarget: ConfigurationMigrationTarget = {
        environmentFile,
        orbitImage: context.resolvedReference,
        appliedVersion: context.facts.imageVersion,
        appliedDigest: context.facts.appliedDigest,
        composeProjectName: volumeState.composeProjectName || context.facts.targetBasename,
      };

      // An existing .env-orbit is preflighted and migrated before anything
      // else is installed (#50).
      let configurationMigrationCompleted = false;
      // No file means a fresh install, so the stamp is absent.
      let stampAbsentBeforeMigration = true;
      if (existsSync(environmentFile)) {
        const preflight = transaction.shareLock(() => runConfigurationPreflight(environmentFile));
        if (!preflight.ok) return fail("configuration", "configuration", preflight.message);
        // Read only once the preflight has accepted the file, and before the
        // migration below writes the stamp, so configure can tell a
        // pre-provisioned first install from one that lost its secrets.
        stampAbsentBeforeMigration = !environmentHasAppliedStamp(context.targetDir);
        const migration = transaction.shareLock(() => runConfigurationMigration(migrationTarget));
        if (!migration.ok) return fail("configuration", "configuration", migration.message);
        say(dependencies, [migration.message]);
        configurationMigrationCompleted = true;
      }

      // Asset directories (#51), the reviewed guided configuration (#52,
      // secrets before the file that names them), then every asset.
      try {
        for (const directory of deriveAssetDirectories(DEPLOYMENT_ASSETS)) transaction.ensureManagedDirectory(directory);
        if (guidedStaged) {
          stageSecretsDirectoryTree(transaction, join(scratchDir, SECRETS_DIRECTORY), SECRETS_DIRECTORY);
          transaction.commitMove(SECRETS_DIRECTORY, "directory");
          transaction.writeStagedFile(ENVIRONMENT_FILE, readFileSync(join(scratchDir, ENVIRONMENT_FILE)));
          transaction.commitMove(ENVIRONMENT_FILE, "file");
        }
        for (const asset of DEPLOYMENT_ASSETS) {
          transaction.writeStagedFile(asset, readFileSync(join(scratchDir, asset)), DEPLOYMENT_ASSET_FILE_MODE);
          transaction.commitMove(asset, "file");
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return fail("compose", "compose", error.message);
      }

      // prepare_configuration (guarantees #24, #28).
      onEvent({ phase: "configuration", component: "configuration", state: "starting", reason: "configuration-migration", action: "configure" });
      const configurationFailure = (message: string, guidance?: string[]) =>
        fail("configuration", "configuration", message, "configuration-failure", "retry", guidance);
      const leftSafeShape = () => {
        if (!isRegularNonSymlinkFile(environmentFile)) return `Configuration did not leave a regular, non-symlink ${ENVIRONMENT_FILE}.`;
        if (!isRealNonSymlinkDirectory(join(context.targetDir, SECRETS_DIRECTORY))) return `Configuration did not leave a real, non-symlink ${SECRETS_DIRECTORY} directory.`;
        return undefined;
      };
      try {
        say(dependencies, transaction.shareLock(() => runConfigureApply(context.targetDir, context.resolvedReference, { trustOrbitImage: true, stampAbsentBeforeMigration })).messages);
      } catch (error) {
        // A refusal says what the operator must fix (and never carries a secret), so pass it on.
        if (error instanceof ConfigureEngineRefusal) return configurationFailure(`Configuration failed, restoring the previous deployment: ${error.message}`);
        return configurationFailure("Configuration failed; restoring the previous deployment.");
      }
      let shapeProblem = leftSafeShape();
      if (shapeProblem) return configurationFailure(shapeProblem);
      if (profile.profileChange) {
        try {
          say(dependencies, [transaction.shareLock(() => setDeploymentProfile(context.targetDir, profile.selectedProfile, profile.selectedModel))]);
        } catch {
          return configurationFailure("Deployment profile configuration failed; restoring the previous deployment.");
        }
        shapeProblem = leftSafeShape();
        if (shapeProblem) return configurationFailure(shapeProblem);
      }

      let readiness = readinessText(context.targetDir);
      if (!readiness.ok) {
        const missing = missingRequiredFields(readiness.text);
        if (missing.length > 0 && context.interactive) {
          if (missingGuidedFields(readiness.text).length > 0) {
            // An existing deployment already chose its sign-in mode (#918).
            const existingMode = readEnvironmentValue(context.targetDir, "ORBIT_AUTH_OIDC");
            const hint = existingMode === "true" ? "oidc" : existingMode === "false" ? "local" : undefined;
            try {
              say(dependencies, [transaction.shareLock(() => applyGuidedInit(context.targetDir, dependencies.answers.guidedInit(hint)))]);
            } catch {
              return configurationFailure("Guided configuration was cancelled or invalid; restoring the previous deployment.");
            }
            readiness = readinessText(context.targetDir);
          }
          if (readiness.text.split("\n").includes("missing OIDC_CLIENT_SECRET")) {
            try {
              say(dependencies, [transaction.shareLock(() => applySetOidcSecret(context.targetDir, dependencies.answers.oidcSecret()))]);
            } catch {
              return configurationFailure("OIDC client secret collection was cancelled or invalid; restoring the previous deployment.");
            }
            readiness = readinessText(context.targetDir);
          }
        } else if (missing.length > 0) {
          return configurationFailure("Required configuration fields require attention; refusing to start Compose.", noninteractiveConfigurationGuidance(missing));
        }
      }
      if (!readiness.ok) {
        let missing = missingConfigurationFields(readiness.text);
        if (missing.length === 0) missing = ["APP_URL", "ORBIT_IMAGE", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_CALLBACK_URL"];
        return configurationFailure(`Configuration fields require attention (${missing.join(" ")}); refusing to start Compose.`);
      }
      // Readiness warnings (a memory limit below the import peak) do not stop
      // the run, but the operator should see them in the installer window.
      say(dependencies, readiness.text.split("\n").filter((line) => line.startsWith("warning ")));
      onEvent({ phase: "configuration", component: "configuration", state: "running", reason: "configuration-migration", action: "verify" });

      if (!verifyDatabasePasswordPreserved(transaction, context.targetDir, volumeState.databaseVolumeSeen)) {
        return configurationFailure("The existing POSTGRES_PASSWORD_FILE changed during configuration; refusing to start Compose.");
      }

      if (!configurationMigrationCompleted) {
        const migration = transaction.shareLock(() => runConfigurationMigration(migrationTarget));
        if (!migration.ok) return fail("configuration", "configuration", migration.message);
        say(dependencies, [migration.message]);
      }
      onEvent({ phase: "configuration", component: "configuration", state: "completed", reason: "configuration-migration", action: "verify" });

      // OIDC discovery (#25-27, F5): only for a deployment that turned an
      // identity provider on (ADR-0023 section 1).
      if (readEnvironmentValue(context.targetDir, "ORBIT_AUTH_OIDC") === "true") {
        onEvent({ phase: "oidc", component: "oidc", state: "starting", reason: "provider-discovery", action: "verify" });
        const discovery = await verifyOidcDiscovery(context.targetDir, { fetchImpl: dependencies.fetchImpl });
        if (discovery.status === "failed") return fail("oidc", "oidc", discovery.message, discovery.reason, discovery.action);
        onEvent({ phase: "oidc", component: "oidc", state: "completed", reason: "provider-discovery", action: "verify" });
      } else {
        onEvent({ phase: "oidc", component: "oidc", state: "skipped", reason: "provider-discovery", action: "skip" });
      }

      shapeProblem = leftSafeShape();
      if (shapeProblem) return fail("compose", "compose", shapeProblem);

      // The resolved digest, persisted through the transaction (#53-54).
      try {
        transaction.writeStagedFile(ENVIRONMENT_FILE, withResolvedImage(readFileSync(environmentFile, "utf8"), context.resolvedReference), 0o600);
        transaction.commitMove(ENVIRONMENT_FILE, "file");
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return fail("compose", "compose", error.message);
      }

      // The switch (F1, F8): from here a failure no longer restores files.
      try {
        transaction.commit();
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return fail("compose", "compose", error.message);
      }
      committed = true;
      dependencies.afterTransactionCommitted?.();
    } finally {
      interruptCleanups.delete(disposeTransaction);
      const disposal = transaction.dispose();
      if (!committed && !disposal.rollbackSucceeded) {
        onEvent({ phase: "rollback", component: "installer", state: "blocked", reason: "rollback", action: "repair" });
        if (disposal.preservedStagingDirectory && lastFailure) {
          const relative = disposal.preservedStagingDirectory.slice(context.targetDir.length).replace(/^\/+/, "");
          lastFailure.guidance = [...(lastFailure.guidance ?? []), `Orbit installer: rollback incomplete; recovery staging preserved at ./${relative}.`];
        }
      }
    }

    return {
      status: "ok",
      fresh: targetWasEmpty,
      selectedProfile: profile.selectedProfile,
      modelPullRequested: profile.modelPullRequested,
      databaseVolume: volumeState.databaseVolumeSeen ? volumeState.databaseVolumeName : undefined,
    };
  } finally {
    interruptCleanups.delete(removeScratch);
    removeScratch();
  }
}
