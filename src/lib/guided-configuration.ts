import { lstatSync } from "node:fs";

// Guided configuration driving (issue #295 slice 4), ported from
// scripts/install.sh's `stage_guided_install_configuration`
// (install.sh:1031-1077) and `prepare_configuration` (install.sh:947-1008),
// plus the small decision helpers they call directly:
// `missing_required_fields`, `missing_guided_fields`,
// `missing_configuration_fields` (install.sh:843-877) and
// `print_noninteractive_configuration_guidance` (install.sh:879-885).
// Guarantee numbers below cite docs/installer-guarantees.md, Part 1 /
// install.sh, and are re-asserted by name in
// src/lib/guided-configuration.test.ts.
//
// install.sh itself always hands the real controlling terminal to
// scripts/configure.sh for these flows (`bash scripts/configure.sh --init`,
// with `ORBIT_CONFIGURE_PROMPTS` never set) — see docs/engine-events.md's
// "Machine prompts (v0)" section: "install.sh never sets this variable."
// The CLI port has no `/dev/tty` to hand a child process, so per the slice
// plan this module always drives configure.sh's guided fields (APP_URL,
// OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET) through the #297
// `ORBIT_CONFIGURE_PROMPTS=machine` line grammar instead of TTY prompting —
// the exact grammar scripts/engine-prompt-renderer.fixture.mjs already
// demonstrates driving generically (docs/engine-events.md "Machine prompts
// (v0)"). `parseMachinePromptLine` below reimplements that same grammar (not
// a new variant of it): the same four line shapes, the same field/kind/
// reason vocabulary, and — like the fixture — it never itself branches on
// what a specific field name *means*.
//
// Deciding the actual answer values (from CLI flags, environment, or a
// future interactive UI) is the caller's responsibility via the injected
// MachinePromptAnswerProvider; collecting those answers is explicitly
// deferred to slice 5's orchestration/wiring work, per the plan's own slice
// boundary. Likewise, every configure.sh invocation (--init, the bare
// default invocation, --set-oidc-secret, --set-deployment-profile, --check)
// is a caller-supplied adapter method with no production implementation
// shipped in this slice — the same "handoff, not port" non-goal
// src/lib/database-volume-safety.ts's and
// src/lib/configuration-migration.ts's adapters established for slices 2-3.
//
// Unlike every prior adapter in this port (each models one blocking
// `$(cmd ...)` call, mirrored as a synchronous method), the two
// machine-prompt methods here (runInit, runSetOidcSecret) model a live,
// multi-round stdin/stdout exchange with a real child process and are
// declared async — Node has no synchronous equivalent of a blocking-but-
// interactive subprocess exchange the way `execFileSync`/`spawnSync` model
// a single blocking call. See docs/adr-notes/295-install-port-plan.md's
// Flags section.

/**
 * One parsed line of the #297 machine-prompt grammar
 * (docs/engine-events.md "Machine prompts (v0)" §Line grammar). `kind` and
 * `required` are carried as raw strings, deliberately unvalidated against a
 * fixed enum here — exactly like scripts/engine-prompt-renderer.fixture.mjs,
 * this module never branches on what a specific field name or kind
 * *means*; only the caller-supplied MachinePromptAnswerProvider does.
 */
export type MachinePromptLine =
  | { type: "prompt"; field: string; kind: string; required: string; attempt: number }
  | { type: "prompt-reject"; field: string; reason: string }
  | { type: "prompt-accept"; field: string }
  | { type: "prompt-abort"; field: string };

const PROMPT_LINE = /^prompt field=(\S+) kind=(\S+) required=(\S+) attempt=(\d+)$/;
const REJECT_LINE = /^prompt-reject field=(\S+) reason=(\S+)$/;
const ACCEPT_LINE = /^prompt-accept field=(\S+)$/;
const ABORT_LINE = /^prompt-abort field=(\S+)$/;

/**
 * Parses one line of configure.sh's `ORBIT_CONFIGURE_PROMPTS=machine`
 * output (docs/engine-events.md "Machine prompts (v0)" §Line grammar;
 * bash side: `machine_prompt_collect`, configure.sh:654-676). Returns null
 * for any unrecognised line — the caller should ignore it, exactly as
 * scripts/engine-prompt-renderer.fixture.mjs ignores configure.sh's closing
 * "Orbit guided configuration saved ..." message.
 */
export function parseMachinePromptLine(line: string): MachinePromptLine | null {
  let match = PROMPT_LINE.exec(line);
  if (match) {
    const [, field, kind, required, attempt] = match;
    return { type: "prompt", field, kind, required, attempt: Number(attempt) };
  }
  match = REJECT_LINE.exec(line);
  if (match) {
    const [, field, reason] = match;
    return { type: "prompt-reject", field, reason };
  }
  match = ACCEPT_LINE.exec(line);
  if (match) {
    return { type: "prompt-accept", field: match[1] };
  }
  match = ABORT_LINE.exec(line);
  if (match) {
    return { type: "prompt-abort", field: match[1] };
  }
  return null;
}

/** What a MachinePromptAnswerProvider is asked to answer for one `prompt` line. `required` is omitted: docs/engine-events.md notes it is always the literal "true" in v0. */
export interface MachinePromptRequest {
  field: string;
  kind: string;
  attempt: number;
}

/**
 * Supplies one answer per `prompt` line (docs/engine-events.md §Security:
 * "no prompt line ... ever carries a value" — this interface is the only
 * place an answer value exists in this module; parseMachinePromptLine and
 * MachinePromptLine above never carry one). Deciding the actual answer
 * values is out of scope for this slice — see the module comment above.
 */
export interface MachinePromptAnswerProvider {
  answer(request: MachinePromptRequest): string | Promise<string>;
}

/**
 * The outcome of one machine-prompt-driven configure.sh invocation
 * (--init or --set-oidc-secret). `events` is the ordered, parsed line
 * grammar observed — never raw answer text (see MachinePromptAnswerProvider
 * above). `ok` mirrors the child process's exit status, exactly like
 * install.sh's own `bash ... configure.sh --init || fail_with ...`.
 */
export interface MachinePromptSessionResult {
  ok: boolean;
  events: MachinePromptLine[];
}

/** The result of a non-machine-prompt configure.sh invocation: exit status plus raw stdout (install.sh's own `$(...)` command-substitution capture point). */
export interface ConfigureScriptResult {
  status: number;
  stdout: string;
}

/**
 * Every scripts/configure.sh invocation `stage_guided_install_configuration`
 * and `prepare_configuration` make, as one method per invocation shape — the
 * same "thin adapter at the edge" pattern src/lib/database-volume-safety.ts
 * established for `docker`. No production implementation ships in this
 * slice; a real implementation belongs to slice 5's orchestration work.
 */
export interface GuidedConfigurationAdapter {
  /** ORBIT_IMAGE=<orbitImage> ORBIT_CONFIGURE_PROMPTS=machine bash <configureScript> --init (install.sh:1041,984 — machine-prompt variant of install.sh's own TTY --init call). */
  runInit(
    configureScript: string,
    orbitImage: string,
    answers: MachinePromptAnswerProvider,
  ): Promise<MachinePromptSessionResult>;
  /** ORBIT_IMAGE=<orbitImage> bash <configureScript> (no flags) — the bare, non-interactive default invocation (install.sh:953,1043). */
  runDefault(configureScript: string, orbitImage: string): ConfigureScriptResult;
  /** ORBIT_CONFIGURE_PROMPTS=machine bash <configureScript> --set-oidc-secret (install.sh:1045,990 — machine-prompt variant, replacing install.sh's own ORBIT_CONFIGURE_TTY_INPUT=1). */
  runSetOidcSecret(configureScript: string, answers: MachinePromptAnswerProvider): Promise<MachinePromptSessionResult>;
  /** ORBIT_IMAGE=<orbitImage> bash <configureScript> --set-deployment-profile <profile> [model] (install.sh:1050-1056,962-968). `model` is omitted entirely (not passed as an empty string) for any profile other than ai/full, exactly like install.sh's own two call shapes. */
  runSetDeploymentProfile(
    configureScript: string,
    orbitImage: string,
    profile: string,
    model: string | undefined,
  ): ConfigureScriptResult;
  /** bash <configureScript> --check (install.sh:959,978,988,1000,1059). */
  runCheck(configureScript: string): ConfigureScriptResult;
  /**
   * install.sh's final `installer_ui_select` apply/cancel review menu
   * (install.sh:1064-1071) — the only interactive decision in this slice
   * that is not part of the #297 machine-prompt grammar (it has no field
   * name and never appears on the configure.sh child process at all).
   * install.sh distinguishes a clean "cancel" choice (fixed exit 130) from
   * a non-zero status from the select call itself (e.g. a read error);
   * this port collapses both into a single "cancel" outcome — see Flags.
   */
  confirmApply(context: { selectedProfile: string }): Promise<"apply" | "cancel">;
}

function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/, "");
}

function readinessLines(readiness: string): Set<string> {
  return new Set(stripTrailingNewlines(readiness).split("\n"));
}

/** True when configure.sh --check's readiness summary contains an exact "missing <field>" line (configure.sh:986-994's `report_required_bool`). */
function isFieldMissing(readiness: string, field: string): boolean {
  return readinessLines(readiness).has(`missing ${field}`);
}

function missingFieldsFrom(readiness: string, fields: readonly string[]): string[] {
  const lines = readinessLines(readiness);
  return fields.filter((field) => lines.has(`missing ${field}`));
}

// The exact field arrays install.sh's three missing_*_fields functions
// iterate, in the same order (install.sh:845,857,869).
const REQUIRED_FIELDS = ["APP_URL", "ORBIT_IMAGE", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_CALLBACK_URL"];
const GUIDED_FIELDS = ["APP_URL", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CALLBACK_URL"];
const CONFIGURATION_FIELDS = [...REQUIRED_FIELDS, "processing", "ai", "mail", "imap", "push"];

/** missing_required_fields (install.sh:843-853). */
export function missingRequiredFields(readiness: string): string[] {
  return missingFieldsFrom(readiness, REQUIRED_FIELDS);
}

/** missing_guided_fields (install.sh:855-865). */
export function missingGuidedFields(readiness: string): string[] {
  return missingFieldsFrom(readiness, GUIDED_FIELDS);
}

/** missing_configuration_fields (install.sh:867-877). */
export function missingConfigurationFields(readiness: string): string[] {
  return missingFieldsFrom(readiness, CONFIGURATION_FIELDS);
}

/**
 * print_noninteractive_configuration_guidance (install.sh:879-885,
 * guarantee #24): the exact remediation lines install.sh prints to stderr
 * before refusing a non-interactive run with required fields still missing
 * — install.sh's own next-step guidance, not a CLI-specific rewrite, so a
 * caller that surfaces this text keeps parity with the documented Bash
 * entry point.
 */
export function noninteractiveConfigurationGuidance(missing: readonly string[]): string[] {
  return [
    `Orbit installer: configuration fields requiring attention: ${missing.join(" ")}.`,
    "Orbit installer: non-interactive use requires a complete .env-orbit and an existing owner-only .orbit-secrets/oidc-client-secret file.",
    "Orbit installer: safe next command in a controlling terminal: curl -fsSL https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/install.sh | bash",
    "Orbit installer: configure with --init, provide the secret with --set-oidc-secret, then verify with --check before rerunning automation.",
  ];
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

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

function deploymentProfileModel(profile: string, model: string | undefined): string | undefined {
  return profile === "ai" || profile === "full" ? model : undefined;
}

/** Facts stage_guided_install_configuration decides from — install.sh's own globals at the call site (install.sh:1031-1077), supplied by the caller rather than independently probed. See module comment above for `hasControllingTerminal`. */
export interface StageGuidedInstallConfigurationContext {
  /** install.sh's $installer_action. */
  installerAction: "install" | "update" | "repair";
  /** install.sh's $plain_mode (bash 0/1; boolean here). */
  plainMode: boolean;
  /** install.sh's has_controlling_terminal() (install.sh:597-603) — an injected fact, matching src/lib/target-identity.ts's and src/lib/database-volume-safety.ts's own injected-filesystem/docker-facts convention, since this module has no `/dev/tty` of its own to probe. */
  hasControllingTerminal: boolean;
  /** Absolute path to $environment_file as evaluated at this call site (install.sh:1034-1035, under the staging directory — install.sh:1041 invokes "$staging_dir/scripts/configure.sh"). */
  environmentFile: string;
  /** Absolute path to $secrets_directory at the same staging-area basis. */
  secretsDirectory: string;
  /**
   * Absolute path to the *target's* `.env-orbit`, used only for guarantee
   * #30's precondition guard (install.sh:1034-1035: `[[ ! -e
   * "$environment_file" ... ]]`) — install.sh's `$environment_file` is the
   * plain relative path `.env-orbit`, evaluated against the target
   * directory it has already `cd`'d into, never the staging copy `-init`
   * writes into. `environmentFile` above is deliberately kept separate:
   * it's the staging-area basis every later step in this function stages
   * *into*, which is always empty at call time and so could never itself
   * carry the pre-existing-deployment signal this guard exists to catch
   * (issue #383).
   */
  targetEnvironmentFile: string;
  /** Absolute path to the *target's* `.orbit-secrets`, the guard-only counterpart to `targetEnvironmentFile` above. */
  targetSecretsDirectory: string;
  /** Path to configure.sh as install.sh invokes it here (install.sh:1041,1043,1045,1050,1054,1059: "$staging_dir/scripts/configure.sh"). */
  configureScript: string;
  orbitImage: string;
  profileChange: boolean;
  selectedProfile: string;
  selectedModel: string | undefined;
}

export type StageGuidedInstallConfigurationOutcome =
  | { status: "skipped" }
  | { status: "cancelled" }
  | { status: "failed"; reason: "configuration-failure"; action: "retry"; message: string }
  | { status: "staged"; readiness: string };

function configurationFailure(message: string): StageGuidedInstallConfigurationOutcome {
  return { status: "failed", reason: "configuration-failure", action: "retry", message };
}

/**
 * stage_guided_install_configuration (install.sh:1031-1077). Guarantee #30:
 * only activates for a fresh, wizard-mode install with no pre-existing
 * `.env-orbit`/`.orbit-secrets` (not even as a symlink); guarantee #31:
 * every step runs against the staged copy and every failure message states
 * "the target remains unchanged"; guarantee #32: a final "apply" choice is
 * required before the caller may treat the result as staged/committable —
 * "cancel" (or any non-"apply" outcome from the injected confirmApply
 * adapter) aborts with nothing applied.
 */
export async function stageGuidedInstallConfiguration(
  context: StageGuidedInstallConfigurationContext,
  adapter: GuidedConfigurationAdapter,
  answers: MachinePromptAnswerProvider,
): Promise<StageGuidedInstallConfigurationOutcome> {
  if (context.installerAction !== "install" || context.plainMode) return { status: "skipped" };
  // Guarantee #30 (issue #383): tested against the *target's* .env-orbit/
  // .orbit-secrets, matching install.sh's own `$environment_file`/
  // `$secrets_directory` globals — never the empty staging-area paths this
  // function stages into, which would never let this guard fire at all.
  if (pathExists(context.targetEnvironmentFile) || pathExists(context.targetSecretsDirectory)) return { status: "skipped" };
  if (!context.hasControllingTerminal) return { status: "skipped" };

  const init = await adapter.runInit(context.configureScript, context.orbitImage, answers);
  if (!init.ok) {
    return configurationFailure("Guided configuration was cancelled or invalid; the target remains unchanged.");
  }

  const secretGeneration = adapter.runDefault(context.configureScript, context.orbitImage);
  if (secretGeneration.status !== 0) {
    return configurationFailure("Secret generation failed; the target remains unchanged.");
  }

  const oidcSecret = await adapter.runSetOidcSecret(context.configureScript, answers);
  if (!oidcSecret.ok) {
    return configurationFailure("OIDC client secret collection was cancelled or invalid; the target remains unchanged.");
  }

  if (context.profileChange) {
    const profileResult = adapter.runSetDeploymentProfile(
      context.configureScript,
      context.orbitImage,
      context.selectedProfile,
      deploymentProfileModel(context.selectedProfile, context.selectedModel),
    );
    if (profileResult.status !== 0) {
      return configurationFailure("Deployment profile configuration failed; the target remains unchanged.");
    }
  }

  const check = adapter.runCheck(context.configureScript);
  if (check.status !== 0) {
    return configurationFailure("Guided configuration is incomplete; the target remains unchanged.");
  }
  const readiness = stripTrailingNewlines(check.stdout);
  if (readiness === "") {
    return configurationFailure("Guided configuration did not return a readiness summary; the target remains unchanged.");
  }

  const choice = await adapter.confirmApply({ selectedProfile: context.selectedProfile });
  if (choice !== "apply") return { status: "cancelled" };

  return { status: "staged", readiness };
}

/** Facts prepare_configuration decides from — install.sh's own globals at the call site (install.sh:947-1008). */
export interface PrepareConfigurationContext {
  /** Absolute path to $environment_file (install.sh:956-959,972-975 — guarantee #28's re-verification target). */
  environmentFile: string;
  /** Absolute path to $secrets_directory (same guarantee #28 re-verification). */
  secretsDirectory: string;
  /** Path to configure.sh as install.sh invokes it here (install.sh:953,962,966,978,984,988,990,1000: bare "scripts/configure.sh" — the target's own tree, not a staging copy). */
  configureScript: string;
  orbitImage: string;
  /** install.sh's has_controlling_terminal() (install.sh:981) — see StageGuidedInstallConfigurationContext's own doc for why this is an injected fact. */
  hasControllingTerminal: boolean;
  profileChange: boolean;
  selectedProfile: string;
  selectedModel: string | undefined;
}

export type PrepareConfigurationOutcome =
  | { status: "ready" }
  | { status: "failed"; message: string; guidance?: string[] };

function failed(message: string): PrepareConfigurationOutcome {
  return { status: "failed", message };
}

/**
 * prepare_configuration (install.sh:947-1008). Guarantee #24: in a
 * non-interactive context with required fields still missing, refuses and
 * prints install.sh's exact remediation guidance rather than guessing,
 * auto-filling, or silently skipping required secrets. Guarantee #28: after
 * every configure.sh invocation that mutates configuration (the initial
 * bare call and any deployment-profile change), `.env-orbit` and
 * `.orbit-secrets` are re-verified as a regular non-symlink file and a real
 * non-symlink directory respectively before continuing — even the
 * installer's own trusted configuration step is re-validated rather than
 * assumed correct.
 */
export async function prepareConfiguration(
  context: PrepareConfigurationContext,
  adapter: GuidedConfigurationAdapter,
  answers: MachinePromptAnswerProvider,
): Promise<PrepareConfigurationOutcome> {
  const initial = adapter.runDefault(context.configureScript, context.orbitImage);
  if (initial.status !== 0) {
    return failed("Configuration failed; restoring the previous deployment.");
  }
  if (!isRegularNonSymlinkFile(context.environmentFile)) {
    return failed(`Configuration did not leave a regular, non-symlink ${context.environmentFile}.`);
  }
  if (!isRealNonSymlinkDirectory(context.secretsDirectory)) {
    return failed(`Configuration did not leave a real, non-symlink ${context.secretsDirectory} directory.`);
  }

  if (context.profileChange) {
    const profileResult = adapter.runSetDeploymentProfile(
      context.configureScript,
      context.orbitImage,
      context.selectedProfile,
      deploymentProfileModel(context.selectedProfile, context.selectedModel),
    );
    if (profileResult.status !== 0) {
      return failed("Deployment profile configuration failed; restoring the previous deployment.");
    }
    if (!isRegularNonSymlinkFile(context.environmentFile)) {
      return failed(`Configuration did not leave a regular, non-symlink ${context.environmentFile}.`);
    }
    if (!isRealNonSymlinkDirectory(context.secretsDirectory)) {
      return failed(`Configuration did not leave a real, non-symlink ${context.secretsDirectory} directory.`);
    }
  }

  let check = adapter.runCheck(context.configureScript);
  if (check.status !== 0) {
    const missing = missingRequiredFields(check.stdout);
    if (missing.length > 0 && context.hasControllingTerminal) {
      const guidedMissing = missingGuidedFields(check.stdout);
      if (guidedMissing.length > 0) {
        const init = await adapter.runInit(context.configureScript, context.orbitImage, answers);
        if (!init.ok) {
          return failed("Guided configuration was cancelled or invalid; restoring the previous deployment.");
        }
      }
      // install.sh:988 ignores a non-zero status from this re-check
      // (`|| true`) and only inspects its stdout.
      const recheck = adapter.runCheck(context.configureScript);
      if (isFieldMissing(recheck.stdout, "OIDC_CLIENT_SECRET")) {
        const oidcSecret = await adapter.runSetOidcSecret(context.configureScript, answers);
        if (!oidcSecret.ok) {
          return failed("OIDC client secret collection was cancelled or invalid; restoring the previous deployment.");
        }
      }
    } else if (missing.length > 0) {
      return {
        status: "failed",
        message: "Required configuration fields require attention; refusing to start Compose.",
        guidance: noninteractiveConfigurationGuidance(missing),
      };
    }
  }

  check = adapter.runCheck(context.configureScript);
  if (check.status !== 0) {
    let missing = missingConfigurationFields(check.stdout);
    if (missing.length === 0) missing = REQUIRED_FIELDS;
    return failed(`Configuration fields require attention (${missing.join(" ")}); refusing to start Compose.`);
  }

  return { status: "ready" };
}

// Re-exported for tests that need to assert on raw facts without duplicating
// the predicate logic above — mirrors install-transaction.ts's and
// target-identity.ts's own `internal` export.
export const internal = {
  pathExists,
  isRegularNonSymlinkFile,
  isRealNonSymlinkDirectory,
  isFieldMissing,
};
