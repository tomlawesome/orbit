import { describe, expect, it } from "vitest";
import { GENERIC_REFERENCE_PREFERENCE, referencePreference } from "./extraction-reference-kind";
import type { GroupBin } from "./extraction-subtype-bins";

const bin = (group: string): GroupBin =>
  ({ group, count: 1, places: { title: 0, heading: 0, body: 1 }, sources: [] });
const kinds = (...groups: string[]) => ({ kinds: groups.map(bin), qualifiers: [] });
const about = (kindGroups: string[], qualifierGroups: string[]) => ({
  kinds: kindGroups.map(bin),
  qualifiers: qualifierGroups.map(bin),
});

/** Which of two tags this page would hear first. */
const beats = (preference: readonly string[], first: string, second: string) =>
  preference.indexOf(first) < preference.indexOf(second);

describe("referencePreference", () => {
  it("takes the word a page of that kind prints for the household's own number", () => {
    expect(referencePreference(kinds("Insurance"))[0]).toBe("policy");
    expect(referencePreference(kinds("Utility"))[0]).toBe("account");
    expect(referencePreference(kinds("Licence"))[0]).toBe("certificate");
    expect(referencePreference(kinds("Loan"))[0]).toBe("agreement");
    expect(referencePreference(kinds("Membership"))[0]).toBe("customer");
  });

  it("puts the kind's own word in front of the word reference", () => {
    expect(beats(referencePreference(kinds("Insurance")), "policy", "reference")).toBe(true);
    expect(beats(referencePreference(kinds("Tax")), "account", "reference")).toBe(true);
  });

  it("leaves reference in front where nothing says what kind of thing this is", () => {
    expect(referencePreference(kinds())).toEqual([...GENERIC_REFERENCE_PREFERENCE]);
    expect(referencePreference(kinds("Claim", "Fees"))).toEqual([...GENERIC_REFERENCE_PREFERENCE]);
  });

  it("does not let a word every page uses decide against the thing the page is about", () => {
    // An insurance schedule says "claim" more often than "insurance", and
    // every kind of paper has fees, a service and a deposit on it.
    expect(referencePreference(kinds("Claim", "Insurance"))[0]).toBe("policy");
    expect(referencePreference(kinds("Service", "Fees", "Utility"))[0]).toBe("account");
  });

  it("hears a word for the paper only after the thing the paper is about", () => {
    // Every tenancy is a contract and every renewal is a bill.
    expect(referencePreference(kinds("Contract", "Tenancy"))[0]).toBe("agreement");
    expect(beats(referencePreference(kinds("Bill", "Insurance")), "policy", "account")).toBe(true);
  });

  it("still answers on a page whose only kind word is the paper's own", () => {
    expect(referencePreference(kinds("Certificate"))[0]).toBe("certificate");
    expect(referencePreference(kinds("Bill"))[0]).toBe("account");
  });

  it("offers every kind the page supports, best-supported kind first", () => {
    // A dental plan statement: the plan number leads, the membership number
    // it is also printed with comes next, and the generic order fills in.
    const preference = referencePreference(kinds("Plan", "Statement", "Membership"));
    expect(preference.slice(0, 3)).toEqual(["policy", "customer", "account"]);
  });

  it("lets a qualifier name the thing where the kind word is vague", () => {
    // "Your bill" says nothing; "water" says this is an account.
    expect(referencePreference(about([], ["Water"]))[0]).toBe("account");
    expect(referencePreference(about(["Record"], ["Gas safety"]))[0]).toBe("certificate");
  });

  it("hears the kind before the qualifier, because the kind is the thing", () => {
    const preference = referencePreference(about(["Insurance"], ["Mobile"]));
    expect(beats(preference, "policy", "account")).toBe(true);
  });

  it("ends with every tag that can carry a reference, and none that cannot", () => {
    const preference = referencePreference(kinds("Insurance", "Utility"));
    expect([...preference].sort()).toEqual([...GENERIC_REFERENCE_PREFERENCE].sort());
  });
});
