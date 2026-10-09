import { describe, expect, it } from "vitest";
import { currencyCode, isCurrencyCode, isTimeZone, timeZoneName } from "./platform-lists";

describe("currency codes", () => {
  it.each(["GBP", "EUR", "USD", "JPY", "CHF"])("lists %s", (code) => expect(isCurrencyCode(code)).toBe(true));
  it.each(["ZZZ", "XXX", "gbp", "GB", "GBPP", "£££", "", " GBP"])("does not list %j", (code) => {
    expect(isCurrencyCode(code)).toBe(false);
  });
  it("is a zod schema that says what it wants", () => {
    expect(currencyCode.parse("GBP")).toBe("GBP");
    expect(currencyCode.safeParse("ZZZ").success).toBe(false);
    expect(currencyCode.safeParse(826).success).toBe(false);
  });
});

describe("time zones", () => {
  it.each(["Europe/London", "America/New_York", "Australia/Sydney", "UTC"])("lists %s", (zone) => {
    expect(isTimeZone(zone)).toBe(true);
  });
  it("takes a name the platform spells another way (Kolkata for Calcutta), not just the one it lists", () => {
    expect(isTimeZone("Asia/Kolkata")).toBe(true);
    expect(isTimeZone("Asia/Calcutta")).toBe(true);
  });
  it.each(["Not/AZone", "America/New York", "Europe/London ", "europe/london", "GMT+1", "", "Europe"])(
    "does not list %j",
    (zone) => expect(isTimeZone(zone)).toBe(false),
  );
  it("is a zod schema", () => {
    expect(timeZoneName.parse("Europe/Dublin")).toBe("Europe/Dublin");
    expect(timeZoneName.safeParse("Mars/Olympus").success).toBe(false);
  });
});
