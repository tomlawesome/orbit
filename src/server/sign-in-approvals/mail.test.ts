import { describe, expect, it } from "vitest";
import { formatApprovalMoment, renderApprovalMail } from "./mail";

/**
 * The approval mail's words, pinned (#1033, ADR-0027 §5).
 *
 * This mail IS the second factor: it is the only place the approval link
 * exists, and it is the only thing a reader who was not expecting it has to
 * judge by. What it says, and the order it says it in, is therefore worth
 * asserting rather than discovering in somebody's mailbox.
 */

const CONTEXT = {
  displayName: "Priya Raman",
  link: "https://orbit.example/approve/HBNyRhRPr4dnzt9Y1KAZjB2rGCNFhTe7",
  device: "Chrome on Linux",
  where: "your home network",
  requestedAt: new Date("2026-09-20T11:22:33.000Z"),
  expiresAt: new Date("2026-09-20T11:32:33.000Z"),
};

describe("the sign-in approval mail", () => {
  it("writes the mail word for word, bullets before the link", () => {
    const mail = renderApprovalMail(CONTEXT);
    expect(mail.subject).toBe("Approve your Orbit sign-in");
    expect(mail.text).toBe([
      "Hello Priya,",
      "",
      "Your Orbit password has just been used to sign in. Nobody gets in",
      "until you approve it:",
      "",
      "  - Orbit at orbit.example",
      "  - Chrome on Linux",
      "  - From your home network",
      "  - 20 Sep 2026 at 11:22 UTC",
      "",
      "Approve it, or say it wasn't you:",
      "",
      "  https://orbit.example/approve/HBNyRhRPr4dnzt9Y1KAZjB2rGCNFhTe7",
      "",
      "The link works once and lapses at 20 Sep 2026 at 11:32 UTC.",
      "Opening it approves nothing by itself - you choose on the page.",
      "If this wasn't you, ignore it - nobody gets in without approval.",
      "",
      "Orbit at orbit.example, run by a household, not a company.",
      "",
    ].join("\n"));
  });

  it("puts the four facts before the link, never after it", () => {
    /* The order is the whole safety of the message: a reader who has already
       pressed the link has stopped reading. ADR-0027 §5 says bullets first,
       and this is what would catch somebody moving them. */
    const { text } = renderApprovalMail(CONTEXT);
    const link = text.indexOf(CONTEXT.link);
    for (const fact of ["- Orbit at", "- Chrome on Linux", "- From your home network", "- 20 Sep 2026"]) {
      expect(text.indexOf(fact), fact).toBeLessThan(link);
    }
  });

  it("says a private address as a place, and a public one as itself", () => {
    expect(renderApprovalMail(CONTEXT).text).toContain("  - From your home network");
    expect(renderApprovalMail({ ...CONTEXT, where: "203.0.113.9" }).text).toContain("  - From 203.0.113.9");
  });

  it("names no account, and carries the link as its one remote thing", () => {
    const { text } = renderApprovalMail(CONTEXT);
    /* No address at all, unlike the setup mail: this one is about a REQUEST,
       and a link that reaches the wrong hands must not hand over the address
       it was sent to. */
    expect(text.match(/[\w.+-]+@[\w.-]+\w/gu)).toBeNull();
    expect(text.match(/https?:\/\/\S+/gu)).toEqual([CONTEXT.link]);
  });

  it("is plain ASCII, so it survives every mail client", () => {
    /* The apostrophes are straight, the dashes are hyphens, and there is no
       middle dot: `deviceInWords` exists precisely to keep the sessions
       list's own separator out of here. */
    expect(/^[\x09\x0a\x20-\x7e]*$/u.test(renderApprovalMail(CONTEXT).text)).toBe(true);
  });

  it("always carries the clock, and always says which clock", () => {
    expect(formatApprovalMoment(new Date("2026-01-01T09:05:00.000Z"))).toBe("1 Jan 2026 at 09:05 UTC");
    expect(formatApprovalMoment(new Date("2026-09-20T23:30:00.000Z"))).toBe("20 Sep 2026 at 23:30 UTC");
  });
});
