import type { MalwareScanResult } from "@/server/documents/scanner";

export const SCANNER_RECOVERY_MAX_ATTEMPTS = 5;
export const SCANNER_RECOVERY_LEASE_MS = 10 * 60 * 1_000;

export const retryableScannerFailureCodes = [
  "scanner_unavailable",
  "scanner_timeout",
  "scanner_protocol",
] as const;

export type RetryableScannerFailureCode = typeof retryableScannerFailureCodes[number];

export function retryableScannerFailureCode(result: MalwareScanResult): RetryableScannerFailureCode | undefined {
  if (result.status !== "error") return undefined;
  if (result.reason === "unavailable") return "scanner_unavailable";
  if (result.reason === "timeout") return "scanner_timeout";
  if (result.reason === "protocol") return "scanner_protocol";
  return undefined;
}

export function scannerRecoveryDelayMs(attempt: number): number {
  const boundedAttempt = Math.max(1, Math.min(attempt, SCANNER_RECOVERY_MAX_ATTEMPTS));
  return Math.min(60 * 1_000 * (2 ** (boundedAttempt - 1)), 15 * 60 * 1_000);
}

export function isRetryableScannerFailureCode(value: string | null | undefined): value is RetryableScannerFailureCode {
  return Boolean(value && (retryableScannerFailureCodes as readonly string[]).includes(value));
}

export function isScannerRecoveryExpired(expiresAt: Date, now = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}
