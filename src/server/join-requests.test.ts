import { describe, expect, it } from "vitest";
import { planJoinDecision } from "@/server/join-requests";

/** The §11 authority matrix (#453), pinned pure — the transaction feeds it
 * the state it read under lock, exactly like planOwnershipTransfer. */
describe("planJoinDecision", () => {
  const pending = { status: "pending" as const, requesterDisabled: false };

  it("lets that household's owner approve, granting membership", () => {
    const plan = planJoinDecision({ ...pending, actorIsOwner: true, actorIsAdministrator: false }, "approve");
    expect(plan).toEqual({ nextStatus: "approved", grantsMembership: true });
  });

  it("lets that household's owner decline, granting nothing", () => {
    const plan = planJoinDecision({ ...pending, actorIsOwner: true, actorIsAdministrator: false }, "decline");
    expect(plan).toEqual({ nextStatus: "declined", grantsMembership: false });
  });

  it("lets an instance admin decide any household's request", () => {
    const plan = planJoinDecision({ ...pending, actorIsOwner: false, actorIsAdministrator: true }, "approve");
    expect(plan.grantsMembership).toBe(true);
  });

  it("refuses everyone else — plain members included", () => {
    expect(() =>
      planJoinDecision({ ...pending, actorIsOwner: false, actorIsAdministrator: false }, "approve"),
    ).toThrowError(/owner/i);
  });

  it("never decides twice", () => {
    for (const status of ["approved", "declined"] as const) {
      expect(() =>
        planJoinDecision({ status, actorIsOwner: true, actorIsAdministrator: false, requesterDisabled: false }, "decline"),
      ).toThrowError(/already been decided/i);
    }
  });

  it("never grants membership to a disabled account", () => {
    expect(() =>
      planJoinDecision({ status: "pending", actorIsOwner: true, actorIsAdministrator: false, requesterDisabled: true }, "approve"),
    ).toThrowError(/disabled/i);
    /* declining a disabled account's request is still allowed — it closes it */
    const plan = planJoinDecision(
      { status: "pending", actorIsOwner: true, actorIsAdministrator: false, requesterDisabled: true },
      "decline",
    );
    expect(plan.grantsMembership).toBe(false);
  });
});
