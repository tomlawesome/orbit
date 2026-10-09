/**
 * The one place a malware-scan result becomes a decision (#1349, engine-7).
 *
 * Five callers used to map `MalwareScanResult` by hand and disagreed about a
 * scanner `protocol` error. They still own their own flow -- what to store,
 * what to throw, whether to stage for retry -- but none of them re-derives
 * what the result *means*.
 *
 * Fail closed, by construction: only a result whose `status` is exactly
 * "clean" classifies as clean. A protocol error, a scanner-reported error, an
 * error with no reason and a status nobody recognises are all "error", so the
 * unsafe direction -- a file becoming available because the scanner said
 * something unexpected -- has no branch to take. Only `unavailable`, `timeout`
 * and `protocol` are retryable (ADR-0010); every other non-clean outcome is
 * terminal.
 */
import { AppError } from "@/lib/errors";
import type { MalwareScanResult } from "@/server/documents/scanner";

/** The fixed, non-secret reasons a scan outcome is logged under. */
export type ScanLogReason =
  | "malware_detected"
  | "scanner_unavailable"
  | "scanner_timeout"
  | "scanner_protocol"
  | "scanner_failed";

/** The code a path records for each non-clean outcome; the path says so explicitly. */
export interface ScanCodes<Code extends string = string> {
  infected: Code;
  unavailable: Code;
  timeout: Code;
  protocol: Code;
  /** A scanner-reported error, or any outcome nothing else names. */
  failed: Code;
}

/**
 * The mapping the document lifecycle shares: upload, scanner recovery, the
 * create form's inspection and preview, and mail-in holding. Each passes it
 * explicitly. A path that must record something else passes its own table and
 * says why beside it.
 */
export const documentScanCodes = {
  infected: "malware_detected",
  unavailable: "scanner_unavailable",
  timeout: "scanner_timeout",
  protocol: "scanner_protocol",
  failed: "scanner_failed",
} as const satisfies ScanCodes<ScanLogReason>;

export type ScanClassification<Code extends string> =
  | { status: "clean"; retryable: false }
  | {
    /** "infected" only for malware; every other non-clean outcome is "error". */
    status: "infected" | "error";
    logReason: ScanLogReason;
    code: Code;
    /** True only where ADR-0010 allows a held retry: unavailable, timeout, protocol. */
    retryable: boolean;
    /** The scanner could not be reached at all (unavailable or timed out). */
    unreachable: boolean;
  };

export function classifyScan<Code extends string>(
  result: MalwareScanResult,
  codes: ScanCodes<Code>,
): ScanClassification<Code> {
  if (result.status === "clean") return { status: "clean", retryable: false };
  if (result.status === "infected") {
    return { status: "infected", logReason: "malware_detected", code: codes.infected, retryable: false, unreachable: false };
  }
  // Not clean, not infected: whatever it is, it is an error, never a pass.
  const reason = result.status === "error" ? result.reason : undefined;
  if (reason === "unavailable") {
    return { status: "error", logReason: "scanner_unavailable", code: codes.unavailable, retryable: true, unreachable: true };
  }
  if (reason === "timeout") {
    return { status: "error", logReason: "scanner_timeout", code: codes.timeout, retryable: true, unreachable: true };
  }
  if (reason === "protocol") {
    return { status: "error", logReason: "scanner_protocol", code: codes.protocol, retryable: true, unreachable: false };
  }
  return { status: "error", logReason: "scanner_failed", code: codes.failed, retryable: false, unreachable: false };
}

/**
 * The refusal the create form's two pre-attachment steps give when the scan
 * did not pass. `noun` names the step ("inspection" or "preview") so a
 * preview does not claim to be an inspection; the error codes are the same
 * for both.
 */
export function scanRefusal(
  outcome: Exclude<ScanClassification<string>, { status: "clean" }>,
  noun: "inspection" | "preview",
): AppError {
  if (outcome.status === "infected") {
    return new AppError("document_malware_detected", "Orbit rejected that document because malware was detected", 422);
  }
  return outcome.unreachable
    ? new AppError(
      "document_scanner_unreachable",
      `Document ${noun} is not possible because the malware scanner cannot be reached. It stays blocked until the scanner is running.`,
      503,
    )
    : new AppError(
      "document_scanner_failed",
      `Document ${noun} is not possible because the malware scanner reported a failure. It stays blocked until the scanner is healthy.`,
      503,
    );
}
