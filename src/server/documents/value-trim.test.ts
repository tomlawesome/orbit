import { describe, expect, it } from "vitest";
import { trimFieldValue } from "@/server/documents/value-trim";

describe("the boundary errors actually observed (#965)", () => {
  it("drops a label that introduces a reference", () => {
    expect(trimFieldValue("reference", "Policy number: HI-9284712", "Policy number: HI-9284712"))
      .toBe("HI-9284712");
  });

  it("drops a bracketed aside that explains a provider", () => {
    const span = "Insurer: Kestrel Mutual (administered by Faircross Broking Ltd)";
    expect(trimFieldValue("provider", "Kestrel Mutual (administered by Faircross Broking Ltd)", span))
      .toBe("Kestrel Mutual");
  });

  it("drops a trailing period from a subtype", () => {
    const span = "COUNCIL TAX DEMAND NOTICE 2027/28";
    expect(trimFieldValue("subtype", "COUNCIL TAX DEMAND NOTICE 2027/28", span))
      .toBe("COUNCIL TAX DEMAND NOTICE");
  });

  it("drops a qualifier after a spaced dash", () => {
    const span = "Boiler and heating plan — annual statement";
    expect(trimFieldValue("subtype", "Boiler and heating plan — annual statement", span))
      .toBe("Boiler and heating plan");
  });
});

describe("values that must survive untouched", () => {
  it("keeps the dashes inside a reference", () => {
    expect(trimFieldValue("reference", "88-2291-KM", "Policy 88-2291-KM")).toBe("88-2291-KM");
  });

  it("keeps a spaced reference", () => {
    expect(trimFieldValue("reference", "8802 5514 9", "Council tax reference 8802 5514 9"))
      .toBe("8802 5514 9");
  });

  it("keeps a short bracketed qualifier that is part of the name", () => {
    const span = "Supplied by Thameside Water (UK)";
    expect(trimFieldValue("provider", "Thameside Water (UK)", span)).toBe("Thameside Water (UK)");
  });

  it("never applies the subtype rules to a reference", () => {
    // A reference genuinely shaped like a trailing period must survive.
    expect(trimFieldValue("reference", "INV 2027/28", "Invoice INV 2027/28")).toBe("INV 2027/28");
  });

  it("keeps an unspaced dash in a provider name", () => {
    expect(trimFieldValue("provider", "Marks-Spencer Energy", "From Marks-Spencer Energy"))
      .toBe("Marks-Spencer Energy");
  });
});

describe("the span is the safety net", () => {
  it("refuses a trim the span does not carry", () => {
    // The span quotes only the labelled form, so the bare value is not in it.
    const value = "Policy number: HI-9284712";
    expect(trimFieldValue("reference", value, "Policy number: HI-928471")).toBe(value);
  });

  it("never returns an empty string", () => {
    expect(trimFieldValue("subtype", "Notice:", "Notice:")).toBe("Notice:");
  });

  it("leaves a value alone when no rule applies", () => {
    expect(trimFieldValue("provider", "Northfield Gas", "Billed by Northfield Gas"))
      .toBe("Northfield Gas");
  });

  it("compares against the span the way grounding does, ignoring case and spacing", () => {
    const span = "Insurer:   Kestrel   Mutual (administered by Faircross Broking Ltd)";
    expect(trimFieldValue("provider", "Kestrel Mutual (administered by Faircross Broking Ltd)", span))
      .toBe("Kestrel Mutual");
  });
});

describe("rules compose in order", () => {
  it("drops a label and an aside from one provider", () => {
    const span = "Provider: Halverston Home Cover (a trading name of Halverston Group plc)";
    expect(trimFieldValue("provider", "Provider: Halverston Home Cover (a trading name of Halverston Group plc)", span))
      .toBe("Halverston Home Cover");
  });

  it("leaves the value trimmed by whatever rules did apply when one fails", () => {
    // The aside rule cannot fire (two words), the label rule can.
    const span = "Type: Contents insurance (UK)";
    expect(trimFieldValue("subtype", "Type: Contents insurance (UK)", span))
      .toBe("Contents insurance (UK)");
  });
});
