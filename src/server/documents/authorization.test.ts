import { describe, expect, it } from "vitest";
import { canAccessHouseholdDocuments, canManageDocumentDeletion } from "./authorization";

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

describe("document deletion/restore policy (#1151 A3-S1)", () => {
  it("allows an instance administrator regardless of role or upload", () => {
    expect(canManageDocumentDeletion(true, "member", false)).toBe(true);
    expect(canManageDocumentDeletion(true, null, false)).toBe(true);
  });

  it("allows the household owner even when they did not upload it", () => {
    expect(canManageDocumentDeletion(false, "owner", false)).toBe(true);
  });

  it("allows the member who uploaded the document", () => {
    expect(canManageDocumentDeletion(false, "member", true)).toBe(true);
  });

  it("denies an ordinary member acting on another member's upload", () => {
    expect(canManageDocumentDeletion(false, "member", false)).toBe(false);
  });

  it("denies when there is no membership role and no upload match", () => {
    expect(canManageDocumentDeletion(false, null, false)).toBe(false);
    expect(canManageDocumentDeletion(false, undefined, false)).toBe(false);
  });
});
