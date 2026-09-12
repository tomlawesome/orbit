import { describe, expect, it } from "vitest";
import { assignContextRoles, type LocatedDate } from "@/server/documents/context-roles";

// Builds a `LocatedDate` from the position of `needle` inside `text`, so
// tests read as plain sentences rather than hand-counted offsets.
function dateAt(text: string, needle: string, occurrence = 0): LocatedDate {
  let index = -1;
  for (let i = 0; i <= occurrence; i += 1) {
    index = text.indexOf(needle, index + 1);
    if (index === -1) throw new Error(`"${needle}" not found (occurrence ${i}) in: ${text}`);
  }
  return { value: needle, index, length: needle.length };
}

describe("forward triggers", () => {
  it("assigns the label's role to a date that follows it", () => {
    const text = "Renewal date: 1 October 2026.";
    const roles = assignContextRoles(text, [dateAt(text, "1 October 2026")]);
    expect(roles).toEqual(["renewal"]);
  });

  it("stops at the sentence boundary and does not reach into the next sentence", () => {
    const text = "Renewal date: see below. Issued on 4 May 2026.";
    const roles = assignContextRoles(text, [dateAt(text, "4 May 2026")]);
    expect(roles).toEqual(["issued"]);
  });
});

describe("backward triggers", () => {
  it("assigns the label's role to a date that precedes it", () => {
    const text = "1 October 2026 is your renewal date.";
    const roles = assignContextRoles(text, [dateAt(text, "1 October 2026")]);
    expect(roles).toEqual(["renewal"]);
  });
});

describe("the directional case a naive window cannot tell apart", () => {
  it("reads 'renewal date: 1 October' as a renewal", () => {
    const text = "Your renewal date: 1 October 2026.";
    const roles = assignContextRoles(text, [dateAt(text, "1 October 2026")]);
    expect(roles).toEqual(["renewal"]);
  });

  it("reads the same date text as a start date when a start trigger, not a renewal trigger, actually governs it", () => {
    // The word "renewal" appears in this sentence too, right after the date,
    // but the label that actually governs the date is "policy started"
    // (forward, role start). A same-word or fixed-radius window centred on
    // "renewal" would misread this; a directional scope does not, because
    // "renewal date" here has nothing following it to govern.
    const text = "Your policy started 1 October 2026, and your renewal date follows below.";
    const roles = assignContextRoles(text, [dateAt(text, "1 October 2026")]);
    expect(roles).toEqual(["start"]);
  });
});

describe("termination terms cut a scope short of the sentence end", () => {
  // A minimal pair: only the conjunction differs. "but" is a termination
  // term (stops "renewal date"'s forward scope there); "and" is not, so the
  // scope runs on to the sentence's full stop and reaches the second date.
  // A window-based approach cannot tell these apart; a terminated scope can.
  it("keeps an ungoverned second date out of the first trigger's scope when a terminator intervenes", () => {
    const text = "Renewal date: 1 October 2026, but we also received your letter dated 3 January 2026.";
    const roles = assignContextRoles(text, [
      dateAt(text, "1 October 2026"),
      dateAt(text, "3 January 2026"),
    ]);
    expect(roles).toEqual(["renewal", "other"]);
  });

  it("without a terminator, the same scope runs on and claims the second date too", () => {
    const text = "Renewal date: 1 October 2026, and we also received your letter dated 3 January 2026.";
    const roles = assignContextRoles(text, [
      dateAt(text, "1 October 2026"),
      dateAt(text, "3 January 2026"),
    ]);
    expect(roles).toEqual(["renewal", "renewal"]);
  });
});

describe("overlap resolution: nearest trigger wins", () => {
  it("prefers the closer backward trigger over a farther forward one", () => {
    const text = "Your cover starts, and 1 October 2026 is your renewal date.";
    const roles = assignContextRoles(text, [dateAt(text, "1 October 2026")]);
    expect(roles).toEqual(["renewal"]);
  });

  it("prefers the closer forward trigger over a farther one governing the same sentence", () => {
    // "Renewal date" opens the sentence and, absent any terminator, its
    // scope runs all the way to the full stop -- but "policy started" sits
    // right next to the second date, so nearest-trigger resolution still
    // gives that date "start", not "renewal".
    const text = "Renewal date: 1 October 2026, and your policy started 3 January 2026.";
    const roles = assignContextRoles(text, [
      dateAt(text, "1 October 2026"),
      dateAt(text, "3 January 2026"),
    ]);
    expect(roles).toEqual(["renewal", "start"]);
  });
});

describe("a label printed on a line of its own", () => {
  it("reaches the date on the line below it", () => {
    const text = "NEXT VACCINATION DUE \n\n18 May 2027 Book in the two weeks before this date.";
    expect(assignContextRoles(text, [dateAt(text, "18 May 2027")])).toEqual(["service"]);
  });

  it("does not reach past real punctuation", () => {
    const text = "Renewal date: see the schedule. \n\nIssued on 4 May 2026";
    expect(assignContextRoles(text, [dateAt(text, "4 May 2026")])).toEqual(["issued"]);
  });

  it("leaves a date two lines below it alone", () => {
    const text = "EXPIRY DATE \n\n08 September 2027 \n\n14 September 2024";
    const roles = assignContextRoles(text, [dateAt(text, "08 September 2027"), dateAt(text, "14 September 2024")]);
    expect(roles).toEqual(["expiry", "other"]);
  });
});

describe("the labels household paper prints beside its dates", () => {
  const roleOf = (text: string, needle: string) => assignContextRoles(text, [dateAt(text, needle)])[0];

  it("reads the end of a term, an inspection, a statement date and a start", () => {
    expect(roleOf("Minimum term ends 21 April 2028", "21 April 2028")).toBe("expiry");
    expect(roleOf("commencing on 14 June 2026 and expiring on 13 June 2031", "13 June 2031")).toBe("expiry");
    expect(roleOf("Policy end date 17 October 2046", "17 October 2046")).toBe("expiry");
    expect(roleOf("NEXT INSPECTION RECOMMENDED BY 02 September 2031", "02 September 2031")).toBe("service");
    expect(roleOf("DATE(S) OF INSPECTION AND TESTING 02 September 2026", "02 September 2026")).toBe("service");
    expect(roleOf("STATEMENT DATE 5 April 2026", "5 April 2026")).toBe("issued");
    expect(roleOf("Service start (activation) 22 April 2026", "22 April 2026")).toBe("start");
    expect(roleOf("Date of installation 14 March 2026", "14 March 2026")).toBe("start");
  });

  it("reads the day a plan commenced, a move-in, a registration, a booking, a quote and a collection", () => {
    expect(roleOf("Plan commenced 3 November 2024", "3 November 2024")).toBe("start");
    expect(roleOf("Move-in date 15 August 2026", "15 August 2026")).toBe("start");
    expect(roleOf("Registered on 18 January 2019", "18 January 2019")).toBe("start");
    expect(roleOf("Booked 2 September 2026", "2 September 2026")).toBe("issued");
    expect(roleOf("Quote date: 6 October 2026", "6 October 2026")).toBe("issued");
    expect(roleOf("Collection due 23 September 2026, unless you request an extension", "23 September 2026")).toBe("due");
    expect(roleOf("Final instalment due 3 October 2026", "3 October 2026")).toBe("due");
    expect(roleOf("show that your next service is due on 14 October 2026.", "14 October 2026")).toBe("service");
  });
});

describe("default role", () => {
  it("assigns 'other' when no trigger governs the date", () => {
    const text = "We received your letter on 1 October 2026 regarding your account.";
    const roles = assignContextRoles(text, [dateAt(text, "1 October 2026")]);
    expect(roles).toEqual(["other"]);
  });

  it("assigns 'other' to a date outside every trigger's sentence, even when another sentence has triggers", () => {
    const text = "Thank you for your letter dated 2 February 2026. Renewal date: 1 October 2026.";
    const roles = assignContextRoles(text, [
      dateAt(text, "2 February 2026"),
      dateAt(text, "1 October 2026"),
    ]);
    expect(roles).toEqual(["other", "renewal"]);
  });
});

describe("each role family has a working trigger", () => {
  it.each([
    ["Expiry date: 9 March 2027.", "9 March 2027", "expiry"],
    ["Payment due by 15 April 2026.", "15 April 2026", "due"],
    ["Next service: 6 June 2026.", "6 June 2026", "service"],
    ["Date of issue: 3 January 2026.", "3 January 2026", "issued"],
    ["Start date: 1 May 2026.", "1 May 2026", "start"],
  ] as const)("%s -> %s", (text, needle, role) => {
    const roles = assignContextRoles(text, [dateAt(text, needle)]);
    expect(roles).toEqual([role]);
  });
});

describe("multiple dates in one call", () => {
  it("resolves each date independently against the whole trigger set", () => {
    const text = "Issued on 3 January 2026. Renewal date: 1 October 2026. Payment due by 15 April 2026.";
    const roles = assignContextRoles(text, [
      dateAt(text, "3 January 2026"),
      dateAt(text, "1 October 2026"),
      dateAt(text, "15 April 2026"),
    ]);
    expect(roles).toEqual(["issued", "renewal", "due"]);
  });
});
