import { describe, expect, it } from "vitest";
import { reviewInboxState } from "@/server/mail-in/imap-inbox";
// @ts-expect-error plain JS module without types
import { failureWords } from "../../web/src/lib/pocket/words.js";

/*
 * #1670 G-W3: a failed receipt's specific label must not hang on the wording
 * of the server's message. The row carries the stored failure code as
 * `failureCode`, and the pocket keys its label on that.
 */
const TERMINAL_CODES = ["no_supported_pdf", "message_too_large", "attachment_processing_exhausted"];

describe("failed inbox rows carry a stable failure code (#1670 G-W3)", () => {
  it.each(TERMINAL_CODES)("reviewInboxState puts %s on the row payload as failureCode", (code) => {
    expect(reviewInboxState("failed", code)).toMatchObject({ failureCode: code });
  });
});

describe("the specific label follows the code, not the message wording (#1670 G-W3)", () => {
  it("keeps 'nothing to collect' when the message is reworded", () => {
    expect(failureWords({ reason: "no_document", message: "no PDF was attached to it", failureCode: "no_supported_pdf" }))
      .toBe("nothing to collect");
  });

  it("keeps 'too large to collect' when the message is reworded", () => {
    expect(failureWords({ reason: "too_large", message: "the message was over the size limit", failureCode: "message_too_large" }))
      .toBe("too large to collect");
  });
});
