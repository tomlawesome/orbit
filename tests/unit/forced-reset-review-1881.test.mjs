import { describe, expect, it } from "vitest";

import { cardMessageFor, refusalMoment, renewStepAddress } from "$lib/flight/door-state.js";

/*
 * #1881, review round 1. The ratified wording table names the refusal's
 * moment with the month in full ("11 November 2026"), and a marked password
 * on an instance with no mail relay is refused with a pointer to a recovery
 * link rather than a hold (OWASP/NIST: a known-compromised password is reset
 * only through a verified channel).
 */
describe("the renew card's moment (wording table: \"11 November 2026\")", () => {
  it("names the month in full, in UTC, to the minute", () => {
    expect(refusalMoment("2026-11-11T21:14:00.000Z")).toBe("11 November 2026 at 21:14 UTC");
  });

  it("names every month in full", () => {
    const months = ["January", "February", "March", "April", "May", "June", "July",
      "August", "September", "October", "November", "December"];
    months.forEach((month, index) => {
      const iso = new Date(Date.UTC(2026, index, 3, 9, 5)).toISOString();
      expect(refusalMoment(iso)).toBe(`3 ${month} 2026 at 09:05 UTC`);
    });
  });

  it("still puts nothing on the card for a value that is not a moment", () => {
    expect(refusalMoment("not a date")).toBeNull();
    expect(refusalMoment(undefined)).toBeNull();
  });
});

describe("a marked password with no relay (password_recovery_required)", () => {
  it("is answered in Orbit's words, pointing to a new setup link from an administrator", () => {
    const words = cardMessageFor("password_recovery_required");
    expect(words).toBe("Somebody else knew this password, so it no longer signs in. Ask an administrator for a new setup link.");
    expect(words).not.toBe(cardMessageFor("some_unknown_code"));
    expect(words).not.toContain("_");
  });
});

describe("the way to the renew step from outside the door (#1881 fix review)", () => {
  it("is the door with the hold's two parameters and where to go after", () => {
    const address = new URL(renewStepAddress("2026-11-11T21:14:00.000Z", "/settings"), "http://orbit.invalid");
    expect(address.pathname).toBe("/login");
    expect(address.searchParams.get("password")).toBe("new");
    expect(address.searchParams.get("refusedAt")).toBe("2026-11-11T21:14:00.000Z");
    expect(address.searchParams.get("returnTo")).toBe("/settings");
  });

  it("carries no refusedAt it was not given a moment for", () => {
    const address = new URL(renewStepAddress(undefined, "/"), "http://orbit.invalid");
    expect(address.searchParams.get("password")).toBe("new");
    expect(address.searchParams.has("refusedAt")).toBe(false);
  });
});
