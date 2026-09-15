// The truth file is typed by hand in Excel on the owner's own machine, where
// nobody here can see what went in or what it made of it. So the forgiveness
// is tested here: what it accepts, and where it refuses to guess.
import { describe, expect, it } from "vitest";

import { readTruthFile, truthCsv } from "./truth";

/** A file with the standard header and one row of cells. */
function truthFileWith(cells: Record<string, string>): string {
  const columns = ["file", "provider", "reference", "subtype", "cost", "currency", "dates", "dateRoles", "scheduleKind", "recurrenceMonths"];
  const row = columns.map((name) => `"${(cells[name] ?? "").replaceAll('"', '""')}"`);
  return `${columns.map((name) => `"${name}"`).join(",")}\r\n${row.join(",")}\r\n`;
}

function onlyEntry(cells: Record<string, string>) {
  const { entries } = readTruthFile(truthFileWith({ file: "bill.pdf", ...cells }));
  expect(entries).toHaveLength(1);
  return entries[0];
}

describe("the truth file the owner fills in", () => {
  it("starts pre-filled with what the reader read, and reads back the same", () => {
    const csv = truthCsv([{
      file: "broadband.pdf",
      fields: {
        provider: "Kestrel Broadband",
        reference: "ORD-2026-0417726",
        subtype: "Broadband contract",
        costMinor: 83976,
        currency: "GBP",
        dates: ["2026-04-22", "2028-04-21"],
        dateRoles: [{ date: "2026-04-22", role: "start" }, { date: "2028-04-21", role: "renewal" }],
        scheduleKind: "renewal",
        recurrenceMonths: 24,
      },
    }]);

    expect(readTruthFile(csv).entries).toEqual([{
      file: "broadband.pdf",
      scorable: true,
      expected: {
        provider: "Kestrel Broadband",
        reference: "ORD-2026-0417726",
        subtype: "Broadband contract",
        costMinor: 83976,
        currency: "GBP",
        dates: ["2026-04-22", "2028-04-21"],
        dateRoles: [{ date: "2026-04-22", role: "start" }, { date: "2028-04-21", role: "renewal" }],
        scheduleKind: "renewal",
        recurrenceMonths: 24,
      },
    }]);
  });

  it("gives a document with nothing read a row of blanks, which claims nothing but 'no dates'", () => {
    const entry = readTruthFile(truthCsv([{ file: "scan.png" }])).entries[0];
    expect(entry).toEqual({ file: "scan.png", scorable: true, expected: { dates: [] } });
  });

  it("takes the money the way a person writes it", () => {
    expect(onlyEntry({ cost: " £1,234.56 " }).expected).toMatchObject({ costMinor: 123456, currency: "GBP" });
    expect(onlyEntry({ cost: "1234.56", currency: " gbp " }).expected).toMatchObject({ costMinor: 123456, currency: "GBP" });
    expect(onlyEntry({ cost: "EUR 40" }).expected).toMatchObject({ costMinor: 4000, currency: "EUR" });
  });

  it("does not guess a currency that is nowhere on the row", () => {
    const { entries, problems } = readTruthFile(truthFileWith({ file: "bill.pdf", cost: "34.99" }));
    expect(entries[0].expected.costMinor).toBeUndefined();
    expect(problems).toEqual(['bill.pdf: cost "34.99" has no currency, so it is not scored: put GBP in the currency column']);
  });

  it("takes British dates, and roles against them", () => {
    expect(onlyEntry({ dates: "14/03/2026;2026-09-01; 1.4.26 " }).expected.dates)
      .toEqual(["2026-03-14", "2026-09-01", "2026-04-01"]);
    expect(onlyEntry({ dateRoles: "14/03/2026=Renewal" }).expected.dateRoles)
      .toEqual([{ date: "2026-03-14", role: "renewal" }]);
  });

  it("reads the words for a blank as a blank, in any of their spellings", () => {
    expect(onlyEntry({ provider: "none", reference: "N/A", scheduleKind: "-" }).expected)
      .toEqual({ dates: [] });
  });

  it("takes an interval in months, in digits or in words", () => {
    expect(onlyEntry({ recurrenceMonths: "12" }).expected.recurrenceMonths).toBe(12);
    expect(onlyEntry({ recurrenceMonths: "every 12 months" }).expected.recurrenceMonths).toBe(12);
    expect(onlyEntry({ recurrenceMonths: "Annual" }).expected.recurrenceMonths).toBe(12);
    expect(onlyEntry({ recurrenceMonths: "monthly" }).expected.recurrenceMonths).toBe(1);
  });

  it("accepts every word the owner will settle for as the subtype", () => {
    expect(onlyEntry({ subtype: "Broadband contract; Broadband plan | Contract" }).expected.subtype)
      .toEqual(["Broadband contract", "Broadband plan", "Contract"]);
    expect(onlyEntry({ subtype: "Broadband contract" }).expected.subtype).toBe("Broadband contract");
  });

  it("stands the whole document down when a date cannot be read, rather than claiming the page has none", () => {
    const { entries, problems } = readTruthFile(truthFileWith({ file: "gas.pdf", dates: "3rd August 2026" }));
    expect(entries[0].scorable).toBe(false);
    expect(problems).toEqual([
      'gas.pdf: date "3rd August 2026" not understood, so this document is not scored: write it as 2026-08-03 or 03/08/2026',
    ]);
    // 31 February is the reason a shape check is not enough on its own.
    expect(readTruthFile(truthFileWith({ file: "gas.pdf", dates: "31/02/2026" })).entries[0].scorable).toBe(false);
  });

  it("drops a cell it cannot read without dropping the row, everywhere else", () => {
    const { entries, problems } = readTruthFile(truthFileWith({
      file: "bill.pdf", dates: "2026-03-14", dateRoles: "2026-03-14=birthday", scheduleKind: "quarterly",
    }));
    expect(entries[0]).toMatchObject({ scorable: true, expected: { dates: ["2026-03-14"] } });
    expect(entries[0].expected.dateRoles).toBeUndefined();
    expect(entries[0].expected.scheduleKind).toBeUndefined();
    expect(problems).toHaveLength(2);
  });

  it("reads a file Excel has been at: reordered columns, odd case, commas and quotes in a cell", () => {
    const { entries } = readTruthFile(
      '"Provider","FILE","dates"\r\n' +
      '"Hale, Brook & Co ""the brokers""","bill.pdf","2026-03-14"\r\n',
    );
    expect(entries).toEqual([{
      file: "bill.pdf",
      scorable: true,
      expected: { provider: 'Hale, Brook & Co "the brokers"', dates: ["2026-03-14"] },
    }]);
  });

  it("skips blank lines, and says so when there is no file column at all", () => {
    expect(readTruthFile('"file","dates"\r\n\r\n"bill.pdf","2026-03-14"\r\n').entries).toHaveLength(1);
    expect(() => readTruthFile('"document","dates"\r\n')).toThrow(/no "file" column/u);
  });
});
