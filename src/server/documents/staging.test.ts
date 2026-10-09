import { describe, expect, it } from "vitest";
import { scannerRecoveryDelayMs } from "./staging";

describe("scanner recovery policy", () => {
  it("uses the bounded 60s, 2m, 4m, 8m, 15m retry schedule", () => {
    expect([1, 2, 3, 4, 5].map(scannerRecoveryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000, 900_000]);
    expect(scannerRecoveryDelayMs(50)).toBe(900_000);
  });
});
