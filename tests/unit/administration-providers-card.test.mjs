import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1676: the Administration "Sign-in providers" card, under People beside
 * Public contact, built to the ratified mock-up
 * (design/v19/provider-removal/round-2/s-the-providers-card.html, ADR-0041).
 *
 * Source text, like v19-administration-no-inert-buttons: the page and the
 * modules beside it (acts.svelte.js and any new one) are read together, so
 * where the post lives is the builder's choice but the words and the wire
 * are pinned. Words are the mock-up's, exactly.
 */
const dir = new URL("../../web/src/routes/administration/", import.meta.url);
const page = readFileSync(new URL("+page.svelte", dir), "utf8");
const all = readdirSync(dir)
  .filter((name) => /\.(svelte|js)$/u.test(name) && !name.includes("server"))
  .map((name) => readFileSync(new URL(name, dir), "utf8"))
  .join("\n");
const flat = all.replace(/\s+/gu, " ");

describe("the Sign-in providers card (#1676)", () => {
  it("is a card headed 'Sign-in providers', in the page", () => {
    expect(page).toMatch(/id="providers-card"/u);
    expect(page).toMatch(/<h[23]>\s*Sign-in providers\s*<\/h[23]>/u);
  });

  it("sits under People, beside Public contact (the same row, before the Public contact card closes the grid)", () => {
    const providers = page.indexOf('id="providers-card"');
    const contact = page.indexOf("<h2>Public contact</h2>");
    expect(providers).toBeGreaterThan(-1);
    expect(contact).toBeGreaterThan(-1);
    expect(Math.abs(providers - contact)).toBeLessThan(6000);
  });

  it("reads the preview from /api/admin/provider-links", () => {
    expect(all).toMatch(/["'`]\/api\/admin\/provider-links["'`]/u);
  });

  it("offers the primary administrator with a password the act 'remove every link…'", () => {
    expect(flat).toMatch(/remove every link(…|&hellip;)/u);
  });

  it("shows another administrator a quiet line naming the primary administrator, as a note and not a button", () => {
    expect(flat).toMatch(/<span class="note">\s*only the primary administrator, \{[^}]+\}, can do this\s*<\/span>/u);
  });

  it("shows a primary administrator with no password a link to Settings → Sign-in methods", () => {
    expect(flat).toMatch(
      /<span class="note">\s*<a href="\/settings#sign-in-methods">set a password in Settings first<\/a>\s*<\/span>/u,
    );
  });

  it("states that a provider still configured cannot be removed", () => {
    expect(flat).toMatch(/still the configured provider/u);
  });

  it("asks for 'your current password' in the confirm", () => {
    expect(flat).toMatch(/your current password/u);
    expect(flat).toMatch(/type="password"/u);
    expect(flat).toMatch(/autocomplete="current-password"/u);
  });

  it("posts the issuer, mailStranded and the password to /api/admin/provider-links/remove", () => {
    expect(all).toMatch(/\/api\/admin\/provider-links\/remove/u);
    expect(all).toMatch(/mailStranded:\s*true/u);
    expect(all).toMatch(/currentPassword/u);
    expect(all).toMatch(/\bissuer\b/u);
  });

  it("gives the result as a count of those mailed, and lists only people not mailed or whose mail failed", () => {
    expect(flat).toMatch(/Setup links? mailed to/u);
    expect(flat).toMatch(/people with no other way in/u);
    expect(flat).toMatch(/have a password and needed nothing/u);
    expect(flat).toMatch(/<h4>not mailed<\/h4>/u);
    expect(flat).toMatch(/send again/u);
    // round 1's per-person "has a password · nothing to send" rows are gone
    expect(flat).not.toMatch(/nothing to send/u);
  });

  it("has no button in the card that does nothing when pressed", () => {
    const start = page.indexOf('id="providers-card"');
    // the card runs to the next card or the end of the grid; a generous window is enough
    const window = page.slice(start, start + 6000);
    const inCard = [...window.matchAll(/<button\b([^>]*)>/gu)].map((m) => m[1]);
    expect(inCard.length).toBeGreaterThan(0);
    for (const attributes of inCard) {
      expect(attributes, `inert button in the providers card: ${attributes}`).toMatch(/\bonclick=|type="submit"/u);
    }
  });
});
