import { describe, expect, it } from "vitest";
import { repairLetterSpacing } from "./extraction-text-repair";

describe("repairLetterSpacing", () => {
  it("joins the letter-spaced headings Tika makes of small capitals", () => {
    expect(repairLetterSpacing("C U R R EN T  T A X  EX P IR ES\n31 October 2026"))
      .toBe("CURRENT TAX EXPIRES\n31 October 2026");
    expect(repairLetterSpacing("E X PI RY  D ATE 14 May 2027")).toBe("EXPIRY DATE 14 May 2027");
    expect(repairLetterSpacing("MO T test certificate")).toBe("MOT test certificate");
    expect(repairLetterSpacing("M ON TH LY  R E N T £95.00")).toBe("MONTHLY RENT £95.00");
  });

  it("leaves capitalised prose alone, short words and all", () => {
    for (const line of [
      "PROPERTY OF BAND D",
      "YOUR BILL IS MADE UP OF",
      "IF YOU DO NOT PAY WE MAY TAKE ACTION",
      "VAT REG NO 123",
      "Two  spaces  between  words",
    ]) {
      expect(repairLetterSpacing(line)).toBe(line);
    }
  });

  it("does not reach into a word that merely starts with capitals", () => {
    expect(repairLetterSpacing("A B Cdef")).toBe("A B Cdef");
  });
});
