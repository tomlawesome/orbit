import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1629, design note 54742 (direction J, "One card is better", owner
 * 2026-11-07; design/v19/mail-setup/round-1/j-one-card.html): the Mail card,
 * desk (+page.svelte) and phone (pocket.svelte).
 *
 * Source text, like administration-providers-card.test.mjs: the page and the
 * modules beside it are read together, so where a word lives is the
 * builder's choice but the words and the wire are pinned. The words are the
 * note's, exactly.
 */
const dir = new URL("../../web/src/routes/administration/", import.meta.url);
const page = readFileSync(new URL("+page.svelte", dir), "utf8");
const pocket = readFileSync(new URL("pocket.svelte", dir), "utf8");
const all = readdirSync(dir)
  .filter((name) => /\.(svelte|js)$/u.test(name) && !name.includes("server"))
  .map((name) => readFileSync(new URL(name, dir), "utf8"))
  .join("\n");
const flat = all.replace(/\s+/gu, " ");
const tick = "(?:'|’|&rsquo;|&#39;)";
const ellipsis = "(?:…|&hellip;|\\.\\.\\.)";
const dot = "(?:·|&middot;)";

describe("the Mail card (#1629)", () => {
  it("is titled Mail on the desk and the phone, and Mail machinery is gone everywhere", () => {
    expect(page).toMatch(/<h2>\s*Mail\s*<\/h2>/u);
    expect(pocket).toMatch(/<h2[^>]*>\s*Mail\s*<\/h2>/u);
    expect(page).not.toMatch(/Mail machinery/u);
    expect(pocket).not.toMatch(/Mail machinery/u);
  });

  it("keeps the two test buttons and the two test names in the card's head, on both layouts", () => {
    for (const [name, text] of [["desk", page], ["phone", pocket]]) {
      expect(text, name).toMatch(/>\s*test this mailbox\s*</u);
      expect(text, name).toMatch(/>\s*test outgoing mail\s*</u);
    }
    expect(flat).toMatch(/mailbox test/u);
    expect(flat).toMatch(/outgoing mail test/u);
  });

  it("has a Mailbox half and a Sending half, Mailbox first", () => {
    for (const [name, text] of [["desk", page], ["phone", pocket]]) {
      const mailbox = text.search(/>\s*Mailbox\s*</u);
      const sendingHalf = text.search(/>\s*Sending\s*</u);
      expect(mailbox, name).toBeGreaterThan(-1);
      expect(sendingHalf, name).toBeGreaterThan(mailbox);
    }
  });

  it("shows the Sending rows: sends as, via, password, last sent", () => {
    for (const label of ["sends as", "via", "password", "last sent"]) {
      expect(flat, label).toMatch(new RegExp(`["'>\`]\\s*${label}\\s*["'<\`]`, "u"));
    }
    expect(flat).toMatch(/the mailbox account/u);
    expect(flat).toMatch(/another account/u);
    expect(flat).toMatch(new RegExp(`the mailbox${tick}s`, "u"));
    expect(flat).toMatch(new RegExp(`set by \\{[^}]+\\} ${dot} \\{[^}]+\\}`, "u"));
  });

  it("says, warmly, what is waiting when sending is not set up, and offers to set it up", () => {
    expect(flat).toMatch(new RegExp(
      `Orbit can${tick}t send invitations, reminders or address checks until sending is set up\\.`, "u",
    ));
    expect(flat).toMatch(new RegExp(`set up sending${ellipsis}`, "u"));
    expect(flat).toMatch(new RegExp(`change sending${ellipsis}`, "u"));
    expect(flat).toMatch(/not tested yet/u);
  });

  it("shows the imported notice: copied from .env-orbit, the lines can go, and how", () => {
    expect(flat).toMatch(/copied from \.env-orbit on \{[^}]+\}/u);
    expect(flat).toMatch(/the SMTP lines there can go now/u);
    expect(flat).toMatch(/>\s*how\s*</u);
    expect(flat).toMatch(/source\s*===?\s*["']imported["']/u);
  });

  it("the editor: the two choices, the read-only via line, verify and save, cancel, and the note", () => {
    expect(flat).toMatch(/sender name/u);
    expect(flat).toMatch(/sender address/u);
    expect(flat).toMatch(/port 587, STARTTLS, signed in as \{[^}]+\}/u);
    expect(flat).toMatch(/>\s*verify and save\s*</u);
    expect(flat).toMatch(/>\s*cancel\s*</u);
    expect(flat).toMatch(/Orbit signs in to the server before saving\. The password is never shown again\./u);
    expect(flat).toMatch(/STARTTLS/u);
    expect(flat).toMatch(/\bTLS\b/u);
  });

  it("reads and writes the sending half through /api/admin/sending", () => {
    const workspace = readFileSync(new URL("../../web/src/lib/data/workspace.js", import.meta.url), "utf8");
    expect(`${all}\n${workspace}`).toMatch(/["'`]\/api\/admin\/sending["'`]/u);
  });
});
