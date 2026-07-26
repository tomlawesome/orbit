import { describe, expect, it } from "vitest";
import { proposalFromText } from "./document-drafts";

describe("proposalFromText", () => {
  it("derives safe, editable suggestions without requiring an extracted field", () => {
    expect(proposalFromText("Provider: Acme Cover\nPolicy number: AB-12345\nRenews 2027-08-01", "home-insurance.pdf"))
      .toEqual({ title: "home-insurance", provider: "Acme Cover", reference: "AB-12345", dates: ["2027-08-01"] });
  });

  it("falls back to the filename when no usable text is available", () => {
    expect(proposalFromText("", "receipt.png")).toEqual({ title: "receipt", provider: undefined, reference: undefined, dates: [] });
  });
});
