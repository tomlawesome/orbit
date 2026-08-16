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

// #462: the archive — every attached document plus the relay's catches,
// newest first, grouped by recency against the reckoning date.
import { archiveOf } from "../../web/src/lib/data/documents.js";
import { WORKSPACE_FIXTURE, DOCUMENTS_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";
import { INBOX_FIXTURE } from "../../web/src/lib/data/fixtures/inbox.js";

describe("archiveOf", () => {
  const archive = archiveOf({
    workspace: WORKSPACE_FIXTURE,
    receipts: INBOX_FIXTURE.receipts,
    documentsByItem: DOCUMENTS_FIXTURE,
    today: "2026-08-13",
  });

  it("counts the whole belt, loose catches included", () => {
    expect(archive.total).toBe(5);
    expect(archive.megabytes).toBe("1.4");
    expect(archive.allClean).toBe(true);
  });

  it("groups by recency, newest first, the relay's catch on top", () => {
    expect(archive.groups.map((group) => [group.label, group.rows.length])).toEqual([
      ["This month", 1],
      ["Earlier this year", 4],
    ]);
    const loose = archive.groups[0].rows[0];
    expect(loose.loose).toBe(true);
    expect(loose.name).toBe("policy-schedule.pdf");
    expect(loose.suggestion).toBe("Home insurance renewal");
    expect(loose.viaRelay).toBe(true);
  });

  it("dresses each attached row in its body's dial colour", () => {
    const rows = archive.groups[1].rows;
    expect(rows.map((row) => row.name)).toEqual([
      "service-checklist.pdf", "service-invoice-2026.pdf", "Service history", "MOT certificate 2025",
    ]);
    expect(rows[0].item.band).toBe("ok"); // Car full service, T−161d
    expect(rows[2].item.band).toBe("due-soon"); // Car MOT, T−16d
    expect(rows[0].viaRelay).toBe(false); // provenance unknowable for stored docs (#467)
  });

  it("degrades to an empty archive rather than throwing", () => {
    const empty = archiveOf({ workspace: null, today: "2026-08-13" });
    expect(empty.total).toBe(0);
    expect(empty.groups).toEqual([]);
  });
});
