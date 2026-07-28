import { describe, expect, it } from "vitest";
import { processOwnedPurge, type OwnedPurgeDriver, type OwnedPurgeJob, type OwnedPurgeState } from "./purge";

const job: OwnedPurgeJob = {
  id: "11111111-1111-4111-8111-111111111111",
  documentId: "22222222-2222-4222-8222-222222222222",
  generation: 4,
  leaseToken: "33333333-3333-4333-8333-333333333333",
};

const state: OwnedPurgeState = {
  householdId: "44444444-4444-4444-8444-444444444444",
  itemId: "55555555-5555-4555-8555-555555555555",
  storageKey: "a".repeat(64),
  generation: job.generation,
};

function driverFor(overrides: Partial<OwnedPurgeDriver> = {}, events: string[] = []): OwnedPurgeDriver {
  return {
    readOwnedPurge: async () => {
      events.push("read");
      return state;
    },
    deleteCiphertext: async (storageKey) => {
      events.push(`delete:${storageKey}`);
    },
    finalizeOwnedPurge: async () => {
      events.push("finalize");
      return true;
    },
    ...overrides,
  };
}

describe("owned document purge coordination", () => {
  it("deletes ciphertext before finalizing the durable lifecycle", async () => {
    const events: string[] = [];

    await expect(processOwnedPurge(job, driverFor({}, events))).resolves.toBe("completed");

    expect(events).toEqual(["read", `delete:${state.storageKey}`, "finalize"]);
  });

  it("leaves finalization for a retry when ciphertext deletion fails", async () => {
    const events: string[] = [];
    const driver = driverFor({
      deleteCiphertext: async () => {
        events.push("delete");
        throw new Error("storage unavailable");
      },
    }, events);

    await expect(processOwnedPurge(job, driver)).rejects.toThrow("storage unavailable");
    expect(events).toEqual(["read", "delete"]);
  });

  it("does not touch storage or durable state for a stale or invalid claim", async () => {
    const events: string[] = [];
    const driver = driverFor({
      readOwnedPurge: async () => {
        events.push("read");
        return undefined;
      },
    }, events);

    await expect(processOwnedPurge(job, driver)).resolves.toBe("stale");
    expect(events).toEqual(["read"]);
  });
});
