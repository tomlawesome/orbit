import { describe, expect, it } from "vitest";
import { reviewInboxState } from "./review-state";

/* #1388: the mail size limit is set by the administrator (1 to 50 MiB), so the
   words a member reads for an oversized forward must not name a size. */
describe("the member's words for sender_too_large (#1388)", () => {
  it("names no fixed size, because the limit is admin-set", () => {
    const state = reviewInboxState("failed", "sender_too_large");
    expect(state.message).toBe("This message was over the size limit, so Orbit could not check that it came from you and did not keep it. Send it again with fewer or smaller attachments.");
    expect(state.message).not.toMatch(/\d+\s*MiB/u);
  });
});
