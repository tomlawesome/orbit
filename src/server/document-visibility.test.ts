import { describe, expect, it } from "vitest";
import { listableDocumentLifecycles, toSummary } from "./document-repository";

const record = (overrides: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  itemId: "22222222-2222-4222-8222-222222222222",
  displayName: "policy.pdf",
  mediaType: "application/pdf",
  sizeBytes: 1024,
  lifecycle: "available",
  scanStatus: "clean",
  availableAt: new Date("2026-07-31T12:00:00.000Z"),
  deleteAfter: null,
  failureCode: null,
  ...overrides,
});

describe("document visibility boundary", () => {
  it("never lists a deleted document", () => {
    // A purged document must stay invisible. This list must not become a way
    // to observe removed content.
    expect(listableDocumentLifecycles).not.toContain("deleted");
    expect(() => toSummary(record({ lifecycle: "deleted" }))).toThrow(/not in a user-visible state/u);
  });

  it("rejects an unrecognised lifecycle rather than rendering it", () => {
    expect(() => toSummary(record({ lifecycle: "some_future_state" }))).toThrow(/not in a user-visible state/u);
  });

  it("lists a document that is still processing, with its state", () => {
    for (const lifecycle of ["receiving", "validating", "quarantined", "scanning", "encrypting"]) {
      const summary = toSummary(record({ lifecycle, scanStatus: "pending", availableAt: null }));
      expect(summary.lifecycle).toBe(lifecycle);
      expect(summary.ready).toBe(false);
    }
  });

  it("lists a rejected document with its bounded failure code", () => {
    const summary = toSummary(record({
      lifecycle: "rejected",
      scanStatus: "infected",
      availableAt: null,
      failureCode: "malware_detected",
    }));

    expect(summary.lifecycle).toBe("rejected");
    expect(summary.ready).toBe(false);
    expect(summary.failureCode).toBe("malware_detected");
  });

  it("marks only the openable states ready", () => {
    expect(toSummary(record()).ready).toBe(true);
    expect(toSummary(record({ lifecycle: "pending_deletion", deleteAfter: new Date() })).ready).toBe(true);
    expect(toSummary(record({ lifecycle: "scanning", availableAt: null })).ready).toBe(false);
    expect(toSummary(record({ lifecycle: "rejected", availableAt: null })).ready).toBe(false);
  });

  it("carries no failure code for a healthy document", () => {
    expect(toSummary(record()).failureCode).toBe(null);
  });

  it("does not expose storage or crypto detail", () => {
    // The summary reaches the browser, so it must carry nothing about where or
    // how the document is stored.
    const summary = toSummary(record());
    expect(Object.keys(summary).sort()).toEqual([
      "availableAt",
      "deleteAfter",
      "displayName",
      "failureCode",
      "id",
      "itemId",
      "lifecycle",
      "mediaType",
      "ready",
      "scanStatus",
      "sizeBytes",
    ]);
  });
});
