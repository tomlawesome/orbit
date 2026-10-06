import { ALLOWED_KEYS, type AllowedKey, type EnvOrbitRecord } from "./config-contract";

// Parser for the persistent .env-orbit deployment file, mirroring
// scripts/configuration.sh line for line: the same accepted grammar, the
// same refusal codes, the same provenance rules. Pure — file safety
// (regular, non-symlink, mode 600) is the caller's responsibility because
// it needs the filesystem.

export const ENV_ORBIT_SCHEMA_VERSION = 1;

export type EnvOrbitFailureCode =
  | "configuration_syntax"
  | "configuration_unknown_key"
  | "configuration_removed_key"
  | "configuration_project"
  | "configuration_version"
  | "configuration_provenance"
  | "configuration_secret_conflict";

export type ParseEnvOrbitResult =
  | { ok: true; record: EnvOrbitRecord; schemaPresent: boolean }
  | { ok: false; code: EnvOrbitFailureCode };

// Mirrors scripts/configuration.sh's `removed_keys` (SQ1-Q1): keys this
// project used to accept and now refuses with a dedicated
// configuration_removed_key code, rather than the generic
// configuration_unknown_key an operator would otherwise get.
const REMOVED_KEYS: readonly string[] = [
  "IMAP_ENABLED",
  "IMAP_HOST",
  "IMAP_PORT",
  "IMAP_USER",
  "IMAP_PASSWORD",
  "IMAP_PASSWORD_FILE",
  "IMAP_MAILBOX",
  "IMAP_TLS_SERVER_NAME",
  "IMAP_RECIPIENT_DOMAIN",
  "IMAP_TRUSTED_RECIPIENT_HEADER",
  "IMAP_POLL_SECONDS",
  "IMAP_ALIAS_CURRENT_GENERATION",
  "IMAP_ALIAS_CURRENT_SECRET",
  "IMAP_ALIAS_CURRENT_SECRET_FILE",
  "IMAP_ALIAS_PREVIOUS_GENERATION",
  "IMAP_ALIAS_PREVIOUS_SECRET",
  "IMAP_ALIAS_PREVIOUS_SECRET_FILE",
  "IMAP_ALIAS_PREVIOUS_EXPIRES_AT",
  "IMAP_ALIAS_GENERATION",
  "IMAP_ALIAS_CURRENT_KEY",
  "IMAP_ALIAS_CURRENT_KEY_FILE",
  "IMAP_ALIAS_SECRET",
  "IMAP_ALIAS_SECRET_FILE",
  "IMAP_ALIAS_PREVIOUS_KEY",
  "IMAP_ALIAS_PREVIOUS_KEY_FILE",
  "IMAP_ALIAS_PREVIOUS_EXPIRY",
];

function isControlFree(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function isValidValue(value: string): boolean {
  if (value.length > 4096) return false;
  if (!isControlFree(value)) return false;
  if (/^\s|\s$/.test(value)) return false;
  // Mirrors scripts/configuration.sh's validate_value exactly (#383): $ and
  // ` are ambiguous to Compose's env-file parser anywhere (interpolation,
  // unescapable by a preceding backslash); a leading quote is ambiguous
  // because Compose treats it as opening a value that can run on and
  // consume following lines; a `#` is only a comment marker when preceded
  // by whitespace. A quote elsewhere in the value, or a backslash anywhere,
  // is passed through literally and no longer needs blanket rejection.
  if (/[$`]/.test(value)) return false;
  if (/^['"]/.test(value)) return false;
  if (/\s#/.test(value)) return false;
  return true;
}

function isValidComposeProjectName(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

function isValidAppliedVersion(value: string): boolean {
  return /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value);
}

function isValidAppliedDigest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function isValidImmutableImage(value: string): boolean {
  return /^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/.test(value);
}

// Direct-value/_FILE pairs the app's own contract (config-contract.ts's
// exclusivePairs) rejects as mutually exclusive, in the same order. The
// configuration migration refuses a file that sets both (#1151 O1-Q1);
// `orbit check` reports readiness without this refusal, as configure.sh
// --check always did.
const SECRET_FILE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["SESSION_SECRET", "SESSION_SECRET_FILE"],
  ["DOCUMENT_KEK", "DOCUMENT_KEK_FILE"],
  ["DOCUMENT_KEK_NEXT", "DOCUMENT_KEK_NEXT_FILE"],
  ["POSTGRES_PASSWORD", "POSTGRES_PASSWORD_FILE"],
  ["OIDC_CLIENT_SECRET", "OIDC_CLIENT_SECRET_FILE"],
  ["VAPID_PRIVATE_KEY", "VAPID_PRIVATE_KEY_FILE"],
  ["SMTP_PASSWORD", "SMTP_PASSWORD_FILE"],
  ["DATABASE_URL", "DATABASE_URL_FILE"],
  ["SMTP_URL", "SMTP_URL_FILE"],
];

export interface ParseEnvOrbitOptions {
  /** Refuse a populated direct secret beside its populated _FILE twin (configuration_secret_conflict). */
  refuseSecretConflicts?: boolean;
}

export function parseEnvOrbitContent(content: string, options: ParseEnvOrbitOptions = {}): ParseEnvOrbitResult {
  const record: EnvOrbitRecord = {};
  const seen = new Set<string>();
  let assignmentCount = 0;
  let schemaPresent = false;
  let schemaValue = "";
  let appliedVersionPresent = false;
  let appliedDigestPresent = false;
  let appliedVersionValue = "";
  let appliedDigestValue = "";
  let orbitImageValue = "";

  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!isControlFree(line)) return { ok: false, code: "configuration_syntax" };
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) return { ok: false, code: "configuration_syntax" };
    const key = match[1];
    const value = match[2];
    if (seen.has(key)) return { ok: false, code: "configuration_syntax" };
    seen.add(key);
    assignmentCount += 1;
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        code: REMOVED_KEYS.includes(key)
          ? "configuration_removed_key"
          : "configuration_unknown_key",
      };
    }
    if (!isValidValue(value)) return { ok: false, code: "configuration_syntax" };
    switch (key) {
      case "ORBIT_CONFIG_SCHEMA_VERSION":
        schemaPresent = true;
        schemaValue = value;
        break;
      case "ORBIT_IMAGE":
        orbitImageValue = value;
        break;
      case "ORBIT_CONFIG_APPLIED_VERSION":
        appliedVersionPresent = true;
        appliedVersionValue = value;
        break;
      case "ORBIT_CONFIG_APPLIED_DIGEST":
        appliedDigestPresent = true;
        appliedDigestValue = value;
        break;
      case "COMPOSE_PROJECT_NAME":
        if (!isValidComposeProjectName(value)) {
          return { ok: false, code: "configuration_project" };
        }
        break;
    }
    record[key as AllowedKey] = value;
  }

  if (assignmentCount === 0) return { ok: false, code: "configuration_syntax" };
  if (options.refuseSecretConflicts) {
    const values = record as Record<string, string | undefined>;
    for (const [direct, file] of SECRET_FILE_PAIRS) {
      // An empty direct placeholder beside a populated _FILE value (the shape
      // configure writes for OIDC_CLIENT_SECRET) is not a conflict.
      if (values[direct] && values[file]) return { ok: false, code: "configuration_secret_conflict" };
    }
  }
  if (schemaValue && schemaValue !== String(ENV_ORBIT_SCHEMA_VERSION)) {
    return { ok: false, code: "configuration_version" };
  }

  if (appliedVersionPresent !== appliedDigestPresent) {
    return { ok: false, code: "configuration_provenance" };
  }
  if (appliedVersionPresent) {
    if (
      !isValidAppliedVersion(appliedVersionValue) ||
      !isValidAppliedDigest(appliedDigestValue) ||
      !isValidImmutableImage(orbitImageValue) ||
      orbitImageValue.split("@").pop() !== appliedDigestValue
    ) {
      return { ok: false, code: "configuration_provenance" };
    }
  }

  return { ok: true, record, schemaPresent };
}
