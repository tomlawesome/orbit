import { describe, expect, it } from "vitest";
import { proposalFromText } from "./document-drafts";

describe("proposalFromText", () => {
  it("derives safe, editable suggestions without requiring an extracted field", () => {
    expect(proposalFromText("Provider: Acme Cover\nPolicy number: AB-12345\nRenews 2027-08-01", "home-insurance.pdf"))
      .toEqual({
        title: "home-insurance",
        provider: "Acme Cover",
        reference: "AB-12345",
        dates: ["2027-08-01"],
        // The heuristics never label a date with a role: the four
        // model-owned fields and the roles are the model path's (#319,
        // ADR-0025 section 7), so the keys are simply absent here.
      });
  });

  it("falls back to the filename when no usable text is available", () => {
    expect(proposalFromText("", "receipt.png"))
      .toEqual({ title: "receipt", provider: undefined, reference: undefined, dates: [] });
  });
});
