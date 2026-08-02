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

/**
 * Convergence requests one item view may spend before it stops asking.
 *
 * Processing that has not finished within the budget is a server problem the
 * view cannot fix by asking again, so the list stops rather than polling an
 * unbounded number of times.
 */
export const convergenceBudget = 6;

/** Minimum wait between a completed request and the next convergence request. */
export const convergenceDelayMs = 1_500;

export interface ConvergenceState {
  /** Documents returned by the request that has just completed. */
  documents: DocumentProgress[];
  /** Convergence requests already spent on this item view. */
  attempts: number;
  /** Whether the page is currently hidden. */
  hidden: boolean;
}

export type ConvergenceDecision = "request" | "settled" | "exhausted" | "hidden";

/**
 * Whether a completed request should be followed by another one.
 *
 * The order of the checks is the behaviour: a settled list stops even when the
 * page is hidden, so it can never resume later; an exhausted budget is
 * likewise terminal. Only `hidden` is a pause, and showing the page again
 * continues with the remaining budget rather than a fresh one.
 */
export function convergenceDecision({ documents, attempts, hidden }: ConvergenceState): ConvergenceDecision {
  if (!documents.some(awaitingProgress)) return "settled";
  if (attempts >= convergenceBudget) return "exhausted";
  if (hidden) return "hidden";
  return "request";
}
