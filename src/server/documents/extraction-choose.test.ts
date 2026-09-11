import { describe, expect, it } from "vitest";

import { chooseFields } from "./extraction-choose";
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
 * most rules never look at the block. */
function candidate<K extends CandidateKind>(
  kind: K,
  value: string,
  tags: Array<TagInput<K>>,
  extra: { line?: string; currency?: string } = {},
): TaggedCandidate<K> {
  return {
    kind,
    value,
    index: nextIndex++,
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

  it("lets the role more sieves agree on beat one a single sieve reached", () => {
    const chosen = chooseFields([
      candidate("date", "2026-05-01", [
        { value: "renewal", trigger: "12 months", sieves: ["term-arithmetic", "heading-above"], strength: 1 },
        { value: "expiry", trigger: "Expiry", sieves: ["heading-above"], strength: 1 },
      ]),
    ]);

    expect(chosen.dateRoles).toEqual([{ date: "2026-05-01", role: "renewal" }]);
  });

  it("prefers the role whose tag quoted the page over one that guessed", () => {
    const chosen = chooseFields([
      candidate("date", "2026-05-01", ["expiry"]),
      candidate("date", "2026-05-01", [{ value: "renewal", trigger: "Renewal date" }]),
    ]);

    expect(chosen.dateRoles).toEqual([{ date: "2026-05-01", role: "renewal" }]);
  });

  it("keeps the date but drops the role when two quoted tags disagree", () => {
    const chosen = chooseFields([
      candidate("date", "2026-05-01", [{ value: "renewal", trigger: "renews" }]),
      candidate("date", "2026-05-01", [{ value: "expiry", trigger: "expires" }]),
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
    ]);

    expect(chosen.recurrenceMonths).toBe(12);
  });

  const withLine = (line: string) =>
    chooseFields([candidate("date", "2026-06-01", [{ value: "renewal", trigger: "renewal date" }], { line })]);

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

  it("trims the label off a value that carried one", () => {
    const chosen = chooseFields([
      candidate("identifier", "Policy number: HI-9284712", [{ value: "policy", trigger: "Policy number" }], {
        line: "Policy number: HI-9284712",
      }),
    ]);

    expect(chosen.reference).toBe("HI-9284712");
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
});

describe("the meaning-shaped fields", () => {
  it("takes the provider the page states, and leaves subtype to the model", () => {
    const chosen = chooseFields([
      candidate("organisation", "Kestrel Mutual", [
        { value: "provider", trigger: "your insurer", sieves: ["language-fact", "contact-details"] },
      ]),
      candidate("heading", "HOME INSURANCE", [{ value: "title", trigger: "" }]),
    ]);

    expect(chosen.provider).toBe("Kestrel Mutual");
    expect(chosen.subtype).toBeUndefined();
  });
});
