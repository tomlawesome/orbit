import { describe, expect, it } from "vitest";
import { processOwnedPurge, type OwnedPurgeDriver, type OwnedPurgeJob, type OwnedPurgeState } from "./purge";

/**
 * #1433 D20, design note §2.6 line 12 (the order, by a driver spy): the purge
 * driver gains `deletePreviews(documentId)` (§2.5), called before the
 * document object is deleted and before the metadata finalizes, so a
 * terminal row never points at preview bytes either. The driver method does
 * not exist in the type yet, so the driver is cast.
 */

const job: OwnedPurgeJob = {
  id: "11111111-1111-4111-8111-111111111111",
  documentId: "22222222-2222-4222-8222-222222222222",
  generation: 2,
  leaseToken: "33333333-3333-4333-8333-333333333333",
};

const state: OwnedPurgeState = {
  householdId: "44444444-4444-4444-8444-444444444444",
  itemId: "55555555-5555-4555-8555-555555555555",
  storageKey: "b".repeat(64),
  generation: job.generation,
};

function spyDriver(events: string[], overrides: Record<string, unknown> = {}): OwnedPurgeDriver {
  return {
    readOwnedPurge: async () => {
      events.push("read");
      return state;
    },
    deletePreviews: async (documentId: string) => {
      events.push(`previews:${documentId}`);
    },
    deleteCiphertext: async (storageKey: string) => {
      events.push(`delete:${storageKey}`);
    },
    finalizeOwnedPurge: async () => {
      events.push("finalize");
      return true;
    },
    ...overrides,
  } as unknown as OwnedPurgeDriver;
}

describe("purge deletes previews first (#1433 §2.6 line 12)", () => {
  it("line 12: deletes every preview of the document before the document object and before finalizing", async () => {
    const events: string[] = [];
    await expect(processOwnedPurge(job, spyDriver(events))).resolves.toBe("completed");
    expect(events).toEqual(["read", `previews:${job.documentId}`, `delete:${state.storageKey}`, "finalize"]);
  });

  it("line 12: a failed preview deletion leaves the document object and the metadata for the retry", async () => {
    const events: string[] = [];
    const driver = spyDriver(events, {
      deletePreviews: async () => {
        events.push("previews");
        throw new Error("storage unavailable");
      },
    });
    await expect(processOwnedPurge(job, driver)).rejects.toThrow("storage unavailable");
    expect(events).toEqual(["read", "previews"]);
  });
});
