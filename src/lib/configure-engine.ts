import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  CANONICAL_OIDC_SECRET_FILE_PATH,
  OIDC_CALLBACK_PATH,
  SECRET_HEX256_PATTERN,
  containsForbiddenCharacters,
  isForbiddenHost,
  isValidClientId,
  isValidOidcIssuer,
  isValidOrbitImage,
  normalizePublicOrigin,
  secretFileFormatMessage,
} from "./config-contract";
import { parseEnvOrbitContent } from "./env-orbit-file";

// The write side of scripts/configure.sh, ported to the TypeScript engine
// (issue #294, completing the port begun for `--check` in src/lib/
// config-contract.ts / src/lib/env-orbit-file.ts). Guarantee numbers below
// cite docs/installer-guarantees.md's `configure.sh` section (items 1-33)
// and are re-asserted by name in src/lib/configure-engine.test.ts and
// src/lib/configure-engine.parity.test.ts.
//
// Scope: every configure.sh write flow EXCEPT `ensure_vapid_keys`
// (configure.sh:684-716, guarantees #24-26), which is the one sub-step that
// genuinely needs `docker` (to either run an already-resolved ORBIT_IMAGE or
// build+run a throwaway bootstrap image). Per the settled #295 engine-
// delivery architecture ("the engine can never manage the Docker socket.
// Ever." / "host scripts remain the only Docker-touching layer"), that step
// cannot move into this module or into the containerized `orbit configure`
// CLI command it backs — it stays bash-only, always, run by
// scripts/configure.sh itself immediately after delegating (or running
// locally) everything else this module implements. This is a permanent
// scope boundary, not a placeholder: see docs/adr-notes/294-configure-write-
// port-plan.md, "Docker-dependency audit".
//
// Schema-migration handoff: configure.sh's own `run_configuration_preflight`
// delegates to `configuration.sh --preflight` as a subprocess. That script
// is not shipped inside the app image (only the bundled `orbit` CLI itself
// is — see the Dockerfile's `cli-builder`/`runner` stages), so a real
// in-container subprocess hand-off is not possible here. Instead
// runConfigurePreflight below reuses src/lib/env-orbit-file.ts's
// parseEnvOrbitContent — itself already the parity-proven TypeScript mirror
// of configuration.sh's own `parse_file` (established for #292/the `check`
// port) — rather than re-deriving new parsing/validation logic. This is
// "mirror it, don't reimplement it" applied to the one mirror that already
// exists and is already proven, not a fresh reimplementation.
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
  | "write-failed";

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
  } catch {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* best effort cleanup */
    }
    refuse(`Could not write ${finalPath}.`, "write-failed");
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
    entries: [{ key: "TIKA_URL" }, { key: "OLLAMA_MODEL" }, { key: "IMAP_ENABLED" }],
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

/** ensure_secret_file (configure.sh:747-772, guarantees #15-16), used for session-secret/postgres-password/document-kek. */
export function ensureSecretFile(deployDir: string, relativePath: string): EnsureSecretFileResult {
  const path = join(deployDir, relativePath);
  const info = pathInfo(path);
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

/** ensure_oidc_secret_placeholder (configure.sh:786-814, guarantees #18-19). */
export function ensureOidcSecretPlaceholder(deployDir: string): void {
  if (environmentKeyIsNonEmpty(deployDir, "OIDC_CLIENT_SECRET") && !environmentKeyIsNonEmpty(deployDir, "OIDC_CLIENT_SECRET_FILE")) {
    return;
  }

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

  ensureEnvironmentFile(deployDir);
  ensureSecretsDirectory(deployDir);

  const secretPath = join(deployDir, OIDC_SECRET_RELATIVE_PATH);
  atomicWriteFile(secretPath, secret, 0o600, "installing");

  updateManagedKeys(deployDir, [
    ["OIDC_CLIENT_SECRET", ""],
    ["OIDC_CLIENT_SECRET_FILE", CANONICAL_OIDC_SECRET_FILE_PATH],
  ]);

  return `Orbit saved the OIDC client secret to ${OIDC_SECRET_RELATIVE_PATH}.`;
}

// --- guided configuration (--init) --------------------------------------

export interface GuidedInitInput {
  appUrl: string;
  issuer: string;
  clientId: string;
}

/** guided_init's validate-then-write tail (configure.sh:684-745, guarantees #11-14), given already-collected candidate answers (TTY prompting, the ORBIT_CONFIGURE_* env triad, or #297 machine prompts are all the caller's concern — see the CLI wiring in src/cli/orbit.ts). Writes nothing until all three re-validate. */
export function applyGuidedInit(deployDir: string, input: GuidedInitInput): string {
  const normalizedAppUrl = normalizePublicOrigin(input.appUrl);
  if (!normalizedAppUrl) {
    refuse(
      "APP_URL must be a complete https:// public origin with no credentials, path, query, fragment, loopback address or example.com placeholder.",
      "guided-configuration-invalid",
    );
  }
  if (!isValidOidcIssuer(input.issuer)) {
    refuse(
      "OIDC_ISSUER must be a complete https:// issuer URL with no credentials, query, fragment, loopback address or example.com placeholder.",
      "guided-configuration-invalid",
    );
  }
  if (!isValidClientId(input.clientId)) {
    refuse("OIDC_CLIENT_ID must be a non-empty value with no whitespace or control characters.", "guided-configuration-invalid");
  }

  const callbackUrl = `${normalizedAppUrl}${OIDC_CALLBACK_PATH}`;
  ensureEnvironmentFile(deployDir);
  updateManagedKeys(deployDir, [
    ["APP_URL", normalizedAppUrl],
    ["OIDC_ISSUER", input.issuer],
    ["OIDC_CLIENT_ID", input.clientId],
    ["OIDC_CALLBACK_URL", callbackUrl],
  ]);

  return "Orbit guided configuration saved APP_URL, OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CALLBACK_URL.";
}

// --- deployment profile ---------------------------------------------------

function isValidLocalModel(value: string): boolean {
  if (value.length < 1 || value.length > 128) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(value);
}

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

  ensureEnvironmentFile(deployDir);
  updateManagedKeys(deployDir, [
    ["COMPOSE_PROFILES", profiles],
    ["TIKA_URL", tikaUrl],
    ["OLLAMA_MODEL", model ?? ""],
  ]);

  return `Orbit deployment profile saved: ${preset}.`;
}

// --- configuration preflight (configuration.sh --preflight handoff) --------

export type ConfigurePreflightOutcome =
  | { ok: true }
  | { ok: false; code: "preflight-failed" | "configuration-migration-required" };

/**
 * run_configuration_preflight (configure.sh:42-51, guarantee #2). bash
 * drives `configuration.sh --preflight` as a subprocess; that script is not
 * shipped inside the app image, so this reuses env-orbit-file.ts's
 * parseEnvOrbitContent — the existing parity-proven mirror of
 * configuration.sh's own `parse_file` — instead (see this module's header
 * comment). File-safety (regular, non-symlink, mode 600) is re-checked here
 * the same way src/cli/orbit.ts's commandCheck does: a single O_NOFOLLOW
 * descriptor so the safety check and the content read cannot be split by a
 * file swap. Deliberately not a separate existsSync-then-open pair (CodeQL
 * js/file-system-race): "does the file exist" is answered by the same
 * openSync call that reads it, dispatching on its own failure code —
 * mirroring recovery-bundle.ts's readRegularFileNoFollow, whose own comment
 * notes "a dangling/symlink path surfaces as ELOOP/ENOENT from the single
 * open call itself." Only a true ENOENT (nothing at this path at all) skips
 * preflight, matching bash's `[[ ! -e ]]`; a symlinked `.env-orbit` (ELOOP)
 * fails closed here rather than bash's own dangling-symlink-only skip —
 * strictly more conservative, not a behavioral regression.
 */
export function runConfigurePreflight(deployDir: string): ConfigurePreflightOutcome {
  const envPath = join(deployDir, ENVIRONMENT_FILE_NAME);

  let descriptor: number;
  try {
    descriptor = openSync(envPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true };
    return { ok: false, code: "preflight-failed" };
  }
  let content: string;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      return { ok: false, code: "preflight-failed" };
    }
    content = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }

  const parsed = parseEnvOrbitContent(content);
  if (!parsed.ok) return { ok: false, code: "preflight-failed" };
  if (!parsed.schemaPresent) return { ok: false, code: "configuration-migration-required" };
  return { ok: true };
}

// --- the bare (no-argument) flow, minus ensure_vapid_keys ------------------

const GENERATED_SECRET_RELATIVE_PATHS = [
  `${SECRETS_DIRECTORY_NAME}/session-secret`,
  `${SECRETS_DIRECTORY_NAME}/postgres-password`,
  `${SECRETS_DIRECTORY_NAME}/document-kek`,
];

export interface ConfigureApplyResult {
  messages: string[];
}

/**
 * configure.sh's bare/default invocation (configure.sh:1156-1167), minus
 * `ensure_vapid_keys` (guarantees #24-26) — see this module's header
 * comment for why that step is permanently out of scope here. The caller
 * (scripts/configure.sh, when delegating, or src/cli/orbit.ts's `configure`
 * command) is responsible for running the VAPID step and printing the final
 * "Orbit configuration is ready..." message itself, in that order, so
 * combined output stays in the same sequence configure.sh has always used.
 */
export function runConfigureApply(deployDir: string, orbitImage: string | undefined): ConfigureApplyResult {
  const messages: string[] = [];

  const envResult = ensureEnvironmentFile(deployDir);
  if (envResult.message) messages.push(envResult.message);

  const preflight = runConfigurePreflight(deployDir);
  if (!preflight.ok) {
    if (preflight.code === "configuration-migration-required") {
      refuse("configuration_migration_required", preflight.code);
    }
    refuse("Configuration preflight failed; restoring the previous deployment.", preflight.code);
  }

  persistOrbitImage(deployDir, orbitImage);
  ensureSecretsDirectory(deployDir);

  for (const relativePath of GENERATED_SECRET_RELATIVE_PATHS) {
    const result = ensureSecretFile(deployDir, relativePath);
    if (result.message) messages.push(result.message);
  }

  ensureOidcSecretPlaceholder(deployDir);

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
  issuer: string;
  clientId: string;
}

/** The machine-prompt-driven collection guided_init performs when `ORBIT_CONFIGURE_PROMPTS=machine` (configure.sh:698-707): APP_URL, then OIDC_ISSUER, then OIDC_CLIENT_ID, in that order. */
export function collectMachineGuidedInit(driver: ConfigureMachinePromptDriver): CollectedGuidedInitAnswers {
  const appUrl = collectConfigureMachineField("APP_URL", driver, validateAppUrlAnswer, (value) => classifyUrlRejection(value, false));
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
  pathInfo,
  exampleActiveValue,
  buildMinimalEnvironmentContent,
  environmentKeyIsNonEmpty,
  isValidLocalModel,
  classifyUrlRejection,
};
