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
  ready: boolean;
  failureCode: string | null;
}

const rejectionReasons: Record<string, string> = {
  malware_detected: "Rejected because malware was detected.",
  processing_interrupted: "Processing was interrupted. Upload it again.",
  crypto_metadata_missing: "Rejected because its encryption record is missing.",
  storage_object_missing: "Rejected because its stored copy is missing.",
  storage_object_invalid: "Rejected because its stored copy could not be read.",
};

export function progressDescription(document: DocumentProgress): string | null {
  if (document.ready) return null;

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

/** Whether a document should keep the list polling for convergence. */
export function awaitingProgress(document: DocumentProgress): boolean {
  return !document.ready && document.lifecycle !== "rejected";
}
