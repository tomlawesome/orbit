import { describe, expect, it } from "vitest";
import { reviewInboxState } from "./review-state";

/* #1810 L-new-1: the server honours a dismiss on any of the member's own
   `held` rows, so the review state offers it for a pause-held row too. */
describe("a pause-held row can be discarded (#1810 L-new-1)", () => {
  it("says canDiscard for status held, and still cannot be approved", () => {
    const state = reviewInboxState("held", null);
    expect(state).toMatchObject({ classification: "waiting", canApprove: false, canDiscard: true });
    expect(state.message).toBe("Collection is paused. This will be prepared when you turn it back on.");
  });

  it("leaves the rows still being prepared undiscardable", () => {
    expect(reviewInboxState("processing", null).canDiscard).toBe(false);
    expect(reviewInboxState("approving", null).canDiscard).toBe(false);
  });
});
