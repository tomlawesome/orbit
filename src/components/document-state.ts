/**
 * Explains a document that cannot be opened yet.
 *
 * Kept free of JSX so it is testable under the repository's node test
 * environment. Reasons are mapped from the bounded server failure vocabulary
 * rather than rendered raw, so scanner and parser internals never reach the
 * interface.
 */

export interface DocumentProgress {
  lifecycle: string;
  /** Absent in payloads produced before readiness was reported. */
  ready?: boolean;
  failureCode?: string | null;
}

/** Lifecycles whose content can be opened; mirrors the server's boundary. */
const openableLifecycles = ["available", "pending_deletion"];

/**
 * Whether a document's content can be opened.
 *
 * Readiness is derived from the lifecycle when the field is absent, so a
 * payload that predates the field cannot make an available document look
 * stuck and hide its actions.
 */
export function isReady(document: DocumentProgress): boolean {
  return document.ready ?? openableLifecycles.includes(document.lifecycle);
}

const rejectionReasons: Record<string, string> = {
  malware_detected: "Rejected because malware was detected.",
  processing_interrupted: "Processing was interrupted. Upload it again.",
  crypto_metadata_missing: "Rejected because its encryption record is missing.",
  storage_object_missing: "Rejected because its stored copy is missing.",
  storage_object_invalid: "Rejected because its stored copy could not be read.",
};

export function progressDescription(document: DocumentProgress): string | null {
  if (isReady(document)) return null;

  if (document.lifecycle === "rejected") {
    const known = document.failureCode ? rejectionReasons[document.failureCode] : undefined;
    if (known) return known;
    // Scanner failure codes are generated as `scanner_<reason>`, so they are
    // recognised by shape rather than enumerated. The specific reason is not
    // surfaced: it describes the scanner, not the document.
    if (document.failureCode?.startsWith("scanner_")) {
      return "Rejected because the malware scanner could not check it.";
    }
    return "Rejected. Upload it again.";
  }

  if (document.lifecycle === "scanning") return "Checking for malware…";
  if (document.lifecycle === "encrypting") return "Encrypting…";
  return "Processing…";
}

/** Whether a document is still expected to change state. */
export function awaitingProgress(document: DocumentProgress): boolean {
  return !isReady(document) && document.lifecycle !== "rejected";
}
