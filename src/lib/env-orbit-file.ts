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
  | "configuration_provenance";

export type ParseEnvOrbitResult =
  | { ok: true; record: EnvOrbitRecord; schemaPresent: boolean }
  | { ok: false; code: EnvOrbitFailureCode };

const REMOVED_KEYS: readonly string[] = [];

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
  // Forms ambiguous to Compose or a shell-like dotenv parser.
  return !/[$`"'#\\]/.test(value);
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

export function parseEnvOrbitContent(content: string): ParseEnvOrbitResult {
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
