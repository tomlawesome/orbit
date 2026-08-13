// The configuration.sh --migrate --transaction handoff (issue #295 slice 3),
// ported from scripts/install.sh's `run_configuration_migration`
// (install.sh:1010-1029) and its `--preflight` companion call
// (install.sh:1441-1448). Guarantee numbers below cite
// docs/installer-guarantees.md, Part 1 / install.sh (this file's own
// numbering) unless marked "configuration.sh #N", which cites that script's
// own list in the same document.
//
// Unlike src/lib/install-transaction.ts (slice 1), scripts/configuration.sh
// already has its own standalone, independently-tested --preflight and
// --migrate --transaction entry points. This module does not reimplement
// migrate_file's atomic-write/rollback-backup/provenance logic in
// TypeScript — that would duplicate a contract configuration.sh already
// proves (configuration.sh #10-25), for no safety benefit and real drift
// risk. Instead it ports install.sh's own decision logic *around* the
// handoff: exactly which arguments to pass, and which of configuration.sh's
// two known-good stdout strings are accepted as success (#29) — anything
// else, including a plausible-looking but different string, is treated as
// failure. The subprocess call itself is a caller-supplied adapter with no
// shipped production implementation ("handoff", not port — the same
// non-goal src/lib/database-volume-safety.ts's docker adapters established
// for slice 2), so PATH-shim tests can drive the exact argv this module
// builds against the real, unmodified script.

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
  /** bash <configurationScript> --preflight --file <environmentFile> (install.sh:1444). */
  runPreflight(configurationScript: string, environmentFile: string): ConfigurationScriptResult;
  /** bash <configurationScript> --migrate --transaction --file <environmentFile> --orbit-image <orbitImage> --applied-version <appliedVersion> --compose-project-name <composeProjectName> --applied-digest <appliedDigest> (install.sh:1013-1018). */
  runMigrate(configurationScript: string, target: ConfigurationMigrationTarget): ConfigurationScriptResult;
}

/** Exact argv `configuration.sh --preflight` is invoked with (install.sh:1444). */
export function buildPreflightArgv(environmentFile: string): string[] {
  return ["--preflight", "--file", environmentFile];
}

/** Exact argv `configuration.sh --migrate --transaction` is invoked with, in install.sh's own order (install.sh:1013-1018). */
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

// The only two output prefixes migrate_file ever prints on success
// (configuration.sh:216,271) — configuration.sh #18's idempotent "already
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
