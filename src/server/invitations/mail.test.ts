import { describe, expect, it } from "vitest";
import { formatInvitationDate, renderInvitationMail } from "./mail";

/**
 * The mail's words, pinned (#481).
 *
 * The template's own data story — Sam Okafor invites priya@example.com to
 * Harbour House, good until 20 Sep 2026 — is used verbatim, so this file also
 * records what `design/v19/mail/round-1/text.txt` said. When the approved
 * mockup replaces the HTML part, the text assertions below must still pass
 * unchanged: the look is being chosen, the words are not.
 */

const CONTEXT = {
  inviterName: "Sam Okafor",
  householdName: "Harbour House",
  email: "priya@example.com",
  link: "https://orbit.example/invite/HBNyRhRPr4dnzt9Y1KAZjB2rGCNFhTe7",
  expiresAt: new Date("2026-09-20T11:22:33.000Z"),
};

describe("the invitation mail", () => {
  it("names the inviter, the household and Orbit in the subject", () => {
    expect(renderInvitationMail(CONTEXT).subject).toBe("Sam Okafor invited you to Harbour House on Orbit");
  });

  it("writes the ratified plain-text part, word for word", () => {
    expect(renderInvitationMail(CONTEXT).text).toBe([
      "Sam Okafor has a place for you in Harbour House on Orbit.",
      "",
      "Orbit keeps a household's year in one calm view - the boiler service,",
      "the insurance renewal, the MOT - and Sam would like you in theirs.",
      "",
      "Open your invitation and sign in with this address; you'll land",
      "straight in the house:",
      "",
      "  https://orbit.example/invite/HBNyRhRPr4dnzt9Y1KAZjB2rGCNFhTe7",
      "",
      "Sent to priya@example.com. Good until 20 Sep 2026.",
      "Not expecting this? There is nothing to do - the link simply lapses.",
      "",
      "Orbit at orbit.example, run by Sam's household, not a company.",
      "",
    ].join("\n"));
  });

  it("dates in UTC, with a spelling that cannot move under the host's locale data", () => {
    expect(formatInvitationDate(new Date("2026-09-20T23:30:00.000Z"))).toBe("20 Sep 2026");
    expect(formatInvitationDate(new Date("2026-01-01T00:00:00.000Z"))).toBe("1 Jan 2026");
    expect(formatInvitationDate(new Date("2026-12-31T12:00:00.000Z"))).toBe("31 Dec 2026");
  });

  it("says the same things in the HTML part, and carries the link as its one remote resource", () => {
    const { html } = renderInvitationMail(CONTEXT);
    for (const words of [
      "Sam Okafor has a place for you in Harbour House on Orbit.",
      "Sent to priya@example.com.",
      "Good until 20 Sep 2026.",
      "Open your invitation",
      "not a company.",
    ]) {
      expect(html).toContain(words);
    }
    /* No remote images, no web fonts, no stylesheets: the mail has to be
       legible with images off, and a blocked resource must not be able to
       report that it was opened. */
    expect(html).not.toMatch(/<img\b/iu);
    expect(html).not.toMatch(/<link\b/iu);
    expect(html).not.toMatch(/@import|url\(/iu);
    const remote = [...html.matchAll(/https?:\/\/[^"'\s<>]+/gu)].map((match) => match[0]);
    expect(new Set(remote)).toEqual(new Set([CONTEXT.link]));
  });

  it("escapes a chosen display name rather than letting it write markup", () => {
    const { html, subject } = renderInvitationMail({
      ...CONTEXT,
      inviterName: "<script>alert(1)</script>",
      householdName: "Tom & Sue's",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Tom &amp; Sue&#39;s");
    /* The subject is a header, not markup: it is not escaped, and must not be. */
    expect(subject).toContain("<script>alert(1)</script>");
  });

  it("reads the instance's host off the one link rather than being told it twice", () => {
    const { text } = renderInvitationMail({ ...CONTEXT, link: "https://orbit.lawson.example:8443/invite/abc" });
    expect(text).toContain("Orbit at orbit.lawson.example:8443, run by Sam's household");
  });

  it("uses a one-word display name for the familiar lines without inventing a surname", () => {
    const { text } = renderInvitationMail({ ...CONTEXT, inviterName: "Gran" });
    expect(text).toContain("Gran has a place for you in Harbour House on Orbit.");
    expect(text).toContain("and Gran would like you in theirs.");
    expect(text).toContain("run by Gran's household");
  });
});
