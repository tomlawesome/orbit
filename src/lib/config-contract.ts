import { z } from "zod";

// The .env-orbit configuration contract (ADR-0011, issue #292): the single
// TypeScript source of truth for the deployment configuration, mirroring the
// operator-facing semantics implemented today by scripts/configure.sh and
// scripts/configuration.sh. Parity with `configure.sh --check` is enforced
// line-for-line by src/lib/config-contract.parity.test.ts — a semantic
// change on either side fails that test, so the two implementations cannot
// drift silently while the Phase 2 engine port is in progress.
//
// evaluateReadiness is deliberately pure: filesystem facts are injected, so
// the same logic serves the application, the future engine CLI, and tests.

// Keys accepted in .env-orbit, exactly matching `allowed_keys` in
// scripts/configuration.sh.
export const ALLOWED_KEYS = [
  "APP_URL",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_CLIENT_SECRET_FILE",
  "OIDC_CALLBACK_URL",
  "ORBIT_IMAGE",
  "ORBIT_CONFIG_APPLIED_VERSION",
  "ORBIT_CONFIG_APPLIED_DIGEST",
  "COMPOSE_PROJECT_NAME",
  "SESSION_SECRET",
  "SESSION_SECRET_FILE",
  "DOCUMENT_KEK",
  "DOCUMENT_KEK_FILE",
  "POSTGRES_PASSWORD",
  "POSTGRES_PASSWORD_FILE",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_PRIVATE_KEY_FILE",
  "ORBIT_BIND_ADDRESS",
  "ORBIT_PORT",
  "ORBIT_LOG_LEVEL",
  "ORBIT_LOG_FORMAT",
  "COMPOSE_PROFILES",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "DATABASE_URL",
  "DATABASE_URL_FILE",
  "DOCUMENTS_ROOT",
  "DOCUMENTS_QUARANTINE_ROOT",
  "DOCUMENT_MAX_BYTES",
  "DOCUMENT_HOUSEHOLD_QUOTA_BYTES",
  "DOCUMENT_INSTANCE_QUOTA_BYTES",
  "DOCUMENT_RETENTION_DAYS",
  "DOCUMENT_SCAN_RECOVERY_RETENTION_HOURS",
  "DOCUMENT_SCAN_MODE",
  "CLAMAV_HOST",
  "CLAMAV_PORT",
  "CLAMAV_TIMEOUT_MS",
  "CLAMAV_MEMORY_LIMIT",
  "TIKA_URL",
  "TIKA_TIMEOUT_MS",
  "TIKA_MEMORY_LIMIT",
  "OLLAMA_MODEL",
  "OLLAMA_MEMORY_LIMIT",
  "OLLAMA_CPUS",
  "OLLAMA_MAX_QUEUE",
  "OLLAMA_KEEP_ALIVE",
  "IMAP_ENABLED",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURITY",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_PASSWORD_FILE",
  "SMTP_FROM",
  "SMTP_URL",
  "SMTP_URL_FILE",
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
  "VAPID_SUBJECT",
  "SESSION_TTL_SECONDS",
  "OIDC_SCOPES",
  "OIDC_EMAIL_CLAIM",
  "OIDC_EMAIL_VERIFIED_CLAIM",
  "OIDC_NAME_CLAIM",
  "OIDC_AVATAR_CLAIM",
  "WORKER_POLL_SECONDS",
  "MAINTENANCE_TICK_SECONDS",
  "NOTIFICATION_MAX_ATTEMPTS",
  "MIGRATE_ON_START",
  "WORKER_ENABLED",
  "DRIZZLE_MIGRATIONS_PATH",
  "ORBIT_SECRETS_DIR",
  "ORBIT_CONFIG_SCHEMA_VERSION",
] as const;

export type AllowedKey = (typeof ALLOWED_KEYS)[number];
export type EnvOrbitRecord = Partial<Record<AllowedKey, string>>;

// Canonical in-container mount for the file-backed OIDC client secret; the
// only OIDC_CLIENT_SECRET_FILE value `--check` accepts as ready.
export const CANONICAL_OIDC_SECRET_FILE_PATH =
  "/run/orbit-secrets/orbit-oidc-client-secret";

// The one true callback path: the deployment contract derives the
// registered callback from APP_URL with it, and the runtime derives the
// default the same way (src/lib/env.ts).
export const OIDC_CALLBACK_PATH = "/api/auth/callback";

const HOSTNAME_PATTERN =
  /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// Exported for src/lib/configure-engine.ts's machine-prompt rejection
// classifiers (classifyUrlRejection etc.), which need the same underlying
// predicates configure.sh's own classify_*_rejection helpers use — a
// diagnostic-only second pass over an answer already known to be rejected,
// never itself deciding acceptance (docs/engine-events.md, "Machine prompts
// (v0)" §Validation).
export function containsForbiddenCharacters(value: string): boolean {
  // Bash [[:cntrl:][:space:]]: any whitespace or control character.
  return /[\s\u0000-\u001f\u007f]/.test(value);
}

export function isForbiddenHost(host: string): boolean {
  const bare = host.replace(/:.*$/, "");
  if (["127.0.0.1", "localhost", "0.0.0.0", "::1"].includes(bare)) return true;
  if (bare.startsWith("127.")) return true;
  if (bare === "example.com" || bare.endsWith(".example.com")) return true;
  return false;
}

function validateAuthority(authority: string): boolean {
  let host = authority;
  if (authority.includes(":")) {
    host = authority.slice(0, authority.lastIndexOf(":"));
    const port = authority.slice(authority.lastIndexOf(":") + 1);
    if (!/^[0-9]{1,5}$/.test(port)) return false;
    const numeric = Number.parseInt(port, 10);
    if (numeric < 1 || numeric > 65535) return false;
  }
  if (!HOSTNAME_PATTERN.test(host)) return false;
  return !isForbiddenHost(authority);
}

// Mirrors configure.sh normalize_public_origin: https public origin with no
// credentials, path, query, fragment, loopback or example.com placeholder.
// Returns the lowercase-normalised origin, or null when invalid.
export function normalizePublicOrigin(value: string): string | null {
  if (containsForbiddenCharacters(value)) return null;
  if (!value.startsWith("https://")) return null;
  if (value.includes("@") || value.includes("?") || value.includes("#")) return null;
  const trimmed = value.replace(/\/$/, "");
  const host = trimmed.slice("https://".length);
  if (host.includes("/") || host.length === 0) return null;
  const lower = host.toLowerCase();
  if (!validateAuthority(lower)) return null;
  return `https://${lower}`;
}

// Mirrors configure.sh validate_oidc_issuer: https, no credentials, query or
// fragment; a provider-specific path is allowed; same forbidden-host rules.
export function isValidOidcIssuer(value: string): boolean {
  if (containsForbiddenCharacters(value)) return false;
  if (!value.startsWith("https://")) return false;
  if (value.includes("@") || value.includes("?") || value.includes("#")) return false;
  const rest = value.slice("https://".length);
  const authority = rest.split("/")[0] ?? "";
  if (authority.length === 0) return false;
  return validateAuthority(authority.toLowerCase());
}

export function isValidOrbitImage(value: string): boolean {
  return (
    /^orbit-local:[0-9a-f]{12}$/.test(value) ||
    /^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/.test(value)
  );
}

export function isValidClientId(value: string): boolean {
  return value.length > 0 && !containsForbiddenCharacters(value);
}

// Field-format schema: shape validation for every allowed key when present.
// Cross-field and filesystem-dependent readiness lives in evaluateReadiness.
export const envOrbitSchema = z
  .object({
    APP_URL: z.string().optional(),
    OIDC_ISSUER: z.string().optional(),
    OIDC_CLIENT_ID: z.string().optional(),
    OIDC_CLIENT_SECRET: z.string().optional(),
    OIDC_CLIENT_SECRET_FILE: z.string().optional(),
    OIDC_CALLBACK_URL: z.string().optional(),
    ORBIT_IMAGE: z
      .string()
      .refine((v) => v === "" || isValidOrbitImage(v), {
        message: "ORBIT_IMAGE must be digest-pinned or an installer-local tag",
      })
      .optional(),
    ORBIT_CONFIG_APPLIED_VERSION: z
      .string()
      .regex(/^$|^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/)
      .optional(),
    ORBIT_CONFIG_APPLIED_DIGEST: z
      .string()
      .regex(/^$|^sha256:[0-9a-f]{64}$/)
      .optional(),
    SESSION_SECRET: z.string().regex(/^$|^[0-9a-fA-F]{64}$/).optional(),
    DOCUMENT_KEK: z.string().regex(/^$|^[0-9a-fA-F]{64}$/).optional(),
    ORBIT_PORT: z.string().regex(/^$|^[0-9]{1,5}$/).optional(),
    POSTGRES_PORT: z.string().regex(/^$|^[0-9]{1,5}$/).optional(),
    ORBIT_LOG_LEVEL: z.enum(["", "error", "warn", "info", "debug"]).optional(),
    ORBIT_LOG_FORMAT: z.enum(["", "text", "json"]).optional(),
    DOCUMENT_SCAN_MODE: z.enum(["", "required", "disabled"]).optional(),
    SMTP_SECURITY: z.enum(["", "starttls", "implicit_tls"]).optional(),
    IMAP_ENABLED: z.enum(["", "true", "false"]).optional(),
    MIGRATE_ON_START: z.enum(["", "true", "false"]).optional(),
    WORKER_ENABLED: z.enum(["", "true", "false"]).optional(),
  })
  .catchall(z.string())
  .superRefine((record, context) => {
    for (const key of Object.keys(record)) {
      if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is not a supported .env-orbit key`,
        });
      }
    }
    const exclusivePairs: Array<[AllowedKey, AllowedKey]> = [
      ["SESSION_SECRET", "SESSION_SECRET_FILE"],
      ["DOCUMENT_KEK", "DOCUMENT_KEK_FILE"],
      ["POSTGRES_PASSWORD", "POSTGRES_PASSWORD_FILE"],
      ["OIDC_CLIENT_SECRET", "OIDC_CLIENT_SECRET_FILE"],
      ["VAPID_PRIVATE_KEY", "VAPID_PRIVATE_KEY_FILE"],
      ["SMTP_PASSWORD", "SMTP_PASSWORD_FILE"],
      ["IMAP_PASSWORD", "IMAP_PASSWORD_FILE"],
      ["DATABASE_URL", "DATABASE_URL_FILE"],
      ["SMTP_URL", "SMTP_URL_FILE"],
    ];
    for (const [direct, file] of exclusivePairs) {
      if (record[direct] && record[file]) {
        context.addIssue({
          code: "custom",
          path: [direct],
          message: `${direct} and ${file} are mutually exclusive`,
        });
      }
    }
  });

export interface OidcSecretFileFacts {
  secretsDirectoryExists: boolean;
  secretsDirectoryIsSymlink: boolean;
  secretsDirectoryMode: number | null;
  secretFileExists: boolean;
  secretFileIsRegular: boolean;
  secretFileIsSymlink: boolean;
  secretFileMode: number | null;
  secretFileSize: number;
}

export interface ReadinessReport {
  lines: string[];
  ok: boolean;
}

function isSet(record: EnvOrbitRecord, key: AllowedKey): boolean {
  return (record[key] ?? "") !== "";
}

function anySet(record: EnvOrbitRecord, ...keys: AllowedKey[]): boolean {
  return keys.some((key) => isSet(record, key));
}

function allSet(record: EnvOrbitRecord, ...keys: AllowedKey[]): boolean {
  return keys.every((key) => isSet(record, key));
}

function exactlyOneSet(record: EnvOrbitRecord, a: AllowedKey, b: AllowedKey): boolean {
  return isSet(record, a) !== isSet(record, b);
}

function profileEnabled(record: EnvOrbitRecord, profile: string): boolean {
  return (record.COMPOSE_PROFILES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .includes(profile);
}

// Mirrors the readiness report of `configure.sh --check` line for line:
// required core fields first, then the optional groups, in the same order
// with the same ready/missing/optional labels. The parity test compares
// this output against the real script's output for identical fixtures.
export function evaluateReadiness(
  record: EnvOrbitRecord,
  oidcSecretFacts: OidcSecretFileFacts,
): ReadinessReport {
  const lines: string[] = [];
  let ok = true;

  const required = (label: string, ready: boolean) => {
    lines.push(`${ready ? "ready" : "missing"} ${label}`);
    if (!ready) ok = false;
  };
  const optional = (label: string, ready: boolean, present: boolean) => {
    if (ready) lines.push(`ready ${label}`);
    else if (present) {
      lines.push(`missing ${label}`);
      ok = false;
    } else lines.push(`optional ${label}`);
  };

  const normalizedAppUrl = isSet(record, "APP_URL")
    ? normalizePublicOrigin(record.APP_URL as string)
    : null;
  const appUrlReady = normalizedAppUrl !== null;
  const imageReady =
    isSet(record, "ORBIT_IMAGE") && isValidOrbitImage(record.ORBIT_IMAGE as string);
  const issuerReady =
    isSet(record, "OIDC_ISSUER") && isValidOidcIssuer(record.OIDC_ISSUER as string);
  const clientIdReady =
    isSet(record, "OIDC_CLIENT_ID") && isValidClientId(record.OIDC_CLIENT_ID as string);
  const callbackReady =
    appUrlReady &&
    (record.OIDC_CALLBACK_URL ?? "") === `${normalizedAppUrl}${OIDC_CALLBACK_PATH}`;

  let oidcSecretReady = false;
  if (isSet(record, "OIDC_CLIENT_SECRET") && !isSet(record, "OIDC_CLIENT_SECRET_FILE")) {
    oidcSecretReady = true;
  } else if (
    !isSet(record, "OIDC_CLIENT_SECRET") &&
    record.OIDC_CLIENT_SECRET_FILE === CANONICAL_OIDC_SECRET_FILE_PATH &&
    oidcSecretFacts.secretsDirectoryExists &&
    !oidcSecretFacts.secretsDirectoryIsSymlink &&
    oidcSecretFacts.secretsDirectoryMode === 0o700 &&
    oidcSecretFacts.secretFileExists &&
    oidcSecretFacts.secretFileIsRegular &&
    !oidcSecretFacts.secretFileIsSymlink &&
    oidcSecretFacts.secretFileSize > 0 &&
    oidcSecretFacts.secretFileMode === 0o600
  ) {
    oidcSecretReady = true;
  }

  required("APP_URL", appUrlReady);
  required("ORBIT_IMAGE", imageReady);
  required("OIDC_ISSUER", issuerReady);
  required("OIDC_CLIENT_ID", clientIdReady);
  required("OIDC_CLIENT_SECRET", oidcSecretReady);
  required("OIDC_CALLBACK_URL", callbackReady);

  const processingPresent =
    profileEnabled(record, "processing") || isSet(record, "TIKA_URL");
  const processingReady =
    profileEnabled(record, "processing") && isSet(record, "TIKA_URL");
  optional("processing", processingReady, processingPresent);

  const aiPresent = profileEnabled(record, "ai") || isSet(record, "OLLAMA_MODEL");
  const aiReady = profileEnabled(record, "ai") && isSet(record, "OLLAMA_MODEL");
  optional("ai", aiReady, aiPresent);

  const mailPresent = anySet(
    record,
    "SMTP_HOST",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_PASSWORD_FILE",
    "SMTP_URL",
    "SMTP_URL_FILE",
  );
  let mailReady = false;
  if (
    exactlyOneSet(record, "SMTP_URL", "SMTP_URL_FILE") &&
    !anySet(record, "SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_PASSWORD_FILE")
  ) {
    mailReady = true;
  } else if (
    allSet(record, "SMTP_HOST", "SMTP_USER") &&
    exactlyOneSet(record, "SMTP_PASSWORD", "SMTP_PASSWORD_FILE") &&
    !anySet(record, "SMTP_URL", "SMTP_URL_FILE")
  ) {
    mailReady = true;
  }
  optional("mail", mailReady, mailPresent);

  const imapEnabled = (record.IMAP_ENABLED ?? "false") === "true";
  const imapPresent =
    imapEnabled ||
    anySet(
      record,
      "IMAP_HOST",
      "IMAP_USER",
      "IMAP_PASSWORD",
      "IMAP_PASSWORD_FILE",
      "IMAP_RECIPIENT_DOMAIN",
      "IMAP_ALIAS_CURRENT_GENERATION",
      "IMAP_ALIAS_CURRENT_SECRET",
      "IMAP_ALIAS_CURRENT_SECRET_FILE",
      "IMAP_TRUSTED_RECIPIENT_HEADER",
    );
  const imapReady =
    imapEnabled &&
    allSet(
      record,
      "IMAP_HOST",
      "IMAP_USER",
      "IMAP_RECIPIENT_DOMAIN",
      "IMAP_ALIAS_CURRENT_GENERATION",
      "IMAP_TRUSTED_RECIPIENT_HEADER",
    ) &&
    exactlyOneSet(record, "IMAP_PASSWORD", "IMAP_PASSWORD_FILE") &&
    exactlyOneSet(record, "IMAP_ALIAS_CURRENT_SECRET", "IMAP_ALIAS_CURRENT_SECRET_FILE") &&
    mailReady;
  optional("imap", imapReady, imapPresent);

  const pushPresent = isSet(record, "VAPID_SUBJECT");
  const pushReady =
    isSet(record, "VAPID_SUBJECT") &&
    isSet(record, "VAPID_PUBLIC_KEY") &&
    exactlyOneSet(record, "VAPID_PRIVATE_KEY", "VAPID_PRIVATE_KEY_FILE");
  optional("push", pushReady, pushPresent);

  return { lines, ok };
}
