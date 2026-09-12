import { describe, expect, it } from "vitest";

import {
  AMOUNT_SIEVES,
  amountPageFacts,
  amountTagsFromVotes,
  runAmountSieves,
  type AmountCandidate,
  type AmountVote,
} from "./extraction-amount-sieves";
import { STRENGTH_STATED, STRENGTH_WEAK, type Tag } from "./extraction-stages";

// Each sieve is one way of asking what a figure is. The text here is
// written for the sieve under test and nothing else, so a sieve that starts
// answering from the shape of a page rather than from its words fails here
// first.

/** The amount `printed` in `text`, as stage 1 hands it to stage 2. */
function amount(text: string, printed: string, currency = "GBP"): AmountCandidate {
  const index = text.indexOf(printed);
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  const digits = printed.replace(/[^\d.]/gu, "");
  const [whole, pence = "00"] = digits.split(".");
  return {
    value: String(Number(whole.replace(/,/gu, "")) * 100 + Number(pence)),
    currency,
    index,
    length: printed.length,
    line: text.slice(start, end === -1 ? text.length : end).replace(/\s+/gu, " ").trim(),
  };
}

function votesFrom(
  sieveName: string,
  text: string,
  candidate: AmountCandidate,
  all: readonly AmountCandidate[] = [candidate],
  labels: ReadonlyArray<Tag<"amount"> | undefined> = [],
): AmountVote[] {
  const sieve = AMOUNT_SIEVES.find((entry) => entry.name === sieveName);
  if (!sieve) throw new Error(`no sieve called ${sieveName}`);
  return sieve.read(candidate, all, amountPageFacts(text, all, labels));
}

describe("the words-after sieve", () => {
  it("reads the clause printed after a figure", () => {
    const text = "The balance of £163.37 is now due.";
    const votes = votesFrom("words-after", text, amount(text, "£163.37"));

    expect(votes[0].tag).toBe("due");
    expect(votes[0].weight).toBe(STRENGTH_STATED);
  });

  it("stops at the next figure, so one clause cannot name two", () => {
    const text = "Total charges £159.31 £163.37 to pay";
    const all = [amount(text, "£159.31"), amount(text, "£163.37")];

    expect(votesFrom("words-after", text, all[0], all)).toEqual([]);
    expect(votesFrom("words-after", text, all[1], all)[0].tag).toBe("due");
  });

  it("reads a period after the figure as what the figure is one of", () => {
    const text = "£31.00 a month for twenty-four months";
    expect(votesFrom("words-after", text, amount(text, "£31.00"))[0].tag).toBe("instalment");
  });
});

describe("the heading-above sieve", () => {
  it("takes the column heading a flattened table keeps above its figures", () => {
    const text = "Amount due\n\n£163.37 to be collected on 1 May";
    const votes = votesFrom("heading-above", text, amount(text, "£163.37"));

    expect(votes[0].tag).toBe("due");
    expect(votes[0].weight).toBe(STRENGTH_WEAK);
  });

  it("reads a heading printed straight over a bare figure as the form's own label", () => {
    const text = "THIS MONTH'S INSTALMENT\n\n£14.99";
    const votes = votesFrom("heading-above", text, amount(text, "£14.99"));

    expect(votes[0].tag).toBe("instalment");
    expect(votes[0].weight).toBe(STRENGTH_STATED);
  });

  it("keeps the weaker reading where the heading is further up", () => {
    const text = "Amount due\n\nPaid by\n\n£163.37";
    const votes = votesFrom("heading-above", text, amount(text, "£163.37"));

    expect(votes[0].tag).toBe("due");
    expect(votes[0].weight).toBe(STRENGTH_WEAK);
  });

  it("reads a benefits column heading as not the cost", () => {
    const text = "Benefit Limit\n\nVet fees £7,500";
    expect(votesFrom("heading-above", text, amount(text, "£7,500"))[0].tag).toBe("other");
  });

  it("refuses a sentence that happens to carry the word", () => {
    const text = "The total shown above includes VAT at the standard rate\n\n£163.37";
    expect(votesFrom("heading-above", text, amount(text, "£163.37"))).toEqual([]);
  });

  it("refuses a block that is a row of figures rather than a heading of them", () => {
    const text = "Previous balance £42.00\n\n£163.37";
    expect(votesFrom("heading-above", text, amount(text, "£163.37"))).toEqual([]);
  });
});

describe("the column-period sieve", () => {
  const text = [
    "Precepting authority 2025/26 2026/27",
    "Calderhythe District Council £298.61 £312.44",
    "Total council tax charge for the year £2,056.30 £2,159.07",
  ].join("\n");

  it("reads the figure under the current period as this year's charge", () => {
    const all = [
      amount(text, "£298.61"), amount(text, "£312.44"),
      amount(text, "£2,056.30"), amount(text, "£2,159.07"),
    ];
    const votes = votesFrom("column-period", text, all[3], all);

    expect(votes[0].tag).toBe("total");
    expect(votes[0].weight).toBe(STRENGTH_STATED);
  });

  it("reads the figure under the earlier period as last year's", () => {
    const all = [
      amount(text, "£298.61"), amount(text, "£312.44"),
      amount(text, "£2,056.30"), amount(text, "£2,159.07"),
    ];
    expect(votesFrom("column-period", text, all[2], all)[0].tag).toBe("previous");
  });

  it("says nothing where the heading names no periods", () => {
    const plain = "Charges\nWater supply £89.12 £70.19";
    const all = [amount(plain, "£89.12"), amount(plain, "£70.19")];
    expect(votesFrom("column-period", plain, all[0], all)).toEqual([]);
  });
});

describe("the period-adjacent sieve", () => {
  it("reads a monthly figure as one payment of the thing", () => {
    const text = "Monthly membership fee, collected by Direct Debit £42.50";
    expect(votesFrom("period-adjacent", text, amount(text, "£42.50"))[0].tag).toBe("instalment");
  });

  it("reads a yearly figure as the whole of it", () => {
    const text = "Annual premium £412.99";
    expect(votesFrom("period-adjacent", text, amount(text, "£412.99"))[0].tag).toBe("total");
  });

  it("says nothing where the block prints both periods", () => {
    const text = "£31.00 a month, which is £372.00 a year";
    expect(votesFrom("period-adjacent", text, amount(text, "£31.00"))).toEqual([]);
  });
});

describe("the printed-throughout sieve", () => {
  const text = [
    "Amount due £163.37",
    "The payment shown above covers this period's charges and the arrears carried forward from the last bill, which came to £163.37.",
    "Nothing else is outstanding on the account at the date this bill was produced.",
    "We will collect £163.37 on 30 June 2026 by Direct Debit, as arranged.",
  ].join("\n");

  function sightings(): AmountCandidate[] {
    const at: AmountCandidate[] = [];
    let from = 0;
    for (let i = 0; i < 3; i += 1) {
      const index = text.indexOf("£163.37", from);
      at.push({ ...amount(text, "£163.37"), index });
      from = index + 1;
    }
    return at;
  }

  it("reads a figure the page keeps coming back to as the page's own", () => {
    const all = sightings();
    const labels: Array<Tag<"amount"> | undefined> = [
      { value: "due", trigger: "Amount due", source: "label" },
      undefined,
      undefined,
    ];
    const votes = votesFrom("printed-throughout", text, all[0], all, labels);

    expect(votes[0].tag).toBe("due");
    expect(votes[0].weight).toBe(STRENGTH_STATED);
  });

  it("says nothing about a figure the page never named", () => {
    const all = sightings();
    expect(votesFrom("printed-throughout", text, all[0], all, [undefined, undefined, undefined])).toEqual([]);
  });
});

describe("the instalment-total sieve", () => {
  it("reads the figure the printed instalments add up to as the total", () => {
    const text = "Pay by ten monthly instalments of £215.91 (final instalment £215.88), or pay £2,159.07 in one go.";
    const all = [amount(text, "£215.91"), amount(text, "£215.88"), amount(text, "£2,159.07")];
    const votes = votesFrom("instalment-total", text, all[2], all);

    expect(votes[0].tag).toBe("total");
    expect(votes[0].weight).toBe(STRENGTH_STATED);
  });

  it("reads a schedule with no rounding the same way", () => {
    const text = "12 payments of £31.00, £372.00 over the year";
    const all = [amount(text, "£31.00"), amount(text, "£372.00")];
    expect(votesFrom("instalment-total", text, all[1], all)[0].tag).toBe("total");
  });

  it("says nothing where the arithmetic does not come out", () => {
    const text = "12 payments of £31.00, £400.00 over the year";
    const all = [amount(text, "£31.00"), amount(text, "£400.00")];
    expect(votesFrom("instalment-total", text, all[1], all)).toEqual([]);
  });
});

describe("the table-neighbours sieve", () => {
  const limit = (trigger: string): Tag<"amount"> => ({ value: "other", trigger, source: "label" });
  const text = "Vet fees, per condition per year £7,500\n\nComplementary treatment £500 per year\n\nThird-party liability £1,000,000\n\nDeath of your pet up to £2,000\n\nAnnual premium £287.64";
  const all = [amount(text, "£7,500"), amount(text, "£500"), amount(text, "£1,000,000"), amount(text, "£2,000"), amount(text, "£287.64")];
  const labels = [limit("per condition per year"), undefined, undefined, limit("up to"), { value: "total", trigger: "Annual premium", source: "label" } as Tag<"amount">];

  it("reads a row between two cover limits as a cover limit, past rows the table said nothing about", () => {
    const votes = votesFrom("table-neighbours", text, all[1], all, labels);
    expect(votes[0].tag).toBe("other");
    expect(votes[0].weight).toBe(STRENGTH_STATED);
  });

  it("says nothing at the edge of the table", () => {
    expect(votesFrom("table-neighbours", text, all[4], all, labels)).toEqual([]);
  });

  it("says nothing about a fee between two other fees", () => {
    const fees = "Joining fee £25.00\n\nMonthly membership fee £42.50\n\nAdministration fee £60.00";
    const rows = [amount(fees, "£25.00"), amount(fees, "£42.50"), amount(fees, "£60.00")];
    const feeLabels = [limit("Joining fee"), undefined, limit("administration fee")];
    expect(votesFrom("table-neighbours", fees, rows[1], rows, feeLabels)).toEqual([]);
  });
});

describe("the votes merged into tags", () => {
  it("names every sieve that agreed, and how good the best reason was", () => {
    const text = "Annual premium £412.99 is the total for the year";
    const all = [amount(text, "£412.99")];
    const votes = runAmountSieves(text, all, [
      { value: "total", trigger: "Annual premium", source: "label" },
    ]);
    const tags = amountTagsFromVotes(votes[0]);

    expect(tags[0].value).toBe("total");
    expect(tags[0].sieves).toContain("label");
    expect(tags[0].sieves).toContain("words-after");
    expect(tags[0].strength).toBe(STRENGTH_STATED);
  });

  it("leaves a tag no other sieve spoke about exactly as it always was", () => {
    const text = "Renewal premium £612.40";
    const all = [amount(text, "£612.40")];
    const votes = runAmountSieves(text, all, [
      { value: "total", trigger: "Renewal premium", source: "label" },
    ]);

    expect(amountTagsFromVotes(votes[0])).toEqual([
      { value: "total", trigger: "Renewal premium", source: "label" },
    ]);
  });
});
