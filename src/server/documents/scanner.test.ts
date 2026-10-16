import { describe, expect, it } from "vitest";
import { parseClamAvResponse, parseClamAvSignatureDate } from "./scanner";

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

describe("ClamAV VERSION reply (#1296)", () => {
  it("reads the signature date from the end of the reply, as UTC", () => {
    expect(parseClamAvSignatureDate("ClamAV 1.5.4/28137/Mon Sep 28 06:24:12 2026\0")?.toISOString()).toBe(
      "2026-09-28T06:24:12.000Z",
    );
    expect(parseClamAvSignatureDate("ClamAV 1.5.4/28146/Wed Oct  7 06:24:18 2026")?.toISOString()).toBe(
      "2026-10-07T06:24:18.000Z",
    );
  });

  it("answers null when the reply has no readable date", () => {
    for (const reply of ["", "ClamAV 1.5.4", "ClamAV 1.5.4/28137", "ClamAV 1.5.4/28137/not a date", "UNKNOWN COMMAND"]) {
      expect(parseClamAvSignatureDate(reply), reply).toBeNull();
    }
  });
});
