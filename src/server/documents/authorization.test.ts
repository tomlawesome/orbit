import { describe, expect, it } from "vitest";
import { canAccessHouseholdDocuments } from "./authorization";

describe("document authorization policy", () => {
  it("allows current household members and instance administrators", () => {
    expect(canAccessHouseholdDocuments(false, "member-user")).toBe(true);
    expect(canAccessHouseholdDocuments(true, null)).toBe(true);
  });

  it("denies signed-out, unrelated, and removed users", () => {
    expect(canAccessHouseholdDocuments(false, null)).toBe(false);
    expect(canAccessHouseholdDocuments(false, undefined)).toBe(false);
    expect(canAccessHouseholdDocuments(false, "")).toBe(false);
  });
});
