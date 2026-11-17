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
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { acquireDeployLock } from "./deploy-lock";
import { ENV_ORBIT_SCHEMA_VERSION, decodeUtf8Strict, parseEnvOrbitContent, type EnvOrbitFailureCode } from "./env-orbit-file";
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
// rollback copy beside the file for a standalone migration, kept only until
// the new file is confirmed (#1834); the one deploy lock
// (src/lib/deploy-lock.ts) beside the file.

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
  /** The single failure code configuration.sh printed on stderr (on success empty, or one line naming a kept leftover copy, #1834). */
  stderr: string;
  /** The setting an unknown-key or secret-conflict refusal is about; never printed, so the stdout/stderr contract is unchanged. */
  key?: string;
}

function failure(code: ConfigurationFailureCode, stdout = "", key?: string): ConfigurationCommandResult {
  return key === undefined ? { status: 1, stdout, stderr: `${code}\n` } : { status: 1, stdout, stderr: `${code}\n`, key };
}

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
 * An unknown key also prints configuration.sh's one-word classification
 * line on stdout before the code (never the key itself).
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
  return parseConfigurationBytes(raw);
}

/** parse_file on bytes already read: the strict UTF-8 decode, the shared grammar and the secret-pair refusal. */
function parseConfigurationBytes(raw: Buffer): ParseOutcome {
  // Never decode lossily: the file is rebuilt from this string, so a replaced
  // byte would silently change a value on disk.
  const content = decodeUtf8Strict(raw);
  if (content === undefined) return { ok: false, result: failure("configuration_syntax", "not_utf8 configuration\n") };
  const parsed = parseEnvOrbitContent(content, { refuseSecretConflicts: true });
  if (!parsed.ok) {
    const stdout = parsed.code === "configuration_unknown_key" ? "unknown configuration\n" : "";
    return { ok: false, result: failure(parsed.code, stdout, parsed.key) };
  }
  const values = parsed.record as Record<string, string>;
  return { ok: true, parsed: { raw, content, keys: Object.keys(values), values, schemaPresent: parsed.schemaPresent } };
}

/** report_classification: one category line per key, never a value. */
function classificationLines(parsed: ParsedConfiguration): string {
  const lines = parsed.keys.map((key) => `current ${key}`);
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

type ManagedValues = Record<(typeof MANAGED_ORDER)[number], string>;

/**
 * The migrated text for a parsed file and its five managed values: each
 * managed key written once, at its first line (#1847), the rest appended in
 * MANAGED_ORDER, every other line kept byte for byte. Pure, so a migration can
 * be replayed to prove where a leftover copy came from (#1877).
 */
function buildMigratedContent(parsed: ParsedConfiguration, managed: ManagedValues): string {
  const newline = parsed.content.includes("\r") ? "\r\n" : "\n";
  const written = new Set<string>();
  let output = "";
  for (const line of readLines(parsed.content)) {
    const withoutCr = line.endsWith("\r") ? line.slice(0, -1) : line;
    const key = MANAGED_ORDER.find((candidate) => withoutCr.startsWith(`${candidate}=`) || withoutCr === `# ${candidate}=`);
    if (key) {
      if (written.has(key)) continue;
      output += `${key}=${managed[key]}${newline}`;
      written.add(key);
    } else {
      output += `${line}\n`;
    }
  }
  for (const key of MANAGED_ORDER) {
    if (!written.has(key)) output += `${key}=${managed[key]}${newline}`;
  }
  return output;
}

/** A leftover copy larger than this is never read whole, replayed or deleted by the replay rule (#1877). */
const LEFTOVER_COPY_REPLAY_LIMIT = 1024 * 1024;

/** The device and inode a leftover copy was checked on, so only that same file is ever removed. */
interface LeftoverIdentity {
  dev: number;
  ino: number;
}

/**
 * #1877 roll-forward recovery after the commit point: true only when the
 * copy's bytes pass the same strict parse as the file, and replaying the
 * migration on them with the current file's five managed values gives the
 * current file byte for byte. Such a copy is the pre-migration file of a run
 * that got past its rename. A parse error is not proof.
 */
function leftoverCopyIsFinishedMigration(raw: Buffer, current: ParsedConfiguration): boolean {
  const managed = {} as ManagedValues;
  for (const key of MANAGED_ORDER) {
    const value = current.values[key];
    if (value === undefined) return false;
    managed[key] = value;
  }
  const outcome = parseConfigurationBytes(raw);
  if (!outcome.ok) return false;
  return Buffer.from(buildMigratedContent(outcome.parsed, managed), "utf8").equals(current.raw);
}

/**
 * Whether a leftover copy may be removed, and the file it was checked on.
 * Read through one O_NOFOLLOW descriptor, it must be a regular file (never a
 * symlink) and either byte-identical to the current file (#1151 O1-R5) or
 * proven by the #1877 replay. The read is bounded: a copy no larger than the
 * current file can be compared as identical, and only a copy of at most
 * 1 MiB is replayed. Any read error, or a larger copy, is not proof.
 */
function provenLeftoverCopy(copy: string, current: ParsedConfiguration): LeftoverIdentity | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(copy, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  let raw: Buffer;
  let identity: LeftoverIdentity;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return undefined;
    if (stat.size > Math.max(LEFTOVER_COPY_REPLAY_LIMIT, current.raw.length)) return undefined;
    identity = { dev: stat.dev, ino: stat.ino };
    raw = Buffer.alloc(stat.size);
    let length = 0;
    while (length < raw.length) {
      const count = readSync(descriptor, raw, length, raw.length - length, null);
      if (count === 0) break;
      length += count;
    }
    raw = raw.subarray(0, length);
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
  if (raw.equals(current.raw)) return identity;
  if (raw.length > LEFTOVER_COPY_REPLAY_LIMIT) return undefined;
  return leftoverCopyIsFinishedMigration(raw, current) ? identity : undefined;
}

/**
 * Removes a proven leftover copy only if the path is still the regular file
 * that was checked (same device and inode); otherwise it is left alone and
 * treated as not proven. Throws if the removal itself fails.
 */
function removeProvenLeftoverCopy(copy: string, identity: LeftoverIdentity): boolean {
  const now = lstatSync(copy, { throwIfNoEntry: false });
  if (!now || !now.isFile() || now.dev !== identity.dev || now.ino !== identity.ino) return false;
  rmSync(copy, { force: true });
  return true;
}

/**
 * migrate_file: stamps the schema, the applied image/version/digest and the
 * Compose project name into the file, preserving every other byte of every
 * other line (comments, CRLF, a missing final newline gains one). An
 * already-current file is reported and left untouched. Outside an install
 * transaction the pre-migration file is first copied to
 * `<file>.orbit-config.rollback` (mode 600); a leftover copy byte-identical
 * to the file is an interrupted earlier run and is replaced (#1151 O1-R5).
 * A differing leftover is finished off by roll-forward recovery (#1877): the
 * rename is the commit point, so a regular-file copy whose replayed migration,
 * with the current file's managed values, equals the file byte for byte is
 * removed and the run carries on; any other leftover refuses. Once the new file is written it is read
 * again under the same strict parse and must carry this run's applied
 * version, digest and Compose project; then the copy is removed. If not, the
 * file is restored from the copy, which is kept, and the run fails with
 * configuration_migration (#1834). Holds the deploy lock throughout.
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
    // #1834: a run killed after its rename, or one whose removal failed,
    // leaves a copy nothing points at. A symlink or a copy not at mode 600
    // refuses. A regular copy byte-identical to the file (which has just
    // passed the strict parse) is dropped, and so is one #1877's replay
    // proves is the pre-migration file of a finished migration. Any other
    // differing copy may be the only good copy Repair's
    // configuration-migration-interrupted class needs, so it is kept and named.
    let stderr = "";
    if (!options.transaction) {
      const leftoverCopy = `${file}${CONFIGURATION_ROLLBACK_SUFFIX}`;
      const stray = lstatSync(leftoverCopy, { throwIfNoEntry: false });
      if (stray) {
        if (!stray.isFile() || (stray.mode & 0o777) !== 0o600) return failure("configuration_migration");
        const identity = provenLeftoverCopy(leftoverCopy, parsed);
        let removed = false;
        if (identity) {
          try {
            removed = removeProvenLeftoverCopy(leftoverCopy, identity);
          } catch {
            return failure("configuration_migration");
          }
        }
        if (!removed) {
          stderr = `Orbit configuration: kept ${leftoverCopy}: it differs from the current file and may be the only copy of the earlier one; remove it once Orbit is working, or run Repair (scripts/repair.sh --check) if it is not.\n`;
        }
      }
    }
    return {
      status: 0,
      stdout: `Orbit configuration: already current schema v1 version ${desiredVersion} digest ${desiredDigest}\n`,
      stderr,
    };
  }

  const priorSchema = parsed.schemaPresent ? "v1" : "v0";
  // A first install's file carries no applied stamp yet.
  const priorVersion = appliedVersionPresent ? currentVersion : "none";
  const priorDigest = appliedDigestPresent ? currentDigest : "none";
  const managed: ManagedValues = {
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
      // #1877: a copy is removed only when it is byte-identical or replaying
      // the migration proves it is the pre-migration file of a run that got
      // past its rename, and only if the path is still that same file;
      // anything else still refuses.
      const identity = provenLeftoverCopy(backup, parsed);
      if (!identity) return failure("configuration_migration");
      let removed: boolean;
      try {
        removed = removeProvenLeftoverCopy(backup, identity);
      } catch {
        return failure("configuration_migration");
      }
      if (!removed) return failure("configuration_migration");
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

  const output = buildMigratedContent(parsed, managed);

  // The `.env-orbit.migrating.*` scratch name is also matched by install.sh rollback_files.
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

  // #1834: confirm the new file while the deploy lock is still held, then
  // drop the copy; a file that is not what this run meant to write is put
  // back from the copy, which stays for the operator.
  if (!options.transaction) {
    const confirmed = readConfiguration(file);
    const ok =
      confirmed.ok &&
      confirmed.parsed.values.ORBIT_CONFIG_APPLIED_VERSION === desiredVersion &&
      confirmed.parsed.values.ORBIT_CONFIG_APPLIED_DIGEST === desiredDigest &&
      confirmed.parsed.values.COMPOSE_PROJECT_NAME === desiredProject;
    if (!ok) {
      restoreFromRollbackCopy(file, backup);
      return failure("configuration_migration");
    }
    try {
      rmSync(backup, { force: true });
    } catch {
      /* a copy left behind is replaced, finished off (#1877) or refused by the next run, never trusted */
    }
  }

  return {
    status: 0,
    stdout: `Orbit configuration: migrated from schema ${priorSchema} version ${priorVersion} digest ${priorDigest} to schema v1 version ${desiredVersion} digest ${desiredDigest}\n`,
    stderr: "",
  };
}

/**
 * Puts the pre-migration file back from the rollback copy the same way it was
 * replaced (stage beside it, mode 600, rename), and keeps the copy at mode
 * 600. On any error the copy is still there for the operator.
 */
function restoreFromRollbackCopy(file: string, backup: string): void {
  const scratch = join(dirname(file), `${basename(file)}.migrating.${randomBytes(6).toString("hex")}`);
  try {
    chmodSync(backup, 0o600);
  } catch {
    /* the copy was made at 600; nothing else changes it */
  }
  try {
    copyFileSync(backup, scratch, constants.COPYFILE_EXCL);
    chmodSync(scratch, 0o600);
    applyHostOwnership(scratch);
    renameSync(scratch, file);
  } catch {
    try {
      rmSync(scratch, { force: true });
    } catch {
      /* best effort */
    }
  }
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
// install's hand-off (issue #295 slice 3). Since #1212 the install engine
// calls the port above in its own process, under the deploy lock its file
// transaction already holds (src/lib/deploy-lock.ts, share()).

export interface ConfigurationMigrationTarget {
  /** Absolute path to the .env-orbit file being migrated. */
  environmentFile: string;
  /** The already digest-verified resolved image reference (install.sh's $resolved_reference). */
  orbitImage: string;
  /** The image's own recorded semantic version. */
  appliedVersion: string;
  /** The image's own recorded digest. */
  appliedDigest: string;
  /** The already-derived Compose project name (src/lib/target-identity.ts's deriveComposeProjectName). */
  composeProjectName: string;
}

/** `--preflight --file <environmentFile>`, as install ran it. */
export function installPreflightCommand(environmentFile: string): ConfigurationCommandResult {
  return preflightEnvironmentFile(environmentFile);
}

/** `--migrate --transaction --file ... --orbit-image ... --applied-version ... --compose-project-name ... --applied-digest ...`, as install ran it. */
export function installMigrateCommand(target: ConfigurationMigrationTarget): ConfigurationCommandResult {
  return migrateEnvironmentFile(target.environmentFile, {
    transaction: true,
    orbitImage: target.orbitImage,
    appliedVersion: target.appliedVersion,
    appliedDigest: target.appliedDigest,
    composeProjectName: target.composeProjectName,
  });
}

export type ConfigurationPreflightOutcome = { ok: true } | { ok: false; message: string };

/**
 * Run only for an existing `.env-orbit`, before any asset or configure step:
 * a failed preflight fails closed with install.sh's exact message. Part of
 * guarantee #50: preflight and migrate both happen inside the install's file
 * transaction (src/lib/install-transaction.ts), so a failure rolls back.
 */
export function runConfigurationPreflight(environmentFile: string): ConfigurationPreflightOutcome {
  const result = installPreflightCommand(environmentFile);
  if (result.status !== 0) return { ok: false, message: preflightFailureMessage(result) };
  return { ok: true };
}

// An undecodable file is reported only as "not_utf8" on stdout, which the
// installer never shows; without naming the encoding an operator whose editor
// saved .env-orbit as cp1252 is rolled back with nothing to say why.
export const NOT_UTF8_FAILURE_MESSAGE =
  ".env-orbit is not valid UTF-8; re-save it as UTF-8 and run the install again (restoring the previous deployment).";

export function isNotUtf8Failure(result: ConfigurationCommandResult): boolean {
  return result.status !== 0 && result.stdout.startsWith("not_utf8");
}

// Names the offending line where the parser knows it: without the key an
// operator whose file carries an unknown setting is rolled back with
// nothing to say which line to fix, and stays blocked.
function preflightFailureMessage(result: ConfigurationCommandResult): string {
  if (isNotUtf8Failure(result)) return NOT_UTF8_FAILURE_MESSAGE;
  const { key } = result;
  if (key !== undefined) {
    switch (result.stderr.trim()) {
      case "configuration_unknown_key":
        return `Configuration preflight failed: .env-orbit has ${key}, which is not an Orbit setting; delete or correct that line and rerun the update.`;
      case "configuration_secret_conflict":
        return `Configuration preflight failed: .env-orbit sets both ${key} and ${key}_FILE; keep only one of them and rerun the update.`;
    }
  }
  return "Configuration preflight failed; restoring the previous deployment.";
}

export type ConfigurationMigrationOutcome = { ok: true; message: string } | { ok: false; message: string };

// The only two output prefixes migrateEnvironmentFile ever prints on success — configuration.sh #18's idempotent "already
// current" message, and its successful-migration message.
const ALREADY_CURRENT_PREFIX = "Orbit configuration: already current schema v1 version ";
const MIGRATED_PREFIX = "Orbit configuration: migrated from schema ";

/**
 * run_configuration_migration (guarantee #29): migrates only with the
 * already digest-verified image reference and derived project name, and
 * accepts only the two known-good output strings above — any other output,
 * even a plausible-looking one, fails closed with install.sh's exact message.
 */
export function runConfigurationMigration(target: ConfigurationMigrationTarget): ConfigurationMigrationOutcome {
  return classifyMigrationResult(installMigrateCommand(target));
}

/** runConfigurationMigration's decision on one migration result. */
export function classifyMigrationResult(result: ConfigurationCommandResult): ConfigurationMigrationOutcome {
  if (isNotUtf8Failure(result)) return { ok: false, message: NOT_UTF8_FAILURE_MESSAGE };
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
