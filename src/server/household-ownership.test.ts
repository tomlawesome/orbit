import { describe, expect, it } from "vitest";
import { planOwnershipTransfer } from "./household-ownership";

const members = [
  { userId: "owner", role: "owner" as const },
  { userId: "member", role: "member" as const },
];

describe("household ownership transfer", () => {
  it("allows the current owner to select an existing member", () => {
    expect(planOwnershipTransfer(members, "owner", "member", false)).toEqual({
      previousOwnerUserId: "owner",
      nextOwnerUserId: "member",
      changed: true,
    });
  });

  it("allows an instance administrator to perform recovery transfers", () => {
    expect(planOwnershipTransfer(members, "administrator", "member", true).changed).toBe(true);
  });

  it("rejects a stale actor who is no longer the owner", () => {
    expect(() => planOwnershipTransfer(members, "member", "owner", false)).toThrow(
      "Only the current household owner",
    );
  });

  it("rejects a target who is not already a household member", () => {
    expect(() => planOwnershipTransfer(members, "owner", "outsider", false)).toThrow(
      "Ownership can only be transferred",
    );
  });
});
