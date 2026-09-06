import { describe, expect, it } from "vitest";
import { formatInvitationDate, renderInvitationMail } from "./mail";

/**
 * The mail's words, pinned (#481).
 *
 * The template's own data story — Sam Okafor invites priya@example.com to
 * Harbour House, good until 20 Sep 2026 — is used verbatim, so this file also
 * records what `design/v19/mail/round-1/text.txt` said. The text assertions
 * below survived the approved mockup landing in the HTML part unchanged, and
 * are meant to keep surviving: the look was chosen, the words were not.
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
    const { html, subject } = renderInvitationMail(CONTEXT);
    for (const words of [
      /* "the living system" splits the opening line over two: the inviter's
         sentence, then the household on its own at display size. */
      "Sam Okafor has a place for you in",
      "Harbour House",
      "Orbit keeps a household’s year in one calm view. Sam would like you in theirs.",
      "sent to <span style=\"color:#7c8699;\">priya@example.com</span> · sign in with that address",
      "good until <span style=\"color:#7c8699;\">20 Sep 2026</span>",
      "not expecting this? nothing to do — the link simply lapses.",
      "Take your place",
      "Orbit at <span style=\"color:#7c8699;\">orbit.example</span> · run by Sam’s household, not a company.",
      /* The preheader: what a phone's list view shows beside the subject. */
      "Sam has a place for you in Harbour House. The link is good until 20 Sep 2026.",
    ]) {
      expect(html).toContain(words);
    }
    expect(html).toContain(`<title>${subject}</title>`);
    /* No remote images, no web fonts, no stylesheets: the mail has to be
       legible with images off, and a blocked resource must not be able to
       report that it was opened. */
    expect(html).not.toMatch(/<img\b/iu);
    expect(html).not.toMatch(/<link\b/iu);
    expect(html).not.toMatch(/@import|url\(/iu);
    const remote = [...html.matchAll(/https?:\/\/[^"'\s<>]+/gu)].map((match) => match[0]);
    expect(new Set(remote)).toEqual(new Set([CONTEXT.link]));
  });

  it("holds the design's own constraints: no images, and nothing positioned", () => {
    const { html } = renderInvitationMail(CONTEXT);
    /* The mockup places the comet's tail and the sun's warmth with margins on
       purpose: `position:` is dropped or mangled by enough clients that the
       layout has to work without it (#481, round 3 direction G). */
    expect(html).not.toMatch(/position\s*:/iu);
    expect(html).not.toMatch(/<img\b/iu);
    expect(html).not.toMatch(/<svg\b/iu);
    expect(html).toContain("width:100%;max-width:560px;");
    /* The animation is enhancement, and it is stoppable. */
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("carries the link exactly twice — the button and the copy-this line — and escapes it", () => {
    const { html } = renderInvitationMail(CONTEXT);
    expect(html.split(CONTEXT.link)).toHaveLength(3);

    /* A real token is base64url and has no metacharacters, but the link is
       built from an instance's own base URL, which can carry a query. */
    const awkward = "https://orbit.example/invite/abc?a=1&b=2";
    const escaped = renderInvitationMail({ ...CONTEXT, link: awkward }).html;
    expect(escaped).not.toContain(awkward);
    expect(escaped.split("https://orbit.example/invite/abc?a=1&amp;b=2")).toHaveLength(3);
  });

  it("escapes the inviter, the household, the address and the date into the HTML", () => {
    const { html } = renderInvitationMail({
      ...CONTEXT,
      inviterName: "Ada <b>Byron",
      householdName: "Harbour <b>& House",
      email: "priya+<b>@example.com",
    });
    expect(html).toContain("Ada &lt;b&gt;Byron has a place for you in");
    expect(html).toContain("Harbour &lt;b&gt;&amp; House");
    expect(html).toContain("priya+&lt;b&gt;@example.com");
    expect(html).toContain("20 Sep 2026");
    expect(html).not.toContain("<b>");
  });

  it("escapes a household name for the HTML part while leaving the text part alone", () => {
    const { html, text } = renderInvitationMail({ ...CONTEXT, householdName: "Nest <b>& Co" });
    expect(html).toContain("Nest &lt;b&gt;&amp; Co");
    expect(html).not.toContain("Nest <b>& Co");
    /* The text part is not markup; escaping it would put "&amp;" in front of
       someone reading the mail with HTML off. */
    expect(text).toContain("Nest <b>& Co");
    expect(text).not.toContain("&lt;");
    expect(text).not.toContain("&amp;");
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
