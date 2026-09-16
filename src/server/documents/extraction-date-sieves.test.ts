import { describe, expect, it } from "vitest";

import {
  addMonths,
  DATE_SIEVES,
  dayBefore,
  issueDate,
  runDateSieves,
  tagsFromVotes,
  type DateCandidate,
  type DateVote,
} from "./extraction-date-sieves";
import { sieve } from "./extraction-sieve";
import { dateCandidatesOf, tagCandidates, wordsBeforeAssignments } from "./extraction-tags";

// Every sieve is judged on text written to show one way of reading a date,
// not on the tuning corpus: the 24 are samples of what a page could be, and
// a sieve has to hold on a page nobody has written yet (owner, 2026-09-11).

const dates = (text: string) => dateCandidatesOf(text, sieve(text));

function dateAt(text: string, value: string): { candidate: DateCandidate; all: DateCandidate[] } {
  const all = dates(text);
  const candidate = all.find((entry) => entry.value === value);
  if (!candidate) throw new Error(`no date ${value} in: ${text}`);
  return { candidate, all };
}

/** What one sieve says about one date, by name. */
function votes(name: string, text: string, value: string): DateVote[] {
  const found = DATE_SIEVES.find((entry) => entry.name === name);
  if (!found) throw new Error(`no sieve ${name}`);
  const { candidate, all } = dateAt(text, value);
  return found.read(text, candidate, all);
}

const roles = (name: string, text: string, value: string) =>
  votes(name, text, value).map((vote) => vote.role);

describe("the words after a date", () => {
  it("reads a clause that says what the date is for", () => {
    // A term end is an `expiry` here whatever the term is; the chooser
    // names it a renewal or an expiry from the page's kind
    // (extraction-term-end.ts).
    const text = "We will write to you again before 14 November 2026, when your cover ends.";
    expect(roles("words-after", text, "2026-11-14")).toEqual(["expiry"]);
  });

  it("ends the term rather than renewing it when the term simply runs out", () => {
    const text = "Your guarantee lasts until 13 June 2031, when this guarantee ends.";
    expect(roles("words-after", text, "2031-06-13")).toEqual(["expiry"]);
  });

  it("stops at the next date, so one date's clause cannot label another", () => {
    const text = "Cover runs from 14 June 2026 to 13 June 2031, when your cover ends.";
    expect(roles("words-after", text, "2026-06-14")).toEqual([]);
    expect(roles("words-after", text, "2031-06-13")).toEqual(["expiry"]);
  });

  it("gives a clause leading into the next date to that date", () => {
    const text = "Your first payment was taken on 15 August 2026 and your next payment is due on 15 September 2026.";
    expect(roles("words-after", text, "2026-08-15")).toEqual([]);
    const alone = "Your payment of £68.00 is due, and a receipt was sent on 15 August 2026.";
    expect(roles("words-after", alone, "2026-08-15")).toEqual([]);
  });

  it("says nothing about a clause that denies itself", () => {
    const text = "the registration certificate issued 20 March 2019, which are not renewal documents";
    expect(roles("words-after", text, "2019-03-20")).toEqual([]);
  });

  it("reads a payment deadline and a service visit", () => {
    expect(roles("words-after", "Pay 30 June 2026 to avoid a late fee.", "2026-06-30")).toEqual(["due"]);
    const service = "Book 2 August 2027 for your next inspection.";
    expect(roles("words-after", service, "2027-08-02")).toEqual(["service"]);
  });
});

describe("the heading above a date", () => {
  const table = ["Renewal date", "Premium", "14 March 2027", "£612.40"].join(" \n\n");

  it("reads the column heading a flattened table left above the value", () => {
    expect(roles("heading-above", table, "2027-03-14")).toEqual(["renewal"]);
  });

  it("refuses a block that holds a date of its own, which is a value and not a heading", () => {
    const page = ["Policy start date 18 October 2026", "17 October 2046"].join(" \n\n");
    expect(roles("heading-above", page, "2046-10-17")).toEqual([]);
  });

  it("says nothing when the heading names two roles at once", () => {
    const page = ["Start and expiry dates", "14 March 2027"].join(" \n\n");
    expect(roles("heading-above", page, "2027-03-14")).toEqual([]);
  });

  it("does not reach past a sentence-shaped block", () => {
    const page = [
      "Renewal date",
      "We have written to you about this before, as we always do at this time of year.",
      "14 March 2027",
    ].join(" \n\n");
    expect(roles("heading-above", page, "2027-03-14")).toEqual([]);
  });
});

describe("the arithmetic between two dates and a printed term", () => {
  const contract = ["Minimum term 24 months", "Plan started 22 April 2026", "Plan ends 21 April 2028"].join(" \n\n");

  it("reads the date a term ends at, and the one it starts at", () => {
    expect(roles("term-arithmetic", contract, "2026-04-22")).toEqual(["start"]);
    expect(roles("term-arithmetic", contract, "2028-04-21")).toEqual(["expiry"]);
  });

  it("counts a year the page called annual", () => {
    const cover = "Annual cover, starting 1 April 2026 and ending 1 April 2027.";
    expect(roles("term-arithmetic", cover, "2027-04-01")).toEqual(["expiry"]);
  });

  it("expires instead when the term is a guarantee", () => {
    const guarantee = "This guarantee runs 14 March 2026 for 10 years to 14 March 2036.";
    expect(roles("term-arithmetic", guarantee, "2036-03-14")).toEqual(["expiry"]);
  });

  it("ends in a visit when the term is a booster rather than a bill", () => {
    const booster = "Annual booster given 18 May 2026, next one 18 May 2027.";
    expect(roles("term-arithmetic", booster, "2027-05-18")).toEqual(["service"]);
  });

  it("says nothing about a period the page is only reporting on", () => {
    const statement = "Benefit statement for the 12 months from 6 April 2025 to 5 April 2026.";
    expect(roles("term-arithmetic", statement, "2026-04-05")).toEqual([]);
  });

  it("says nothing when no term is printed anywhere on the page", () => {
    const bare = "1 April 2026 and 1 April 2027 both appear on this page.";
    expect(roles("term-arithmetic", bare, "2027-04-01")).toEqual([]);
  });

  it("reads a term printed a long way from the dates it governs", () => {
    const gym = [
      "Membership start date 2 March 2026",
      "Your membership runs to 1 March 2027.",
      "Clause 4. Minimum term. Your membership has a minimum term of 12 months from the start date and you cannot cancel during it except as set out in clause 9.",
    ].join(" \n\n" + "Lorem ipsum. \n\n".repeat(12));
    expect(roles("term-arithmetic", gym, "2026-03-02")).toEqual(["start"]);
    expect(roles("term-arithmetic", gym, "2027-03-01")).toEqual(["expiry"]);
  });
});

describe("a date printed all the way through a document", () => {
  const running = [
    "Statement 4 August 2025",
    ...Array.from({ length: 6 }, (_, at) => `Page ${at + 1} of 7 · 4 August 2025 · one line of body text`),
    "Payment due 31 October 2026",
  ].join(" \n\n");

  it("reads it as the day the document was produced, as a guess and no more", () => {
    const cast = votes("printed-throughout", running, "2025-08-04");
    expect(cast.map((vote) => vote.role)).toEqual(["issued"]);
    expect(cast[0].weight).toBe(0);
  });

  it("says nothing about a date printed once", () => {
    expect(roles("printed-throughout", running, "2026-10-31")).toEqual([]);
  });
});

describe("where a date sits relative to the document's own", () => {
  const letter = [
    "Date of issue 4 August 2025",
    "Your last payment reached us on 2 June 2025.",
    "Your licence must be renewed by 31 October 2026.",
  ].join(" \n\n");

  it("finds the issue date by the label beside it", () => {
    expect(issueDate(letter, dates(letter))?.value).toBe("2025-08-04");
    expect(roles("issue-relative", letter, "2025-08-04")).toEqual(["issued"]);
  });

  it("says a date printed before the document was written is not one to act on", () => {
    expect(roles("issue-relative", letter, "2025-06-02")).toEqual(["other"]);
  });

  it("leaves a date after the issue date to the other sieves", () => {
    expect(roles("issue-relative", letter, "2026-10-31")).toEqual([]);
  });

  it("falls back to the early date the page repeats when no label names one", () => {
    const header = ["1 March 2026 · Account summary", "1 March 2026 · page 2", "Renewal 1 March 2027"].join(" \n\n");
    expect(issueDate(header, dates(header))?.value).toBe("2026-03-01");
  });

  it("says nothing at all when the page neither labels nor repeats a date", () => {
    const bare = "Cover runs 1 April 2026 to 31 March 2027.";
    expect(issueDate(bare, dates(bare))).toBeUndefined();
  });

  it("reads a letter's or an email's own 'Date:' line, but not a label that merely ends in date", () => {
    const email = ["From: billing@example", "Date: 3 August 2026, 09:14", "Plan renews on 3 August 2027"].join(" \n\n");
    expect(issueDate(email, dates(email))?.value).toBe("2026-08-03");
    const form = "Renewal date: 3 August 2027";
    expect(issueDate(form, dates(form))).toBeUndefined();
  });
});

describe("the calendar the sieves count with", () => {
  it("clamps a term to the end of the month it lands in", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-04-22", 24)).toBe("2028-04-22");
  });

  it("knows the day before, which is how half of UK paper ends a term", () => {
    expect(dayBefore("2028-04-22")).toBe("2028-04-21");
    expect(dayBefore("2026-01-01")).toBe("2025-12-31");
  });
});

describe("votes becoming tags", () => {
  it("names every sieve that agreed, and how good the best reason was", () => {
    const tags = tagsFromVotes([
      { sieve: "words-before", role: "renewal", trigger: "Renewal date", weight: 2 },
      { sieve: "term-arithmetic", role: "renewal", trigger: "12 months", weight: 1 },
    ]);

    expect(tags).toEqual([
      {
        value: "renewal",
        trigger: "Renewal date",
        source: "label",
        sieves: ["words-before", "term-arithmetic"],
        strength: 2,
      },
    ]);
  });

  it("leaves a tag exactly as stage 2 always made it when only the words before spoke", () => {
    const tags = tagsFromVotes([
      { sieve: "words-before", role: "expiry", trigger: "Expiry date", weight: 2 },
    ]);

    expect(tags).toEqual([{ value: "expiry", trigger: "Expiry date", source: "label" }]);
  });

  it("keeps the words-before reading first, whatever the other sieves said", () => {
    const tags = tagsFromVotes([
      { sieve: "words-before", role: "other", trigger: "", weight: 0 },
      { sieve: "heading-above", role: "service", trigger: "DATE TESTED", weight: 1 },
    ]);

    expect(tags.map((tag) => tag.value)).toEqual(["other", "service"]);
  });
});

describe("stage 2 as a whole", () => {
  it("runs every sieve over every date and records who agreed", () => {
    const page = ["Renewal date", "14 March 2027"].join(" \n\n");
    const all = dates(page);
    const cast = runDateSieves(page, all, wordsBeforeAssignments(page, all));
    const named = cast[0].map((vote) => vote.sieve);

    expect(named).toContain("words-before");
    expect(named).toContain("heading-above");
  });

  it("gives a date its tags through the sieves, and a tag its sieve names", () => {
    const page = ["Renewal date", "14 March 2027"].join(" \n\n");
    const tags = tagCandidates(page, sieve(page)).find((c) => c.kind === "date")?.tags ?? [];

    expect(tags[0].value).toBe("renewal");
    expect(tags[0].sieves).toEqual(["words-before", "heading-above"]);
  });
});
