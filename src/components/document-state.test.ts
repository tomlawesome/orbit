import { describe, expect, it } from "vitest";
import {
  awaitingProgress,
  convergenceBudget,
  convergenceDecision,
  isReady,
  progressDescription,
} from "./document-state";

const document = (overrides: Partial<Parameters<typeof progressDescription>[0]> = {}) => ({
  lifecycle: "available",
  ready: true,
  failureCode: null,
  ...overrides,
});

describe("readiness derivation", () => {
  it("derives readiness from the lifecycle when the field is absent", () => {
    // A payload predating the readiness field must not make an available
    // document look stuck. Treating a missing field as "not ready" hid the
    // document's actions entirely, and a browser journey waited ninety seconds
    // for a button that never rendered.
    expect(isReady({ lifecycle: "available" })).toBe(true);
    expect(isReady({ lifecycle: "pending_deletion" })).toBe(true);
    expect(isReady({ lifecycle: "scanning" })).toBe(false);
    expect(isReady({ lifecycle: "rejected" })).toBe(false);
  });

  it("prefers the reported field over the derivation", () => {
    expect(isReady({ lifecycle: "available", ready: false })).toBe(false);
    expect(isReady({ lifecycle: "scanning", ready: true })).toBe(true);
  });

  it("shows no progress text for an available document lacking the field", () => {
    expect(progressDescription({ lifecycle: "available" })).toBe(null);
  });
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

  it("distinguishes outage recovery from terminal expiry", () => {
    expect(progressDescription(document({ lifecycle: "scanning", ready: false, failureCode: "scanner_timeout", recoverable: true, recoveryStatus: "retrying" }))).toContain("retrying");
    expect(progressDescription(document({ lifecycle: "scanning", ready: false, failureCode: "scanner_timeout", recoverable: true, recoveryStatus: "manual" }))).toContain("administrator");
    expect(progressDescription(document({ lifecycle: "rejected", ready: false, failureCode: "scan_recovery_expired" }))).toContain("expired");
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

describe("convergence decision", () => {
  const scanning = document({ lifecycle: "scanning", ready: false });
  const rejected = document({ lifecycle: "rejected", ready: false, failureCode: "malware_detected" });
  const decide = (overrides: Partial<Parameters<typeof convergenceDecision>[0]>) =>
    convergenceDecision({ documents: [scanning], attempts: 0, hidden: false, ...overrides });

  it("asks for another request while a document is in progress and budget remains", () => {
    expect(decide({})).toBe("request");
    expect(decide({ attempts: convergenceBudget - 1 })).toBe("request");
  });

  it("stops once the budget is spent, so a stuck document cannot poll forever", () => {
    expect(decide({ attempts: convergenceBudget })).toBe("exhausted");
    expect(decide({ attempts: convergenceBudget + 1 })).toBe("exhausted");
  });

  it("issues nothing while the page is hidden, but reports it as resumable", () => {
    // "hidden" is distinct from "exhausted" because showing the page again
    // continues with whatever budget is left rather than starting a new one.
    expect(decide({ hidden: true })).toBe("hidden");
    expect(decide({ hidden: true, attempts: convergenceBudget })).toBe("exhausted");
  });

  it("stops immediately once every document reached a terminal state", () => {
    expect(decide({ documents: [document()] })).toBe("settled");
    expect(decide({ documents: [document({ lifecycle: "pending_deletion" })] })).toBe("settled");
    expect(decide({ documents: [rejected] })).toBe("settled");
    expect(decide({ documents: [] })).toBe("settled");
  });

  it("reports a settled list as settled even while hidden or exhausted", () => {
    // A settled list must never resume when the page is shown again.
    expect(decide({ documents: [document()], hidden: true })).toBe("settled");
    expect(decide({ documents: [document()], attempts: convergenceBudget })).toBe("settled");
  });

  it("keeps going for a mixed list until its last document settles", () => {
    expect(decide({ documents: [document(), scanning] })).toBe("request");
    expect(decide({ documents: [rejected, scanning] })).toBe("request");
    expect(decide({ documents: [document(), rejected] })).toBe("settled");
  });
});
