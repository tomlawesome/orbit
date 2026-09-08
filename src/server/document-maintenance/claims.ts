/**
 * The lease/claim core the scan and purge seams share (#299).
 *
 * Every job the worker touches arrives as one of these claim records: the
 * job's identity, the document generation it was claimed against, and the
 * lease token that fences every subsequent write (ADR-0010). Nothing here
 * reaches the database, so a claim shape can be reasoned about on its own.
 */
import { operationalReasons, type OperationalReason } from "@/lib/logger";
import type { OwnedPurgeJob } from "@/server/documents/purge";

export function operationalDocumentReason(value: string): OperationalReason {
  return (operationalReasons as readonly string[]).includes(value)
    ? value as OperationalReason
    : "unexpected_failure";
}

export interface ClaimedDocumentJob extends OwnedPurgeJob {
  /** The job's status immediately before this claim; distinguishes an expired-lease reclaim from a fresh pending/retry claim. */
  previousStatus: "pending" | "retry" | "processing";
}

/** Pure classification of a claim outcome from the pre-claim status, kept separate from the SQL for direct testability. */
export function purgeClaimOutcome(previousStatus: "pending" | "retry" | "processing"): "claimed" | "reclaimed" {
  return previousStatus === "processing" ? "reclaimed" : "claimed";
}

export interface ClaimedScanJob {
  id: string;
  documentId: string;
  generation: number;
  leaseToken: string;
  previousStatus: "pending" | "retry" | "processing";
}

export interface ScanRecoveryRecord {
  householdId: string;
  itemId: string;
  mediaType: string;
  sizeBytes: number;
  displayName: string;
  contentSha256: string;
  stagingStorageKey: string;
  ciphertextSize: number;
  envelopeVersion: 1;
  contentIv: string;
  contentAuthTag: string;
  wrappedDek: string;
  wrapIv: string;
  wrapAuthTag: string;
  keyId: string;
  recoveryExpiresAt: Date;
}
