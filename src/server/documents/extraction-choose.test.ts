import { describe, expect, it } from "vitest";

import {
  chooseFields,
  chooseFieldsWithModel,
  costShortlistEntries,
  dateShortlistEntries,
  recurrenceShortlistEntries,
  referenceShortlistEntries,
} from "./extraction-choose";
import type { MeaningTransport } from "./extraction-choose-meaning";
import type { CandidateKind } from "./extraction-sieve";
import type { Tag, TagForKind, TaggedCandidate } from "./extraction-stages";

// Stage 3 never reads the page, so these are built by hand rather than run
// through the sieve: the point is what the choice does with a shortlist,
// not whether the sieve can produce this one.

type TagInput<K extends CandidateKind> =
  | TagForKind[K]
  | {
    value: TagForKind[K];
    trigger?: string;
    source?: "label" | "shape";
    /** What stage 2's date sieves record when more than one of them looked
     * at a date (`extraction-date-sieves.ts`). */
    sieves?: readonly string[];
    strength?: number;
  };

let nextIndex = 0;

/** A tagged candidate. `index` rises with each call, so candidates read in
 * the order the test writes them; `line` defaults to the value, because
 * most rules never look at the block. Give `index` where the test hands
 * stage 3 a page as well, so the two agree about where the figure sits. */
function candidate<K extends CandidateKind>(
  kind: K,
  value: string,
  tags: Array<TagInput<K>>,
  extra: { line?: string; currency?: string; index?: number } = {},
): TaggedCandidate<K> {
  return {
    kind,
    value,
    index: extra.index ?? nextIndex++,
    line: extra.line ?? value,
    ...(extra.currency === undefined ? {} : { currency: extra.currency }),
    tags: tags.map((tag): Tag<K> =>
      typeof tag === "string"
        ? { value: tag, trigger: "", source: "label" }
        : { trigger: "", source: "label", ...tag },
    ),
  };
}

describe("choosing dates and their roles", () => {
  it("keeps every explained date, de-duplicated and in page order, with a role each", () => {
    const chosen = chooseFields([
      candidate("date", "2026-10-15", [{ value: "renewal", trigger: "Renewal date" }]),
      candidate("date", "2026-09-24", [{ value: "due", trigger: "payment due" }]),
      candidate("date", "2026-10-15", [{ value: "renewal", trigger: "renews on" }]),
      // A heading in a renewing kind (extraction-term-end.ts) is what names
      // the term end "renewal" rather than "expiry".
      candidate("heading", "Home insurance schedule", ["title"]),
    ]);

    expect(chosen.dates).toEqual(["2026-10-15", "2026-09-24"]);
    expect(chosen.dateRoles).toEqual([
      { date: "2026-10-15", role: "renewal" },
      { date: "2026-09-24", role: "due" },
    ]);
  });

  // Superseded on 2026-09-11 (owner): a rule never discards what the model
  // could still choose, so a date nothing explained is offered without a
  // role rather than dropped. It was the reason the hold-out lost half its
  // dates -- stage 2 could not label them, so stage 3 never saw them.
  it("keeps a date nothing on the page explained, and says nothing about it", () => {
    const chosen = chooseFields([
      candidate("date", "2026-01-02", ["other"]),
      candidate("date", "2026-03-04", [{ value: "expiry", trigger: "expires" }]),
    ]);

    expect(chosen.dates).toEqual(["2026-01-02", "2026-03-04"]);
    expect(chosen.dateRoles).toEqual([{ date: "2026-03-04", role: "expiry" }]);
  });

  it("offers a date only a guess spoke for, without the guess's role", () => {
    const chosen = chooseFields([
      candidate("date", "2026-01-02", [
        { value: "issued", trigger: "printed 4 times across the document", sieves: ["printed-throughout"], strength: 0 },
      ]),
      candidate("date", "2026-03-04", [{ value: "expiry", trigger: "expires" }]),
    ]);

    expect(chosen.dates).toEqual(["2026-01-02", "2026-03-04"]);
    expect(chosen.dateRoles).toEqual([{ date: "2026-03-04", role: "expiry" }]);
  });

  // Renewal and expiry are one family now (extraction-term-end.ts), so this
  // is tested on two roles that stay distinct through the vote.
  it("lets the role more sieves agree on beat one a single sieve reached", () => {
    const chosen = chooseFields([
      candidate("date", "2026-05-01", [
        { value: "due", trigger: "to pay by", sieves: ["term-arithmetic", "heading-above"], strength: 1 },
        { value: "service", trigger: "next test", sieves: ["heading-above"], strength: 1 },
      ]),
    ]);

    expect(chosen.dateRoles).toEqual([{ date: "2026-05-01", role: "due" }]);
  });

  it("prefers the role whose tag quoted the page over one that guessed", () => {
    const chosen = chooseFields([
      candidate("date", "2026-05-01", ["expiry"]),
      candidate("date", "2026-05-01", [{ value: "renewal", trigger: "Renewal date" }]),
      candidate("heading", "Home insurance schedule", ["title"]),
    ]);

    expect(chosen.dateRoles).toEqual([{ date: "2026-05-01", role: "renewal" }]);
  });

  // Two quoted tags disagreeing used to blank a renewal-vs-expiry tie; the
  // two are one family now, so this is tested on roles that stay distinct.
  it("keeps the date but drops the role when two quoted tags disagree", () => {
    const chosen = chooseFields([
      candidate("date", "2026-05-01", [{ value: "due", trigger: "payment due" }]),
      candidate("date", "2026-05-01", [{ value: "service", trigger: "next service" }]),
    ]);

    expect(chosen.dates).toEqual(["2026-05-01"]);
    expect(chosen.dateRoles).toBeUndefined();
    expect(chosen.scheduleKind).toBeUndefined();
  });

  it("prefers a printed label over a range connector for the same date", () => {
    const chosen = chooseFields([
      candidate("date", "2031-06-13", [{ value: "renewal", trigger: "to" }]),
      candidate("date", "2031-06-13", [{ value: "expiry", trigger: "expiring on" }]),
    ]);

    expect(chosen.dateRoles).toEqual([{ date: "2031-06-13", role: "expiry" }]);
  });

  it("lets the job a date does beat the document's own issue date", () => {
    const chosen = chooseFields([
      candidate("date", "2026-08-03", [{ value: "issued", trigger: "Date of issue" }]),
      candidate("date", "2026-08-03", [{ value: "service", trigger: "inspected on" }]),
    ]);

    expect(chosen.dateRoles).toEqual([{ date: "2026-08-03", role: "service" }]);
    expect(chosen.scheduleKind).toBe("service");
  });

  it("still blanks the role when two equally specific labels disagree", () => {
    const chosen = chooseFields([
      candidate("date", "2026-05-01", [{ value: "start", trigger: "starts on" }]),
      candidate("date", "2026-05-01", [{ value: "service", trigger: "next service" }]),
    ]);

    expect(chosen.dates).toEqual(["2026-05-01"]);
    expect(chosen.dateRoles).toBeUndefined();
  });

  it("reads a date that ends one period and starts the next as the start", () => {
    const chosen = chooseFields([
      candidate("date", "2026-10-15", [{ value: "renewal", trigger: "to" }]),
      candidate("date", "2026-10-15", [{ value: "renewal", trigger: "policy ends on" }]),
      candidate("date", "2026-10-15", [{ value: "start", trigger: "to" }]),
    ]);

    expect(chosen.dateRoles).toEqual([{ date: "2026-10-15", role: "start" }]);
  });

  it("takes the role the page states most often when equal labels disagree", () => {
    const chosen = chooseFields([
      candidate("date", "2027-09-08", [{ value: "expiry", trigger: "EXPIRY DATE" }]),
      candidate("date", "2027-09-08", [{ value: "expiry", trigger: "expiry date" }]),
      candidate("date", "2027-09-08", [{ value: "service", trigger: "next test" }]),
    ]);

    expect(chosen.dateRoles).toEqual([{ date: "2027-09-08", role: "expiry" }]);
  });

  it("returns no dates at all when there are no date candidates", () => {
    expect(chooseFields([])).toEqual({ dates: [] });
  });
});

describe("deriving the schedule kind from the roles kept", () => {
  it("says renewal when any kept role is a renewal, whatever else is there", () => {
    const chosen = chooseFields([
      candidate("date", "2026-02-01", [{ value: "service", trigger: "next service" }]),
      candidate("date", "2026-06-01", [{ value: "renewal", trigger: "renewal date" }]),
      candidate("heading", "Home insurance schedule", ["title"]),
    ]);

    expect(chosen.scheduleKind).toBe("renewal");
  });

  it("says service when a service date is the only schedule-bearing role", () => {
    const chosen = chooseFields([
      candidate("date", "2026-02-01", [{ value: "issued", trigger: "Date of issue" }]),
      candidate("date", "2027-02-01", [{ value: "service", trigger: "next inspection" }]),
    ]);

    expect(chosen.scheduleKind).toBe("service");
  });

  it("says nothing when the dates are only an expiry, a due date and a start", () => {
    const chosen = chooseFields([
      candidate("date", "2026-02-01", [{ value: "start", trigger: "cover begins" }]),
      candidate("date", "2026-03-01", [{ value: "due", trigger: "payable by" }]),
      candidate("date", "2027-02-01", [{ value: "expiry", trigger: "expires" }]),
    ]);

    expect(chosen.scheduleKind).toBeUndefined();
  });
});

describe("reading the cycle length off the block a candidate sits in", () => {
  it("reads a year however the page words it", () => {
    const chosen = chooseFields([
      candidate("date", "2027-03-31", [{ value: "renewal", trigger: "Charge for the year" }], {
        line: "Total council tax charge for the year £2,159.07",
      }),
      // A renewing kind (extraction-term-end.ts), so the term end is a
      // renewal and there is a schedule for a cycle length to belong to.
      candidate("heading", "Council Tax bill", ["title"]),
    ]);

    expect(chosen.recurrenceMonths).toBe(12);
  });

  const withLine = (line: string) =>
    chooseFields([
      candidate("date", "2026-06-01", [{ value: "renewal", trigger: "renewal date" }], { line }),
      candidate("heading", "Home insurance schedule", ["title"]),
    ]);

  it("reads a figure in months", () => {
    expect(withLine("Renewal date 1 June 2026, every 12 months").recurrenceMonths).toBe(12);
    expect(withLine("Renewal date 1 June 2026 — 24-month contract").recurrenceMonths).toBe(24);
    expect(withLine("Renewal date 1 June 2026, serviced every 6 months").recurrenceMonths).toBe(6);
  });

  it("reads a figure in years as its months", () => {
    expect(withLine("Renewal date 1 June 2026, 2-year fixed term").recurrenceMonths).toBe(24);
  });

  it("treats an annual cycle as twelve months, and monthly payment as no cycle at all", () => {
    expect(withLine("Renewal date 1 June 2026. Your annual policy, paid monthly.").recurrenceMonths).toBe(12);
    expect(withLine("Renewal date 1 June 2026. Paid by monthly instalments.").recurrenceMonths).toBeUndefined();
  });

  it("says nothing when the cycle is spelled out in words", () => {
    expect(withLine("Renewal date 1 June 2026, a two year agreement").recurrenceMonths).toBeUndefined();
  });

  it("says nothing when there is no schedule for a cycle to belong to", () => {
    const chosen = chooseFields([
      candidate("date", "2026-06-01", [{ value: "expiry", trigger: "expires" }], {
        line: "Expires 1 June 2026, after 12 months",
      }),
    ]);

    expect(chosen.scheduleKind).toBeUndefined();
    expect(chosen.recurrenceMonths).toBeUndefined();
  });
});

describe("choosing the household's reference", () => {
  it("takes the best-labelled identifier, not the first one printed", () => {
    const chosen = chooseFields([
      candidate("identifier", "7724665018", [{ value: "account", trigger: "Account number" }]),
      candidate("identifier", "MTR-8823-0145", [{ value: "policy", trigger: "Policy number" }]),
    ]);

    expect(chosen.reference).toBe("MTR-8823-0145");
  });

  it("prefers a reference over a policy number", () => {
    const chosen = chooseFields([
      candidate("identifier", "MTR-8823-0145", [{ value: "policy", trigger: "Policy number" }]),
      candidate("identifier", "REF-4491", [{ value: "reference", trigger: "Your reference" }]),
    ]);

    expect(chosen.reference).toBe("REF-4491");
  });

  it("blanks when two identifiers are labelled equally well, disagree, and the page repeats neither", () => {
    const chosen = chooseFields([
      candidate("identifier", "POL-1111", [{ value: "policy", trigger: "Policy number" }]),
      candidate("identifier", "POL-2222", [{ value: "policy", trigger: "Policy no." }]),
    ]);

    expect(chosen.reference).toBeUndefined();
  });

  it("takes the one the page repeats when two labelled identifiers disagree", () => {
    const chosen = chooseFields([
      candidate("identifier", "745231", [{ value: "certificate", trigger: "Licence no." }]),
      candidate("identifier", "GSR-2026-04471", [{ value: "certificate", trigger: "Certificate no." }]),
      candidate("identifier", "GSR-2026-04471", ["other"]),
      candidate("identifier", "GSR-2026-04471", ["other"]),
    ]);

    expect(chosen.reference).toBe("GSR-2026-04471");
  });

  it("prefers the number the document is issued under to a policy behind it", () => {
    const chosen = chooseFields([
      candidate("identifier", "GPS-0417-2261", [{ value: "policy", trigger: "Policy no." }]),
      candidate("identifier", "IBG-2026-337215", [{ value: "certificate", trigger: "Certificate no." }]),
    ]);

    expect(chosen.reference).toBe("IBG-2026-337215");
  });

  it("keeps a repeated identifier that agrees with itself", () => {
    const chosen = chooseFields([
      candidate("identifier", "POL-1111", [{ value: "policy", trigger: "Policy number" }]),
      candidate("identifier", "POL-1111", [{ value: "policy", trigger: "policy" }]),
    ]);

    expect(chosen.reference).toBe("POL-1111");
  });

  it("never takes the organisation's own number, even when it is the only one on the page", () => {
    const chosen = chooseFields([
      candidate("identifier", "GB123456789", [{ value: "company", trigger: "VAT registration" }]),
      candidate("identifier", "99887766", ["other"]),
    ]);

    expect(chosen.reference).toBeUndefined();
  });

  it("takes the best tag a candidate carries, ignoring a weaker one beside it", () => {
    const chosen = chooseFields([
      candidate("identifier", "INV-77", [{ value: "invoice", trigger: "Invoice number" }]),
      candidate("identifier", "CUS-88", ["other", { value: "customer", trigger: "Customer number" }]),
    ]);

    expect(chosen.reference).toBe("CUS-88");
  });

  it("lets the kind of thing the page is about decide which label wins", () => {
    const identifiers = [
      candidate("identifier", "REF-4491", [{ value: "reference", trigger: "Your reference" }]),
      candidate("identifier", "MTR-8823-0145", [{ value: "policy", trigger: "Policy number" }]),
    ];

    // Nothing says what this page is about, so "your reference" wins.
    expect(chooseFields(identifiers).reference).toBe("REF-4491");
    // The page calls itself an insurance schedule, so the policy number is
    // the number this household quotes (`extraction-reference-kind.ts`).
    expect(chooseFields([
      candidate("heading", "HOME INSURANCE SCHEDULE", [{ value: "title", trigger: "" }]),
      ...identifiers,
    ]).reference).toBe("MTR-8823-0145");
  });

  it("never takes a number that is somebody else's, even alone on the page", () => {
    // A telephone number the page also called a reference: "call us on
    // 0345 900 2277, quoting your reference" labels one number twice.
    expect(chooseFields([
      candidate("identifier", "0345 900 2277", [
        { value: "reference", trigger: "reference" },
        { value: "phone", trigger: "0345 900 2277", source: "shape" },
      ]),
    ]).reference).toBeUndefined();
  });

  it("does not offer a number that is somebody else's to the model either", () => {
    const entries = referenceShortlistEntries([
      candidate("identifier", "30-92-14", [{ value: "bank", trigger: "Sort code" }]),
      candidate("identifier", "ACC-3348217", [{ value: "account", trigger: "Account number" }]),
    ]);

    expect(entries.map((entry) => entry.value)).toEqual(["ACC-3348217"]);
  });

  it("trims the label off a value that carried one", () => {
    const chosen = chooseFields([
      candidate("identifier", "Policy number: HI-9284712", [{ value: "policy", trigger: "Policy number" }], {
        line: "Policy number: HI-9284712",
      }),
    ]);

    expect(chosen.reference).toBe("HI-9284712");
  });
});

describe("the reference the page carries through every sheet", () => {
  /** Every offset the page printed a value at, in page order: what stage 1
   * would have recorded as each printing's `index`. */
  function printedAt(page: string, value: string): number[] {
    const found: number[] = [];
    for (let at = page.indexOf(value); at !== -1; at = page.indexOf(value, at + 1)) found.push(at);
    return found;
  }

  /** A block per line, as Tika hands one over, and the page's own "page 2 of
   * 3" footers -- the only mark left in the text of where a sheet ended. */
  function page(...blocks: string[]): string {
    return blocks.join("\n\n");
  }

  it("prefers the number printed on every sheet to the better-labelled one printed once", () => {
    const text = page(
      "Northgate Home Security - monitoring agreement",
      "Certificate number CSS-0417",
      "Contract number NGS-CA-20456",
      "NGS-CA-20456 - page 1 of 3",
      "What the monitoring covers",
      "NGS-CA-20456 - page 2 of 3",
      "How to cancel",
      "NGS-CA-20456 - page 3 of 3",
    );
    const [labelled, ...footers] = printedAt(text, "NGS-CA-20456");
    const identifiers = [
      candidate("identifier", "CSS-0417", [{ value: "certificate", trigger: "Certificate number" }], {
        index: printedAt(text, "CSS-0417")[0],
      }),
      candidate("identifier", "NGS-CA-20456", [{ value: "agreement", trigger: "Contract number" }], {
        index: labelled,
      }),
      ...footers.map((index) => candidate("identifier", "NGS-CA-20456", ["other"], { index })),
    ];

    expect(chooseFields(identifiers, text).reference).toBe("NGS-CA-20456");
    // Without the page there are no sheets to count and the better label
    // wins, which is what the ranking did before the sheets were counted.
    expect(chooseFields(identifiers).reference).toBe("CSS-0417");
  });

  it("counts the sheets a number reached, not the times it was printed", () => {
    const text = page(
      "Wexley Water - your bill",
      "Account number 7719 0042 18",
      "Account number 8845 6120 33",
      "Meter reading 8845 6120 33",
      "Estimate 8845 6120 33",
      "Balance brought forward 8845 6120 33",
      "page 1 of 2",
      "7719 0042 18 - page 2 of 2",
    );
    const rival = printedAt(text, "8845 6120 33");
    const chosen = chooseFields([
      ...rival.map((index, at) => candidate(
        "identifier",
        "8845 6120 33",
        at === 0 ? [{ value: "account" as const, trigger: "Account number" }] : ["other" as const],
        { index },
      )),
      ...printedAt(text, "7719 0042 18").map((index, at) => candidate(
        "identifier",
        "7719 0042 18",
        at === 0 ? [{ value: "account" as const, trigger: "Account number" }] : ["other" as const],
        { index },
      )),
    ], text);

    // Four printings against two, the same label on both, and the answer is
    // the one the page carried onto the second sheet rather than the one it
    // set four times in the table on the first.
    expect(rival).toHaveLength(4);
    expect(chosen.reference).toBe("7719 0042 18");
  });

  it("says nothing about a document printed on one sheet", () => {
    const text = page(
      "Foxglove Hosting - renewal",
      "Your reference FGH-2291",
      "Invoice number INV-2026-0099142",
      "INV-2026-0099142",
      "INV-2026-0099142",
    );
    const chosen = chooseFields([
      candidate("identifier", "FGH-2291", [{ value: "reference", trigger: "Your reference" }], {
        index: printedAt(text, "FGH-2291")[0],
      }),
      ...printedAt(text, "INV-2026-0099142").map((index, at) => candidate(
        "identifier",
        "INV-2026-0099142",
        at === 0 ? [{ value: "invoice" as const, trigger: "Invoice number" }] : ["other" as const],
        { index },
      )),
    ], text);

    // Every number is on the one sheet, so the count separates nothing and
    // the word the page used decides, as it does on a page with no sheets.
    expect(chosen.reference).toBe("FGH-2291");
  });

  it("lets the label decide where a rival repeats in the same footer as the answer", () => {
    const text = page(
      "Thornfield Assurance - policy schedule",
      "Policy number TA-HH-7734291 Customer number CUS-880193",
      "TA-HH-7734291 CUS-880193 page 1 of 3",
      "Your cover",
      "TA-HH-7734291 CUS-880193 page 2 of 3",
      "Making a claim",
      "TA-HH-7734291 CUS-880193 page 3 of 3",
    );
    const chosen = chooseFields([
      ...printedAt(text, "TA-HH-7734291").map((index, at) => candidate(
        "identifier",
        "TA-HH-7734291",
        at === 0 ? [{ value: "policy" as const, trigger: "Policy number" }] : ["other" as const],
        { index },
      )),
      ...printedAt(text, "CUS-880193").map((index, at) => candidate(
        "identifier",
        "CUS-880193",
        at === 0 ? [{ value: "customer" as const, trigger: "Customer number" }] : ["other" as const],
        { index },
      )),
    ], text);

    // Both ran through every sheet, so the counts are level and the page's
    // own word for the number is what is left to separate them.
    expect(chosen.reference).toBe("TA-HH-7734291");
  });

  it("keeps the rivals on the shortlist, lower", () => {
    const text = page(
      "Certificate number CSS-0417",
      "Contract number NGS-CA-20456",
      "NGS-CA-20456 - page 1 of 2",
      "NGS-CA-20456 - page 2 of 2",
    );
    const [labelled, ...footers] = printedAt(text, "NGS-CA-20456");
    const entries = referenceShortlistEntries([
      candidate("identifier", "CSS-0417", [{ value: "certificate", trigger: "Certificate number" }], {
        index: printedAt(text, "CSS-0417")[0],
      }),
      candidate("identifier", "NGS-CA-20456", [{ value: "agreement", trigger: "Contract number" }], {
        index: labelled,
      }),
      ...footers.map((index) => candidate("identifier", "NGS-CA-20456", ["other"], { index })),
    ], text);

    expect(entries.map((entry) => entry.value)).toEqual(["NGS-CA-20456", "CSS-0417"]);
  });
});

describe("choosing the cost and its currency", () => {
  it("takes the total over an instalment and a due figure", () => {
    const chosen = chooseFields([
      candidate("amount", "5103", [{ value: "instalment", trigger: "per month" }], { currency: "GBP" }),
      candidate("amount", "61240", [{ value: "total", trigger: "Total payable" }], { currency: "GBP" }),
      candidate("amount", "20000", [{ value: "due", trigger: "amount due" }], { currency: "GBP" }),
    ]);

    expect(chosen.costMinor).toBe(61240);
    expect(chosen.currency).toBe("GBP");
  });

  it("takes a due figure when there is no total", () => {
    const chosen = chooseFields([
      candidate("amount", "5103", [{ value: "instalment", trigger: "per month" }], { currency: "GBP" }),
      candidate("amount", "20000", [{ value: "due", trigger: "amount due" }], { currency: "GBP" }),
    ]);

    expect(chosen.costMinor).toBe(20000);
  });

  it("ignores a figure with no currency rather than letting it outrank one that has", () => {
    const chosen = chooseFields([
      candidate("amount", "41200", [{ value: "total", trigger: "premium" }], { line: "insurance premium +412.00" }),
      candidate("amount", "74218", [{ value: "instalment", trigger: "MONTHLY PAYMENT" }], { currency: "GBP" }),
    ]);

    expect(chosen.costMinor).toBe(74218);
    expect(chosen.currency).toBe("GBP");
  });

  it("never takes last year's premium or the upgrade tier beside it", () => {
    const chosen = chooseFields([
      candidate("amount", "58810", [{ value: "previous", trigger: "last year you paid" }], { currency: "GBP" }),
      candidate("amount", "79900", [{ value: "rival", trigger: "upgrade to" }], { currency: "GBP" }),
      candidate("amount", "1500", ["other"], { currency: "GBP" }),
    ]);

    expect(chosen.costMinor).toBeUndefined();
    expect(chosen.currency).toBeUndefined();
  });

  it("rules out a figure a sieve read in words as a cover limit, whatever else agreed", () => {
    const chosen = chooseFields([
      candidate("amount", "50000", [
        { value: "total", trigger: "per year", sieves: ["label", "words-after"], strength: 2 },
        { value: "other", trigger: "between two cover limits", sieves: ["table-neighbours"], strength: 2 },
      ], { currency: "GBP" }),
      candidate("amount", "28764", [{ value: "total", trigger: "Annual premium" }], { currency: "GBP" }),
    ]);

    expect(chosen.costMinor).toBe(28764);
  });

  it("takes a figure whose only label is the form heading printed straight over it", () => {
    const chosen = chooseFields([
      candidate("amount", "1499", [{ value: "instalment", trigger: "THIS MONTH'S INSTALMENT", sieves: ["heading-above"], strength: 2 }], { currency: "GBP" }),
    ]);

    expect(chosen.costMinor).toBe(1499);
  });

  it("takes the row that adds up the bill over a price read three ways", () => {
    const chosen = chooseFields([
      candidate("amount", "8999", [
        { value: "total", trigger: "per year", sieves: ["label", "words-after", "period-adjacent"], strength: 2 },
      ], { currency: "GBP" }),
      candidate("amount", "1559", [
        { value: "total", trigger: "Total", sieves: ["label", "adds-up"], strength: 2 },
      ], { currency: "GBP" }),
    ]);

    expect(chosen.costMinor).toBe(1559);
  });

  // Owner, 2026-09-13: a fixed-term contract priced only by the month costs
  // duration times the monthly cost.
  it("multiplies a lone instalment by the one contract term the page states", () => {
    const instalment = candidate("amount", "4250", [
      { value: "instalment", trigger: "Monthly membership fee", sieves: ["label", "period-adjacent"], strength: 2 },
    ], { currency: "GBP" });

    expect(chooseFields([instalment], "memberships are subject to an initial minimum term of 12 months from your start date").costMinor).toBe(51000);
    expect(chooseFields([instalment], "This agreement runs for 36 months from 1 June 2025").costMinor).toBe(153000);
    expect(chooseFields([instalment], "Check-ups fall due every 6 months").costMinor).toBe(4250);
    expect(chooseFields([instalment], "Minimum term 12 months. Contract length: 24 months.").costMinor).toBe(4250);
    expect(chooseFields([instalment]).costMinor).toBe(4250);
  });

  it("leaves a printed total alone whatever term the page states", () => {
    const chosen = chooseFields([
      candidate("amount", "2499", [{ value: "instalment", trigger: "Monthly charge", sieves: ["label"], strength: 2 }], { currency: "GBP" }),
      candidate("amount", "59976", [{ value: "total", trigger: "total payable", sieves: ["label", "term-multiple"], strength: 2 }], { currency: "GBP" }),
    ], "24 month minimum term");

    expect(chosen.costMinor).toBe(59976);
  });

  // A rival total outranking the charge, class 1 (item 106): what was paid
  // before is a real, labelled total and still not the commitment.
  it("puts the figure the page dates to last time under every current one", () => {
    const chosen = chooseFields([
      candidate("amount", "14000", [
        { value: "due", trigger: "payment of", sieves: ["label", "heading-above", "printed-throughout"], strength: 2 },
      ], { currency: "GBP", line: "Your last payment of £140.00 was received on 14/10/2026." }),
      candidate("amount", "14255", [
        { value: "due", trigger: "Amount due", sieves: ["label", "printed-throughout"], strength: 2 },
      ], { currency: "GBP", line: "Amount due, 12 November 2026 £142.55" }),
    ]);

    expect(chosen.costMinor).toBe(14255);
  });

  it("keeps last time's figure on the shortlist, under the current ones", () => {
    const entries = costShortlistEntries([
      candidate("amount", "3900", [
        { value: "instalment", trigger: "a month", sieves: ["label", "words-after", "period-adjacent"], strength: 2 },
      ], { currency: "GBP", line: "under the previous price list may still be paying £39.00 a month" }),
      candidate("amount", "4250", [
        { value: "instalment", trigger: "Monthly membership fee", sieves: ["label"], strength: 2 },
      ], { currency: "GBP", line: "Monthly membership fee, collected by Direct Debit £42.50" }),
    ]);

    expect(entries.map((entry) => entry.value)).toEqual(["4250", "3900"]);
  });

  it("still reads a figure the page also prints plainly as a current one", () => {
    const chosen = chooseFields([
      candidate("amount", "28764", [
        { value: "total", trigger: "Annual premium", sieves: ["label"], strength: 2 },
      ], { currency: "GBP", line: "Annual premium (paid in full): £287.64." }),
      candidate("amount", "28764", [
        { value: "total", trigger: "premium", sieves: ["printed-throughout"], strength: 2 },
      ], { currency: "GBP", line: "Last year's premium was £287.64." }),
    ]);

    expect(chosen.costMinor).toBe(28764);
  });

  // Class 2: the page prices one thing twice, and the option to spread the
  // cost is not a second commitment (ADR-0026, 2026-09-13).
  it("takes the premium over the total of paying it monthly", () => {
    const chosen = chooseFields([
      candidate("amount", "44928", [
        { value: "total", trigger: "total", sieves: ["label", "term-multiple", "period-adjacent"], strength: 2 },
      ], { currency: "GBP", line: "Paid monthly across 12 instalments — £37.44 (total £449.28)" }),
      candidate("amount", "41266", [
        { value: "total", trigger: "premium", sieves: ["label"], strength: 2 },
      ], { currency: "GBP", line: "Annual premium, including Insurance Premium Tax £412.66" }),
    ]);

    expect(chosen.costMinor).toBe(41266);
  });

  it("leaves the year's price alone where the page says it is paid monthly", () => {
    const chosen = chooseFields([
      candidate("amount", "17988", [
        { value: "total", trigger: "Annual total if paid monthly", sieves: ["label"], strength: 2 },
      ], { currency: "GBP", line: "Annual total if paid monthly £179.88" }),
      candidate("amount", "1499", [
        { value: "instalment", trigger: "a month", sieves: ["period-adjacent"], strength: 1 },
      ], { currency: "GBP", line: "£14.99 a month" }),
    ]);

    expect(chosen.costMinor).toBe(17988);
  });

  it("separates two equally spoken-for figures by which one the page frames as the term", () => {
    const chosen = chooseFields([
      candidate("amount", "2500", [
        { value: "total", trigger: "fee", sieves: ["label"], strength: 2 },
      ], { currency: "GBP", line: "Mid-term adjustment fee (if you change your cover) £25.00" }),
      candidate("amount", "68430", [
        { value: "total", trigger: "ANNUAL PREMIUM (INCL. IPT)", sieves: ["heading-above"], strength: 2 },
      ], { currency: "GBP", line: "£684.30 for the 12 month period" }),
    ]);

    expect(chosen.costMinor).toBe(68430);
  });

  // Class 3: a tier table comparing this plan with the two beside it
  // borrows the premium into a "per condition" row, and the premium is
  // still the premium.
  it("keeps a figure another cell reads as a cover limit where its own cell names it", () => {
    const chosen = chooseFields([
      candidate("amount", "28764", [
        { value: "total", trigger: "Annual premium", sieves: ["label"], strength: 2 },
      ], { currency: "GBP", line: "Annual premium (paid in full): £287.64." }),
      candidate("amount", "28764", [
        { value: "other", trigger: "per condition", sieves: ["label"], strength: 2 },
        { value: "total", trigger: "printed 3 times", sieves: ["printed-throughout"], strength: 1 },
      ], { currency: "GBP", line: "Standard (this policy) £7,500 per condition £287.64" }),
      candidate("amount", "27120", [
        { value: "total", trigger: "Annual premium", sieves: ["label"], strength: 2 },
      ], { currency: "GBP", line: "1 April 2025 to 31 March 2026 £271.20" }),
    ]);

    expect(chosen.costMinor).toBe(28764);
  });

  // Class 4: the panel of things the page also sells.
  it("ranks a price under an offers heading below the page's own charge", () => {
    const page = [
      "RAILCARD OFFERS",
      "16-25 Railcard — £30.00 for one year, code RC-1625.",
      "SEASON TICKET",
      "Annual season ticket £3,412.00",
    ].join("\n");
    const chosen = chooseFields([
      candidate("amount", "3000", [
        { value: "total", trigger: "for one year", sieves: ["label", "words-after", "period-adjacent"], strength: 2 },
      ], {
        currency: "GBP",
        line: "16-25 Railcard — £30.00 for one year, code RC-1625.",
        index: page.indexOf("£30.00"),
      }),
      candidate("amount", "341200", [
        { value: "total", trigger: "Annual season ticket", sieves: ["label"], strength: 2 },
      ], { currency: "GBP", line: "Annual season ticket £3,412.00", index: page.indexOf("£3,412.00") }),
    ], page);

    expect(chosen.costMinor).toBe(341200);
  });

  it("blanks when two totals disagree", () => {
    const chosen = chooseFields([
      candidate("amount", "61240", [{ value: "total", trigger: "Total payable" }], { currency: "GBP" }),
      candidate("amount", "70000", [{ value: "total", trigger: "Total" }], { currency: "GBP" }),
    ]);

    expect(chosen.costMinor).toBeUndefined();
    expect(chosen.currency).toBeUndefined();
  });

  it("blanks the amount too when its evidence carried no currency", () => {
    const chosen = chooseFields([
      candidate("amount", "61240", [{ value: "total", trigger: "Total payable" }]),
    ]);

    expect(chosen.costMinor).toBeUndefined();
    expect(chosen.currency).toBeUndefined();
  });

  it("takes the figure two sieves agree about over one a single sieve read", () => {
    const chosen = chooseFields([
      candidate("amount", "15931", [
        { value: "total", trigger: "Total charges for this period", sieves: ["label"], strength: 2 },
      ], { currency: "GBP" }),
      candidate("amount", "16337", [
        {
          value: "due",
          trigger: "Amount due",
          sieves: ["label", "printed-throughout"],
          strength: 2,
        },
      ], { currency: "GBP" }),
    ]);

    expect(chosen.costMinor).toBe(16337);
  });

  it("answers from sieves alone where no label named the figure", () => {
    const chosen = chooseFields([
      candidate("amount", "215907", [
        {
          value: "total",
          trigger: "2026/27",
          sieves: ["column-period", "instalment-total"],
          strength: 2,
        },
      ], { currency: "GBP" }),
      candidate("amount", "31244", [
        { value: "total", trigger: "2026/27", sieves: ["column-period"], strength: 2 },
      ], { currency: "GBP" }),
    ]);

    expect(chosen.costMinor).toBe(215907);
  });

  // #1006 class 1: "members still on it pay £98.40 a year" is a rival price
  // in a sentence, and "a year" says how often it falls due -- not that this
  // figure is the document's total.
  it("does not read a period word in a sentence as a total", () => {
    const chosen = chooseFields([
      candidate("amount", "9840", [
        { value: "total", trigger: "a year", sieves: ["label", "words-after", "period-adjacent"], strength: 2 },
      ], { currency: "GBP", line: "Members who are still on the old rate pay £98.40 a year." }),
      candidate("amount", "8499", [
        { value: "due", trigger: "Amount due", sieves: ["label", "printed-throughout"], strength: 2 },
      ], { currency: "GBP", line: "£84.99" }),
    ]);

    expect(chosen.costMinor).toBe(8499);
  });

  it("keeps a period word as a total where the page printed it in a row", () => {
    const chosen = chooseFields([
      candidate("amount", "9600", [
        { value: "total", trigger: "a year", sieves: ["label", "period-adjacent"], strength: 2 },
      ], { currency: "GBP", line: "European breakdown cover £96.00 a year" }),
    ]);

    expect(chosen.costMinor).toBe(9600);
  });

  // #1006 class 3: two figures the sieves spoke for equally well used to
  // blank, throwing away the page's own arithmetic.
  it("breaks a tie towards the figure the line items add up to", () => {
    const chosen = chooseFields([
      candidate("amount", "215907", [
        { value: "total", trigger: "ten monthly instalments of £215.91", sieves: ["instalment-total", "column-period"], strength: 2 },
      ], { currency: "GBP" }),
      candidate("amount", "194630", [
        { value: "total", trigger: "Total", sieves: ["label", "heading-above"], strength: 2 },
      ], { currency: "GBP" }),
    ]);

    expect(chosen.costMinor).toBe(215907);
  });

  it("still blanks a tie neither figure's line items settle", () => {
    const chosen = chooseFields([
      candidate("amount", "215907", [
        { value: "total", trigger: "Total", sieves: ["label", "column-period"], strength: 2 },
      ], { currency: "GBP" }),
      candidate("amount", "194630", [
        { value: "total", trigger: "Total", sieves: ["label", "heading-above"], strength: 2 },
      ], { currency: "GBP" }),
    ]);

    expect(chosen.costMinor).toBeUndefined();
  });

  it("rules out a figure a sieve read in so many words as last year's", () => {
    const chosen = chooseFields([
      candidate("amount", "205630", [
        { value: "total", trigger: "charge for the year", sieves: ["label"], strength: 2 },
        { value: "previous", trigger: "2025/26", sieves: ["column-period"], strength: 2 },
      ], { currency: "GBP" }),
    ]);

    expect(chosen.costMinor).toBeUndefined();
  });

  // #1006 class 5: the multiplier has to be a term the page printed in so
  // many words. A span counted off two dates is a period the document
  // covers, not a commitment it prices, so the monthly figure stands.
  it("will not multiply by a term it had to count off the dates itself", () => {
    const instalment = candidate("amount", "3499", [
      { value: "instalment", trigger: "Monthly price", sieves: ["label", "period-adjacent"], strength: 2 },
    ], { currency: "GBP" });
    const page = (from: string, to: string) => chooseFields([
      candidate("date", from, [{ value: "start", trigger: "Service start date" }]),
      candidate("date", to, [{ value: "expiry", trigger: "Contract end date" }]),
      instalment,
    ], "Monthly price £34.99. Service start date and contract end date as shown.").costMinor;

    // Two years to the day, and the same two years drawn inclusively: a
    // clean term either way, and still not one the page wrote down.
    expect(page("2025-03-20", "2027-03-20")).toBe(3499);
    expect(page("2026-04-01", "2027-03-31")).toBe(3499);
    expect(page("2026-04-01", "2027-03-14")).toBe(3499);
  });

  it("still multiplies where the same page also states the term in words", () => {
    const chosen = chooseFields([
      candidate("date", "2025-03-20", [{ value: "start", trigger: "Service start date" }]),
      candidate("date", "2027-03-20", [{ value: "expiry", trigger: "Contract end date" }]),
      candidate("amount", "3499", [
        { value: "instalment", trigger: "Monthly price", sieves: ["label", "period-adjacent"], strength: 2 },
      ], { currency: "GBP" }),
    ], "Monthly price £34.99. Minimum term 24 months.");

    expect(chosen.costMinor).toBe(3499 * 24);
  });

  // A thing that renews rolls on rather than running out, so its period is
  // not a commitment and its monthly price stands (owner, 2026-09-13).
  it("keeps the monthly figure where the term ends in a renewal", () => {
    const chosen = chooseFields([
      candidate("date", "2026-04-06", [{ value: "start", trigger: "Cover start date" }]),
      candidate("date", "2027-04-06", [{ value: "renewal", trigger: "Renewal date" }]),
      candidate("amount", "1450", [
        { value: "instalment", trigger: "Monthly premium", sieves: ["label", "period-adjacent"], strength: 2 },
      ], { currency: "GBP" }),
    ], "Monthly premium £14.50. This plan renews each year. Health Plan Certificate.");

    expect(chosen.costMinor).toBe(1450);
  });

  it("keeps the monthly figure where the dates make no term at all", () => {
    const chosen = chooseFields([
      candidate("date", "2026-04-01", [{ value: "issued", trigger: "Date of issue" }]),
      candidate("amount", "2150", [
        { value: "instalment", trigger: "Monthly subscription", sieves: ["label", "period-adjacent"], strength: 2 },
      ], { currency: "GBP" }),
    ], "Monthly subscription £21.50. This is a rolling monthly plan with no minimum term.");

    expect(chosen.costMinor).toBe(2150);
  });

  it("keeps the monthly figure where the page states two different terms", () => {
    const chosen = chooseFields([
      candidate("amount", "3499", [
        { value: "instalment", trigger: "Monthly price", sieves: ["label", "period-adjacent"], strength: 2 },
      ], { currency: "GBP" }),
    ], "Monthly price £34.99. Minimum term 12 months. Contract length: 24 months.");

    expect(chosen.costMinor).toBe(3499);
  });

  // Owner, 2026-09-13: a flat term times the standing rate is money never
  // paid where the page opened with a cheaper leg.
  it("sums the legs where the page prices the first few months differently", () => {
    const standing = candidate("amount", "2300", [
      { value: "instalment", trigger: "standard monthly charge", sieves: ["label", "period-adjacent"], strength: 2 },
    ], { currency: "GBP" });

    expect(chooseFields([standing],
      "£14.00/mo for your first 6 months £23.00/mo standard monthly charge, from month 7 onward. Minimum term 24 months")
      .costMinor).toBe(6 * 1400 + 18 * 2300);
    expect(chooseFields([standing],
      "First 3 months at £9.99 a month, then £23.00 per month. Contract length: 18 months")
      .costMinor).toBe(3 * 999 + 15 * 2300);
  });

  it("leaves the whole term at one price where the introductory leg outlasts it", () => {
    const chosen = chooseFields([
      candidate("amount", "2300", [
        { value: "instalment", trigger: "monthly charge", sieves: ["label", "period-adjacent"], strength: 2 },
      ], { currency: "GBP" }),
    ], "£14.00/mo for your first 24 months. Minimum term 12 months");

    expect(chosen.costMinor).toBe(12 * 2300);
  });

  it("blanks where the chosen figure is the introductory rate itself", () => {
    const chosen = chooseFields([
      candidate("amount", "1400", [
        { value: "instalment", trigger: "Monthly price", sieves: ["label", "period-adjacent"], strength: 2 },
      ], { currency: "GBP" }),
    ], "£14.00/mo for your first 6 months. Minimum term 24 months");

    expect(chosen.costMinor).toBeUndefined();
  });

  it("blanks where the page names two different introductory legs", () => {
    const chosen = chooseFields([
      candidate("amount", "2300", [
        { value: "instalment", trigger: "monthly charge", sieves: ["label", "period-adjacent"], strength: 2 },
      ], { currency: "GBP" }),
    ], "£14.00/mo for your first 6 months. £12.00/mo for your first 3 months. Minimum term 24 months");

    expect(chosen.costMinor).toBeUndefined();
  });

  it("refuses a lump sum for the opening months as an introductory rate", () => {
    const chosen = chooseFields([
      candidate("amount", "2300", [
        { value: "instalment", trigger: "monthly charge", sieves: ["label", "period-adjacent"], strength: 2 },
      ], { currency: "GBP" }),
    ], "£300.00 for your first 6 months. Minimum term 24 months");

    expect(chosen.costMinor).toBe(24 * 2300);
  });

  it("hears the monthly fee where nothing the page called a total earned a hearing", () => {
    const chosen = chooseFields([
      candidate("amount", "45900", [
        { value: "total", trigger: "a year", sieves: ["period-adjacent"], strength: 1 },
      ], { currency: "GBP" }),
      candidate("amount", "4250", [
        { value: "instalment", trigger: "Monthly membership fee", sieves: ["label"], strength: 2 },
      ], { currency: "GBP" }),
    ]);

    expect(chosen.costMinor).toBe(4250);
  });
});

// Item 99: on real paper the answers about one thing are printed together,
// so once one field is settled with a clear margin the candidates for the
// others beside it are heard a little louder. Measured field by field: cost
// is the one that gained, and it gained as the LAST tie-break -- so these
// are the rules that shipped, and the two that bound them.
describe("the answers cluster: the figure printed with the settled field", () => {
  /** A number the page labelled and printed nowhere else: the anchor, with
   * no rival to make its margin unclear. */
  const reference = (line: string) =>
    candidate("identifier", "POL-88421", [{ value: "policy", trigger: "Policy number", strength: 2 }], { line });

  it("breaks a tie towards the figure printed in the anchor's own block", () => {
    const panel = "Policy number POL-88421 Total premium £412.66";
    const chosen = chooseFields([
      reference(panel),
      candidate("amount", "41266", [
        { value: "total", trigger: "Total premium", sieves: ["label", "heading-above"], strength: 2 },
      ], { currency: "GBP", line: panel }),
      candidate("amount", "37820", [
        { value: "total", trigger: "Total", sieves: ["label", "heading-above"], strength: 2 },
      ], { currency: "GBP", line: "Home emergency cover Total £378.20" }),
    ]);

    expect(chosen.costMinor).toBe(41266);
  });

  it("still prefers a labelled figure far from the anchor over an unlabelled one beside it", () => {
    const panel = "Policy number POL-88421 £61.83";
    const chosen = chooseFields([
      reference(panel),
      candidate("amount", "6183", [
        { value: "total", trigger: "a year", sieves: ["period-adjacent"], strength: 1 },
      ], { currency: "GBP", line: panel }),
      candidate("amount", "41266", [
        { value: "total", trigger: "Total premium", sieves: ["label", "heading-above"], strength: 2 },
      ], { currency: "GBP", line: "Your premium Total premium £412.66", index: 4_000 }),
    ]);

    expect(chosen.costMinor).toBe(41266);
  });

  it("says nothing where no field was settled clearly, as it did before", () => {
    const panel = "Customer 9034 1128 Total £412.66";
    const chosen = chooseFields([
      // Two numbers labelled equally well and neither repeated: the
      // reference chooser blanks, so there is no anchor to lean on.
      candidate("identifier", "9034 1128", [{ value: "customer", trigger: "Customer number", strength: 2 }], { line: panel }),
      candidate("identifier", "4471 8823", [{ value: "customer", trigger: "Customer number", strength: 2 }], { line: "Customer number 4471 8823" }),
      candidate("amount", "41266", [
        { value: "total", trigger: "Total", sieves: ["label", "heading-above"], strength: 2 },
      ], { currency: "GBP", line: panel }),
      candidate("amount", "37820", [
        { value: "total", trigger: "Total", sieves: ["label", "heading-above"], strength: 2 },
      ], { currency: "GBP", line: "Home emergency cover Total £378.20" }),
    ]);

    expect(chosen.reference).toBeUndefined();
    expect(chosen.costMinor).toBeUndefined();
  });

  it("keeps the far figure on the shortlist, lower down", () => {
    const panel = "Policy number POL-88421 Total premium £412.66";
    const entries = costShortlistEntries([
      reference(panel),
      candidate("amount", "37820", [
        { value: "total", trigger: "Total", sieves: ["label", "heading-above"], strength: 2 },
      ], { currency: "GBP", line: "Home emergency cover Total £378.20" }),
      candidate("amount", "41266", [
        { value: "total", trigger: "Total premium", sieves: ["label", "heading-above"], strength: 2 },
      ], { currency: "GBP", line: panel }),
    ]);

    expect(entries.map((entry) => entry.value)).toEqual(["41266", "37820"]);
  });
});

describe("the meaning-shaped fields", () => {
  it("takes the one name the sieves kept, and the one subtype the page is plain about", () => {
    const chosen = chooseFields([
      candidate("organisation", "Kestrel Mutual", [
        { value: "provider", trigger: "your insurer", sieves: ["language-fact", "contact-details"] },
      ]),
      candidate("heading", "HOME INSURANCE", [{ value: "title", trigger: "" }]),
    ]);

    // The fallback answers the run the page says most often
    // (`extraction-provider-runs.ts`) and the qualifier and kind bins that
    // stand clear (`extraction-subtype-bins.ts`); here each has only the one.
    expect(chosen.provider).toBe("Kestrel Mutual");
    expect(chosen.subtype).toBe("Home Insurance");
  });

  it("does not say a word twice where the qualifier and the kind are the same word", () => {
    // "Mortgage" is both a qualifier and a kind in the taxonomy, and a
    // mortgage statement lands its words in both bins: the answer is
    // "Mortgage", not "Mortgage Mortgage" (owner's real documents,
    // 2026-09-13).
    const chosen = chooseFields([
      candidate("heading", "MORTGAGE ANNUAL STATEMENT", [{ value: "title", trigger: "" }]),
      candidate("heading", "Your mortgage", [{ value: "title", trigger: "" }]),
    ]);

    expect(chosen.subtype).toBe("Mortgage");
  });
});

describe("the shortlists stage 2 ranks for the model", () => {
  it("offers every date, the ones sieves spoke for first", () => {
    const entries = dateShortlistEntries([
      candidate("date", "2026-02-02", ["other"]),
      candidate("date", "2026-10-15", [
        { value: "renewal", trigger: "Renewal date", sieves: ["words-before", "term-arithmetic"], strength: 2 },
      ]),
      candidate("date", "2026-10-15", [{ value: "renewal", trigger: "renews on" }]),
    ]);

    expect(entries.map((entry) => entry.value)).toEqual(["2026-10-15", "2026-02-02"]);
    expect(entries[0].why.join(" ")).toContain(`renewal from "Renewal date" by words-before, term-arithmetic`);
  });

  it("offers every identifier that could be theirs, the best-labelled first", () => {
    const entries = referenceShortlistEntries([
      candidate("identifier", "GB 442 8891 06", [{ value: "company", trigger: "VAT number" }]),
      candidate("identifier", "8845 6120 33", [{ value: "other", trigger: "" }]),
      candidate("identifier", "PN-88421-K", [{ value: "policy", trigger: "Policy number" }]),
    ]);

    // The company's own number is not ranked last, it is not offered: a
    // shortlist carrying it lets a page with nothing else on it be answered
    // with the organisation's VAT number (`extraction-reference-never.ts`).
    expect(entries.map((entry) => entry.value)).toEqual(["PN-88421-K", "8845 6120 33"]);
  });

  it("offers every figure with a currency, and keeps last year's on the list rather than dropping it", () => {
    const entries = costShortlistEntries([
      candidate("amount", "39900", [{ value: "previous", trigger: "last year", strength: 2 }], { currency: "GBP" }),
      candidate("amount", "41299", [{ value: "total", trigger: "Total premium", strength: 2 }], { currency: "GBP" }),
      candidate("amount", "50000", ["other"], { currency: "GBP" }),
    ]);

    expect(entries.map((entry) => entry.display)).toEqual(["£412.99", "£500.00", "£399.00"]);
  });

  it("offers every period the page prints beside a candidate", () => {
    const entries = recurrenceShortlistEntries([
      candidate("date", "2026-10-15", ["other"], { line: "Your 24-month contract ends 15 October 2026" }),
      candidate("amount", "41299", ["total"], { line: "Annual premium £412.99", currency: "GBP" }),
    ]);

    expect(entries.map((entry) => entry.display)).toEqual(["24 months", "12 months"]);
  });
});

describe("stage 3 with a model to ask", () => {
  const shortlist = [
    candidate("date", "2026-10-15", [{ value: "renewal", trigger: "Renewal date", strength: 2 }], {
      line: "Renewal date 15 October 2026",
    }),
    candidate("identifier", "PN-88421-K", [{ value: "policy", trigger: "Policy number" }]),
    candidate("amount", "41299", [{ value: "total", trigger: "Total premium", strength: 2 }], {
      line: "Total premium £412.99 for the 12 months from renewal",
      currency: "GBP",
    }),
    candidate("organisation", "Kestrel Mutual Insurance Ltd", [
      { value: "provider", trigger: "your insurer is", sieves: ["language-fact", "contact-details"], strength: 2 },
    ], { line: "your insurer is Kestrel Mutual Insurance Ltd" }),
    candidate("heading", "Home Insurance Policy Schedule", [{ value: "title", trigger: "" }]),
  ];

  /** A transport that answers each field in the order they are asked. */
  function fakeModel(...replies: string[]): MeaningTransport & { prompts: string[] } {
    const prompts: string[] = [];
    const transport = async (prompt: string): Promise<string> => {
      prompts.push(prompt);
      return replies[prompts.length - 1] ?? "none";
    };
    return Object.assign(transport, { prompts });
  }

  it("asks one question per field and takes every grounded answer", async () => {
    const model = fakeModel("1 renewal", "1", "1", "1", "Home Insurance", "1");
    const chosen = await chooseFieldsWithModel(shortlist, model);

    // Dates and their roles in one call, then reference, cost, provider,
    // subtype, and -- because the roles make a schedule -- how long it runs.
    expect(model.prompts).toHaveLength(6);
    expect(chosen).toEqual({
      dates: ["2026-10-15"],
      dateRoles: [{ date: "2026-10-15", role: "renewal" }],
      scheduleKind: "renewal",
      recurrenceMonths: 12,
      reference: "PN-88421-K",
      provider: "Kestrel Mutual Insurance Ltd",
      subtype: "Home Insurance",
      costMinor: 41299,
      currency: "GBP",
    });
  });

  it("leaves every field blank where the model answers none", async () => {
    const model = fakeModel("none");
    const chosen = await chooseFieldsWithModel(shortlist, model);

    // No roles means no schedule, so the cycle length is not asked about.
    expect(model.prompts).toHaveLength(5);
    expect(chosen).toEqual({ dates: [] });
  });

  it("leaves every field blank where the model answers off the list", async () => {
    const model = fakeModel(
      "2026-12-25 renewal",
      "VAT 442 8891 06",
      "£99.00",
      "Palisade Insurance Company plc",
      "a letter about a house",
    );
    const chosen = await chooseFieldsWithModel(shortlist, model);

    expect(chosen).toEqual({ dates: [] });
  });

  it("never answers from the rules once there is a model to ask", async () => {
    // The rules would have answered every one of these.
    expect(chooseFields(shortlist).provider).toBe("Kestrel Mutual Insurance Ltd");
    expect(await chooseFieldsWithModel(shortlist, async () => "none")).toEqual({ dates: [] });
  });
});
