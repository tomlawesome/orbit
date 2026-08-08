import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readRuntimeSecret } from "@/lib/runtime-secret";

const MIB = 1_048_576;
const GIB = 1_073_741_824;

const documentEnvironmentSchema = z.object({
  DOCUMENTS_ROOT: z.string().min(1).default("/var/lib/orbit/documents"),
  DOCUMENTS_QUARANTINE_ROOT: z.string().min(1).default("/tmp/orbit-document-quarantine"),
  DOCUMENT_MAX_BYTES: z.coerce.number().int().min(MIB).max(100 * MIB).default(25 * MIB),
  DOCUMENT_HOUSEHOLD_QUOTA_BYTES: z.coerce.number().int().min(25 * MIB).max(10_000 * GIB).default(5 * GIB),
  DOCUMENT_INSTANCE_QUOTA_BYTES: z.coerce.number().int().min(25 * MIB).max(100_000 * GIB).default(20 * GIB),
  DOCUMENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(30),
  DOCUMENT_SCAN_RECOVERY_RETENTION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  DOCUMENT_SCAN_MODE: z.enum(["required", "disabled"]).default("required"),
  CLAMAV_HOST: z.string().min(1).default("orbit-clamav"),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65_535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  TIKA_URL: z.preprocess((value) => value === "" ? undefined : value, z.url().optional()),
  TIKA_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(45_000),
  DOCUMENT_KEK: z.string().regex(/^[a-fA-F0-9]{64}$/, "DOCUMENT_KEK must be exactly 32 bytes encoded as hexadecimal"),
});

export interface DocumentConfig {
  storageRoot: string;
  quarantineRoot: string;
  maxBytes: number;
  householdQuotaBytes: number;
  instanceQuotaBytes: number;
  retentionDays: number;
  scanRecoveryRetentionHours: number;
  scanMode: "required" | "disabled";
  clamAv: {
    host: string;
    port: number;
    timeoutMs: number;
  };
  tika: {
    url: URL | null;
    timeoutMs: number;
  };
  keyEncryptionKey: Buffer;
  keyId: string;
}

let cachedDocumentConfig: DocumentConfig | undefined;

/**
 * Loads document configuration lazily so builds and non-document routes do not
 * require the document key. The raw key never leaves this server-only module.
 */
export function getDocumentConfig(environment: NodeJS.ProcessEnv = process.env): DocumentConfig {
  if (environment === process.env && cachedDocumentConfig) return cachedDocumentConfig;

  const parsed = documentEnvironmentSchema.parse({
    ...environment,
    DOCUMENT_KEK: readRuntimeSecret(environment, "DOCUMENT_KEK"),
  });
  if (parsed.DOCUMENT_HOUSEHOLD_QUOTA_BYTES > parsed.DOCUMENT_INSTANCE_QUOTA_BYTES) {
    throw new Error("DOCUMENT_HOUSEHOLD_QUOTA_BYTES cannot exceed DOCUMENT_INSTANCE_QUOTA_BYTES");
  }

  const keyEncryptionKey = Buffer.from(parsed.DOCUMENT_KEK, "hex");
  const config: DocumentConfig = {
    storageRoot: resolve(parsed.DOCUMENTS_ROOT),
    quarantineRoot: resolve(parsed.DOCUMENTS_QUARANTINE_ROOT),
    maxBytes: parsed.DOCUMENT_MAX_BYTES,
    householdQuotaBytes: parsed.DOCUMENT_HOUSEHOLD_QUOTA_BYTES,
    instanceQuotaBytes: parsed.DOCUMENT_INSTANCE_QUOTA_BYTES,
    retentionDays: parsed.DOCUMENT_RETENTION_DAYS,
    scanRecoveryRetentionHours: parsed.DOCUMENT_SCAN_RECOVERY_RETENTION_HOURS,
    scanMode: parsed.DOCUMENT_SCAN_MODE,
    clamAv: {
      host: parsed.CLAMAV_HOST,
      port: parsed.CLAMAV_PORT,
      timeoutMs: parsed.CLAMAV_TIMEOUT_MS,
    },
    tika: {
      url: parsed.TIKA_URL ? new URL(parsed.TIKA_URL) : null,
      timeoutMs: parsed.TIKA_TIMEOUT_MS,
    },
    keyEncryptionKey,
    keyId: createHash("sha256").update("orbit-document-kek-v1\0").update(keyEncryptionKey).digest("hex").slice(0, 24),
  };

  if (config.storageRoot === config.quarantineRoot) {
    throw new Error("DOCUMENTS_ROOT and DOCUMENTS_QUARANTINE_ROOT must be separate");
  }
  if (environment === process.env) cachedDocumentConfig = config;
  return config;
}

export function resetDocumentConfigForTests(): void {
  cachedDocumentConfig = undefined;
}
