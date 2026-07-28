import { describe, expect, it } from "vitest";
import { reconcileMissingDocument, type MissingDocumentReconciliationDriver } from "./reconciliation";

const snapshot = {
  documentId: "22222222-2222-4222-8222-222222222222",
  householdId: "44444444-4444-4444-8444-444444444444",
  itemId: "55555555-5555-4555-8555-555555555555",
};

describe("missing document reconciliation", () => {
  it("preserves a deletion requested after the missing-object snapshot", async () => {
    const events: string[] = [];
    let lifecycle: string = "available";
    let purgeJob: "pending" | "retry" = "pending";
    const driver: MissingDocumentReconciliationDriver = {
      withDocumentLock: async (_documentId, work) => {
        events.push("lock");
        // The deletion request committed after the outer snapshot but before
        // reconciliation acquired the same per-document lock.
        lifecycle = "pending_deletion";
        purgeJob = "pending";
        return work({
          readCurrentLifecycle: async () => {
            events.push("recheck");
            return lifecycle;
          },
          rejectAvailableDocument: async () => {
            events.push("reject");
            lifecycle = "rejected";
            return true;
          },
        });
      },
    };

    await expect(reconcileMissingDocument(snapshot, driver)).resolves.toBe("preserved");
    expect(events).toEqual(["lock", "recheck"]);
    expect(lifecycle).toBe("pending_deletion");
    expect(purgeJob).toBe("pending");
  });

  it("rejects only a document that is still available under the lock", async () => {
    let rejectionCount = 0;
    const driver: MissingDocumentReconciliationDriver = {
      withDocumentLock: async (_documentId, work) => work({
        readCurrentLifecycle: async () => "available",
        rejectAvailableDocument: async () => {
          rejectionCount += 1;
          return true;
        },
      }),
    };

    await expect(reconcileMissingDocument(snapshot, driver)).resolves.toBe("rejected");
    expect(rejectionCount).toBe(1);
  });
});
