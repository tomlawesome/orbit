import { describe, expect, it } from "vitest";
import { formatSetupExpiry, renderSetupMail } from "./mail";

/**
 * The setup mail's words, pinned (#911, ADR-0023 §3).
 *
 * This mail is the only place a setup link exists — the owner ruled on
 * 2026-09-09 that no administrator ever sees it — so what it says is worth
 * asserting rather than discovering in somebody's mailbox.
 */

const CONTEXT = {
  displayName: "Priya Raman",
  email: "priya@example.com",
  link: "https://orbit.example/setup/HBNyRhRPr4dnzt9Y1KAZjB2rGCNFhTe7",
  expiresAt: new Date("2026-09-20T11:22:33.000Z"),
  purpose: "setup" as const,
};

describe("the setup mail", () => {
  it("writes a first password's mail, word for word", () => {
    const mail = renderSetupMail(CONTEXT);
    expect(mail.subject).toBe("Set your Orbit password");
    expect(mail.text).toBe([
      "Hello Priya,",
      "",
      "An administrator has created an Orbit account for you at orbit.example.",
      "Choose a password and you are in:",
      "",
      "  https://orbit.example/setup/HBNyRhRPr4dnzt9Y1KAZjB2rGCNFhTe7",
      "",
      "Sent to priya@example.com. Good until 20 Sep 2026.",
      "The link works once. If it lapses, ask your administrator for another.",
      "Not expecting this? There is nothing to do - the link simply lapses.",
      "",
      "Orbit at orbit.example, run by a household, not a company.",
      "",
    ].join("\n"));
  });

  it("writes a forgotten password's mail, word for word, with the minute it lapses", () => {
    const mail = renderSetupMail({ ...CONTEXT, purpose: "recovery" });
    expect(mail.subject).toBe("Reset your Orbit password");
    expect(mail.text).toBe([
      "Hello Priya,",
      "",
      "An administrator has sent you a new link for your Orbit account at",
      "orbit.example. Choose a new password and you are back in:",
      "",
      "  https://orbit.example/setup/HBNyRhRPr4dnzt9Y1KAZjB2rGCNFhTe7",
      "",
      "Sent to priya@example.com. Good until 20 Sep 2026 at 11:22 UTC.",
      "The link works once. If it lapses, ask your administrator for another.",
      "Not expecting this? There is nothing to do - the link simply lapses.",
      "",
      "Orbit at orbit.example, run by a household, not a company.",
      "",
    ].join("\n"));
  });

  it("dates a day-long link, and times a five-minute one, in UTC", () => {
    expect(formatSetupExpiry(new Date("2026-09-20T23:30:00.000Z"), "setup")).toBe("20 Sep 2026");
    expect(formatSetupExpiry(new Date("2026-01-01T09:05:00.000Z"), "recovery")).toBe("1 Jan 2026 at 09:05 UTC");
  });

  it("names nobody but the recipient, and carries the link as its one remote thing", () => {
    const { text } = renderSetupMail(CONTEXT);
    /* One address and one link: no administrator's name, no second account,
       no household. This mail is about one account and how to get into it. */
    expect(text.match(/[\w.+-]+@[\w.-]+\w/gu)).toEqual(["priya@example.com"]);
    expect(text.match(/https?:\/\/\S+/gu)).toEqual([CONTEXT.link]);
  });
});
