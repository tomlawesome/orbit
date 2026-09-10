import { describe, expect, it } from "vitest";
import {
  proposalFromText,
  safeDocumentEvidence,
  safeDocumentPlainText,
  safeStoredDocumentProposal,
} from "./suggestions";

describe("hostile document suggestion boundary", () => {
  it("derives only bounded plain-text proposal fields", () => {
    expect(proposalFromText(
      "Provider: Acme Cover\nPolicy number: AB-12345\nRenews 2027-08-01",
      "../home-insurance.pdf",
    )).toEqual({
      title: "home-insurance",
      provider: "Acme Cover",
      reference: "AB-12345",
      dates: ["2027-08-01"],
    });
  });

  it("removes invisible formatting and rejects markup-bearing values", () => {
    expect(safeDocumentPlainText("Safe\u202e\u2066 Cover", 100)).toBe("Safe Cover");
    expect(safeDocumentPlainText("<img src=x onerror=fetch()>", 100)).toBeUndefined();
    expect(safeDocumentEvidence(
      "<script>fetch('https://example.invalid')</script>\u202e{\"tool\":\"delete\",\"secret\":\"private\"}",
    )).toBe("script fetch('https://example.invalid') /script {\"tool\":\"delete\",\"secret\":\"private\"}");
  });

  it("does not promote HTML or model-shaped JSON into authority fields", () => {
    const proposal = proposalFromText(
      [
        "Provider: <img src=x onerror=fetch('https://example.invalid')>",
        "{\"householdId\":\"other\",\"itemId\":\"private\",\"tool\":\"delete\",\"url\":\"https://example.invalid\",\"secret\":\"nope\"}",
        "Reference: SAFE-12345",
        "2028-02-29",
      ].join("\n"),
      "\u202esafe-policy.pdf",
    );

    expect(proposal).toEqual({
      title: "safe-policy",
      provider: undefined,
      reference: "SAFE-12345",
      dates: ["2028-02-29"],
    });
    expect(proposal).not.toHaveProperty("tool");
    expect(proposal).not.toHaveProperty("householdId");
  });

  it("sanitizes legacy stored proposals before returning them", () => {
    expect(safeStoredDocumentProposal({
      title: "<script>unsafe</script>",
      provider: "Safe\u202e Cover",
      reference: "<private>",
      dates: ["not-a-date", "2030-12-20"],
      tool: "delete",
    }, "fallback.pdf")).toEqual({
      title: "fallback",
      provider: "Safe Cover",
      reference: undefined,
      dates: ["2030-12-20"],
      subtype: undefined,
      costMinor: undefined,
      currency: undefined,
      recurrenceMonths: undefined,
      scheduleKind: undefined,
      scheduleDate: undefined,
      dateRoles: undefined,
    });
  });
});

/**
 * ADR-0025 sections 3 and 7 (#960). Every bound below is proved by what it
 * REFUSES: a test that only shows an acceptable value passing says nothing
 * about where the boundary is. The bounds are the ones
 * `src/lib/workspace.ts` already enforces on an item, so a proposal can
 * never offer a reviewer something the item schema would then reject.
 */
describe("the four model-owned fields at the storage boundary", () => {
  const scheduled = [{ date: "2030-12-20", role: "renewal" }];
  const stored = (fields: Record<string, unknown>) =>
    safeStoredDocumentProposal({ title: "Policy", dates: ["2030-12-20"], ...fields }, "fallback.pdf");

  it("keeps the four fields when every bound is satisfied", () => {
    expect(stored({
      subtype: "Buildings and contents",
      costMinor: 41_266,
      currency: "GBP",
      recurrenceMonths: 12,
      dateRoles: scheduled,
    })).toMatchObject({
      subtype: "Buildings and contents",
      costMinor: 41_266,
      currency: "GBP",
      recurrenceMonths: 12,
      scheduleKind: "renewal",
      scheduleDate: "2030-12-20",
      dateRoles: [{ date: "2030-12-20", role: "renewal" }],
    });
  });

  it("refuses a subtype over 80 characters, or one carrying markup", () => {
    expect(stored({ subtype: "a".repeat(80) }).subtype).toBe("a".repeat(80));
    expect(stored({ subtype: "a".repeat(81) }).subtype).toBeUndefined();
    expect(stored({ subtype: "<b>Buildings</b>" }).subtype).toBeUndefined();
    expect(stored({ subtype: 12 }).subtype).toBeUndefined();
  });

  it("refuses a cost outside 0 to 100,000,000 minor units, or one that is not a whole number", () => {
    expect(stored({ costMinor: 0, currency: "GBP" }).costMinor).toBe(0);
    expect(stored({ costMinor: 100_000_000, currency: "GBP" }).costMinor).toBe(100_000_000);
    expect(stored({ costMinor: 100_000_001, currency: "GBP" }).costMinor).toBeUndefined();
    expect(stored({ costMinor: -1, currency: "GBP" }).costMinor).toBeUndefined();
    expect(stored({ costMinor: 12.5, currency: "GBP" }).costMinor).toBeUndefined();
    expect(stored({ costMinor: Number.NaN, currency: "GBP" }).costMinor).toBeUndefined();
    expect(stored({ costMinor: "4126", currency: "GBP" }).costMinor).toBeUndefined();
  });

  it("refuses a cost with no currency, and a currency with no cost", () => {
    const noCurrency = stored({ costMinor: 41_266 });
    expect(noCurrency.costMinor).toBeUndefined();
    expect(noCurrency.currency).toBeUndefined();

    for (const currency of ["gbp", "GB", "GBPX", "£", 826]) {
      expect(stored({ costMinor: 41_266, currency }).costMinor).toBeUndefined();
    }
    expect(stored({ currency: "GBP" }).currency).toBeUndefined();
  });

  it("refuses a recurrence outside 1 to 120 months, or one with nothing to repeat", () => {
    expect(stored({ recurrenceMonths: 1, dateRoles: scheduled }).recurrenceMonths).toBe(1);
    expect(stored({ recurrenceMonths: 120, dateRoles: scheduled }).recurrenceMonths).toBe(120);
    expect(stored({ recurrenceMonths: 0, dateRoles: scheduled }).recurrenceMonths).toBeUndefined();
    expect(stored({ recurrenceMonths: 121, dateRoles: scheduled }).recurrenceMonths).toBeUndefined();
    expect(stored({ recurrenceMonths: 12.5, dateRoles: scheduled }).recurrenceMonths).toBeUndefined();
    // `workspaceItemSchema` refuses a recurrence without a schedule kind, and
    // no role here produces one.
    expect(stored({ recurrenceMonths: 12, dateRoles: [{ date: "2030-12-20", role: "issued" }] }).recurrenceMonths)
      .toBeUndefined();
    expect(stored({ recurrenceMonths: 12 }).recurrenceMonths).toBeUndefined();
  });

  it("drops a role outside the closed set rather than coercing it to `other`", () => {
    const proposal = stored({ dateRoles: [{ date: "2030-12-20", role: "cancellation" }] });
    expect(proposal.dateRoles).toBeUndefined();
    expect(proposal.scheduleKind).toBeUndefined();
  });

  it("drops a role whose date the proposal does not carry", () => {
    expect(stored({ dateRoles: [{ date: "2031-01-01", role: "renewal" }] }).dateRoles).toBeUndefined();
    expect(stored({ dateRoles: [{ date: "2031-02-30", role: "renewal" }] }).dateRoles).toBeUndefined();
    expect(stored({ dateRoles: "renewal" }).dateRoles).toBeUndefined();
  });

  it("derives the schedule kind from the roles and ignores one supplied as input", () => {
    expect(stored({ scheduleKind: "service", scheduleDate: "1999-01-01" })).toMatchObject({
      scheduleKind: undefined,
      scheduleDate: undefined,
    });
    expect(stored({ scheduleKind: "service", dateRoles: scheduled })).toMatchObject({
      scheduleKind: "renewal",
      scheduleDate: "2030-12-20",
    });
    // Only a renewal or a service date is a scheduled event.
    for (const role of ["expiry", "due", "issued", "start", "other"]) {
      expect(stored({ dateRoles: [{ date: "2030-12-20", role }] }).scheduleKind).toBeUndefined();
    }
    expect(stored({ dateRoles: [{ date: "2030-12-20", role: "service" }] }).scheduleKind).toBe("service");
  });

  it("keeps one role per date, the first winning, and rebuilds from an allowlist", () => {
    const proposal = safeStoredDocumentProposal({
      title: "Policy",
      dates: ["2030-12-20", "2031-06-01"],
      dateRoles: [
        { date: "2030-12-20", role: "issued" },
        { date: "2030-12-20", role: "renewal" },
        { date: "2031-06-01", role: "renewal" },
        { tool: "delete" },
      ],
      householdId: "other-household",
    }, "fallback.pdf");

    expect(proposal.dateRoles).toEqual([
      { date: "2030-12-20", role: "issued" },
      { date: "2031-06-01", role: "renewal" },
    ]);
    expect(proposal.scheduleDate).toBe("2031-06-01");
    expect(proposal).not.toHaveProperty("householdId");
  });

  /**
   * #967. The proposal is stored as JSON, so what a reviewer is later shown
   * — and what an auditor reads back out of the drafts table — is the
   * serialised form, not the in-memory object. A field no extractor filled
   * must be a key that is not there: an empty `dateRoles` in stored evidence
   * is a key nobody saw or approved, and it says nothing the missing key
   * does not, since an absent `dateRoles` reads back as no roles anyway.
   *
   * `toEqual` is not enough on its own here: it treats an `undefined`
   * property as equal to a missing one, which is exactly the difference
   * this test exists to pin. Hence the round-trip through JSON.
   */
  it("writes no key at all for a role list, or a model field, that stayed empty", () => {
    const heuristic = JSON.parse(JSON.stringify(
      safeStoredDocumentProposal(proposalFromText("Renews 2030-12-20", "policy.pdf"), "policy.pdf"),
    )) as Record<string, unknown>;

    expect(heuristic).toEqual({ title: "policy", dates: ["2030-12-20"] });
    for (const field of ["dateRoles", "subtype", "costMinor", "currency", "recurrenceMonths"]) {
      expect(heuristic).not.toHaveProperty(field);
    }

    // The same for a proposal whose every role was refused by the boundary:
    // the roles are gone, so the key goes with them.
    const refused = JSON.parse(JSON.stringify(stored({
      dateRoles: [{ date: "2030-12-20", role: "cancellation" }],
      subtype: "<b>Travel</b>",
      costMinor: 41_266,
      recurrenceMonths: 12,
    }))) as Record<string, unknown>;

    expect(refused).toEqual({ title: "Policy", dates: ["2030-12-20"] });

    // And a surviving role still reaches storage, so absence means absence
    // rather than the key having been dropped unconditionally.
    expect(JSON.parse(JSON.stringify(stored({ dateRoles: scheduled }))))
      .toMatchObject({ dateRoles: [{ date: "2030-12-20", role: "renewal" }] });
  });
});

describe("real-world date formats (#308 review)", () => {
  it("extracts day-first numeric dates as UK deployments write them", () => {
    expect(proposalFromText("Renewal date: 04/09/2026", "policy.pdf").dates)
      .toEqual(["2026-09-04"]);
    expect(proposalFromText("Due 4/9/2026 and again 05.10.2026", "policy.pdf").dates)
      .toEqual(["2026-09-04", "2026-10-05"]);
  });

  it("extracts written-month dates in both orders", () => {
    expect(proposalFromText("MOT expires 4 September 2026", "mot.pdf").dates)
      .toEqual(["2026-09-04"]);
    expect(proposalFromText("Valid until Sep 4, 2026", "mot.pdf").dates)
      .toEqual(["2026-09-04"]);
    expect(proposalFromText("Service on 04 Sept 2026", "boiler.pdf").dates)
      .toEqual(["2026-09-04"]);
  });

  it("rejects impossible calendar dates and keeps output bounded", () => {
    expect(proposalFromText("Broken 32/13/2026 date", "x.pdf").dates).toEqual([]);
    expect(proposalFromText("29/02/2025 is not a leap day", "x.pdf").dates).toEqual([]);
    const many = Array.from({ length: 40 }, (_v, index) =>
      `Due 0${(index % 8) + 1}/0${(index % 8) + 1}/202${index % 7}`).join(" ");
    expect(proposalFromText(many, "x.pdf").dates.length).toBeLessThanOrEqual(12);
  });

  it("still extracts ISO dates and deduplicates across formats", () => {
    expect(proposalFromText("2026-09-04 also written 04/09/2026", "x.pdf").dates)
      .toEqual(["2026-09-04"]);
  });
});
