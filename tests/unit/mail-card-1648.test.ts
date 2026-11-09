/**
 * Every mail Orbit sends wears the ratified card (#1648).
 *
 * The card is the invitation's (round 3 direction G, #481), the wording is the
 * ratified round 4 direction L (`design/v19/mail/round-4/`, #1648 note 54713).
 * This file holds what needs no database; the senders that build their message
 * inline are in `tests/integration/mail-card-*-1648.test.ts`.
 *
 * The interface these tests choose (the issue names the behaviour, not the
 * shape): `renderMail` in `src/server/invitations/mail.ts`, beside
 * `renderInvitationMail`, taking
 *   { subject, preheader, headline, body: string[], button?: { label, href },
 *     facts?: { label, value }[], footer?: string[], text }
 * and returning { subject, text, html }. The text part is passed in as given
 * and returned untouched.
 *
 * Groups 1-3 fail until the renderer exists. Groups 4-6 pin today's behaviour
 * (plain-text parts, the invitation, the subjects) and must pass before and
 * after the change.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApprovalMail } from "@/server/sign-in-approvals/mail";
import { renderSetupMail } from "@/server/local-credentials/mail";
import { renderInvitationMail, renderMail } from "@/server/invitations/mail";
import * as mailModule from "@/server/invitations/mail";
import { buildImapNotification } from "@/server/mail-in/imap-receipt-worker";
import { parseMailHeaders } from "@/server/mail-in/core/sender-authentication";
import { replyToUnattributedSender, unattributedReplyText } from "@/server/mail-in/unattributed-reply";
import { reminderWords } from "@/server/notification-worker";
import { visibleText } from "../support/mail-card";

/* The unattributed reply reads and claims a row; a stand-in database that
   finds none and accepts the claim lets the real function build its message. */
vi.mock("@/db", () => {
  const chain = (result: unknown): unknown => new Proxy(() => undefined, {
    get: (_target, key) => (key === "then" ? (resolve: (value: unknown) => void) => resolve(result) : chain(result)),
    apply: () => chain(result),
  });
  return {
    getDb: () => ({
      select: () => chain([]),
      insert: () => chain([{ addressSha256: "fixture" }]),
    }),
  };
});

const HOST = "orbit.harlow.example";
const APPROVE_TOKEN = "q3Zr-example-token";
const SET_TOKEN = "m9Tc-example-token";
const APPROVE_LINK = `https://${HOST}/sign-in/approve/${APPROVE_TOKEN}`;
const SET_LINK = `https://${HOST}/set-password/${SET_TOKEN}`;
const INBOX_LINK = `https://${HOST}/inbox`;
const CAPTION = "A SUN · ONE RING · TWELVE MONTHS";

/** The card every mail shares: self-contained, no images, no fonts to fetch. */
function expectRatifiedCard(html: string): void {
  expect(html).toContain("1px solid #4f4118");
  expect(html).toContain(CAPTION);
  expect(html).not.toMatch(/<img/iu);
  expect(html).not.toMatch(/<svg/iu);
  expect(html).not.toMatch(/<link/iu);
  expect(html).not.toMatch(/@import|@font-face|fonts\.googleapis|fonts\.gstatic/iu);
}

describe("renderMail (#1648 item 1)", () => {
  const input = {
    subject: "Check your Orbit sending address",
    preheader: "Open the button while signed in, within 24 hours.",
    headline: "Is this address yours?",
    body: [
      "Orbit is checking that you send mail from ned.harlow@mailbox.example.",
      "Open the button while signed in to Orbit, within 24 hours.",
    ],
    button: { label: "yes, it’s mine", href: `https://${HOST}/relay/verify/x7Kq-example-token` },
    facts: [
      { label: "address", value: "ned.harlow@mailbox.example" },
      { label: "good until", value: "7 Nov 2026 at 18:40 UTC" },
    ],
    footer: ["Didn’t ask for this? Ignore it — nothing changes.", `Orbit at ${HOST}, run by a household, not a company.`],
    text: "plain text, exactly as the sender wrote it\n\nwith a second paragraph\n",
  };
  const render = () => renderMail(input);

  it("is exported beside renderInvitationMail", () => {
    expect(typeof (mailModule as Record<string, unknown>).renderMail).toBe("function");
  });

  it("returns the subject and the text part exactly as given", () => {
    const mail = render();
    expect(mail.subject).toBe(input.subject);
    expect(mail.text).toBe(input.text);
  });

  it("puts the headline, every paragraph, the button, every fact and every footer line in the html", () => {
    const { html } = render();
    const seen = visibleText(html);
    expect(seen).toContain(input.headline);
    for (const paragraph of input.body) expect(seen).toContain(paragraph);
    expect(seen).toContain(input.button.label);
    expect(html).toContain(`href="${input.button.href}"`);
    for (const fact of input.facts) {
      expect(seen).toContain(fact.label);
      expect(seen).toContain(fact.value);
    }
    for (const line of input.footer) expect(seen).toContain(line);
  });

  it("holds the preheader in a hidden element", () => {
    expect(render().html).toMatch(/display:\s*none[^>]*>\s*Open the button while signed in, within 24 hours\./u);
  });

  it("wears the card: outline, caption, no images, no svg, no external fonts or stylesheets", () => {
    expectRatifiedCard(render().html);
  });

  it("is the invitation's card: the same shell above the headline", () => {
    const invitation = renderInvitationMail({
      inviterName: "Ned Harlow", householdName: "The Harlows", email: "ally@harlow.example",
      link: `https://${HOST}/invite/k4Ws-example-token`, expiresAt: new Date("2026-11-14T00:00:00Z"),
    }).html;
    const shell = (html: string) => html.slice(html.indexOf("1px solid #4f4118"), html.indexOf(CAPTION) + CAPTION.length);
    expect(shell(render().html)).toBe(shell(invitation));
  });

  it("carries no link at all when there is no button", () => {
    const { button: _button, ...rest } = input;
    const { html } = renderMail(rest);
    expect(html).not.toMatch(/<a\s/iu);
    expect(html).not.toMatch(/href=/iu);
  });

  it("has exactly one link when there is a button", () => {
    expect(render().html.match(/<a\s/giu)).toHaveLength(1);
  });

  it("escapes every value it inserts", () => {
    const hostile = {
      ...input,
      subject: "a & <b>",
      preheader: "<i>pre</i>",
      headline: "<script>alert(1)</script> & co",
      body: ["<img src=x onerror=alert(1)>"],
      button: { label: "go <now>", href: `https://${HOST}/?a=1&b="2"` },
      facts: [{ label: "<l>", value: "<v> & \"w\"" }],
      footer: ["<f>"],
    };
    const { html } = renderMail(hostile);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>pre");
    expect(html).not.toContain("<l>");
    expect(html).not.toContain("<v>");
    expect(html).not.toContain("<f>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; co");
    expect(html).toContain('href="https://orbit.harlow.example/?a=1&amp;b=&quot;2&quot;"');
  });
});

describe("renderMail refuses a button link that is not http or https (#1648)", () => {
  const base = { subject: "s", preheader: "p", headline: "h", body: ["b"], footer: ["f"], text: "t" };
  const withHref = (href: string) => () => renderMail({ ...base, button: { label: "go", href } });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "//orbit.harlow.example/x",
    "/relative/path",
    "",
  ])("throws for %j", (href) => {
    expect(withHref(href)).toThrow();
  });

  it.each([`https://${HOST}/x?a=1&b=2`, `http://${HOST}/x`])("accepts %s", (href) => {
    expect(withHref(href)).not.toThrow();
  });
});

/* ---------------------------------------------------------------- senders */

interface Sample {
  name: string;
  mail: { subject: string; text: string; html?: string };
  subject: string;
  headline: string;
  button?: { label: string; href: string };
  /** Secrets that may appear in the button's href and the text part only. */
  token?: string;
  /** Strings the reader sees: ratified body, fact labels and values, footer lines. */
  shown: string[];
}

const approval = renderApprovalMail({
  displayName: "Ned Harlow",
  link: APPROVE_LINK,
  device: "Firefox on Windows",
  where: "Leeds, United Kingdom",
  requestedAt: new Date("2026-11-07T16:12:00Z"),
  expiresAt: new Date("2026-11-07T18:40:00Z"),
});
const setupContext = {
  displayName: "Ned Harlow",
  email: "ned@harlow.example",
  link: SET_LINK,
  expiresAt: new Date("2026-11-07T18:40:00Z"),
};
const setup = renderSetupMail({ ...setupContext, purpose: "setup" });
const recovery = renderSetupMail({ ...setupContext, purpose: "recovery" });
const review = buildImapNotification("review_ready", INBOX_LINK);

describe("a link with no usable host leaves no empty host in the footer (#1648)", () => {
  const NOWHERE = "not a link";
  const FALLBACK = "Orbit, run by a household, not a company."; // householdLine("") in mail.ts
  const mails = {
    "sign-in approval": renderApprovalMail({
      displayName: "Ned Harlow", link: NOWHERE, device: "Firefox on Windows", where: "Leeds, United Kingdom",
      requestedAt: new Date("2026-11-07T16:12:00Z"), expiresAt: new Date("2026-11-07T18:40:00Z"),
    }),
    "set password": renderSetupMail({ ...setupContext, link: NOWHERE, purpose: "setup" }),
    "reset password": renderSetupMail({ ...setupContext, link: NOWHERE, purpose: "recovery" }),
  } as Record<string, { html?: string }>;

  it.each(Object.keys(mails))("%s falls back to the host-less household line", (name) => {
    const seen = visibleText(mails[name].html ?? "");
    expect(seen).toContain(FALLBACK);
    expect(seen).not.toMatch(/Orbit at ?,/u);
    expect(seen).not.toMatch(/Orbit at\s*[·,]/u);
  });
});

const SETUP_FOOTER = [
  "The button works once. If it lapses, ask your administrator for another.",
  "Not expecting this? There’s nothing to do — the link simply lapses.",
  `Orbit at ${HOST}, run by a household, not a company.`,
];

const samples: Sample[] = [
  {
    name: "sign-in approval",
    mail: approval,
    subject: "Approve your Orbit sign-in",
    headline: "Approve this sign-in?",
    button: { label: "approve, or say it wasn’t you", href: APPROVE_LINK },
    token: APPROVE_TOKEN,
    shown: [
      "Hello Ned,",
      "Your Orbit password has just been used to sign in. Nobody gets in until you approve it.",
      "device", "Firefox on Windows", "from", "Leeds, United Kingdom", "when", "7 Nov 2026 at 16:12 UTC",
      "The button works once and lapses at 7 Nov 2026 at 18:40 UTC. Opening it approves nothing by itself — you choose on the page.",
      "If this wasn’t you, ignore it — nobody gets in without approval.",
      `Orbit at ${HOST}, run by a household, not a company.`,
    ],
  },
  {
    name: "set password",
    mail: setup,
    subject: "Set your Orbit password",
    headline: "Set your Orbit password",
    button: { label: "choose a password", href: SET_LINK },
    token: SET_TOKEN,
    shown: [
      "Hello Ned,",
      `An administrator has created an Orbit account for you at ${HOST}. Choose a password and you’re in.`,
      "sent to", "ned@harlow.example", "good until", "7 Nov 2026",
      ...SETUP_FOOTER,
    ],
  },
  {
    name: "reset password",
    mail: recovery,
    subject: "Reset your Orbit password",
    headline: "Reset your Orbit password",
    button: { label: "choose a new password", href: SET_LINK },
    token: SET_TOKEN,
    shown: [
      "Hello Ned,",
      `An administrator has sent you a new link for your Orbit account at ${HOST}. Choose a new password and you’re back in.`,
      "sent to", "ned@harlow.example", "good until", "7 Nov 2026 at 18:40 UTC",
      ...SETUP_FOOTER,
    ],
  },
  {
    name: "review available",
    mail: review,
    subject: "Orbit review available",
    headline: "Something’s waiting in your inbox",
    button: { label: "open your inbox", href: INBOX_LINK },
    shown: [
      "Orbit has an update waiting in your private inbox.",
      "This opens your own inbox and changes nothing.",
    ],
  },
];

describe("each sender's mail carries the ratified card (#1648 items 2 and 3)", () => {
  describe.each(samples)("$name", (sample) => {
    const html = () => sample.mail.html ?? "";

    it("has an html part", () => {
      expect(typeof sample.mail.html).toBe("string");
      expect(html().length).toBeGreaterThan(500);
    });

    it("wears the card", () => {
      expectRatifiedCard(html());
    });

    it("holds the ratified headline, the button label and its link", () => {
      const seen = visibleText(html());
      expect(seen).toContain(sample.headline);
      expect(seen).toContain(sample.button!.label);
      expect(html()).toContain(`href="${sample.button!.href}"`);
      expect(html().match(/<a\s/giu)).toHaveLength(1);
    });

    it("shows the ratified body, facts and footer", () => {
      const seen = visibleText(html());
      for (const line of sample.shown) expect(seen).toContain(line);
    });

    it("keeps any token to the button link and the text part", () => {
      if (!sample.token) return;
      expect(sample.mail.text).toContain(sample.token);
      expect(html().split(sample.token).length - 1).toBe(1); // the href, once
      expect(visibleText(html())).not.toContain(sample.token);
      expect(sample.mail.subject).not.toContain(sample.token);
      expect(sample.headline).not.toContain(sample.token);
    });

    it("sets the footer host in its own element, in the mock-up's lighter grey", () => {
      if (!sample.shown.some((line) => line.startsWith(`Orbit at ${HOST}, run by`))) return;
      expect(html()).toMatch(/Orbit at\s*<span[^>]*color:\s*#7c8699[^>]*>orbit\.harlow\.example<\/span>\s*, run by a household/u);
    });

    it("keeps the subject", () => {
      expect(sample.mail.subject).toBe(sample.subject);
    });
  });
});

describe("could-not-match reply carries the ratified card (#1648)", () => {
  const SENDER = "stranger@example.test";
  const sent: Array<{ to: string; subject: string; text: string; html?: string }> = [];
  beforeEach(() => { sent.length = 0; });

  async function reply() {
    const result = await replyToUnattributedSender(
      parseMailHeaders(Buffer.from(`From: ${SENDER}\r\n\r\n`)),
      SENDER,
      async () => ["example.test"],
      {
        now: () => new Date("2026-11-07T16:12:00Z"),
        smtpConfig: () => ({ smtpUrl: "smtps://smtp.example.test", smtpFrom: "orbit@example.test" }) as never,
        sendMail: async (message: never) => { sent.push(message); },
      },
    );
    expect(result).toEqual({ sent: true });
    return sent[0];
  }

  it("sends an html part with the ratified headline and no link at all", async () => {
    const mail = await reply();
    expect(mail.subject).toBe("Orbit could not match your message");
    const html = mail.html ?? "";
    expectRatifiedCard(html);
    const seen = visibleText(html);
    expect(seen).toContain("Orbit couldn’t match your message");
    expect(seen).toContain("It wasn’t matched to anyone, so it has been deleted and nothing was kept.");
    expect(seen).toContain("The usual cause is a redirect rather than a forward.");
    expect(seen).toContain("The other cause is an address Orbit has not checked yet.");
    expect(html).not.toMatch(/<a\s/iu);
    expect(html).not.toMatch(/href=/iu);
  });

  it("leaves the text part as it is today", async () => {
    expect((await reply()).text).toBe(unattributedReplyText());
  });
});

describe("reminder words (#1648)", () => {
  it("keeps the subject, as ratified", () => {
    expect(reminderWords("Car insurance", "20 Nov 2026", "renewal").subject).toBe("Car insurance is coming up");
    expect(reminderWords("Car insurance", "20 Nov 2026", "expiry").subject).toBe("Car insurance is running out");
  });
});

/* ------------------------------------------------- byte-for-byte, as today */

describe("the plain-text parts are unchanged byte for byte (#1648 item 4)", () => {
  it("sign-in approval", () => {
    expect(approval.text).toBe(
      "Hello Ned,\n\nYour Orbit password has just been used to sign in. Nobody gets in\nuntil you approve it:\n\n"
      + "  - Orbit at orbit.harlow.example\n  - Firefox on Windows\n  - From Leeds, United Kingdom\n  - 7 Nov 2026 at 16:12 UTC\n\n"
      + "Approve it, or say it wasn't you:\n\n  https://orbit.harlow.example/sign-in/approve/q3Zr-example-token\n\n"
      + "The link works once and lapses at 7 Nov 2026 at 18:40 UTC.\nOpening it approves nothing by itself - you choose on the page.\n"
      + "If this wasn't you, ignore it - nobody gets in without approval.\n\nOrbit at orbit.harlow.example, run by a household, not a company.\n",
    );
  });

  it("set password", () => {
    expect(setup.text).toBe(
      "Hello Ned,\n\nAn administrator has created an Orbit account for you at orbit.harlow.example.\nChoose a password and you are in:\n\n"
      + "  https://orbit.harlow.example/set-password/m9Tc-example-token\n\n"
      + "Sent to ned@harlow.example. Good until 7 Nov 2026.\nThe link works once. If it lapses, ask your administrator for another.\n"
      + "Not expecting this? There is nothing to do - the link simply lapses.\n\nOrbit at orbit.harlow.example, run by a household, not a company.\n",
    );
  });

  it("reset password", () => {
    expect(recovery.text).toBe(
      "Hello Ned,\n\nAn administrator has sent you a new link for your Orbit account at\norbit.harlow.example. Choose a new password and you are back in:\n\n"
      + "  https://orbit.harlow.example/set-password/m9Tc-example-token\n\n"
      + "Sent to ned@harlow.example. Good until 7 Nov 2026 at 18:40 UTC.\nThe link works once. If it lapses, ask your administrator for another.\n"
      + "Not expecting this? There is nothing to do - the link simply lapses.\n\nOrbit at orbit.harlow.example, run by a household, not a company.\n",
    );
  });

  it("review available", () => {
    expect(review.text).toBe(
      "Orbit has an update waiting in your private inbox.\n\nSign in to Orbit to review it: https://orbit.harlow.example/inbox\n\n"
      + "This link only opens your authenticated inbox; it does not change any data.",
    );
  });

  it("could not match", () => {
    expect(unattributedReplyText()).toBe(
      "Orbit could not match this message to anyone, so it has been deleted and nothing was kept.\n\n"
      + "The usual cause is a redirect rather than a forward. A redirect keeps the original sender's\n"
      + "address, so it looks to Orbit as though somebody else sent it. Forward the message instead,\n"
      + "from your own mail program, and it will arrive from you.\n\n"
      + "The other cause is an address Orbit has not checked yet. Sign in to Orbit, open your relay\n"
      + "settings, and check the address you send from.",
    );
  });

  it("reminder and expiry reminder", () => {
    expect(reminderWords("Car insurance", "20 Nov 2026", "renewal").text)
      .toBe("Reminder: Car insurance is due on 20 Nov 2026.\nOpen Orbit to review it.");
    expect(reminderWords("Car insurance", "20 Nov 2026", "expiry").text)
      .toBe("Reminder: Car insurance ends on 20 Nov 2026.\nOpen Orbit to review it.");
  });
});

describe("the subjects are as today (#1648 item 6)", () => {
  it("approval, set, reset and review", () => {
    expect(approval.subject).toBe("Approve your Orbit sign-in");
    expect(setup.subject).toBe("Set your Orbit password");
    expect(recovery.subject).toBe("Reset your Orbit password");
    expect(review.subject).toBe("Orbit review available");
  });
});

describe("the invitation is unchanged (#1648 item 5)", () => {
  const mail = renderInvitationMail({
    inviterName: "Ned Harlow",
    householdName: "The Harlows",
    email: "ally@harlow.example",
    link: "https://orbit.harlow.example/invite/k4Ws-example-token",
    expiresAt: new Date("2026-11-14T00:00:00Z"),
  });
  const fixture = (name: string) => readFileSync(new URL(`../fixtures/mail/${name}`, import.meta.url), "utf8");

  it("keeps its subject, text and html byte for byte", () => {
    expect(mail.subject).toBe("Ned Harlow invited you to The Harlows on Orbit");
    expect(mail.text).toBe(fixture("invitation.txt"));
    expect(mail.html).toBe(fixture("invitation.html"));
  });
});
