export interface OwnedPurgeJob {
  id: string;
  documentId: string;
  generation: number;
  leaseToken: string;
}

export interface OwnedPurgeState {
  householdId: string;
  itemId: string | null;
  storageKey: string;
  generation: number;
}

/**
 * The small coordination seam keeps the irreversible ordering explicit:
 * durable ownership is checked, ciphertext is removed, and only then may a
 * transaction finalize the metadata. A false finalization result means that
 * ownership changed while storage was being cleaned; the retry keeps the
 * remaining durable evidence available for reconciliation.
 */
export interface OwnedPurgeDriver {
  readOwnedPurge(job: OwnedPurgeJob): Promise<OwnedPurgeState | undefined>;
  /** Deletes every kept page preview object of the document (#1433 D20). Idempotent. */
  deletePreviews(documentId: string): Promise<void>;
  deleteCiphertext(storageKey: string): Promise<void>;
  finalizeOwnedPurge(job: OwnedPurgeJob, state: OwnedPurgeState): Promise<boolean>;
}

export async function processOwnedPurge(
  job: OwnedPurgeJob,
  driver: OwnedPurgeDriver,
): Promise<"completed" | "stale"> {
  const state = await driver.readOwnedPurge(job);
  if (!state || state.generation !== job.generation) return "stale";

  // Both deletions are deliberately idempotent. Do not move them after
  // finalization: a terminal row must never point at bytes, the previews'
  // included. Previews go first, so a failure there leaves the document
  // object and its metadata in place for the retry.
  await driver.deletePreviews(job.documentId);
  await driver.deleteCiphertext(state.storageKey);
  return await driver.finalizeOwnedPurge(job, state) ? "completed" : "stale";
}
