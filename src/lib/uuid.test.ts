import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/app-error";
import { requireUuid, validUuid } from "@/lib/uuid";

describe("validUuid", () => {
  it("accepts well-formed identifiers of every current version, in either case", () => {
    expect(validUuid("3b241101-e2bb-4255-8caf-4136c566a962")).toBe(true);
    expect(validUuid("01890a5d-ac96-774b-bcce-b302099a8057")).toBe(true);
    expect(validUuid("3B241101-E2BB-4255-8CAF-4136C566A962")).toBe(true);
  });

  it("rejects anything else", () => {
    for (const value of ["", "not-a-uuid", "../outside", "3b241101e2bb42558caf4136c566a962", "3b241101-e2bb-4255-8caf-4136c566a96", "3b241101-e2bb-4255-8caf-4136c566a962 ", "3b241101-e2bb-4255-8caf-4136c566a962\n"]) {
      expect(validUuid(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("requireUuid", () => {
  it("returns a valid identifier unchanged", () => {
    expect(requireUuid("3b241101-e2bb-4255-8caf-4136c566a962", "Household")).toBe("3b241101-e2bb-4255-8caf-4136c566a962");
  });

  it("refuses a malformed identifier with 422 and the caller's label", () => {
    let caught: unknown;
    try { requireUuid("nope", "Household"); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ status: 422, code: "invalid_identifier", message: "Household is not a valid identifier" });
  });
});
