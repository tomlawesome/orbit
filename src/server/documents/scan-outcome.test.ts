import { describe, expect, it } from "vitest";
import { operationalReasons } from "@/lib/logger";
import { parseClamAvResponse, type MalwareScanResult } from "./scanner";
import { classifyScan, documentScanCodes, scanRefusal, type ScanCodes } from "./scan-outcome";
import { retryableScannerFailureCodes } from "./staging";

/*
 * The scan-outcome ladder was copied five times and disagreed about a scanner
 * "protocol" error (#1349, engine-7). These pin the one copy, and above all
 * the unsafe direction: nothing but an exact "clean" classifies as clean.
 */
describe("classifyScan", () => {
  it("classifies only an exact clean result as clean", () => {
    expect(classifyScan({ status: "clean" }, documentScanCodes)).toEqual({ status: "clean", retryable: false });
  });

  it.each([
    ["infected", { status: "infected", signature: "Eicar-Test-Signature" }, "infected", "malware_detected", false, false],
    ["unavailable", { status: "error", reason: "unavailable" }, "error", "scanner_unavailable", true, true],
    ["timeout", { status: "error", reason: "timeout" }, "error", "scanner_timeout", true, true],
    ["protocol", { status: "error", reason: "protocol" }, "error", "scanner_protocol", true, false],
    ["scanner-reported", { status: "error", reason: "scanner" }, "error", "scanner_failed", false, false],
  ] as const)("maps %s to a fixed reason and code", (_label, result, status, reason, retryable, unreachable) => {
    expect(classifyScan(result, documentScanCodes)).toEqual({
      status, logReason: reason, code: reason, retryable, unreachable,
    });
  });

  it.each([
    ["an error with no reason", { status: "error" }],
    ["an error with an unlisted reason", { status: "error", reason: "something-new" }],
    ["a status nobody recognises", { status: "quarantined" }],
    ["a status of the wrong case", { status: "CLEAN" }],
    ["an empty object", {}],
  ])("never lets %s through as clean, and does not retry it", (_label, result) => {
    expect(classifyScan(result as unknown as MalwareScanResult, documentScanCodes)).toEqual({
      status: "error",
      logReason: "scanner_failed",
      code: "scanner_failed",
      retryable: false,
      unreachable: false,
    });
  });

  it("is not clean for every shape the ClamAV parser can produce other than OK", () => {
    for (const response of ["stream: ERROR\0", "unexpected", "", "stream: Eicar-Test-Signature FOUND\0"]) {
      expect(classifyScan(parseClamAvResponse(response), documentScanCodes).status).not.toBe("clean");
    }
    expect(classifyScan(parseClamAvResponse("stream: OK\0"), documentScanCodes).status).toBe("clean");
  });

  it("records what each path's table says, not a fixed vocabulary", () => {
    const own = {
      infected: "bad",
      unavailable: "down",
      timeout: "slow",
      protocol: "odd",
      failed: "broken",
    } satisfies ScanCodes;
    const codes = (result: MalwareScanResult) => {
      const outcome = classifyScan(result, own);
      return outcome.status === "clean" ? "clean" : [outcome.code, outcome.logReason];
    };
    expect(codes({ status: "error", reason: "protocol" })).toEqual(["odd", "scanner_protocol"]);
    expect(codes({ status: "error", reason: "scanner" })).toEqual(["broken", "scanner_failed"]);
    expect(codes({ status: "infected", signature: "x" })).toEqual(["bad", "malware_detected"]);
  });

  it("is retryable exactly where ADR-0010 and the staging vocabulary say, and nowhere else", () => {
    const retryableCodes = (["unavailable", "timeout", "protocol", "scanner"] as const)
      .map((reason) => classifyScan({ status: "error", reason }, documentScanCodes))
      .flatMap((outcome) => (outcome.status !== "clean" && outcome.retryable ? [outcome.code] : []));
    expect(retryableCodes).toEqual([...retryableScannerFailureCodes]);
    expect(classifyScan({ status: "infected", signature: "x" }, documentScanCodes))
      .toMatchObject({ retryable: false });
  });

  it("logs only reasons the operational log schema lists", () => {
    for (const reason of Object.values(documentScanCodes)) {
      expect(operationalReasons as readonly string[]).toContain(reason);
    }
  });
});

describe("scanRefusal", () => {
  const refusal = (result: MalwareScanResult, noun: "inspection" | "preview") => {
    const outcome = classifyScan(result, documentScanCodes);
    if (outcome.status === "clean") throw new Error("expected a refusal");
    return scanRefusal(outcome, noun);
  };

  it("refuses malware the same way for both steps", () => {
    for (const noun of ["inspection", "preview"] as const) {
      expect(refusal({ status: "infected", signature: "x" }, noun)).toMatchObject({ code: "document_malware_detected", status: 422 });
    }
  });

  it("calls an unreachable scanner unreachable and every other failure a failure, both 503", () => {
    expect(refusal({ status: "error", reason: "unavailable" }, "inspection")).toMatchObject({ code: "document_scanner_unreachable", status: 503 });
    expect(refusal({ status: "error", reason: "timeout" }, "preview")).toMatchObject({ code: "document_scanner_unreachable", status: 503 });
    expect(refusal({ status: "error", reason: "protocol" }, "inspection")).toMatchObject({ code: "document_scanner_failed", status: 503 });
    expect(refusal({ status: "error", reason: "scanner" }, "preview")).toMatchObject({ code: "document_scanner_failed", status: 503 });
  });

  it("names the step it is refusing", () => {
    expect(refusal({ status: "error", reason: "unavailable" }, "preview").message).toMatch(/^Document preview /);
    expect(refusal({ status: "error", reason: "protocol" }, "inspection").message).toMatch(/^Document inspection /);
    expect(refusal({ status: "error", reason: "protocol" }, "preview").message).not.toContain("inspection");
  });
});
