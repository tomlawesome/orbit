import { describe, expect, it } from "vitest";

import { reviewInboxState } from "../../src/server/mail-in/core/review-state";
import { INBOX_FIXTURE } from "../../web/src/lib/data/fixtures/inbox.js";

/*
 * #1605 ST-43: the demo inbox fixture must follow the server's contract. A
 * failed receipt is `unavailable` and cannot be approved; `retry` is only
 * ever answered for a recoverable receipt that can be approved again.
 * v19-inbox.test.mjs pins this for r-scan-only; r-no-document (a failed
 * receipt, failure code no_supported_pdf) still says `retry`.
 */
describe("INBOX_FIXTURE failed receipts follow the server (ST-43)", () => {
  it("every failed fixture receipt is `unavailable` and not approvable", () => {
    const failed = INBOX_FIXTURE.receipts.filter((receipt) => receipt.status === "failed");
    expect(failed.length).toBeGreaterThan(1);
    for (const receipt of failed) {
      expect(receipt.classification, receipt.id).toBe("unavailable");
      expect(receipt.canApprove, receipt.id).toBe(false);
    }
  });

  it("r-no-document is what the server answers for a failed no_supported_pdf receipt", () => {
    const receipt = INBOX_FIXTURE.receipts.find((one) => one.id === "r-no-document");
    const server = reviewInboxState("failed", "no_supported_pdf");
    expect(receipt.classification).toBe(server.classification);
    expect(receipt.canApprove).toBe(server.canApprove);
    expect(receipt.canDiscard).toBe(server.canDiscard);
    expect(receipt.reason).toBe(server.reason);
  });
});
