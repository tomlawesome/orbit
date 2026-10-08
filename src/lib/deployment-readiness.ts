import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { type EnvOrbitRecord, type OidcSecretFileFacts, evaluateReadiness } from "./config-contract";
import { CONFIGURATION_ROLLBACK_SUFFIX } from "./configuration-migration";
import { parseEnvOrbitContent } from "./env-orbit-file";

// The value-free readiness report of a deployment directory: what `orbit
// check` prints (configure.sh --check before #1210), and what the install
// engine reads in-process since #1212 instead of running `configure.sh
// --check` (ADR-0014 decision 7, docs/engine-events.md "Configuration
// readiness report (v0)").

export type ReadinessOutcome =
  | { status: "report"; ok: boolean; lines: string[] }
  /** The file is not a regular owner-only file, or does not parse: its configuration_* code. */
  | { status: "refused"; code: string };

function gatherOidcSecretFacts(deployDir: string): OidcSecretFileFacts {
  const secretsDirectory = join(deployDir, ".orbit-secrets");
  const secretFile = join(secretsDirectory, "oidc-client-secret");
  const directoryStat = statSync(secretsDirectory, { throwIfNoEntry: false });
  const directoryLstat = lstatSync(secretsDirectory, { throwIfNoEntry: false });
  const fileLstat = lstatSync(secretFile, { throwIfNoEntry: false });
  return {
    secretsDirectoryExists: directoryStat?.isDirectory() ?? false,
    secretsDirectoryIsSymlink: directoryLstat?.isSymbolicLink() ?? false,
    secretsDirectoryMode: directoryStat ? directoryStat.mode & 0o777 : null,
    secretFileExists: fileLstat !== undefined,
    secretFileIsRegular: fileLstat?.isFile() ?? false,
    secretFileIsSymlink: fileLstat?.isSymbolicLink() ?? false,
    secretFileMode: fileLstat ? fileLstat.mode & 0o777 : null,
    secretFileSize: fileLstat?.size ?? 0,
  };
}

/**
 * Reads `.env-orbit` (or, with `rollback`, the migration's rollback copy
 * beside it; the secrets directory is always the live one). No file at all
 * reports every field missing, as configure.sh --check did.
 */
export function readinessReport(deployDir: string, options: { rollback?: boolean } = {}): ReadinessOutcome {
  const environmentFile = join(deployDir, options.rollback ? `.env-orbit${CONFIGURATION_ROLLBACK_SUFFIX}` : ".env-orbit");
  // Open first with O_NOFOLLOW, then verify and read through the same
  // descriptor: the safety check and the content read cannot be split by a
  // file swap (CodeQL js/file-system-race).
  let descriptor: number | undefined;
  try {
    descriptor = openSync(environmentFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { status: "refused", code: "configuration_syntax" };
  }
  let record: EnvOrbitRecord = {};
  if (descriptor !== undefined) {
    let content: string;
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) return { status: "refused", code: "configuration_syntax" };
      content = readFileSync(descriptor, "utf8");
    } finally {
      closeSync(descriptor);
    }
    const parsed = parseEnvOrbitContent(content);
    if (!parsed.ok) return { status: "refused", code: parsed.code };
    record = parsed.record;
  }
  const report = evaluateReadiness(record, gatherOidcSecretFacts(deployDir));
  return { status: "report", ok: report.ok, lines: report.lines };
}
