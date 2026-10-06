import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { acquireDeployLock } from "./deploy-lock";
import { ENV_ORBIT_SCHEMA_VERSION, parseEnvOrbitContent, type EnvOrbitFailureCode } from "./env-orbit-file";
import { applyHostOwnership } from "./host-ownership";

// The .env-orbit configuration contract's preflight and migration: the
// TypeScript port of the retired scripts/configuration.sh (#1210 build note
// D8), guarantees "configuration.sh #1-26" in docs/installer-guarantees.md.
// `orbit configure --preflight` / `orbit configure --migrate` (src/cli/
// orbit.ts) expose it with configuration.sh's own arguments, exit codes,
// stdout lines and stderr codes; src/lib/__fixtures__/configuration-
// migration/matrix.json holds what the bash produced, and
// configuration-migration.parity.test.ts compares this port against it.
//
// The second half of the file is install's decision logic around the
// hand-off (issue #295 slice 3): which arguments to pass, and which two
// success strings are accepted.
//
// Patterns: atomic write via a same-directory temporary file and rename;
// rollback copy beside the file for a standalone migration; the one deploy
// lock (src/lib/deploy-lock.ts) beside the file.

export const CONFIGURATION_ROLLBACK_SUFFIX = ".orbit-config.rollback";

export type ConfigurationFailureCode =
  | EnvOrbitFailureCode
  | "configuration_migration"
  | "configuration_provenance_required"
  | "configuration_project_mismatch"
  | "configuration_project_required";

/** One run's observable result, in configuration.sh's own terms: exit status, stdout lines, and the stderr code on failure. */
export interface ConfigurationCommandResult {
  status: number;
  stdout: string;
  /** The single failure code configuration.sh printed on stderr (empty on success). */
  stderr: string;
}

function failure(code: ConfigurationFailureCode, stdout = ""): ConfigurationCommandResult {
  return { status: 1, stdout, stderr: `${code}\n` };
}

const DEPRECATED_SECRET_KEYS = new Set([
  "OIDC_CLIENT_SECRET",
  "SESSION_SECRET",
  "DOCUMENT_KEK",
  "POSTGRES_PASSWORD",
  "VAPID_PRIVATE_KEY",
  "SMTP_PASSWORD",
  "DATABASE_URL",
  "SMTP_URL",
]);

const isValidAppliedVersion = (value: string): boolean => /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value);
const isValidAppliedDigest = (value: string): boolean => /^sha256:[0-9a-f]{64}$/.test(value);
const isValidImmutableImage = (value: string): boolean => /^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/.test(value);
const isValidComposeProjectName = (value: string): boolean => /^[a-z0-9][a-z0-9_-]*$/.test(value);

interface ParsedConfiguration {
  raw: Buffer;
  content: string;
  keys: string[];
  values: Record<string, string>;
  schemaPresent: boolean;
}

type ParseOutcome = { ok: true; parsed: ParsedConfiguration } | { ok: false; result: ConfigurationCommandResult };

/**
 * check_file_safety + parse_file: a regular, non-symlink, mode-600 file,
 * read through the one O_NOFOLLOW descriptor its safety was checked on, then
 * the shared .env-orbit grammar plus the direct/_FILE secret-pair refusal.
 * An unknown or removed key also prints configuration.sh's one-word
 * classification line on stdout before the code (never the key itself).
 */
function readConfiguration(file: string): ParseOutcome {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { ok: false, result: failure("configuration_syntax") };
  }
  let raw: Buffer;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) return { ok: false, result: failure("configuration_syntax") };
    raw = readFileSync(descriptor);
  } catch {
    return { ok: false, result: failure("configuration_syntax") };
  } finally {
    closeSync(descriptor);
  }
  const content = raw.toString("utf8");
  const parsed = parseEnvOrbitContent(content, { refuseSecretConflicts: true });
  if (!parsed.ok) {
    const stdout =
      parsed.code === "configuration_removed_key"
        ? "removed_incompatible configuration\n"
        : parsed.code === "configuration_unknown_key"
          ? "unknown configuration\n"
          : "";
    return { ok: false, result: failure(parsed.code, stdout) };
  }
  const values = parsed.record as Record<string, string>;
  return { ok: true, parsed: { raw, content, keys: Object.keys(values), values, schemaPresent: parsed.schemaPresent } };
}

/** report_classification: one category line per key, never a value. */
function classificationLines(parsed: ParsedConfiguration): string {
  const lines = parsed.keys.map((key) => `${DEPRECATED_SECRET_KEYS.has(key) ? "deprecated_supported" : "current"} ${key}`);
  if (!parsed.schemaPresent) lines.push("safely_migratable ORBIT_CONFIG_SCHEMA_VERSION");
  if (!("ORBIT_CONFIG_APPLIED_VERSION" in parsed.values) && !("ORBIT_CONFIG_APPLIED_DIGEST" in parsed.values)) {
    lines.push("safely_migratable ORBIT_CONFIG_APPLIED_VERSION", "safely_migratable ORBIT_CONFIG_APPLIED_DIGEST");
  }
  if (!("COMPOSE_PROJECT_NAME" in parsed.values)) lines.push("safely_migratable COMPOSE_PROJECT_NAME");
  return lines.map((line) => `${line}\n`).join("");
}

/** configuration.sh --preflight (and --check): validates without writing anything, and classifies every key. */
export function preflightEnvironmentFile(file: string): ConfigurationCommandResult {
  const outcome = readConfiguration(file);
  if (!outcome.ok) return outcome.result;
  return { status: 0, stdout: classificationLines(outcome.parsed), stderr: "" };
}

export interface MigrateEnvironmentFileOptions {
  /** install's own file transaction owns rollback: no adjacent .orbit-config.rollback copy is made. */
  transaction?: boolean;
  orbitImage?: string;
  appliedVersion?: string;
  appliedDigest?: string;
  composeProjectName?: string;
  /** Test seam: the final rename, so a failure there can be simulated (the retired suite faked `mv`). */
  rename?: (from: string, to: string) => void;
}

const MANAGED_ORDER = [
  "ORBIT_IMAGE",
  "ORBIT_CONFIG_SCHEMA_VERSION",
  "ORBIT_CONFIG_APPLIED_VERSION",
  "ORBIT_CONFIG_APPLIED_DIGEST",
  "COMPOSE_PROJECT_NAME",
] as const;

// The scratch file of a migration in flight, removed on SIGINT/SIGTERM as
// well as on every ordinary failure (#1151 O1-R4).
let migrationScratch: { path: string; releaseLock: () => void } | undefined;
let signalCleanupInstalled = false;

function installSignalCleanup(): void {
  if (signalCleanupInstalled) return;
  signalCleanupInstalled = true;
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.on(signal, () => {
      if (!migrationScratch) {
        process.exit(code);
      }
      try {
        rmSync(migrationScratch.path, { force: true });
      } catch {
        /* best effort */
      }
      migrationScratch.releaseLock();
      process.exit(code);
    });
  }
}

/** Bash `while IFS= read -r line`: lines split on \n, a final unterminated line kept, no empty line after a final newline. */
function readLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

/**
 * migrate_file: stamps the schema, the applied image/version/digest and the
 * Compose project name into the file, preserving every other byte of every
 * other line (comments, CRLF, a missing final newline gains one). An
 * already-current file is reported and left untouched. Outside an install
 * transaction the pre-migration file is first copied to
 * `<file>.orbit-config.rollback` (mode 600); a leftover copy byte-identical
 * to the file is an interrupted earlier run and is replaced, any other
 * leftover refuses (#1151 O1-R5). Holds the deploy lock throughout.
 */
export function migrateEnvironmentFile(file: string, options: MigrateEnvironmentFileOptions = {}): ConfigurationCommandResult {
  let releaseLock: () => void;
  try {
    releaseLock = acquireDeployLock(dirname(file), "configuration migration", (message) => new Error(message));
  } catch {
    return failure("configuration_migration");
  }
  try {
    return migrateLocked(file, options, releaseLock);
  } finally {
    releaseLock();
  }
}

function migrateLocked(file: string, options: MigrateEnvironmentFileOptions, releaseLock: () => void): ConfigurationCommandResult {
  const outcome = readConfiguration(file);
  if (!outcome.ok) return outcome.result;
  const { parsed } = outcome;
  const current = parsed.values;
  const appliedVersionPresent = "ORBIT_CONFIG_APPLIED_VERSION" in current;
  const appliedDigestPresent = "ORBIT_CONFIG_APPLIED_DIGEST" in current;
  const composeProjectPresent = "COMPOSE_PROJECT_NAME" in current;
  const currentImage = current.ORBIT_IMAGE ?? "";
  const currentVersion = current.ORBIT_CONFIG_APPLIED_VERSION ?? "";
  const currentDigest = current.ORBIT_CONFIG_APPLIED_DIGEST ?? "";
  const currentProject = current.COMPOSE_PROJECT_NAME ?? "";

  const targetImage = options.orbitImage ?? "";
  const targetVersion = options.appliedVersion ?? "";
  const targetDigest = options.appliedDigest ?? "";
  const targetProject = options.composeProjectName ?? "";

  let desiredImage: string;
  let desiredVersion: string;
  let desiredDigest: string;
  if (targetImage || targetVersion || targetDigest) {
    if (
      !targetImage ||
      !targetVersion ||
      !targetDigest ||
      !isValidImmutableImage(targetImage) ||
      !isValidAppliedVersion(targetVersion) ||
      !isValidAppliedDigest(targetDigest) ||
      targetImage.split("@").pop() !== targetDigest
    ) {
      return failure("configuration_provenance");
    }
    desiredImage = targetImage;
    desiredVersion = targetVersion;
    desiredDigest = targetDigest;
  } else {
    if (!parsed.schemaPresent || !appliedVersionPresent) return failure("configuration_provenance_required");
    desiredImage = currentImage;
    desiredVersion = currentVersion;
    desiredDigest = currentDigest;
  }

  if (targetProject && !isValidComposeProjectName(targetProject)) return failure("configuration_project");
  let desiredProject: string;
  if (composeProjectPresent) {
    if (targetProject && currentProject !== targetProject) return failure("configuration_project_mismatch");
    desiredProject = currentProject;
  } else {
    if (!targetProject) return failure("configuration_project_required");
    desiredProject = targetProject;
  }

  if (
    parsed.schemaPresent &&
    appliedVersionPresent &&
    currentImage === desiredImage &&
    currentVersion === desiredVersion &&
    currentDigest === desiredDigest &&
    composeProjectPresent &&
    currentProject === desiredProject
  ) {
    return {
      status: 0,
      stdout: `Orbit configuration: already current schema v1 version ${desiredVersion} digest ${desiredDigest}\n`,
      stderr: "",
    };
  }

  const priorSchema = parsed.schemaPresent ? "v1" : "v0";
  const priorVersion = appliedVersionPresent ? currentVersion : "legacy/unknown";
  const priorDigest = appliedDigestPresent ? currentDigest : "legacy/unknown";
  const managed: Record<(typeof MANAGED_ORDER)[number], string> = {
    ORBIT_IMAGE: desiredImage,
    ORBIT_CONFIG_SCHEMA_VERSION: String(ENV_ORBIT_SCHEMA_VERSION),
    ORBIT_CONFIG_APPLIED_VERSION: desiredVersion,
    ORBIT_CONFIG_APPLIED_DIGEST: desiredDigest,
    COMPOSE_PROJECT_NAME: desiredProject,
  };

  const backup = `${file}${CONFIGURATION_ROLLBACK_SUFFIX}`;
  if (!options.transaction) {
    const leftover = lstatSync(backup, { throwIfNoEntry: false });
    if (leftover) {
      let identical = false;
      if (!leftover.isSymbolicLink()) {
        try {
          identical = readFileSync(backup).equals(parsed.raw);
        } catch {
          identical = false;
        }
      }
      if (!identical) return failure("configuration_migration");
      try {
        rmSync(backup, { force: true });
      } catch {
        return failure("configuration_migration");
      }
    }
    try {
      copyFileSync(file, backup, constants.COPYFILE_EXCL);
    } catch {
      return failure("configuration_migration");
    }
    try {
      chmodSync(backup, 0o600);
      applyHostOwnership(backup);
    } catch {
      rmSync(backup, { force: true });
      return failure("configuration_migration");
    }
  }

  const newline = parsed.content.includes("\r") ? "\r\n" : "\n";
  const written = new Set<string>();
  let output = "";
  for (const line of readLines(parsed.content)) {
    const withoutCr = line.endsWith("\r") ? line.slice(0, -1) : line;
    const key = MANAGED_ORDER.find((candidate) => withoutCr.startsWith(`${candidate}=`) || withoutCr === `# ${candidate}=`);
    if (key) {
      output += `${key}=${managed[key]}${newline}`;
      written.add(key);
    } else {
      output += `${line}\n`;
    }
  }
  for (const key of MANAGED_ORDER) {
    if (!written.has(key)) output += `${key}=${managed[key]}${newline}`;
  }

  const scratch = join(dirname(file), `${basename(file)}.migrating.${randomBytes(6).toString("hex")}`);
  installSignalCleanup();
  migrationScratch = { path: scratch, releaseLock };
  try {
    writeFileSync(scratch, output, { mode: 0o600, flag: "wx" });
    chmodSync(scratch, 0o600);
    applyHostOwnership(scratch);
    (options.rename ?? renameSync)(scratch, file);
  } catch {
    try {
      rmSync(scratch, { force: true });
    } catch {
      /* best effort */
    }
    if (!options.transaction) {
      try {
        copyFileSync(backup, file);
      } catch {
        /* the rollback copy is still there for the operator */
      }
    }
    return failure("configuration_migration");
  } finally {
    migrationScratch = undefined;
  }

  return {
    status: 0,
    stdout: `Orbit configuration: migrated from schema ${priorSchema} version ${priorVersion} digest ${priorDigest} to schema v1 version ${desiredVersion} digest ${desiredDigest}\n`,
    stderr: "",
  };
}

/**
 * configuration.sh's command line, unchanged: `--check|--preflight|--migrate
 * [--transaction] [--file F] [--orbit-image I] [--applied-version V]
 * [--applied-digest D] [--compose-project-name P]`, flags in any order, the
 * last action winning. A flag missing its value or an unknown flag is exit 2
 * with configuration_usage; --transaction without --migrate is
 * configuration_migration. `orbit configure --preflight|--migrate` runs this.
 */
export function runConfigurationCommand(args: readonly string[], defaultFile: string): ConfigurationCommandResult {
  const usage: ConfigurationCommandResult = { status: 2, stdout: "", stderr: "configuration_usage\n" };
  let action: "check" | "migrate" = "check";
  let transaction = false;
  let file = defaultFile;
  const options: MigrateEnvironmentFileOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const valueFlags: Record<string, (value: string) => void> = {
      "--file": (value) => {
        file = value === "" ? "" : resolve(value);
      },
      "--orbit-image": (value) => {
        options.orbitImage = value;
      },
      "--applied-version": (value) => {
        options.appliedVersion = value;
      },
      "--applied-digest": (value) => {
        options.appliedDigest = value;
      },
      "--compose-project-name": (value) => {
        options.composeProjectName = value;
      },
    };
    if (flag === "--check" || flag === "--preflight") {
      action = "check";
    } else if (flag === "--migrate") {
      action = "migrate";
    } else if (flag === "--transaction") {
      transaction = true;
    } else if (Object.hasOwn(valueFlags, flag)) {
      if (index + 1 >= args.length) return usage;
      index += 1;
      valueFlags[flag](args[index]);
    } else {
      return usage;
    }
  }
  if (file === "") return failure("configuration_syntax");
  if (transaction && action !== "migrate") return failure("configuration_migration");
  return action === "migrate" ? migrateEnvironmentFile(file, { ...options, transaction }) : preflightEnvironmentFile(file);
}

// ---------------------------------------------------------------------------
// install's hand-off (issue #295 slice 3), unchanged in meaning: the
// adapter now runs the port above rather than a bash subprocess.

export interface ConfigurationMigrationTarget {
  /** Path to the .env-orbit file being migrated (install.sh's $environment_file). */
  environmentFile: string;
  /** The already digest-verified resolved image reference (install.sh's $resolved_reference). */
  orbitImage: string;
  /** The image's own recorded semantic version (install.sh's $image_version). */
  appliedVersion: string;
  /** The image's own recorded digest (install.sh's $applied_digest). */
  appliedDigest: string;
  /** The already-derived Compose project name (src/lib/target-identity.ts's deriveComposeProjectName — this is how this module "wires onto slice 2's validated identity"). */
  composeProjectName: string;
}

export interface ConfigurationScriptResult {
  status: number;
  stdout: string;
}

export interface ConfigurationScriptAdapter {
  /** `--preflight --file <environmentFile>` (install.sh:1444). */
  runPreflight(configurationScript: string, environmentFile: string): ConfigurationScriptResult;
  /** `--migrate --transaction --file <environmentFile> --orbit-image <orbitImage> --applied-version <appliedVersion> --compose-project-name <composeProjectName> --applied-digest <appliedDigest>` (install.sh:1013-1018). */
  runMigrate(configurationScript: string, target: ConfigurationMigrationTarget): ConfigurationScriptResult;
}

/** Exact argv the preflight is invoked with (install.sh:1444). */
export function buildPreflightArgv(environmentFile: string): string[] {
  return ["--preflight", "--file", environmentFile];
}

/** Exact argv the transactional migration is invoked with, in install.sh's own order (install.sh:1013-1018). */
export function buildMigrateArgv(target: ConfigurationMigrationTarget): string[] {
  return [
    "--migrate",
    "--transaction",
    "--file",
    target.environmentFile,
    "--orbit-image",
    target.orbitImage,
    "--applied-version",
    target.appliedVersion,
    "--compose-project-name",
    target.composeProjectName,
    "--applied-digest",
    target.appliedDigest,
  ];
}

export type ConfigurationPreflightOutcome = { ok: true } | { ok: false; message: string };

/**
 * install.sh:1443-1445: run only for an existing `.env-orbit`, before any
 * fetched asset or configure.sh mutation — a non-zero preflight fails
 * closed with install.sh's exact message. Part of guarantee #50: preflight
 * and migrate both happen before any asset is installed, and both remain
 * covered by the outer file transaction (src/lib/install-transaction.ts) —
 * this is how this module "wires onto slice 1's transaction": the caller is
 * expected to hold an active InstallTransaction across both calls so a
 * preflight or migration failure rolls back cleanly.
 */
export function runConfigurationPreflight(
  configurationScript: string,
  environmentFile: string,
  adapter: ConfigurationScriptAdapter,
): ConfigurationPreflightOutcome {
  const result = adapter.runPreflight(configurationScript, environmentFile);
  if (result.status !== 0) {
    return { ok: false, message: "Configuration preflight failed; restoring the previous deployment." };
  }
  return { ok: true };
}

export type ConfigurationMigrationOutcome = { ok: true; message: string } | { ok: false; message: string };

// The only two output prefixes migrateEnvironmentFile ever prints on success — configuration.sh #18's idempotent "already
// current" message, and its successful-migration message.
const ALREADY_CURRENT_PREFIX = "Orbit configuration: already current schema v1 version ";
const MIGRATED_PREFIX = "Orbit configuration: migrated from schema ";

/**
 * run_configuration_migration (install.sh:1010-1029, guarantee #29):
 * invokes the migration only with the already digest-verified resolved
 * image reference and derived project name, and accepts only the two
 * known-good output strings above — any other output, including a
 * plausible-looking but unexpected result, is treated as failure and fails
 * closed with install.sh's exact message. Bash's `migration_output="$(...)"`
 * command substitution strips all trailing newlines before the case match;
 * this port does the same to the adapter's raw stdout before classifying.
 */
export function runConfigurationMigration(
  configurationScript: string,
  target: ConfigurationMigrationTarget,
  adapter: ConfigurationScriptAdapter,
): ConfigurationMigrationOutcome {
  const result = adapter.runMigrate(configurationScript, target);
  if (result.status !== 0) {
    return { ok: false, message: "Configuration migration failed; restoring the previous deployment." };
  }
  const output = result.stdout.replace(/\n+$/, "");
  if (output.startsWith(ALREADY_CURRENT_PREFIX) || output.startsWith(MIGRATED_PREFIX)) {
    return { ok: true, message: output };
  }
  return {
    ok: false,
    message: "Configuration migration returned an unexpected result; restoring the previous deployment.",
  };
}
