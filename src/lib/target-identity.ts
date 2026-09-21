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
/** The deployment asset whose own top-level `name:` names the Compose project (#999). */
export const COMPOSE_FILE = "docker-compose.yml";
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

/**
 * read_compose_project_name (install.sh:479-496, brought there from
 * end-maintenance.sh / engine-check.sh / repair.sh by #999): the target's
 * own `docker-compose.yml` declares `name: orbit` on its first line, and
 * until #999 neither implementation ever read it. Returns undefined
 * wherever bash returns 1 with nothing printed — no such line, an empty
 * value, or a file that cannot be read — so the caller falls through to
 * the working-directory basename exactly as before.
 *
 * Deliberately a top-level-key line read, not a YAML parse, matching the
 * bash byte for byte: `name:` is Compose's own top-level scalar key, so a
 * line anchored at column 0 is enough. An inline `#` comment is cut, the
 * remainder trimmed, and one layer of surrounding double then single
 * quotes stripped — the same four `${var%...}`/`${var#...}` steps, in the
 * same order.
 */
function readComposeProjectName(composeManifestPath: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(composeManifestPath, "utf8");
  } catch {
    return undefined;
  }
  // bash's `while IFS= read -r line` over the file: a line is whatever sits
  // between newlines, and a trailing \r survives into the value the way it
  // does in bash — where the [[:space:]] trim below then removes it.
  for (const line of content.split("\n")) {
    const match = /^name:[ \t\r\f\v]*(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[1];
    const commentIndex = value.indexOf("#");
    if (commentIndex !== -1) value = value.slice(0, commentIndex);
    value = value.replace(/^[ \t\r\f\v]+/, "").replace(/[ \t\r\f\v]+$/, "");
    if (value.endsWith('"')) value = value.slice(0, -1);
    if (value.startsWith('"')) value = value.slice(1);
    if (value.endsWith("'")) value = value.slice(0, -1);
    if (value.startsWith("'")) value = value.slice(1);
    return value === "" ? undefined : value;
  }
  return undefined;
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
  /**
   * Mirrors install.sh's `compose_project_name_provisional` (#999): true only
   * when the working-directory basename was the last resort, so a caller that
   * later puts the bundled `docker-compose.yml` into the target can derive
   * again and improve on it. False for every name with a real source — a
   * configured `.env-orbit` value, an explicit request, or the compose file's
   * own `name:`.
   */
  provisional: boolean;
}

/**
 * derive_compose_project_name (install.sh:504-554, guarantee #12): the
 * Compose project name — whether read from an existing `.env-orbit`,
 * supplied via the `COMPOSE_PROJECT_NAME` override, read from the target's
 * own `docker-compose.yml` `name:`, or derived from the working-directory
 * basename — must match `^[a-z0-9][a-z0-9_-]*$`; a configured file value
 * and an explicitly requested value that disagree refuse rather than
 * silently pick one.
 *
 * The compose-file step is #999's fix, ported here by #1043: the repository
 * declares `name: orbit` on docker-compose.yml's first line and nothing
 * reached it, so installing into ~/apps/household created and persisted the
 * Compose project "household". It sits below both explicit sources and
 * above the basename, is read only through the same regular-file,
 * no-symlink gate as every other target read, and a `name:` Compose itself
 * would not accept falls through to the basename rather than aborting a
 * healthy run — exactly what the bash does.
 *
 * `composeManifestPath` mirrors install.sh's own optional argument to
 * derive_compose_project_name: it defaults to the target's own
 * docker-compose.yml, and a caller deriving again once the bundled file has
 * been staged but not yet installed passes that staged copy instead.
 *
 * `requestedName` mirrors `${COMPOSE_PROJECT_NAME:-}` (undefined or ""
 * both mean "not requested", matching bash's `-n` test); `fallbackBasename`
 * mirrors `basename -- "$(pwd -P)"` — both are the caller's responsibility
 * to resolve so this function itself never touches `process.env` or `cwd`.
 *
 * install.sh's derive_compose_project_name reads and writes
 * `compose_project_name`/`compose_project_name_explicit` as globals that
 * persist across calls within one script run (an `elif
 * "$compose_project_name_explicit" == 1: return` early-exit exists for
 * exactly that case). #999 gave install.sh a second call site — the
 * re-derivation from the staged copy of the bundled compose file, before
 * anything persists a name (install.sh:1663-1665) — so the "exactly one
 * call site, that branch is dead code" simplification this port was built
 * on no longer holds, and
 * docs/adr-notes/295-install-port-plan.md records which way it went: this
 * function still models a single, self-contained call (`explicit` always
 * starts false) rather than accepting prior-call state, and the caller
 * decides whether to call it again by reading `provisional`. The state bash
 * carries in globals between the two calls is exactly what `provisional`
 * reports, so nothing is lost; install-orchestrator.ts drives the second
 * call, and the early-exit branch stays unreachable here by construction.
 */
export function deriveComposeProjectName(
  targetDir: string,
  requestedName: string | undefined,
  fallbackBasename: string,
  composeManifestPath: string = join(targetDir, COMPOSE_FILE),
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
    return { composeProjectName: requestedName, explicit: true, provisional: false };
  }

  if (explicit) {
    return { composeProjectName, explicit, provisional: false };
  }

  // docker-compose.yml's own `name: orbit` (#999, ported by #1043). On a
  // fresh install the bundled compose file has not been staged yet when this
  // first runs, so nothing is found here and the basename below stands in
  // provisionally; install-orchestrator.ts derives again once the staged copy
  // exists, which is what makes `orbit` reachable at all.
  if (isRegularNonSymlinkFile(composeManifestPath)) {
    const declaredName = readComposeProjectName(composeManifestPath);
    if (declaredName !== undefined && PROJECT_NAME_PATTERN.test(declaredName)) {
      return { composeProjectName: declaredName, explicit: false, provisional: false };
    }
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
  return { composeProjectName: sanitized, explicit: false, provisional: true };
}

// Re-exported for tests that need to assert on raw filesystem facts without
// duplicating the predicate logic above (mirrors install-transaction.ts's
// own `internal` export).
export const internal = {
  readComposeProjectName,
  isRegularNonSymlinkFile,
  isRealNonSymlinkDirectory,
  hasMode,
  targetIsEmpty,
};
