import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  type ConfigurationScriptAdapter,
  runConfigurationMigration,
  runConfigurationPreflight,
} from "./configuration-migration";
import {
  DEPLOYMENT_ASSETS,
  DEPLOYMENT_SCRIPTS,
  ENVIRONMENT_FILE,
  SECRETS_DIRECTORY,
  buildManagedPaths,
  deriveAssetDirectories,
} from "./deployment-assets";
import {
  type CurrentDeploymentProfileResult,
  type DeploymentProfile,
  currentDeploymentProfile,
  resolveNonInteractiveProfileSelection,
} from "./deployment-profile";
import { type EngineEvent, defaultFailureAction, defaultFailureReason } from "./engine-event";
import { type Clock, realClock, waitForComponentHealth } from "./health-wait";
import type { ImageIdentityAdapter } from "./image-resolution";
import { resolveImageIdentity } from "./image-resolution";
import { InstallTransaction, InstallTransactionRefusal, type ManagedPath } from "./install-transaction";
import {
  type DatabaseVolumeSafetyAdapter,
  type DatabaseVolumeSafetyState,
  DatabaseVolumeSafetyRefusal,
  type PostgresPasswordFacts,
  verifyDatabaseVolumeSafety,
} from "./database-volume-safety";
import {
  type OidcDiscoveryAdapters,
  type OidcDiscoveryFetchAdapter,
  verifyOidcDiscovery,
} from "./oidc-discovery";
import {
  type GuidedConfigurationAdapter,
  type MachinePromptAnswerProvider,
  prepareConfiguration,
  stageGuidedInstallConfiguration,
} from "./guided-configuration";
import {
  ComposeProjectNameRefusal,
  TargetValidationRefusal,
  deriveComposeProjectName,
  readEnvironmentValue,
  validateTarget,
} from "./target-identity";

// The install/update orchestrator (issue #295 slice 5): the single module
// that drives slices 1-4's pure modules, plus this slice's own
// image-resolution.ts/deployment-assets.ts/deployment-profile.ts/
// health-wait.ts, through the exact sequencing scripts/install.sh's main
// flow performs (install.sh:1259-1556). Every Docker/curl/subprocess call is
// a caller-supplied adapter (src/lib/install-docker-adapter.ts,
// install-curl-adapter.ts, install-script-adapters.ts ship the production
// implementations this slice adds) so this module itself remains pure
// sequencing/decision logic, fully testable with fakes — see
// install-orchestrator.test.ts.
//
// See docs/adr-notes/295-install-port-plan.md's Flags section for the
// deliberate scope-narrowing decisions this module makes relative to
// install.sh's own interactive branches (profile-selection wizard,
// TTY-driven guided configuration transport).

export interface InstallOrchestratorAdapters {
  docker: ImageIdentityAdapter & DatabaseVolumeSafetyAdapter & {
    checkDockerAvailable(): boolean;
    validateOidcDiscoverySandbox(resolvedReference: string, issuer: string, documentPath: string): boolean;
    composePull(service: string): boolean;
    composeUp(): boolean;
    composeDown(): void;
    composeConfigValidate(): boolean;
    probeDatabaseHealth(): boolean;
    probeApplicationHealth(): boolean;
    probeClamavHealth(): boolean;
    probeTikaHealth(): boolean;
    probeOllamaHealth(): boolean;
    probeApplicationLiveness(): boolean;
    pullOllamaModel(model: string): boolean;
    /** See InstallDockerAdapter.setComposeProjectName's own doc (install-docker-adapter.ts) for why this must be callable after construction. */
    setComposeProjectName(name: string): void;
  };
  fetchAsset(url: string, destinationPath: string): { ok: boolean };
  checkCurlAvailable(): boolean;
  oidcFetch: OidcDiscoveryFetchAdapter;
  configurationScript: ConfigurationScriptAdapter;
  guidedConfiguration: GuidedConfigurationAdapter;
  answers: MachinePromptAnswerProvider;
  clock?: Clock;
}

export interface InstallOrchestratorContext {
  targetDir: string;
  requestedAction: "install" | "update";
  /** install.sh's $repository ("owner/repo", ORBIT_REPOSITORY). */
  repository: string;
  /** install.sh's $registry (ORBIT_REGISTRY). */
  registry: string;
  /** install.sh's $channel (ORBIT_CHANNEL). */
  channel: string;
  /** install.sh's ${COMPOSE_PROJECT_NAME:-}. */
  requestedComposeProjectName?: string;
  /** install.sh's `basename -- "$(pwd -P)"` fallback for derive_compose_project_name. */
  fallbackBasename: string;
  /**
   * install.sh's has_controlling_terminal() (install.sh:597-603). The CLI
   * has no real controlling terminal the way a spawned bash script's own
   * `exec {fd}<>/dev/tty` does, so the shipped CLI (src/cli/orbit.ts) always
   * passes `false` here — see this module's own Flags entry for why, and
   * why this is left as an injected context field (not hardcoded) so a
   * future slice wiring a real answer-provider/CLI-flag surface can flip it
   * without changing this module.
   */
  hasControllingTerminal: boolean;
  /** install.sh's $readiness_timeout_seconds (ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS, 1-900). */
  readinessTimeoutSeconds: number;
  /** install.sh's $readiness_poll_seconds (ORBIT_INSTALLER_POLL_INTERVAL_SECONDS, 1-9). */
  readinessPollSeconds: number;
}

export type OnEvent = (event: EngineEvent) => void;

export interface InstallOutcomeOk {
  status: "ok";
  resolvedReference: string;
  revision: string;
  imageVersion: string;
  appliedDigest: string;
  composeProjectName: string;
  selectedProfile: DeploymentProfile;
}

export interface InstallOutcomeCancelled {
  status: "cancelled";
}

export interface InstallOutcomeFailed {
  status: "failed";
  phase: string;
  component: string;
  reason: string;
  action: string;
  message: string;
  /**
   * install.sh's print_noninteractive_configuration_guidance
   * (install.sh:879-885, guarantee #24): the exact remediation lines,
   * present only for prepareConfiguration's non-interactive
   * required-fields-missing refusal. install.sh prints these to stderr
   * directly — they are operator-facing remediation text, not part of the
   * fixed-vocabulary engine-event stream (engine-event.ts's own module
   * comment: only fixed-vocabulary values pass through `onEvent`), so the
   * caller (the CLI) is responsible for surfacing them, exactly as
   * install.sh's own printf calls do.
   */
  guidance?: string[];
}

export type InstallOutcome = InstallOutcomeOk | InstallOutcomeCancelled | InstallOutcomeFailed;

function isRegularNonSymlinkFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function hasMode(path: string, mode: number): boolean {
  try {
    return (lstatSync(path).mode & 0o777) === mode;
  } catch {
    return false;
  }
}

function readPostgresPasswordFacts(targetDir: string): PostgresPasswordFacts {
  const path = join(targetDir, SECRETS_DIRECTORY, "postgres-password");
  return { isRegularNonSymlinkFile: isRegularNonSymlinkFile(path), mode: isRegularNonSymlinkFile(path) ? lstatSync(path).mode & 0o777 : null };
}

/**
 * verify_database_password_preserved (install.sh:588-595, guarantee #19):
 * once a run has attached to a pre-existing, proven database volume
 * (`databaseVolumeSeen`), the live `postgres-password` secret's content and
 * mode-600 permission must be byte-identical to the pre-transaction backup
 * (`InstallTransaction.originalDir`) — the one guarantee slice 2 explicitly
 * deferred to this orchestration slice (see database-volume-safety.ts's own
 * module comment) because it needs both slice 1's transaction and slice 2's
 * volume-safety state together.
 */
function verifyDatabasePasswordPreserved(transaction: InstallTransaction, targetDir: string, databaseVolumeSeen: boolean): boolean {
  if (!databaseVolumeSeen) return true;
  const live = join(targetDir, SECRETS_DIRECTORY, "postgres-password");
  const backup = join(transaction.originalDir, SECRETS_DIRECTORY, "postgres-password");
  if (!hasMode(live, 0o600)) return false;
  try {
    return readFileSync(backup).equals(readFileSync(live));
  } catch {
    return false;
  }
}

function stageSecretsDirectoryTree(transaction: InstallTransaction, sourceDir: string, relativeDir: string): void {
  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, entry);
    const stat = lstatSync(sourcePath);
    if (!stat.isFile()) continue;
    transaction.writeStagedFile(join(relativeDir, entry), readFileSync(sourcePath), stat.mode & 0o777);
  }
  chmodSync(join(transaction.stagingDir, relativeDir), 0o700);
}

/**
 * runInstall — the full install/update orchestration
 * (install.sh:1259-1556). Adapters are injected (see
 * InstallOrchestratorAdapters); `onEvent` receives the same
 * `{phase,component,state,reason,action}` records docs/engine-events.md's
 * plain-mode stream documents (src/lib/engine-event.ts formats/validates
 * them). Never throws for an expected refusal — every failure path returns
 * `{status:"failed",...}`; only a genuine programming error propagates.
 */
export async function runInstall(
  context: InstallOrchestratorContext,
  adapters: InstallOrchestratorAdapters,
  onEvent: OnEvent,
): Promise<InstallOutcome> {
  const clock = adapters.clock ?? realClock();

  function fail(
    phase: string,
    component: string,
    message: string,
    reason?: string,
    action?: string,
    guidance?: string[],
  ): InstallOutcomeFailed {
    const resolvedReason = reason ?? defaultFailureReason(phase);
    const resolvedAction = action ?? defaultFailureAction(phase);
    onEvent({ phase, component, state: "failed", reason: resolvedReason, action: resolvedAction });
    return { status: "failed", phase, component, reason: resolvedReason, action: resolvedAction, message, guidance };
  }

  onEvent({ phase: "host", component: "host", state: "starting", reason: "host-tools", action: "check" });

  let targetWasEmpty: boolean;
  try {
    ({ targetWasEmpty } = validateTarget(context.targetDir));
  } catch (error) {
    // validateTarget's own contract is to throw only TargetValidationRefusal
    // for an expected refusal (see target-identity.ts); anything else is a
    // genuine programming error and must propagate, matching this
    // function's own header comment ("Never throws for an expected
    // refusal ... only a genuine programming error propagates").
    if (!(error instanceof TargetValidationRefusal)) throw error;
    return fail("host", "host", error.message);
  }

  // guarantee #21
  if (context.requestedAction === "install" && !targetWasEmpty) {
    return fail(
      "host",
      "host",
      "Install requires an empty target or safe pre-provisioned bootstrap; use Update for a recognized deployment.",
    );
  }
  if (context.requestedAction === "update" && targetWasEmpty) {
    return fail("host", "host", "Update requires a recognized existing Orbit deployment.");
  }

  // guarantee #40 (curl/docker/compose availability; GNU `timeout` is not
  // required — see install-docker-adapter.ts's own header comment for why).
  if (!adapters.docker.checkDockerAvailable()) {
    return fail("host", "host", "Docker and Docker Compose v2 are required.");
  }
  if (!adapters.checkCurlAvailable()) {
    return fail("host", "host", "curl is required.");
  }

  // First verify_database_volume_safety call site (install.sh:1264, before
  // any image pull) — guarantees #13-18.
  let volumeState: DatabaseVolumeSafetyState = {
    databaseVolumeChecked: false,
    databaseVolumeSeen: false,
    databaseVolumeName: "",
    targetWasEmpty,
    composeProjectNameExplicit: false,
    composeProjectName: "",
  };
  try {
    volumeState = verifyDatabaseVolumeSafety(
      context.targetDir,
      context.requestedComposeProjectName,
      context.fallbackBasename,
      volumeState,
      readPostgresPasswordFacts(context.targetDir),
      adapters.docker,
    );
  } catch (error) {
    // verifyDatabaseVolumeSafety's own first call re-derives the Compose
    // project name (database-volume-safety.ts:228) without wrapping a
    // ComposeProjectNameRefusal into its own DatabaseVolumeSafetyRefusal —
    // bash's equivalent (derive_compose_project_name calling install.sh's
    // shared `fail`) is just as fatal as any other verify_database_volume_
    // safety refusal at this same call site, so both documented refusal
    // types are expected-refusal here, not a programming error.
    if (!(error instanceof DatabaseVolumeSafetyRefusal) && !(error instanceof ComposeProjectNameRefusal)) throw error;
    return fail("host", "host", (error as DatabaseVolumeSafetyRefusal | ComposeProjectNameRefusal).message);
  }
  // The Compose project name is now finally resolved (deriveComposeProjectName's
  // own decision, possibly overridden by a proven pre-existing volume's own
  // label — database-volume-safety.ts:305-313, install.sh:573). The docker
  // adapter was constructed before this was known, so every later
  // `compose`-wrapped call (composePull/composeUp/... — all only ever
  // invoked below this point) must be told the final name now, mirroring
  // install.sh's own `compose()` helper reading its `$compose_project_name`
  // global fresh on every call rather than capturing it once.
  adapters.docker.setComposeProjectName(volumeState.composeProjectName);
  onEvent({ phase: "host", component: "host", state: "completed", reason: "host-tools", action: "check" });

  // Image identity resolution (install.sh:1264-1310, guarantees #41-44).
  onEvent({ phase: "identity", component: "image", state: "starting", reason: "image-identity", action: "pull" });
  const imageRepository = `${context.registry}/${context.repository}`;
  const identity = resolveImageIdentity(imageRepository, context.channel, adapters.docker);
  if (identity.status === "failed") {
    return fail("identity", "image", identity.message);
  }
  onEvent({ phase: "identity", component: "image", state: "running", reason: "image-identity", action: "inspect" });
  onEvent({ phase: "identity", component: "image", state: "completed", reason: "image-identity", action: "verify" });

  const assetBase = `https://raw.githubusercontent.com/${context.repository}/${identity.revision}`;
  const assetDirectories = deriveAssetDirectories(DEPLOYMENT_ASSETS);
  const managedPaths: ManagedPath[] = buildManagedPaths(DEPLOYMENT_ASSETS);

  // A private scratch directory for asset download/validation and any
  // guided-configuration staging, created and always removed here —
  // distinct from InstallTransaction's own staging directory (created only
  // once preflight_final_paths/prepare_rollback_area's equivalent begins,
  // below). install.sh reuses a single staging_dir for both phases; see
  // docs/adr-notes/295-install-port-plan.md's Flags section for why this
  // port uses two.
  const scratchDir = mkdtempSync(join(context.targetDir, ".orbit-install-scratch."));
  chmodSync(scratchDir, 0o700);

  try {
    onEvent({ phase: "assets", component: "assets", state: "starting", reason: "assets-verified", action: "fetch" });
    for (const asset of DEPLOYMENT_ASSETS) {
      const destination = join(scratchDir, asset);
      // install.sh:1406-1407's own per-asset `mkdir -p -- "$(dirname
      // "$staged_path")"`, run unconditionally before every fetch (a no-op
      // for a top-level asset whose dirname is already the staging root) —
      // without this, fetchAsset's own destination parent
      // (scratchDir/config, scratchDir/scripts) would not exist yet for any
      // nested asset, and a real curl invocation fails to write there.
      mkdirSync(dirname(destination), { recursive: true });
      const fetchResult = adapters.fetchAsset(`${assetBase}/${asset}`, destination);
      if (!fetchResult.ok || !isRegularNonSymlinkFile(destination)) {
        return fail("assets", "assets", `Could not fetch ${asset} from the published revision.`);
      }
      if (lstatSync(destination).size === 0) {
        return fail("assets", "assets", `Fetched ${asset} is empty.`);
      }
    }
    for (const script of DEPLOYMENT_SCRIPTS) {
      const check = spawnSync("bash", ["-n", join(scratchDir, script)]);
      if (check.status !== 0) {
        return fail("assets", "assets", `Fetched ${script} failed a syntax check.`);
      }
    }
    onEvent({ phase: "assets", component: "assets", state: "completed", reason: "assets-verified", action: "fetch" });

    // resolve_installer_action's non-interactive branch only (install.sh:
    // 826-841) — see this module's own header comment / the plan's Flags
    // section for why the interactive profile-selection wizard
    // (choose_deployment_profile) is out of scope for this CLI.
    const environmentFileExists = existsSync(join(context.targetDir, ENVIRONMENT_FILE));
    const profileResult: CurrentDeploymentProfileResult = currentDeploymentProfile(context.targetDir, environmentFileExists);
    if (!profileResult.ok) {
      return fail("host", "host", "The existing optional-service configuration is unsupported or ambiguous.");
    }
    const { selectedProfile, profileChange } = resolveNonInteractiveProfileSelection(context.requestedAction, profileResult.profile);

    // stage_guided_install_configuration (install.sh:1031-1077, guarantees
    // #30-32) — always attempted for a fresh install; self-skips per its
    // own guarded preconditions (pre-existing .env-orbit/.orbit-secrets, or
    // context.hasControllingTerminal false).
    const guidedOutcome = await stageGuidedInstallConfiguration(
      {
        installerAction: context.requestedAction,
        plainMode: false,
        hasControllingTerminal: context.hasControllingTerminal,
        environmentFile: join(scratchDir, ENVIRONMENT_FILE),
        secretsDirectory: join(scratchDir, SECRETS_DIRECTORY),
        configureScript: join(scratchDir, "scripts", "configure.sh"),
        orbitImage: identity.resolvedReference,
        profileChange,
        selectedProfile,
        selectedModel: undefined,
      },
      adapters.guidedConfiguration,
      adapters.answers,
    );
    if (guidedOutcome.status === "cancelled") return { status: "cancelled" };
    if (guidedOutcome.status === "failed") {
      return fail("configuration", "configuration", guidedOutcome.message, guidedOutcome.reason, guidedOutcome.action);
    }
    const guidedStaged = guidedOutcome.status === "staged";

    // preflight_final_paths + prepare_rollback_area (install.sh:1435-1439,
    // guarantees #46-49) — InstallTransaction.begin() performs both
    // atomically.
    let transaction: InstallTransaction;
    try {
      transaction = InstallTransaction.begin(context.targetDir, managedPaths);
    } catch (error) {
      if (!(error instanceof InstallTransactionRefusal)) throw error;
      return fail("compose", "compose", error.message);
    }

    let committed = false;
    try {
      // Configuration preflight + migrate for an *existing* .env-orbit,
      // before any fetched asset is installed (install.sh:1441-1448,
      // guarantee #50, first of the two configuration_migration_completed
      // call sites).
      let configurationMigrationCompleted = false;
      const finalEnvironmentFile = join(context.targetDir, ENVIRONMENT_FILE);
      const configurationScriptScratchPath = join(scratchDir, "scripts", "configuration.sh");
      if (existsSync(finalEnvironmentFile)) {
        const preflight = runConfigurationPreflight(configurationScriptScratchPath, finalEnvironmentFile, adapters.configurationScript);
        if (!preflight.ok) return fail("configuration", "configuration", preflight.message);
        const migration = runConfigurationMigration(
          configurationScriptScratchPath,
          {
            environmentFile: finalEnvironmentFile,
            orbitImage: identity.resolvedReference,
            appliedVersion: identity.imageVersion,
            appliedDigest: identity.appliedDigest,
            composeProjectName: volumeState.composeProjectName || context.fallbackBasename,
          },
          adapters.configurationScript,
        );
        if (!migration.ok) return fail("configuration", "configuration", migration.message);
        configurationMigrationCompleted = true;
      }

      // Create asset directories (install.sh:1450-1459, guarantee #51).
      for (const directory of assetDirectories) {
        transaction.ensureManagedDirectory(directory);
      }

      // Move guided-install configuration into place (install.sh:1460-1465, guarantee #52).
      if (guidedStaged) {
        transaction.writeStagedFile(ENVIRONMENT_FILE, readFileSync(join(scratchDir, ENVIRONMENT_FILE)));
        transaction.commitMove(ENVIRONMENT_FILE, "file");
        stageSecretsDirectoryTree(transaction, join(scratchDir, SECRETS_DIRECTORY), SECRETS_DIRECTORY);
        transaction.commitMove(SECRETS_DIRECTORY, "directory");
      }

      // Move every fetched asset into place (install.sh:1467-1474).
      for (const asset of DEPLOYMENT_ASSETS) {
        const content = readFileSync(join(scratchDir, asset));
        transaction.writeStagedFile(asset, content);
        transaction.commitMove(asset, "file");
      }

      // prepare_configuration (install.sh:947-1008) — runs against the
      // target's own just-installed scripts/configure.sh, not the scratch
      // copy (see guided-configuration.ts's PrepareConfigurationContext doc).
      const prepared = await prepareConfiguration(
        {
          environmentFile: finalEnvironmentFile,
          secretsDirectory: join(context.targetDir, SECRETS_DIRECTORY),
          configureScript: join(context.targetDir, "scripts", "configure.sh"),
          orbitImage: identity.resolvedReference,
          hasControllingTerminal: context.hasControllingTerminal,
          profileChange,
          selectedProfile,
          selectedModel: undefined,
        },
        adapters.guidedConfiguration,
        adapters.answers,
      );
      if (prepared.status === "failed") {
        return fail("configuration", "configuration", prepared.message, "configuration-failure", "retry", prepared.guidance);
      }

      // Second verify_database_volume_safety call site (install.sh:1481,
      // guarantee #17's TOCTOU re-check) + verify_database_password_preserved
      // (install.sh:1482, guarantee #19).
      try {
        volumeState = verifyDatabaseVolumeSafety(
          context.targetDir,
          context.requestedComposeProjectName,
          context.fallbackBasename,
          volumeState,
          readPostgresPasswordFacts(context.targetDir),
          adapters.docker,
        );
      } catch (error) {
        if (!(error instanceof DatabaseVolumeSafetyRefusal)) throw error;
        return fail("database", "database", error.message);
      }
      if (!verifyDatabasePasswordPreserved(transaction, context.targetDir, volumeState.databaseVolumeSeen)) {
        return fail(
          "database",
          "database",
          "The existing POSTGRES_PASSWORD_FILE changed during configuration; refusing to start Compose.",
        );
      }

      // Second configuration-migration call site, only if the first one
      // never ran (install.sh:1484-1487).
      if (!configurationMigrationCompleted) {
        const targetConfigurationScript = join(context.targetDir, "scripts", "configuration.sh");
        const migration = runConfigurationMigration(
          targetConfigurationScript,
          {
            environmentFile: finalEnvironmentFile,
            orbitImage: identity.resolvedReference,
            appliedVersion: identity.imageVersion,
            appliedDigest: identity.appliedDigest,
            composeProjectName: volumeState.composeProjectName || context.fallbackBasename,
          },
          adapters.configurationScript,
        );
        if (!migration.ok) return fail("configuration", "configuration", migration.message);
        configurationMigrationCompleted = true;
      }
      onEvent({ phase: "configuration", component: "configuration", state: "completed", reason: "configuration-migration", action: "verify" });

      // verify_oidc_discovery (install.sh:1491-1493, guarantees #25-27).
      onEvent({ phase: "oidc", component: "oidc", state: "starting", reason: "provider-discovery", action: "verify" });
      const discoveryPath = transaction.stagingPathFor("oidc-discovery.json");
      const oidcOutcome = verifyOidcDiscovery(context.targetDir, discoveryPath, {
        fetch: adapters.oidcFetch,
        sandbox: { validate: (issuer, documentPath) => adapters.docker.validateOidcDiscoverySandbox(identity.resolvedReference, issuer, documentPath) },
      } satisfies OidcDiscoveryAdapters);
      if (oidcOutcome.status === "failed") {
        return fail("oidc", "oidc", oidcOutcome.message, oidcOutcome.reason, oidcOutcome.action);
      }
      onEvent({ phase: "oidc", component: "oidc", state: "completed", reason: "provider-discovery", action: "verify" });

      // Persist the resolved digest into ORBIT_IMAGE (install.sh:1495-1536,
      // guarantees #53-54).
      const currentContent = readFileSync(finalEnvironmentFile, "utf8");
      const orbitImageLine = `ORBIT_IMAGE=${identity.resolvedReference}`;
      const lines = currentContent.split("\n");
      let sawKey = false;
      const rewritten = lines.map((line) => {
        if (line.startsWith("ORBIT_IMAGE=")) {
          sawKey = true;
          return orbitImageLine;
        }
        return line;
      });
      const finalContent = sawKey ? rewritten.join("\n") : `${currentContent.replace(/\n$/, "")}\n${orbitImageLine}\n`;
      transaction.writeStagedFile(ENVIRONMENT_FILE, finalContent, 0o600);
      transaction.commitMove(ENVIRONMENT_FILE, "file");

      // docker compose config --quiet (install.sh:1539-1541, guarantee #55)
      // — must succeed *before* the transaction is marked committed
      // (guarantee #56).
      if (!adapters.docker.composeConfigValidate()) {
        return fail(
          "compose",
          "compose",
          "Docker Compose configuration is invalid; review the named configuration fields and rerun.",
        );
      }
      onEvent({ phase: "compose", component: "compose", state: "completed", reason: "compose-validation", action: "check" });

      transaction.commit();
      committed = true;
    } finally {
      const disposal = transaction.dispose();
      if (!committed && !disposal.rollbackSucceeded) {
        onEvent({ phase: "rollback", component: "installer", state: "blocked", reason: "rollback", action: "repair" });
      }
    }

    if (!committed) {
      // A failure already returned above; this branch only exists to
      // satisfy the type checker's control-flow analysis for the `finally`
      // block above (functionally unreachable — every failure path already
      // returned).
      return fail("compose", "compose", "The installation could not be committed.");
    }

    // Service image preparation (install.sh:1125-1162, guarantee #36) —
    // outside the file transaction's rollback scope from this point on
    // (guarantee #56).
    onEvent({ phase: "preparation", component: "database", state: "starting", reason: "service-preparation", action: "pull" });
    if (!adapters.docker.composePull("orbit-db")) {
      return fail("preparation", "database", "Could not prepare the Orbit database image.");
    }
    onEvent({ phase: "preparation", component: "database", state: "completed", reason: "service-preparation", action: "pull" });
    onEvent({ phase: "preparation", component: "application", state: "completed", reason: "service-preparation", action: "pull" });

    onEvent({ phase: "preparation", component: "clamav", state: "starting", reason: "service-preparation", action: "pull" });
    if (!adapters.docker.composePull("orbit-clamav")) {
      return fail("preparation", "clamav", "Could not prepare the private scanner image.");
    }
    onEvent({ phase: "preparation", component: "clamav", state: "completed", reason: "service-preparation", action: "pull" });

    if (selectedProfile === "processing" || selectedProfile === "full") {
      onEvent({ phase: "preparation", component: "tika", state: "starting", reason: "service-preparation", action: "pull" });
      if (!adapters.docker.composePull("orbit-tika")) {
        return fail("preparation", "tika", "Could not prepare the optional document-processing image.");
      }
      onEvent({ phase: "preparation", component: "tika", state: "completed", reason: "service-preparation", action: "pull" });
    } else {
      onEvent({ phase: "preparation", component: "tika", state: "skipped", reason: "service-preparation", action: "skip" });
    }

    if (selectedProfile === "ai" || selectedProfile === "full") {
      onEvent({ phase: "preparation", component: "ollama", state: "starting", reason: "service-preparation", action: "pull" });
      if (!adapters.docker.composePull("orbit-ollama")) {
        return fail("preparation", "ollama", "Could not prepare the optional local-model service image.");
      }
      onEvent({ phase: "preparation", component: "ollama", state: "completed", reason: "service-preparation", action: "pull" });
    } else {
      onEvent({ phase: "preparation", component: "ollama", state: "skipped", reason: "service-preparation", action: "skip" });
    }

    // wait_for_deployment_readiness (install.sh:1164-1219).
    onEvent({ phase: "database", component: "database", state: "starting", reason: "database-health", action: "start" });
    if (!adapters.docker.composeUp()) {
      if (targetWasEmpty) adapters.docker.composeDown();
      return fail("host", "host", "Orbit services could not be created or started.");
    }
    const databaseHealthy = await waitForComponentHealth({
      probe: () => adapters.docker.probeDatabaseHealth(),
      timeoutSeconds: context.readinessTimeoutSeconds,
      pollSeconds: context.readinessPollSeconds,
      clock,
      onWaiting: () => onEvent({ phase: "database", component: "database", state: "waiting", reason: "database-health", action: "wait" }),
    });
    if (!databaseHealthy) {
      return fail("database", "database", "The database did not become healthy within the bounded startup window.");
    }

    onEvent({ phase: "application", component: "application", state: "starting", reason: "application-health", action: "start" });
    const applicationHealthy = await waitForComponentHealth({
      probe: () => adapters.docker.probeApplicationHealth(),
      timeoutSeconds: context.readinessTimeoutSeconds,
      pollSeconds: context.readinessPollSeconds,
      clock,
      onWaiting: () => onEvent({ phase: "application", component: "application", state: "waiting", reason: "application-health", action: "wait" }),
    });
    if (!applicationHealthy) {
      if (adapters.docker.probeApplicationLiveness()) {
        return fail("application", "application", "Orbit did not report ready within the bounded startup window.");
      }
      return fail(
        "application",
        "application",
        "Orbit stopped before it could report ready; the bounded status does not claim an unproven cause.",
      );
    }

    onEvent({ phase: "optional", component: "clamav", state: "starting", reason: "optional-status", action: "health" });
    const clamavHealthy = await waitForComponentHealth({
      probe: () => adapters.docker.probeClamavHealth(),
      timeoutSeconds: context.readinessTimeoutSeconds,
      pollSeconds: context.readinessPollSeconds,
      clock,
      onWaiting: () => onEvent({ phase: "optional", component: "clamav", state: "waiting", reason: "optional-status", action: "health" }),
    });
    if (!clamavHealthy) {
      return fail("optional", "clamav", "The private scanner did not become healthy within the bounded startup window.");
    }

    if (selectedProfile === "processing" || selectedProfile === "full") {
      onEvent({ phase: "optional", component: "tika", state: "starting", reason: "optional-status", action: "health" });
      const tikaHealthy = await waitForComponentHealth({
        probe: () => adapters.docker.probeTikaHealth(),
        timeoutSeconds: context.readinessTimeoutSeconds,
        pollSeconds: context.readinessPollSeconds,
        clock,
        onWaiting: () => onEvent({ phase: "optional", component: "tika", state: "waiting", reason: "optional-status", action: "health" }),
      });
      if (!tikaHealthy) {
        return fail("optional", "tika", "The selected document-processing service did not become healthy within the bounded startup window.");
      }
    } else {
      onEvent({ phase: "optional", component: "tika", state: "skipped", reason: "optional-status", action: "skip" });
    }

    if (selectedProfile === "ai" || selectedProfile === "full") {
      onEvent({ phase: "optional", component: "ollama", state: "starting", reason: "optional-status", action: "health" });
      const ollamaHealthy = await waitForComponentHealth({
        probe: () => adapters.docker.probeOllamaHealth(),
        timeoutSeconds: context.readinessTimeoutSeconds,
        pollSeconds: context.readinessPollSeconds,
        clock,
        onWaiting: () => onEvent({ phase: "optional", component: "ollama", state: "waiting", reason: "optional-status", action: "health" }),
      });
      if (!ollamaHealthy) {
        return fail("optional", "ollama", "The selected local-model service did not become healthy within the bounded startup window.");
      }
      // Guarantee #20: a confirmed model download is always a separate,
      // explicitly-confirmed step, never a side effect of profile
      // selection — this CLI never sets a requested model to pull (see the
      // plan's Flags section), so that step is always skipped here.
    } else {
      onEvent({ phase: "optional", component: "ollama", state: "skipped", reason: "optional-status", action: "skip" });
    }

    onEvent({ phase: "complete", component: "installer", state: "completed", reason: "deployment-ready", action: "complete" });

    return {
      status: "ok",
      resolvedReference: identity.resolvedReference,
      revision: identity.revision,
      imageVersion: identity.imageVersion,
      appliedDigest: identity.appliedDigest,
      composeProjectName: volumeState.composeProjectName || deriveFallbackComposeProjectName(context),
      selectedProfile,
    };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

function deriveFallbackComposeProjectName(context: InstallOrchestratorContext): string {
  try {
    return deriveComposeProjectName(context.targetDir, context.requestedComposeProjectName, context.fallbackBasename).composeProjectName;
  } catch {
    return context.fallbackBasename;
  }
}

// Re-exported for the CLI and tests.
export { readEnvironmentValue };
