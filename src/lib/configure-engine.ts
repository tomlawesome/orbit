import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  CANONICAL_OIDC_SECRET_FILE_PATH,
  OIDC_CALLBACK_PATH,
  SECRET_HEX256_PATTERN,
  containsForbiddenCharacters,
  isForbiddenHost,
  isValidClientId,
  isValidLocalModel,
  isValidOidcIssuer,
  isValidOrbitImage,
  normalizePublicOrigin,
  secretFileFormatMessage,
} from "./config-contract";
import { acquireDeployLock as acquireSharedDeployLock } from "./deploy-lock";
import { HostOwnershipError, applyHostOwnership } from "./host-ownership";
import { preflightEnvironmentFile } from "./configuration-migration";
import { ensureVapidKeys } from "./vapid-keys";

// The write side of scripts/configure.sh, ported to the TypeScript engine
// (issue #294, completing the port begun for `--check` in src/lib/
// config-contract.ts / src/lib/env-orbit-file.ts). Guarantee numbers below
// cite docs/installer-guarantees.md's `configure.sh` section (items 1-33)
// and are re-asserted by name in src/lib/configure-engine.test.ts and
// src/lib/configure-engine.parity.test.ts.
//
// Scope: every configure.sh write flow, VAPID key generation included since
// #1210 (build note D7, src/lib/vapid-keys.ts). scripts/configure.sh is now
// only the shell that runs this engine as a one-off container; it writes no
// configuration itself.
//
// Schema-migration preflight: runConfigurePreflight below applies
// src/lib/configuration-migration.ts's preflight (the TypeScript port of the
// retired scripts/configuration.sh, #1210 D8) to .env-orbit.
//
// Every mutating function here operates on real files under an explicit
// `deployDir` (mirroring src/cli/orbit.ts's existing `--dir` convention),
// using the same atomic mktemp-in-place + chmod + rename discipline
// configure.sh itself uses (guarantees #6-8, #15-19, #23, #26), and the same
// existence-following-symlinks semantics bash's `[[ -e ]]` / `[[ -f ]]` /
// `[[ -L ]]` triad uses (a dangling symlink at a managed path is treated as
// absent, exactly like bash, and gets atomically replaced rather than
// refused).

export const ENVIRONMENT_FILE_NAME = ".env-orbit";
export const ENVIRONMENT_EXAMPLE_NAME = ".env-orbit.example";
export const SECRETS_DIRECTORY_NAME = ".orbit-secrets";
export const OIDC_SECRET_RELATIVE_PATH = `${SECRETS_DIRECTORY_NAME}/oidc-client-secret`;
export const MAXIMUM_SECRET_BYTES = 65536;

export type ConfigureEngineRefusalCode =
  | "environment-example-missing"
  | "environment-file-invalid"
  | "environment-file-permissions"
  | "environment-defaults-invalid"
  | "secrets-directory-invalid"
  | "secrets-directory-permissions"
  | "secret-file-invalid"
  | "orbit-image-invalid"
  | "deployment-profile-invalid"
  | "guided-configuration-invalid"
  | "oidc-secret-invalid"
  | "oidc-secret-placeholder-invalid"
  | "preflight-failed"
  | "configuration-migration-required"
  | "write-failed"
  | "locked";

/**
 * Thrown for every fail-closed refusal this module makes. Never carries a
 * configured value or secret material — mirroring configure.sh's own
 * `fail()` (category-only messages) and the same no-leak discipline
 * src/lib/recovery-bundle.ts's RecoveryBundleRefusal documents.
 */
export class ConfigureEngineRefusal extends Error {
  readonly code: ConfigureEngineRefusalCode;

  constructor(message: string, code: ConfigureEngineRefusalCode) {
    super(message);
    this.name = "ConfigureEngineRefusal";
    this.code = code;
  }
}

function refuse(message: string, code: ConfigureEngineRefusalCode): never {
  throw new ConfigureEngineRefusal(message, code);
}

// --- path facts: bash's `[[ -e ]]` / `[[ -f ]]` / `[[ -d ]]` / `[[ -L ]]` ---

interface PathInfo {
  /** bash `[[ -e path ]]`: existence FOLLOWING a symlink (false for a dangling symlink). */
  existsFollowing: boolean;
  /** bash `[[ -L path ]]`: the path itself, not its target, is a symlink. */
  isSymlink: boolean;
  /** bash `[[ -f path ]]`: a regular file at the resolved target. */
  isRegularFollowing: boolean;
  /** bash `[[ -d path ]]`: a directory at the resolved target. */
  isDirectoryFollowing: boolean;
}

function pathInfo(path: string): PathInfo {
  let lst: Stats | undefined;
  try {
    lst = lstatSync(path);
  } catch {
    lst = undefined;
  }
  let st: Stats | undefined;
  try {
    st = statSync(path);
  } catch {
    st = undefined;
  }
  return {
    existsFollowing: st !== undefined,
    isSymlink: lst?.isSymbolicLink() ?? false,
    isRegularFollowing: st?.isFile() ?? false,
    isDirectoryFollowing: st?.isDirectory() ?? false,
  };
}

// --- atomic write: mktemp-in-place + chmod + rename -------------------------

function atomicWriteFile(finalPath: string, content: string | Buffer, mode: number, prefix: string): void {
  const dir = dirname(finalPath);
  const tmpPath = join(dir, `.${prefix}.${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(tmpPath, content, { mode });
    chmodSync(tmpPath, mode);
    // #1258: handed to the host operator before it takes its final name.
    applyHostOwnership(tmpPath);
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* best effort cleanup */
    }
    refuse(error instanceof HostOwnershipError ? error.message : `Could not write ${finalPath}.`, "write-failed");
  }
  try {
    renameSync(tmpPath, finalPath);
  } catch {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* best effort cleanup */
    }
    refuse(`Could not persist ${finalPath}.`, "write-failed");
  }
}

// --- cross-process lock (O1-R8/O1-R7) ---------------------------------------
//
// The one deploy lock (src/lib/deploy-lock.ts, #1210 D9), shared with the
// configuration migration and install/update's file transaction.
function acquireDeployLock(deployDir: string, operationLabel: string): () => void {
  return acquireSharedDeployLock(deployDir, operationLabel, (message) => new ConfigureEngineRefusal(message, "locked"));
}

function generateHexSecret(): string {
  // node:crypto's randomBytes is a CSPRNG (equivalent security posture to
  // configure.sh's own `openssl rand -hex 32` / `/dev/urandom` fallback);
  // .toString("hex") already yields lowercase, matching bash's `${secret,,}`.
  return randomBytes(32).toString("hex");
}

// --- .env-orbit -------------------------------------------------------------

interface MinimalEnvironmentEntry {
  key: string;
  managed?: true;
}

interface MinimalEnvironmentSection {
  heading: string;
  entries: MinimalEnvironmentEntry[];
}

// Exact port of configure.sh's own call to write_minimal_environment
// (configure.sh:187-194): same headings, same keys, same order.
const MINIMAL_ENVIRONMENT_SECTIONS: MinimalEnvironmentSection[] = [
  {
    heading: "Core",
    entries: [
      { key: "ORBIT_CONFIG_SCHEMA_VERSION" },
      { key: "APP_URL" },
      { key: "ORBIT_IMAGE" },
      { key: "ORBIT_CONFIG_APPLIED_VERSION", managed: true },
      { key: "ORBIT_CONFIG_APPLIED_DIGEST", managed: true },
    ],
  },
  {
    heading: "Authentication",
    entries: [
      { key: "ORBIT_AUTH_OIDC" },
      { key: "OIDC_ISSUER" },
      { key: "OIDC_CLIENT_ID" },
      { key: "OIDC_CLIENT_SECRET" },
      { key: "OIDC_CLIENT_SECRET_FILE", managed: true },
      { key: "OIDC_CALLBACK_URL" },
    ],
  },
  {
    heading: "Generated secrets and keys",
    entries: [
      { key: "SESSION_SECRET_FILE" },
      { key: "DOCUMENT_KEK_FILE" },
      { key: "POSTGRES_PASSWORD_FILE" },
      { key: "VAPID_PUBLIC_KEY" },
      { key: "VAPID_PRIVATE_KEY_FILE" },
    ],
  },
  {
    heading: "Deployment",
    entries: [
      { key: "COMPOSE_PROJECT_NAME", managed: true },
      { key: "ORBIT_BIND_ADDRESS" },
      { key: "ORBIT_PORT" },
      { key: "COMPOSE_PROFILES" },
      { key: "POSTGRES_DB" },
      { key: "POSTGRES_USER" },
    ],
  },
  {
    heading: "Optional services",
    entries: [{ key: "TIKA_URL" }, { key: "OLLAMA_MODEL" }],
  },
  {
    heading: "Observability",
    entries: [{ key: "ORBIT_LOG_LEVEL" }, { key: "ORBIT_LOG_FORMAT" }],
  },
];

/** example_active_value (configure.sh:133-143): exactly one active (uncommented) `KEY=` line required, else undefined. */
function exampleActiveValue(exampleContent: string, key: string): string | undefined {
  let value: string | undefined;
  let found = 0;
  for (const line of exampleContent.split("\n")) {
    if (line.startsWith(`${key}=`)) {
      value = line.slice(key.length + 1);
      found += 1;
    }
  }
  return found === 1 ? value : undefined;
}

/** write_minimal_environment (configure.sh:145-169), applied to the fixed section/key list above. */
function buildMinimalEnvironmentContent(exampleContent: string): string {
  let output = "";
  for (const section of MINIMAL_ENVIRONMENT_SECTIONS) {
    output += `# --- ${section.heading} ---\n`;
    for (const entry of section.entries) {
      if (entry.managed) {
        if (entry.key === "OIDC_CLIENT_SECRET_FILE") {
          output += `# ${entry.key}=${CANONICAL_OIDC_SECRET_FILE_PATH}\n`;
        } else {
          output += `# ${entry.key}=\n`;
        }
      } else {
        const value = exampleActiveValue(exampleContent, entry.key);
        if (value === undefined) {
          refuse(
            "Could not create a concise Orbit environment file from the supported defaults.",
            "environment-defaults-invalid",
          );
        }
        output += `${entry.key}=${value}\n`;
      }
    }
    output += "\n";
  }
  return output;
}

export interface EnsureEnvironmentFileResult {
  created: boolean;
  message?: string;
}

/** ensure_environment_file's own "Created ..." line, as a prefix for a flow's closing message (bash printed both). */
function withCreatedLine(created: EnsureEnvironmentFileResult, message: string): string {
  return created.message ? `${created.message}\n${message}` : message;
}

/** ensure_environment_file (configure.sh:171-198, guarantees #4-6). */
export function ensureEnvironmentFile(deployDir: string): EnsureEnvironmentFileResult {
  const examplePath = join(deployDir, ENVIRONMENT_EXAMPLE_NAME);
  const envPath = join(deployDir, ENVIRONMENT_FILE_NAME);

  const exampleInfo = pathInfo(examplePath);
  if (!exampleInfo.isRegularFollowing) {
    refuse(`${ENVIRONMENT_EXAMPLE_NAME} is missing.`, "environment-example-missing");
  }

  const envInfo = pathInfo(envPath);
  if (envInfo.existsFollowing) {
    if (!envInfo.isRegularFollowing || envInfo.isSymlink) {
      refuse(`Refusing to use ${ENVIRONMENT_FILE_NAME} because it is not a regular file.`, "environment-file-invalid");
    }
    try {
      chmodSync(envPath, 0o600);
    } catch {
      refuse(`Could not restrict ${ENVIRONMENT_FILE_NAME} permissions.`, "environment-file-permissions");
    }
    return { created: false };
  }

  const exampleContent = readFileSync(examplePath, "utf8");
  const content = buildMinimalEnvironmentContent(exampleContent);
  atomicWriteFile(envPath, content, 0o600, "env-orbit.installing");
  return { created: true, message: `Created ${ENVIRONMENT_FILE_NAME} from ${ENVIRONMENT_EXAMPLE_NAME}.` };
}

/**
 * update_managed_keys (configure.sh:218-310, guarantees #7-8): the single
 * reusable atomic writer for every managed key. Rewrites the first active
 * assignment for each given key in place, drops further duplicate active
 * assignments for the same key, relocates `OIDC_CLIENT_SECRET_FILE` to its
 * documented position (the commented placeholder, or immediately after an
 * `OIDC_CLIENT_SECRET=` line), appends any key with no existing assignment
 * at the end (in call order), copies every other line through byte-for-byte,
 * and preserves the file's original trailing-newline convention. `pairs`
 * order matters: it is both match precedence and append order, exactly like
 * bash's own `order` array built from positional arguments.
 */
export function updateManagedKeys(deployDir: string, pairs: ReadonlyArray<readonly [string, string]>): void {
  const releaseLock = acquireDeployLock(deployDir, "orbit configure");
  try {
    updateManagedKeysLocked(deployDir, pairs);
  } finally {
    releaseLock();
  }
}

/** The actual read-modify-write, now only ever reached with the deployment lock held (O1-R8). */
function updateManagedKeysLocked(deployDir: string, pairs: ReadonlyArray<readonly [string, string]>): void {
  const envPath = join(deployDir, ENVIRONMENT_FILE_NAME);
  const order = pairs.map(([key]) => key);
  const pending = new Map<string, string>(pairs);

  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    refuse(`Could not read ${ENVIRONMENT_FILE_NAME} for an atomic update.`, "environment-file-invalid");
  }

  let finalNewline = true;
  if (raw.length > 0) {
    finalNewline = raw.endsWith("\n");
  }

  let inputLines = raw.length === 0 ? [] : raw.split("\n");
  if (raw.endsWith("\n") && inputLines.length > 0) {
    inputLines = inputLines.slice(0, -1);
  }

  const outputLines: string[] = [];
  const written = new Set<string>();
  const hasOidcSecretFilePending = pending.has("OIDC_CLIENT_SECRET_FILE");

  for (const line of inputLines) {
    if (hasOidcSecretFilePending && line.startsWith("# OIDC_CLIENT_SECRET_FILE=")) {
      if (!written.has("OIDC_CLIENT_SECRET_FILE")) {
        outputLines.push(`OIDC_CLIENT_SECRET_FILE=${pending.get("OIDC_CLIENT_SECRET_FILE")}`);
        written.add("OIDC_CLIENT_SECRET_FILE");
      }
      continue;
    }

    let found = false;
    for (const key of order) {
      if (line.startsWith(`${key}=`)) {
        found = true;
        if (key === "OIDC_CLIENT_SECRET_FILE") {
          // Relocated elsewhere (the commented selector above, or right
          // after OIDC_CLIENT_SECRET below) — this stale copy is dropped.
        } else if (!written.has(key)) {
          outputLines.push(`${key}=${pending.get(key)}`);
          written.add(key);
        }
        break;
      }
    }

    if (!found) {
      outputLines.push(line);
    }

    if (hasOidcSecretFilePending && !written.has("OIDC_CLIENT_SECRET_FILE") && line.startsWith("OIDC_CLIENT_SECRET=")) {
      outputLines.push(`OIDC_CLIENT_SECRET_FILE=${pending.get("OIDC_CLIENT_SECRET_FILE")}`);
      written.add("OIDC_CLIENT_SECRET_FILE");
    }
  }

  for (const key of order) {
    if (!written.has(key)) {
      outputLines.push(`${key}=${pending.get(key)}`);
      finalNewline = true;
    }
  }

  const content = outputLines
    .map((line, index) => (index === outputLines.length - 1 && !finalNewline ? line : `${line}\n`))
    .join("");

  atomicWriteFile(envPath, content, 0o600, "env-orbit.updating");
}

/** persist_orbit_image (configure.sh:312-319, guarantee #9). */
export function persistOrbitImage(deployDir: string, orbitImage: string | undefined): void {
  if (!orbitImage) return;
  if (!isValidOrbitImage(orbitImage)) {
    refuse(
      "ORBIT_IMAGE must be an immutable registry digest or the installer-generated local build tag.",
      "orbit-image-invalid",
    );
  }
  updateManagedKeys(deployDir, [["ORBIT_IMAGE", orbitImage]]);
}

// --- .orbit-secrets -----------------------------------------------------

/** ensure_secrets_directory (configure.sh:200-209, guarantee #17). */
export function ensureSecretsDirectory(deployDir: string): void {
  const dirPath = join(deployDir, SECRETS_DIRECTORY_NAME);
  const info = pathInfo(dirPath);
  if (info.existsFollowing) {
    if (!info.isDirectoryFollowing || info.isSymlink) {
      refuse(`Refusing to use ${SECRETS_DIRECTORY_NAME} because it is not a regular directory.`, "secrets-directory-invalid");
    }
  } else {
    try {
      mkdirSync(dirPath);
    } catch {
      refuse(`Could not create ${SECRETS_DIRECTORY_NAME}.`, "secrets-directory-invalid");
    }
    try {
      applyHostOwnership(dirPath);
    } catch (error) {
      refuse((error as Error).message, "write-failed");
    }
  }
  try {
    chmodSync(dirPath, 0o700);
  } catch {
    refuse(`Could not restrict ${SECRETS_DIRECTORY_NAME} permissions.`, "secrets-directory-permissions");
  }
}

export interface EnsureSecretFileResult {
  generated: boolean;
  message?: string;
}

/**
 * Like pathInfo, but also reports *why* statSync failed to follow the path
 * when it did: ENOENT ("truly nothing here") versus anything else (EACCES,
 * EIO, a transient mount problem, ...). ensureSecretFile needs that
 * distinction (O1-S1/SS1-S2): pathInfo's own blanket catch treats every stat
 * failure as "doesn't exist," which is exactly how a merely-unstatable
 * DOCUMENT_KEK/SESSION_SECRET file used to get silently treated as absent
 * and regenerated.
 */
function secretFilePathInfo(path: string): { info: PathInfo; statErrorCode?: string } {
  let lst: Stats | undefined;
  try {
    lst = lstatSync(path);
  } catch {
    lst = undefined;
  }
  let st: Stats | undefined;
  let statErrorCode: string | undefined;
  try {
    st = statSync(path);
  } catch (error) {
    statErrorCode = (error as NodeJS.ErrnoException).code;
  }
  return {
    info: {
      existsFollowing: st !== undefined,
      isSymlink: lst?.isSymbolicLink() ?? false,
      isRegularFollowing: st?.isFile() ?? false,
      isDirectoryFollowing: st?.isDirectory() ?? false,
    },
    statErrorCode,
  };
}

/**
 * ensure_secret_file (configure.sh:747-772, guarantees #15-16), used for
 * session-secret/postgres-password/document-kek.
 *
 * `isFreshInstall` governs the one case that matters most here (O1-S1/
 * SS1-S2): a missing DOCUMENT_KEK or SESSION_SECRET file. On a genuinely
 * fresh install (nothing deployed here yet) that is the normal first run and
 * generating one is correct and expected. On an existing deployment it is
 * instead the symptom of a lost or corrupted secret, and every encrypted
 * document becomes permanently unreadable (or every session invalid) the
 * moment this function "fixes" it by generating a replacement — so on an
 * existing deployment a missing file is always a hard refusal naming the
 * file and the recovery path, never a silent regeneration. A stat failure
 * that is not ENOENT (permissions, I/O, a half-mounted secrets volume) is a
 * hard refusal unconditionally, fresh install or not: it is never evidence
 * that the file doesn't exist, only that this process could not find out.
 */
export function ensureSecretFile(deployDir: string, relativePath: string, isFreshInstall: boolean): EnsureSecretFileResult {
  const path = join(deployDir, relativePath);
  const { info, statErrorCode } = secretFilePathInfo(path);
  if (info.existsFollowing) {
    if (!info.isRegularFollowing || info.isSymlink) {
      refuse(`Refusing to use ${relativePath} because it is not a regular file.`, "secret-file-invalid");
    }
    const existingValue = readFileSync(path, "utf8").replace(/[\r\n]/g, "");
    if (!SECRET_HEX256_PATTERN.test(existingValue)) {
      refuse(secretFileFormatMessage(relativePath), "secret-file-invalid");
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      refuse(`Could not restrict permissions on ${relativePath}.`, "secret-file-invalid");
    }
    return { generated: false };
  }

  if (statErrorCode !== undefined && statErrorCode !== "ENOENT") {
    refuse(
      `Could not check ${relativePath} (${statErrorCode}); refusing to guess whether it exists rather than possibly generating a replacement secret.`,
      "secret-file-invalid",
    );
  }

  if (!isFreshInstall) {
    refuse(
      `${relativePath} is missing on an existing Orbit deployment. Refusing to generate a replacement, which would make existing encrypted data unreadable or sign out every user. Restore ${relativePath} from backup (or Orbit's recovery bundle) to the exact path ${path}, then run \`orbit configure\` again.`,
      "secret-file-invalid",
    );
  }

  const secret = generateHexSecret();
  atomicWriteFile(path, `${secret}\n`, 0o600, "installing");
  return { generated: true, message: `Generated ${relativePath}.` };
}

// --- OIDC client secret ------------------------------------------------

/** environment_key_is_nonempty (configure.sh:774-784): a raw, unvalidated last-assignment-wins scan, deliberately not the full parseEnvOrbitContent parser. */
function rawEnvironmentKeyValue(deployDir: string, key: string): string | undefined {
  const envPath = join(deployDir, ENVIRONMENT_FILE_NAME);
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return undefined;
  }
  let value: string | undefined;
  let found = false;
  for (const line of raw.split("\n")) {
    if (line.startsWith(`${key}=`)) {
      value = line.slice(key.length + 1);
      found = true;
    }
  }
  return found ? value : undefined;
}

function environmentKeyIsNonEmpty(deployDir: string, key: string): boolean {
  const envPath = join(deployDir, ENVIRONMENT_FILE_NAME);
  const info = pathInfo(envPath);
  if (!info.isRegularFollowing || info.isSymlink) return false;
  return (rawEnvironmentKeyValue(deployDir, key) ?? "") !== "";
}

/**
 * ensure_oidc_secret_placeholder (configure.sh:786-814, guarantees #18-19).
 *
 * The zero-byte placeholder this writes exists for one reason only: Compose's
 * `file:`-backed secret declaration needs a host source to exist even before
 * an operator has ever run `--set-oidc-secret`. That bootstrap case is safe
 * because nothing is lost — there was never a real secret at this path.
 *
 * Once OIDC_CLIENT_SECRET_FILE is itself already configured, though, a
 * missing file here means the real secret this deployment already has was
 * lost or deleted (O1-S5) — writing a fresh zero-byte placeholder over it
 * would silently and permanently disable OIDC sign-in while `orbit
 * configure` reports success. That case is always a hard refusal instead;
 * never an empty secret.
 */
export function ensureOidcSecretPlaceholder(deployDir: string): void {
  if (environmentKeyIsNonEmpty(deployDir, "OIDC_CLIENT_SECRET") && !environmentKeyIsNonEmpty(deployDir, "OIDC_CLIENT_SECRET_FILE")) {
    return;
  }

  const fileModeActive = environmentKeyIsNonEmpty(deployDir, "OIDC_CLIENT_SECRET_FILE");

  const secretPath = join(deployDir, OIDC_SECRET_RELATIVE_PATH);
  const info = pathInfo(secretPath);
  if (info.existsFollowing) {
    if (!info.isRegularFollowing || info.isSymlink) {
      refuse(`Refusing to use ${OIDC_SECRET_RELATIVE_PATH} because it is not a regular file.`, "oidc-secret-placeholder-invalid");
    }
    try {
      chmodSync(secretPath, 0o600);
    } catch {
      refuse(`Could not restrict permissions on ${OIDC_SECRET_RELATIVE_PATH}.`, "oidc-secret-placeholder-invalid");
    }
    return;
  }

  if (fileModeActive) {
    refuse(
      `${OIDC_SECRET_RELATIVE_PATH} is missing but OIDC_CLIENT_SECRET_FILE is already configured. Refusing to replace it with an empty placeholder, which would silently disable OIDC sign-in. Restore the OIDC client secret to ${OIDC_SECRET_RELATIVE_PATH}, or run \`orbit configure --set-oidc-secret\` again, then retry.`,
      "oidc-secret-placeholder-invalid",
    );
  }

  atomicWriteFile(secretPath, Buffer.alloc(0), 0o600, "installing");
}

/** set_oidc_secret's file-writing tail (configure.sh:822-879, guarantees #20-23), given an already-read secret. Non-empty/size validation is re-applied here as defense in depth, matching bash's own post-read checks. */
export function applySetOidcSecret(deployDir: string, secret: string): string {
  if (secret.length === 0) {
    refuse("Could not read a non-empty OIDC client secret from standard input.", "oidc-secret-invalid");
  }
  const secretBytes = Buffer.byteLength(secret, "utf8");
  if (secretBytes > MAXIMUM_SECRET_BYTES) {
    refuse(`The OIDC client secret exceeds the ${MAXIMUM_SECRET_BYTES}-byte maximum.`, "oidc-secret-invalid");
  }

  const created = ensureEnvironmentFile(deployDir);
  ensureSecretsDirectory(deployDir);

  const secretPath = join(deployDir, OIDC_SECRET_RELATIVE_PATH);
  // O1-R10: captured before the write below, so the failure handling that
  // follows can tell a brand-new secret (safe to remove again on failure)
  // from a rotation of one .env-orbit already points at (never removed —
  // its content is already overwritten either way, but the live pointer
  // must never end up referencing a file this call just deleted).
  // Both writes under the one deploy lock: otherwise the losing one of two
  // overlapping calls rolled back the secret file the winner had just
  // written and pointed .env-orbit at.
  const releaseLock = acquireDeployLock(deployDir, "orbit configure");
  const secretExistedBefore = pathInfo(secretPath).existsFollowing;
  try {
    atomicWriteFile(secretPath, secret, 0o600, "installing");
  } catch (error) {
    releaseLock();
    throw error;
  }

  try {
    updateManagedKeysLocked(deployDir, [
      ["OIDC_CLIENT_SECRET", ""],
      ["OIDC_CLIENT_SECRET_FILE", CANONICAL_OIDC_SECRET_FILE_PATH],
    ]);
  } catch (error) {
    // O1-R10: these are two separate atomic writes (the secret file, then
    // its .env-orbit pointer) — anything short of an uncatchable kill
    // between them (a lock conflict, a full disk, ...) must not leave a
    // secret this call just created sitting on disk with nothing pointing
    // at it, so a first-time write is rolled back on failure rather than
    // left orphaned.
    if (!secretExistedBefore) {
      try {
        rmSync(secretPath, { force: true });
      } catch {
        /* best effort */
      }
    }
    throw error;
  } finally {
    releaseLock();
  }

  return withCreatedLine(created, `Orbit saved the OIDC client secret to ${OIDC_SECRET_RELATIVE_PATH}.`);
}

// --- guided configuration (--init) --------------------------------------

export interface GuidedInitInput {
  appUrl: string;
  /** Defaults to "oidc" (unset preserves this function's original always-OIDC behavior). */
  authMode?: "local" | "oidc";
  issuer?: string;
  clientId?: string;
}

/**
 * guided_init's validate-then-write tail (configure.sh:684-745, guarantees
 * #11-14), given already-collected candidate answers (TTY prompting, the
 * ORBIT_CONFIGURE_* env triad, or #297 machine prompts are all the caller's
 * concern — see the CLI wiring in src/cli/orbit.ts). Writes nothing until
 * every required field re-validates.
 *
 * O1-F1: `authMode: "local"` is guided_init's local-only branch
 * (configure.sh:843-850, ADR-0023 §1) — APP_URL and ORBIT_AUTH_OIDC=false
 * only, never touching OIDC_*, so switching the provider off never forces
 * deleting its configuration. This engine previously had no such path at
 * all, so a local-only init always demanded `issuer`/`clientId`.
 */
export function applyGuidedInit(deployDir: string, input: GuidedInitInput): string {
  const normalizedAppUrl = normalizePublicOrigin(input.appUrl);
  if (!normalizedAppUrl) {
    refuse(
      "APP_URL must be a complete https:// public origin with no credentials, path, query, fragment, loopback address or example.com placeholder.",
      "guided-configuration-invalid",
    );
  }

  if (input.authMode === "local") {
    const created = ensureEnvironmentFile(deployDir);
    updateManagedKeys(deployDir, [
      ["APP_URL", normalizedAppUrl],
      ["ORBIT_AUTH_OIDC", "false"],
    ]);
    return withCreatedLine(created, "Orbit guided configuration saved APP_URL and set ORBIT_AUTH_OIDC=false (local accounts only).");
  }

  if (!isValidOidcIssuer(input.issuer ?? "")) {
    refuse(
      "OIDC_ISSUER must be a complete https:// issuer URL with no credentials, query, fragment, loopback address or example.com placeholder.",
      "guided-configuration-invalid",
    );
  }
  if (!isValidClientId(input.clientId ?? "")) {
    refuse("OIDC_CLIENT_ID must be a non-empty value with no whitespace or control characters.", "guided-configuration-invalid");
  }

  const callbackUrl = `${normalizedAppUrl}${OIDC_CALLBACK_PATH}`;
  const created = ensureEnvironmentFile(deployDir);
  updateManagedKeys(deployDir, [
    ["APP_URL", normalizedAppUrl],
    ["ORBIT_AUTH_OIDC", "true"],
    ["OIDC_ISSUER", input.issuer as string],
    ["OIDC_CLIENT_ID", input.clientId as string],
    ["OIDC_CALLBACK_URL", callbackUrl],
  ]);

  return withCreatedLine(created, "Orbit guided configuration saved APP_URL, ORBIT_AUTH_OIDC=true, OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CALLBACK_URL.");
}

// --- deployment profile ---------------------------------------------------

/** set_deployment_profile (configure.sh:327-357, guarantee #10). Argument-shape refusals here map to configure.sh's own `return 2` (usage error, exit 2 from the CLI dispatch) rather than its generic `fail()` (exit 1) — src/cli/orbit.ts distinguishes them by this function's ConfigureEngineRefusal code. */
export function setDeploymentProfile(deployDir: string, preset: string, model: string | undefined): string {
  let profiles = "";
  let tikaUrl = "";
  switch (preset) {
    case "standard":
      if (model) refuse("standard accepts no model.", "deployment-profile-invalid");
      break;
    case "processing":
      if (model) refuse("processing accepts no model.", "deployment-profile-invalid");
      profiles = "processing";
      tikaUrl = "http://orbit-tika:9998";
      break;
    case "ai":
      if (!model || !isValidLocalModel(model)) refuse("ai requires a valid local model identifier.", "deployment-profile-invalid");
      profiles = "ai";
      break;
    case "full":
      if (!model || !isValidLocalModel(model)) refuse("full requires a valid local model identifier.", "deployment-profile-invalid");
      profiles = "processing,ai";
      tikaUrl = "http://orbit-tika:9998";
      break;
    default:
      refuse(`Unknown deployment profile preset: ${preset}.`, "deployment-profile-invalid");
  }

  const created = ensureEnvironmentFile(deployDir);
  updateManagedKeys(deployDir, [
    ["COMPOSE_PROFILES", profiles],
    ["TIKA_URL", tikaUrl],
    ["OLLAMA_MODEL", model ?? ""],
  ]);

  return withCreatedLine(created, `Orbit deployment profile saved: ${preset}.`);
}

// --- configuration preflight (configuration.sh --preflight handoff) --------

export type ConfigurePreflightOutcome =
  | { ok: true }
  | { ok: false; code: "preflight-failed" | "configuration-migration-required" };

/**
 * run_configuration_preflight (configure.sh guarantee #2): an existing
 * .env-orbit must pass the configuration contract's preflight
 * (src/lib/configuration-migration.ts, the port of configuration.sh); a file
 * with no schema marker needs the installer's migration first. Nothing at
 * the path at all (bash's `[[ ! -e ]]`) skips the check.
 */
export function runConfigurePreflight(deployDir: string): ConfigurePreflightOutcome {
  const envPath = join(deployDir, ENVIRONMENT_FILE_NAME);
  if (!pathInfo(envPath).existsFollowing && !pathInfo(envPath).isSymlink) return { ok: true };
  const result = preflightEnvironmentFile(envPath);
  if (result.status !== 0) return { ok: false, code: "preflight-failed" };
  if (/^safely_migratable ORBIT_CONFIG_SCHEMA_VERSION$/m.test(result.stdout)) {
    return { ok: false, code: "configuration-migration-required" };
  }
  return { ok: true };
}

// --- the bare (no-argument) flow ----------------------------------------------

const GENERATED_SECRET_RELATIVE_PATHS = [
  `${SECRETS_DIRECTORY_NAME}/session-secret`,
  `${SECRETS_DIRECTORY_NAME}/postgres-password`,
  `${SECRETS_DIRECTORY_NAME}/document-kek`,
];

export interface ConfigureApplyResult {
  messages: string[];
}

/**
 * configure.sh's bare/default invocation (guarantees #1-9, #15-19, #24-26,
 * #33): the environment file, preflight, the pinned image, the generated
 * secrets, the OIDC placeholder and, last, the VAPID key pair. The CLI
 * prints the returned messages, then "Orbit configuration is ready...".
 */
export function runConfigureApply(
  deployDir: string,
  orbitImage: string | undefined,
  options: { trustOrbitImage?: boolean } = {},
): ConfigureApplyResult {
  const messages: string[] = [];

  // #1151 RANGE-F1 (O1-S1/SS1-S2's "existing deployment" signal for
  // ensureSecretFile): a deployment is existing when any of the three
  // generated secrets already exists before this run (a symlink counts).
  // .env-orbit and the secrets directory are not signals: install.sh runs
  // `configure.sh --init` (which writes .env-orbit) and then a bare
  // configure in a second process. Checked once for the whole set, before
  // the first is generated, so writing one cannot make the next look existing.
  // hadEnvironmentFile is only for persist_orbit_image's rule below.
  const hadEnvironmentFile = pathInfo(join(deployDir, ENVIRONMENT_FILE_NAME)).existsFollowing;
  const isFreshInstall = !GENERATED_SECRET_RELATIVE_PATHS.some((relativePath) => {
    const info = pathInfo(join(deployDir, relativePath));
    return info.existsFollowing || info.isSymlink;
  });

  const envResult = ensureEnvironmentFile(deployDir);
  if (envResult.message) messages.push(envResult.message);

  const preflight = runConfigurePreflight(deployDir);
  if (!preflight.ok) {
    if (preflight.code === "configuration-migration-required") {
      refuse("configuration_migration_required", preflight.code);
    }
    refuse("Configuration preflight failed; restoring the previous deployment.", preflight.code);
  }

  // persist_orbit_image's rule (configure.sh): an existing deployment only
  // changes its pinned image through the installer, which says so with
  // ORBIT_CONFIGURE_TRUST_ORBIT_IMAGE=1. Without it, a stale ORBIT_IMAGE
  // left in the shell re-pinned the deployment through the container
  // engine while the bash path refused.
  if (orbitImage && hadEnvironmentFile && !options.trustOrbitImage) {
    messages.push(`Orbit configure: ignoring the environment's ORBIT_IMAGE value ${orbitImage}; an existing deployment only changes its pinned image through the installer.`);
  } else {
    persistOrbitImage(deployDir, orbitImage);
  }
  ensureSecretsDirectory(deployDir);

  // #1151 RANGE-R5: two concurrent first-time `orbit configure` runs both
  // see every secret missing and each generate their own; whichever
  // finishes last previously overwrote the other's file unchallenged,
  // exactly the read-modify-write race acquireDeployLock exists to close
  // elsewhere. ensureSecretFile itself never takes this lock (it has no
  // caller-independent reason to serialize on its own), so the loop takes
  // it here, same lock, same deployDir, safe to nest after persistOrbitImage's
  // own acquire/release above has already completed.
  const releaseSecretsLock = acquireDeployLock(deployDir, "orbit configure");
  try {
    for (const relativePath of GENERATED_SECRET_RELATIVE_PATHS) {
      const result = ensureSecretFile(deployDir, relativePath, isFreshInstall);
      if (result.message) messages.push(result.message);
    }
  } finally {
    releaseSecretsLock();
  }

  ensureOidcSecretPlaceholder(deployDir);

  // #1210 D7: VAPID keys are generated here now, not by a Docker-backed bash step.
  const vapid = ensureVapidKeys(deployDir);
  if (vapid.message) messages.push(vapid.message);

  return { messages };
}

// =============================================================================
// Machine prompts (v0) — the engine's own "server" side.
//
// docs/engine-events.md's "Machine prompts (v0)" section documents the exact
// line grammar `configure.sh` speaks when driven with
// `ORBIT_CONFIGURE_PROMPTS=machine`; src/lib/guided-configuration.ts already
// implements the "client" side (parseMachinePromptLine) for install.sh's own
// driving of that bash process. The containerized `orbit configure --init` /
// `--set-oidc-secret` commands have no controlling terminal of their own
// (mirroring install-orchestrator.ts's `hasControllingTerminal: false`), so
// when they need to collect an answer interactively at all, they always
// speak this same grammar themselves — this is the "server" half, absent
// until now because bash's own TTY prompting has been the only production
// implementation. Reuses the exact validators/classifiers configure.sh's own
// TTY and machine-prompt paths both call (src/lib/config-contract.ts), so
// acceptance can never drift between the two.
// =============================================================================

export type ConfigureMachineField = "APP_URL" | "OIDC_ISSUER" | "OIDC_CLIENT_ID" | "OIDC_CLIENT_SECRET";
export type ConfigureMachineKind = "url" | "text" | "secret";
export type ConfigureMachineReason =
  | "empty"
  | "invalid-characters"
  | "not-https"
  | "not-absolute-url"
  | "forbidden-host"
  | "too-large";

/** Mirrors src/lib/recovery-prompts.ts's MachinePromptDriver shape exactly — the same write/readLine seam, scoped to configure.sh's own field vocabulary. */
export interface ConfigureMachinePromptDriver {
  write(line: string): void;
  readLine(): string | undefined;
}

/** Thrown after a third rejected answer, or end-of-input, for one field — configure.sh's own `machine_prompt_collect` returning failure for its caller to `fail` on (configure.sh:654-676). */
export class ConfigureMachinePromptAbortedError extends Error {
  readonly field: ConfigureMachineField;

  constructor(field: ConfigureMachineField) {
    super(`orbit: no valid answer was given for ${field}`);
    this.name = "ConfigureMachinePromptAbortedError";
    this.field = field;
  }
}

/** machine_prompt_field_kind (configure.sh:524-533). */
function configureMachineFieldKind(field: ConfigureMachineField): ConfigureMachineKind {
  switch (field) {
    case "APP_URL":
    case "OIDC_ISSUER":
      return "url";
    case "OIDC_CLIENT_ID":
      return "text";
    case "OIDC_CLIENT_SECRET":
      return "secret";
  }
}

const CONFIGURE_MACHINE_MAX_ATTEMPTS = 3;

/** machine_prompt_collect (configure.sh:654-676). */
function collectConfigureMachineField<T>(
  field: ConfigureMachineField,
  driver: ConfigureMachinePromptDriver,
  validate: (input: string) => T | undefined,
  classifyRejection: (input: string) => ConfigureMachineReason,
): T {
  const kind = configureMachineFieldKind(field);
  for (let attempt = 1; attempt <= CONFIGURE_MACHINE_MAX_ATTEMPTS; attempt += 1) {
    driver.write(`prompt field=${field} kind=${kind} required=true attempt=${attempt}`);
    const input = driver.readLine();
    if (input === undefined) {
      driver.write(`prompt-abort field=${field}`);
      throw new ConfigureMachinePromptAbortedError(field);
    }
    const value = validate(input);
    if (value !== undefined) {
      driver.write(`prompt-accept field=${field}`);
      return value;
    }
    driver.write(`prompt-reject field=${field} reason=${classifyRejection(input)}`);
  }
  driver.write(`prompt-abort field=${field}`);
  throw new ConfigureMachinePromptAbortedError(field);
}

/** classify_url_rejection (configure.sh:540-596): a diagnostic-only second pass, never itself deciding acceptance. */
function classifyUrlRejection(value: string, allowPath: boolean): ConfigureMachineReason {
  if (value === "") return "empty";
  if (containsForbiddenCharacters(value)) return "invalid-characters";
  if (!value.startsWith("https://")) return "not-https";
  if (value.includes("@") || value.includes("?") || value.includes("#")) return "not-absolute-url";
  let host = value.slice("https://".length);
  if (allowPath) {
    host = host.split("/")[0] ?? "";
  } else {
    host = host.replace(/\/$/, "");
    if (host.includes("/")) return "not-absolute-url";
  }
  if (host === "") return "not-absolute-url";
  if (isForbiddenHost(host.toLowerCase())) return "forbidden-host";
  return "not-absolute-url";
}

/** classify_oidc_client_id_rejection (configure.sh:606-612). */
function classifyClientIdRejection(value: string): ConfigureMachineReason {
  return value === "" ? "empty" : "invalid-characters";
}

/** classify_oidc_secret_rejection (configure.sh:618-624). */
function classifyOidcSecretRejection(value: string): ConfigureMachineReason {
  return value === "" ? "empty" : "too-large";
}

function validateAppUrlAnswer(value: string): string | undefined {
  return normalizePublicOrigin(value) ?? undefined;
}

function validateOidcIssuerAnswer(value: string): string | undefined {
  return isValidOidcIssuer(value) ? value : undefined;
}

function validateClientIdAnswer(value: string): string | undefined {
  return isValidClientId(value) ? value : undefined;
}

/** machine_validate_oidc_secret (configure.sh:640-647). */
function validateOidcSecretAnswer(value: string): string | undefined {
  if (value === "") return undefined;
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_SECRET_BYTES) return undefined;
  return value;
}

export interface CollectedGuidedInitAnswers {
  appUrl: string;
  issuer?: string;
  clientId?: string;
}

/**
 * The machine-prompt-driven collection guided_init performs when
 * `ORBIT_CONFIGURE_PROMPTS=machine` (configure.sh:698-707): APP_URL, then —
 * for `oidc` mode only — OIDC_ISSUER, then OIDC_CLIENT_ID. `authMode`
 * defaults to "oidc" to match configure.sh's own machine-prompt default
 * (guided_init: `[[ -n "$auth_mode" ]] || auth_mode="oidc"`, configure.sh
 * line ~786); "local" asks for APP_URL alone (O1-F1 — this previously had
 * no local-only path at all, so a local-only machine-prompt init always
 * demanded OIDC values the operator never intended to supply).
 */
export function collectMachineGuidedInit(driver: ConfigureMachinePromptDriver, authMode: "local" | "oidc" = "oidc"): CollectedGuidedInitAnswers {
  const appUrl = collectConfigureMachineField("APP_URL", driver, validateAppUrlAnswer, (value) => classifyUrlRejection(value, false));
  if (authMode === "local") return { appUrl };
  const issuer = collectConfigureMachineField("OIDC_ISSUER", driver, validateOidcIssuerAnswer, (value) => classifyUrlRejection(value, true));
  const clientId = collectConfigureMachineField("OIDC_CLIENT_ID", driver, validateClientIdAnswer, classifyClientIdRejection);
  return { appUrl, issuer, clientId };
}

/** The machine-prompt-driven collection set_oidc_secret performs when `ORBIT_CONFIGURE_PROMPTS=machine` (configure.sh:825-828). */
export function collectMachineOidcSecret(driver: ConfigureMachinePromptDriver): string {
  return collectConfigureMachineField("OIDC_CLIENT_SECRET", driver, validateOidcSecretAnswer, classifyOidcSecretRejection);
}

// Re-exported for tests that need to assert on raw facts without duplicating
// the predicate logic above — mirrors guided-configuration.ts's/install-
// transaction.ts's own `internal` export.
export const internal = {
  atomicWriteFile,
  pathInfo,
  exampleActiveValue,
  buildMinimalEnvironmentContent,
  environmentKeyIsNonEmpty,
  isValidLocalModel,
  classifyUrlRejection,
};
