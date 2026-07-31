import { describe, expect, it } from "vitest";
import { parseClamAvResponse } from "./scanner";

describe("ClamAV protocol responses", () => {
  it("normalizes clean, infected, and unsafe scanner responses", () => {
    expect(parseClamAvResponse("stream: OK\0")).toEqual({ status: "clean" });
    expect(parseClamAvResponse("stream: Eicar-Test-Signature FOUND\0")).toEqual({
      status: "infected",
      signature: "Eicar-Test-Signature",
    });
    expect(parseClamAvResponse("stream: size limit exceeded. ERROR\0")).toEqual({
      status: "error",
      reason: "scanner",
    });
    expect(parseClamAvResponse("unexpected")).toEqual({ status: "error", reason: "protocol" });
  });
});
