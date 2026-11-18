import { describe, expect, it } from "vitest";

import { INBOX_FIXTURE } from "../../web/src/lib/data/fixtures/inbox.js";
import { failureWords } from "../../web/src/lib/pocket/words.js";

/*
 * #1605 ST-43: the fixture's r-no-document receipt carries what the server
 * sends for a message with no readable PDF (src/server/mail-in/core/review-state.ts:
 * message "no PDF attached", failureCode "no_supported_pdf"). The desktop inbox
 * draws a failure as `${failureWords(failure)} · ${failure.message}`
 * (routes/inbox/+page.svelte), which read "... · undefined" for the old fixture.
 */
const receipt = /** @type {any} */ (INBOX_FIXTURE.receipts.find((r) => r.id === "r-no-document"));

describe("the fixture's no-document receipt is what the server sends (#1605 ST-43)", () => {
  it("carries the server's message and failure code", () => {
    expect(receipt, "fixture has r-no-document").toBeTruthy();
    expect(receipt.message).toBe("no PDF attached");
    expect(receipt.failureCode).toBe("no_supported_pdf");
  });

  it("its failed line on the desktop inbox never reads undefined", () => {
    const line = `${failureWords(receipt)} · ${receipt.message}`;
    expect(line).not.toContain("undefined");
    expect(line).toBe("nothing to collect · no PDF attached");
  });
});
