import { describe, expect, it } from "vitest";
import { classifyScan, documentScanCodes, scanRefusal } from "@/server/documents/scan-outcome";
import type { MalwareScanResult } from "@/server/documents/scanner";

/*
 * #1810 W-F2 (note 57316): one code per outcome the reader must tell apart. A
 * scan that timed out is not "could not be reached": Orbit does not tell
 * administrators about one slow scan, so its refusal must not read like the
 * held one. An unavailable scanner is unchanged.
 */
const refusal = (result: MalwareScanResult, noun: "inspection" | "preview") => {
  const outcome = classifyScan(result, documentScanCodes);
  if (outcome.status === "clean") throw new Error("expected a refusal");
  return scanRefusal(outcome, noun);
};

describe("scanRefusal and a scan timeout (#1810 W-F2)", () => {
  it("answers a timeout with 503 document_scanner_timeout", () => {
    expect(refusal({ status: "error", reason: "timeout" }, "preview")).toMatchObject({ code: "document_scanner_timeout", status: 503 });
  });

  it("says the scanner did not answer in time, naming the step", () => {
    expect(refusal({ status: "error", reason: "timeout" }, "preview").message).toBe(
      "Document preview is not possible because the malware scanner did not answer in time. Try again, or add the entry and Orbit will check the file then.",
    );
    expect(refusal({ status: "error", reason: "timeout" }, "inspection").message).toMatch(/^Document inspection is not possible because the malware scanner did not answer in time\./u);
  });

  it("keeps document_scanner_unreachable for an unavailable scanner", () => {
    expect(refusal({ status: "error", reason: "unavailable" }, "inspection")).toMatchObject({ code: "document_scanner_unreachable", status: 503 });
    expect(refusal({ status: "error", reason: "unavailable" }, "preview")).toMatchObject({ code: "document_scanner_unreachable", status: 503 });
  });
});
