import { describe, expect, it } from "vitest";
import {
  proposalFromText,
  safeDocumentEvidence,
  safeDocumentPlainText,
  safeStoredDocumentProposal,
} from "./suggestions";

describe("hostile document suggestion boundary", () => {
  it("derives only bounded plain-text proposal fields", () => {
    expect(proposalFromText(
      "Provider: Acme Cover\nPolicy number: AB-12345\nRenews 2027-08-01",
      "../home-insurance.pdf",
    )).toEqual({
      title: "home-insurance",
      provider: "Acme Cover",
      reference: "AB-12345",
      dates: ["2027-08-01"],
    });
  });

  it("removes invisible formatting and rejects markup-bearing values", () => {
    expect(safeDocumentPlainText("Safe\u202e\u2066 Cover", 100)).toBe("Safe Cover");
    expect(safeDocumentPlainText("<img src=x onerror=fetch()>", 100)).toBeUndefined();
    expect(safeDocumentEvidence(
      "<script>fetch('https://example.invalid')</script>\u202e{\"tool\":\"delete\",\"secret\":\"private\"}",
    )).toBe("script fetch('https://example.invalid') /script {\"tool\":\"delete\",\"secret\":\"private\"}");
  });

  it("does not promote HTML or model-shaped JSON into authority fields", () => {
    const proposal = proposalFromText(
      [
        "Provider: <img src=x onerror=fetch('https://example.invalid')>",
        "{\"householdId\":\"other\",\"itemId\":\"private\",\"tool\":\"delete\",\"url\":\"https://example.invalid\",\"secret\":\"nope\"}",
        "Reference: SAFE-12345",
        "2028-02-29",
      ].join("\n"),
      "\u202esafe-policy.pdf",
    );

    expect(proposal).toEqual({
      title: "safe-policy",
      provider: undefined,
      reference: "SAFE-12345",
      dates: ["2028-02-29"],
    });
    expect(proposal).not.toHaveProperty("tool");
    expect(proposal).not.toHaveProperty("householdId");
  });

  it("sanitizes legacy stored proposals before returning them", () => {
    expect(safeStoredDocumentProposal({
      title: "<script>unsafe</script>",
      provider: "Safe\u202e Cover",
      reference: "<private>",
      dates: ["not-a-date", "2030-12-20"],
      tool: "delete",
    }, "fallback.pdf")).toEqual({
      title: "fallback",
      provider: "Safe Cover",
      reference: undefined,
      dates: ["2030-12-20"],
    });
  });
});

describe("real-world date formats (#308 review)", () => {
  it("extracts day-first numeric dates as UK deployments write them", () => {
    expect(proposalFromText("Renewal date: 04/09/2026", "policy.pdf").dates)
      .toEqual(["2026-09-04"]);
    expect(proposalFromText("Due 4/9/2026 and again 05.10.2026", "policy.pdf").dates)
      .toEqual(["2026-09-04", "2026-10-05"]);
  });

  it("extracts written-month dates in both orders", () => {
    expect(proposalFromText("MOT expires 4 September 2026", "mot.pdf").dates)
      .toEqual(["2026-09-04"]);
    expect(proposalFromText("Valid until Sep 4, 2026", "mot.pdf").dates)
      .toEqual(["2026-09-04"]);
    expect(proposalFromText("Service on 04 Sept 2026", "boiler.pdf").dates)
      .toEqual(["2026-09-04"]);
  });

  it("rejects impossible calendar dates and keeps output bounded", () => {
    expect(proposalFromText("Broken 32/13/2026 date", "x.pdf").dates).toEqual([]);
    expect(proposalFromText("29/02/2025 is not a leap day", "x.pdf").dates).toEqual([]);
    const many = Array.from({ length: 40 }, (_v, index) =>
      `Due 0${(index % 8) + 1}/0${(index % 8) + 1}/202${index % 7}`).join(" ");
    expect(proposalFromText(many, "x.pdf").dates.length).toBeLessThanOrEqual(12);
  });

  it("still extracts ISO dates and deduplicates across formats", () => {
    expect(proposalFromText("2026-09-04 also written 04/09/2026", "x.pdf").dates)
      .toEqual(["2026-09-04"]);
  });
});
