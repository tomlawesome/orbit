import { describe, expect, it } from "vitest";
import { isDocumentContentReady, listableDocumentLifecycles, toSummary } from "./document-repository";

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
    expect(() => toSummary(record({ lifecycle: "deleted" }), "required")).toThrow(/not in a user-visible state/u);
  });

  it("rejects an unrecognised lifecycle rather than rendering it", () => {
    expect(() => toSummary(record({ lifecycle: "some_future_state" }), "required")).toThrow(/not in a user-visible state/u);
  });

  it("lists a document that is still processing, with its state", () => {
    for (const lifecycle of ["receiving", "validating", "quarantined", "scanning", "encrypting"]) {
      const summary = toSummary(record({ lifecycle, scanStatus: "pending", availableAt: null }), "required");
      expect(summary.lifecycle).toBe(lifecycle);
      expect(summary.ready).toBe(false);
    }
  });

  it.each(["pending", "error", "infected"] as const)("fails closed for a %s scan status", (scanStatus) => {
    expect(toSummary(record({ scanStatus }), "required").ready).toBe(false);
  });

  it("fails closed for a skipped scan when scanning is required", () => {
    expect(toSummary(record({ scanStatus: "skipped" }), "required").ready).toBe(false);
  });

  it("allows a skipped scan only when scanning is disabled", () => {
    expect(toSummary(record({ scanStatus: "skipped" }), "disabled").ready).toBe(true);
  });

  it("does not treat unknown scan modes as disabled", () => {
    expect(isDocumentContentReady(record(), "unexpected", "download")).toBe(true);
    expect(isDocumentContentReady(record({ scanStatus: "skipped" }), "unexpected", "download")).toBe(false);
  });

  it("lists a rejected document with its bounded failure code", () => {
    const summary = toSummary(record({
      lifecycle: "rejected",
      scanStatus: "infected",
      availableAt: null,
      failureCode: "malware_detected",
    }), "required");

    expect(summary.lifecycle).toBe("rejected");
    expect(summary.ready).toBe(false);
    expect(summary.failureCode).toBe("malware_detected");
  });

  it("marks only the openable states ready", () => {
    expect(toSummary(record(), "required").ready).toBe(true);
    expect(toSummary(record({ lifecycle: "pending_deletion", deleteAfter: new Date() }), "required").ready).toBe(true);
    expect(toSummary(record({ lifecycle: "scanning", availableAt: null }), "required").ready).toBe(false);
    expect(toSummary(record({ lifecycle: "rejected", availableAt: null }), "required").ready).toBe(false);
  });

  it("applies the operation-specific lifecycle guard", () => {
    const ready = { lifecycle: "available", scanStatus: "clean" };
    const pendingDeletion = { lifecycle: "pending_deletion", scanStatus: "clean" };

    expect(isDocumentContentReady(ready, "required", "download")).toBe(true);
    expect(isDocumentContentReady(ready, "required", "draft")).toBe(true);
    expect(isDocumentContentReady(pendingDeletion, "required", "restore")).toBe(true);
    expect(isDocumentContentReady(pendingDeletion, "required", "download")).toBe(false);
    expect(isDocumentContentReady(ready, "required", "restore")).toBe(false);
  });

  it("carries no failure code for a healthy document", () => {
    expect(toSummary(record(), "required").failureCode).toBe(null);
  });

  it("does not expose storage or crypto detail", () => {
    // The summary reaches the browser, so it must carry nothing about where or
    // how the document is stored.
    const summary = toSummary(record(), "required");
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
      "recoverable",
      "recoveryExpiresAt",
      "recoveryStatus",
      "scanStatus",
      "sizeBytes",
    ]);
  });
});
