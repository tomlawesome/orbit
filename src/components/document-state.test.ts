import { describe, expect, it } from "vitest";
import { awaitingProgress, progressDescription } from "./document-state";

const document = (overrides: Partial<Parameters<typeof progressDescription>[0]> = {}) => ({
  lifecycle: "available",
  ready: true,
  failureCode: null,
  ...overrides,
});

describe("document progress description", () => {
  it("says nothing about a document that can be opened", () => {
    expect(progressDescription(document())).toBe(null);
    expect(progressDescription(document({ lifecycle: "pending_deletion" }))).toBe(null);
  });

  it("distinguishes the in-progress states", () => {
    expect(progressDescription(document({ lifecycle: "scanning", ready: false }))).toBe("Checking for malware…");
    expect(progressDescription(document({ lifecycle: "encrypting", ready: false }))).toBe("Encrypting…");
    expect(progressDescription(document({ lifecycle: "quarantined", ready: false }))).toBe("Processing…");
    expect(progressDescription(document({ lifecycle: "receiving", ready: false }))).toBe("Processing…");
  });

  it("explains each known rejection", () => {
    const rejected = (failureCode: string) =>
      progressDescription(document({ lifecycle: "rejected", ready: false, failureCode }));

    expect(rejected("malware_detected")).toMatch(/malware was detected/u);
    expect(rejected("processing_interrupted")).toMatch(/Upload it again/u);
    expect(rejected("crypto_metadata_missing")).toMatch(/encryption record/u);
  });

  it("recognises a scanner failure by shape without naming the reason", () => {
    // The scanner's own reason describes the scanner, not the document, so it
    // must not reach the interface.
    const description = progressDescription(document({
      lifecycle: "rejected",
      ready: false,
      failureCode: "scanner_unavailable",
    }));

    expect(description).toBe("Rejected because the malware scanner could not check it.");
    expect(description).not.toMatch(/unavailable/u);
  });

  it("falls back to a safe explanation for an unrecognised failure", () => {
    const description = progressDescription(document({
      lifecycle: "rejected",
      ready: false,
      failureCode: "some_future_code_with_detail",
    }));

    expect(description).toBe("Rejected. Upload it again.");
    expect(description).not.toMatch(/some_future_code/u);
  });

  it("handles a rejection carrying no code at all", () => {
    expect(progressDescription(document({ lifecycle: "rejected", ready: false, failureCode: null })))
      .toBe("Rejected. Upload it again.");
  });
});

describe("polling for convergence", () => {
  it("keeps polling while a document is genuinely in progress", () => {
    expect(awaitingProgress(document({ lifecycle: "scanning", ready: false }))).toBe(true);
    expect(awaitingProgress(document({ lifecycle: "encrypting", ready: false }))).toBe(true);
  });

  it("stops polling once a document is openable", () => {
    expect(awaitingProgress(document())).toBe(false);
  });

  it("stops polling for a rejected document, because rejection is terminal", () => {
    // Otherwise a permanently rejected document would poll forever.
    expect(awaitingProgress(document({ lifecycle: "rejected", ready: false, failureCode: "malware_detected" })))
      .toBe(false);
  });
});
