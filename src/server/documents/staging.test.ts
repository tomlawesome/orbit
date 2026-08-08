import { describe, expect, it } from "vitest";
import { retryableScannerFailureCode, scannerRecoveryDelayMs } from "./staging";

describe("scanner recovery policy", () => {
  it.each([
    ["unavailable", "scanner_unavailable"],
    ["timeout", "scanner_timeout"],
    ["protocol", "scanner_protocol"],
  ] as const)("maps %s to a recoverable fixed code", (reason, expected) => {
    expect(retryableScannerFailureCode({ status: "error", reason })).toBe(expected);
  });

  it("does not turn scanner-reported errors into durable recovery", () => {
    expect(retryableScannerFailureCode({ status: "error", reason: "scanner" })).toBeUndefined();
    expect(retryableScannerFailureCode({ status: "infected", signature: "safe-test-signature" })).toBeUndefined();
  });

  it("uses the bounded 60s, 2m, 4m, 8m, 15m retry schedule", () => {
    expect([1, 2, 3, 4, 5].map(scannerRecoveryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000, 900_000]);
    expect(scannerRecoveryDelayMs(50)).toBe(900_000);
  });
});
