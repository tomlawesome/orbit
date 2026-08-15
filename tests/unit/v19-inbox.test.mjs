import { describe, expect, it } from "vitest";

import { approvalItemOf, receiptFailuresOf, receiptSuggestionsOf } from "../../web/src/lib/data/inbox.js";

// #434: mail-in receipts become the manifest's suggestions and the relay's
// visible failures. The mapping is pure and pinned here.
const READY = {
  id: "r-1", status: "pending_review", householdId: "hh-1", draftVersion: 2,
  expiresAt: "2026-09-27T00:00:00.000Z", receivedAt: "2026-08-13T09:00:00.000Z",
  attachmentCount: 1, classification: "ready", canApprove: true, canDiscard: true,
  cleanupOnly: false, message: "Ready for your review.",
  proposal: { title: "Home insurance renewal", dueDate: "2026-10-03", costMinor: 40000, currency: "GBP", scheduleKind: "renewal", recurrenceMonths: 12 },
  fieldEvidence: { title: { source: "document", confidence: "high" } },
};
const WAITING = { ...READY, id: "r-2", status: "processing", classification: "waiting", canApprove: false, message: "Orbit is still preparing this private review." };
const DEAD = { ...READY, id: "r-3", status: "failed", classification: "unavailable", canApprove: false, canDiscard: false, proposal: {}, fieldEvidence: {}, message: "This incoming document is no longer available for review." };

describe("receiptSuggestionsOf", () => {
  it("maps only approvable receipts, carrying what approval needs", () => {
    const suggestions = receiptSuggestionsOf([READY, WAITING, DEAD]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      id: "r-1",
      receiptId: "r-1",
      draftVersion: 2,
      householdId: "hh-1",
      title: "Home insurance renewal",
      renewsOn: "2026-10-03",
      costMinor: 40000,
      currency: "GBP",
      sourceDocument: "1 forwarded document",
    });
  });

  it("survives a bare proposal", () => {
    const bare = receiptSuggestionsOf([{ ...READY, proposal: {}, attachmentCount: 0 }]);
    expect(bare[0].title).toBe("Forwarded email");
    expect(bare[0].renewsOn).toBe(null);
    expect(bare[0].sourceDocument).toBe("forwarded email");
  });
});

describe("receiptFailuresOf", () => {
  it("surfaces arrived-but-unreviewable mail with its bounded message", () => {
    const failures = receiptFailuresOf([READY, WAITING, DEAD]);
    expect(failures.map((f) => f.id)).toEqual(["r-3"]);
    expect(failures[0].message).toBe("This incoming document is no longer available for review.");
    expect(failures[0].receivedAt).toBe(DEAD.receivedAt);
  });
  it("keeps still-processing mail visible as waiting, not failed", () => {
    const failures = receiptFailuresOf([WAITING]);
    expect(failures).toEqual([]);
  });
});

describe("approvalItemOf", () => {
  it("builds final values from the proposal, defaulting the currency", () => {
    const item = approvalItemOf(READY.proposal, "EUR");
    expect(item).toEqual({
      title: "Home insurance renewal",
      currency: "GBP",
      dueDate: "2026-10-03",
      scheduleKind: "renewal",
      recurrenceMonths: 12,
      costMinor: 40000,
    });
    expect(approvalItemOf({}, "EUR")).toEqual({ title: "Forwarded email", currency: "EUR" });
  });
  it("never sends a schedule without a date, nor recurrence without a schedule", () => {
    const item = approvalItemOf({ title: "x", scheduleKind: "renewal", recurrenceMonths: 12 }, "GBP");
    expect(item.scheduleKind).toBeUndefined();
    expect(item.recurrenceMonths).toBeUndefined();
  });
});
