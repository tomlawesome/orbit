import { describe, expect, it } from "vitest";
import { percent, percentOfRatio } from "./eval-format";

describe("eval-format percent (engine-13)", () => {
  it("prints one decimal by default and the precision the caller asks for", () => {
    expect(percent(1, 3)).toBe("33.3%");
    expect(percent(1, 3, 0)).toBe("33%");
    expect(percent(5, 5)).toBe("100.0%");
    expect(percent(0, 4)).toBe("0.0%");
  });

  it("calls a tally of nothing n/a, never 0%, at any precision", () => {
    expect(percent(0, 0)).toBe("n/a");
    expect(percent(0, 0, 0)).toBe("n/a");
  });

  it("formats a ratio already worked out", () => {
    expect(percentOfRatio(0.8766)).toBe("87.7%");
    expect(percentOfRatio(1, 0)).toBe("100%");
  });
});
