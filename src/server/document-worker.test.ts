import { describe, expect, it } from "vitest";
import { getDocumentWorkerHealth, purgeClaimOutcome } from "./document-worker";

describe("document worker health", () => {
  it("exposes only bounded initial worker health", () => {
    expect(getDocumentWorkerHealth()).toEqual({
      started: false,
      running: false,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorCode: null,
      lastReconciliationAt: null,
    });
  });
});

describe("purgeClaimOutcome", () => {
  it("distinguishes an expired processing lease reclaim from an ordinary pending or retry claim", () => {
    expect(purgeClaimOutcome("processing")).toBe("reclaimed");
    expect(purgeClaimOutcome("pending")).toBe("claimed");
    expect(purgeClaimOutcome("retry")).toBe("claimed");
  });
});
