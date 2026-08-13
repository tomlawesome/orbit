import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Target and identity validation (issue #295 slice 2), ported from
// scripts/install.sh's `validate_target`, `is_preprovisioned_input`, and
// `derive_compose_project_name` (install.sh:262-304,410-462). Guarantee
// numbers below cite docs/installer-guarantees.md, Part 1 / install.sh, and
// are re-asserted by name in src/lib/target-identity.test.ts.
//
// This module is pure filesystem logic over a caller-supplied target
// directory, mirroring the direct node:fs approach
// src/lib/install-transaction.ts (slice 1) already established: install.sh
// itself makes these decisions with plain `[[ -f/-d/-L ]]` and `stat`
// checks against its own cwd, never Docker or the network, so there is no
// injected-facts boundary to draw here the way config-contract.ts's OIDC
// secret facts do for something genuinely async/environment-dependent.
// `deriveComposeProjectName`'s two external inputs that are *not*
// filesystem facts (the `COMPOSE_PROJECT_NAME` environment override, and
// the working-directory basename used as a last-resort fallback) are
// accepted as plain parameters so the function itself stays pure and
// testable without process/env coupling.
//
// Database-volume identity (`volume_belongs_to_deployment`,
// `verify_database_volume_safety`) is a distinct module
// (src/lib/database-volume-safety.ts) because those functions' decisions
// genuinely depend on sequential `docker` calls; this module has none.

const ENVIRONMENT_FILE = ".env-orbit";
const COMPOSE_FILE = "docker-compose.yml";
const SECRETS_DIRECTORY = ".orbit-secrets";
export const DATABASE_VOLUME_KEY = "orbit-db-data";

const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function isRegularNonSymlinkFile(absolutePath: string): boolean {
  try {
    return lstatSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

function isRealNonSymlinkDirectory(absolutePath: string): boolean {
  try {
    return lstatSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

function existsAsAnyType(absolutePath: string): boolean {
  try {
    lstatSync(absolutePath);
    return true;
  } catch {
    return false;
  }
}

// has_mode (install.sh:278-280): `stat -c '%a'` compared as a literal
// three-octal-digit string; lstat's mode bitmask compared against the same
// octal literal is equivalent for the 600/700 checks this module makes.
function hasMode(absolutePath: string, expectedMode: number): boolean {
  try {
    return (lstatSync(absolutePath).mode & 0o777) === expectedMode;
  } catch {
    return false;
  }
}

// target_is_empty (install.sh:270-276): `shopt -s nullglob dotglob; entries=(*)`
// enumerates every directory entry including dotfiles, never "." or "..".
// readdirSync has the same contract without needing the glob dance.
function targetIsEmpty(targetDir: string): boolean {
  return readdirSync(targetDir).length === 0;
}

/**
 * is_preprovisioned_input (install.sh:282-304, guarantee #6): the strict
 * unattended pre-provisioning contract — `.env-orbit` must be exactly mode
 * 600 and a regular non-symlink file, `.orbit-secrets/` must be exactly
 * mode 700 and a real non-symlink directory containing *only* non-empty,
 * mode-600, regular non-symlink files, the target directory must contain
 * *exactly* those two entries and nothing else, and an
 * `oidc-client-secret` file inside it must itself be non-empty.
 */
export function isPreprovisionedInput(targetDir: string): boolean {
  const environmentFile = join(targetDir, ENVIRONMENT_FILE);
  const secretsDirectory = join(targetDir, SECRETS_DIRECTORY);

  if (!(isRegularNonSymlinkFile(environmentFile) && hasMode(environmentFile, 0o600))) return false;
  if (!(isRealNonSymlinkDirectory(secretsDirectory) && hasMode(secretsDirectory, 0o700))) return false;

  let entries: string[];
  let children: string[];
  try {
    entries = readdirSync(targetDir);
    children = readdirSync(secretsDirectory);
  } catch {
    return false;
  }
  if (entries.length !== 2) return false;
  if (!(existsAsAnyType(environmentFile) && existsAsAnyType(secretsDirectory))) return false;

  for (const child of children) {
    const childPath = join(secretsDirectory, child);
    if (!isRegularNonSymlinkFile(childPath)) return false;
    let size: number;
    try {
      size = lstatSync(childPath).size;
    } catch {
      return false;
    }
    if (size === 0) return false;
    if (!hasMode(childPath, 0o600)) return false;
  }

  const oidcSecretFile = join(secretsDirectory, "oidc-client-secret");
  if (!isRegularNonSymlinkFile(oidcSecretFile)) return false;
  try {
    if (lstatSync(oidcSecretFile).size === 0) return false;
  } catch {
    return false;
  }

  return true;
}

export type TargetValidationRefusalCode = "not-recognizable";

/** Thrown by validateTarget when a non-empty target is neither a recognized deployment nor safe pre-provisioned input. */
export class TargetValidationRefusal extends Error {
  readonly code: TargetValidationRefusalCode = "not-recognizable";

  constructor(message: string) {
    super(message);
    this.name = "TargetValidationRefusal";
  }
}

export interface ValidateTargetResult {
  /** Mirrors install.sh's `target_was_empty`: true for a genuinely empty target or one that only holds safe pre-provisioned input. */
  targetWasEmpty: boolean;
}

/**
 * validate_target (install.sh:410-429, guarantee #7): a non-empty target
 * directory must already be a recognizable Orbit deployment (regular
 * `.env-orbit` + regular `docker-compose.yml` + real `.orbit-secrets/`,
 * all non-symlinks) or pass the strict pre-provisioned-input contract
 * above; any other non-empty directory is refused before any pull or
 * download happens. Runs before any mutation — see
 * src/lib/install-transaction.ts for the transaction this gates.
 */
export function validateTarget(targetDir: string): ValidateTargetResult {
  if (targetIsEmpty(targetDir)) {
    return { targetWasEmpty: true };
  }

  const environmentFile = join(targetDir, ENVIRONMENT_FILE);
  const composeFile = join(targetDir, COMPOSE_FILE);
  const secretsDirectory = join(targetDir, SECRETS_DIRECTORY);
  if (
    isRegularNonSymlinkFile(environmentFile) &&
    isRegularNonSymlinkFile(composeFile) &&
    isRealNonSymlinkDirectory(secretsDirectory)
  ) {
    return { targetWasEmpty: false };
  }

  if (isPreprovisionedInput(targetDir)) {
    return { targetWasEmpty: true };
  }

  throw new TargetValidationRefusal(
    "The installation directory is not empty and is not a recognizable Orbit deployment or safe pre-provisioned bootstrap. Refusing to install here.",
  );
}

/**
 * read_environment_value (install.sh:605-615): install.sh's own minimal
 * line-scanner for a single `.env-orbit` key — distinct from, and simpler
 * than, scripts/configuration.sh's full grammar (src/lib/env-orbit-file.ts
 * ports that one instead). Later matches win, exactly like the bash
 * `while read` loop that never `break`s. Returns undefined (bash: non-zero
 * exit, no stdout) when the key is not assigned anywhere in the file, and
 * when the file cannot be read at all.
 */
export function readEnvironmentValue(targetDir: string, key: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(join(targetDir, ENVIRONMENT_FILE), "utf8");
  } catch {
    return undefined;
  }
  const prefix = `${key}=`;
  let found = false;
  let value = "";
  for (const line of content.split("\n")) {
    if (line.startsWith(prefix)) {
      value = line.slice(prefix.length);
      found = true;
    }
  }
  return found ? value : undefined;
}

/** Thrown by deriveComposeProjectName wherever install.sh's derive_compose_project_name calls `fail`. */
export class ComposeProjectNameRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeProjectNameRefusal";
  }
}

export interface DeriveComposeProjectNameResult {
  composeProjectName: string;
  /** Mirrors install.sh's `compose_project_name_explicit`. */
  explicit: boolean;
}

/**
 * derive_compose_project_name (install.sh:431-462, guarantee #12): the
 * Compose project name — whether read from an existing `.env-orbit`,
 * supplied via the `COMPOSE_PROJECT_NAME` override, or derived from the
 * working-directory basename — must match `^[a-z0-9][a-z0-9_-]*$`; a
 * configured file value and an explicitly requested value that disagree
 * refuse rather than silently pick one.
 *
 * `requestedName` mirrors `${COMPOSE_PROJECT_NAME:-}` (undefined or ""
 * both mean "not requested", matching bash's `-n` test); `fallbackBasename`
 * mirrors `basename -- "$(pwd -P)"` — both are the caller's responsibility
 * to resolve so this function itself never touches `process.env` or `cwd`.
 *
 * install.sh's derive_compose_project_name reads and writes
 * `compose_project_name`/`compose_project_name_explicit` as globals that
 * would, in principle, persist across multiple calls within one script run
 * (an `elif "$compose_project_name_explicit" == 1: return` early-exit
 * exists for exactly that case). In practice install.sh has exactly one
 * call site (inside `verify_database_volume_safety`), so that branch is
 * dead code today; this function models a single, self-contained call
 * (`explicit` always starts false) and does not accept prior-call state.
 * If a future slice ever calls this a second time within one run, that
 * simplification would need revisiting — see
 * docs/adr-notes/295-install-port-plan.md.
 */
export function deriveComposeProjectName(
  targetDir: string,
  requestedName: string | undefined,
  fallbackBasename: string,
): DeriveComposeProjectNameResult {
  let composeProjectName = "";
  let explicit = false;

  if (isRegularNonSymlinkFile(join(targetDir, ENVIRONMENT_FILE))) {
    const configuredName = readEnvironmentValue(targetDir, "COMPOSE_PROJECT_NAME");
    if (configuredName !== undefined) {
      if (!PROJECT_NAME_PATTERN.test(configuredName)) {
        throw new ComposeProjectNameRefusal(
          "Could not verify the configured Docker Compose project name; refusing to start Compose.",
        );
      }
      composeProjectName = configuredName;
      explicit = true;
    }
  }

  if (requestedName !== undefined && requestedName !== "") {
    if (!PROJECT_NAME_PATTERN.test(requestedName)) {
      throw new ComposeProjectNameRefusal(
        "Could not determine a safe Docker Compose project name; refusing to start Compose.",
      );
    }
    if (explicit && composeProjectName !== requestedName) {
      throw new ComposeProjectNameRefusal(
        "The configured Docker Compose project name does not match the requested project; refusing to start Compose.",
      );
    }
    return { composeProjectName: requestedName, explicit: true };
  }

  if (explicit) {
    return { composeProjectName, explicit };
  }

  let sanitized = fallbackBasename.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  while (sanitized.startsWith("-") || sanitized.startsWith("_")) {
    sanitized = sanitized.slice(1);
  }
  if (sanitized === "" || !PROJECT_NAME_PATTERN.test(sanitized)) {
    throw new ComposeProjectNameRefusal(
      "Could not determine a safe Docker Compose project name; refusing to start Compose.",
    );
  }
  return { composeProjectName: sanitized, explicit: false };
}

// Re-exported for tests that need to assert on raw filesystem facts without
// duplicating the predicate logic above (mirrors install-transaction.ts's
// own `internal` export).
export const internal = {
  isRegularNonSymlinkFile,
  isRealNonSymlinkDirectory,
  hasMode,
  targetIsEmpty,
};
