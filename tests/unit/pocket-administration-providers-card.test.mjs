import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1676: the phone Administration screen carries the same "Sign-in providers"
 * card, with the same words and scenes as the desk (mock-up round 2 has 390px
 * shots of confirm and the result). Source text, like
 * administration-providers-card.test.mjs. The card itself must be in
 * pocket.svelte; the words may come from words.js / acts.svelte.js, which
 * the desk shares.
 */
const dir = new URL("../../web/src/routes/administration/", import.meta.url);
const pocket = readFileSync(new URL("pocket.svelte", dir), "utf8");
const shared = ["words.js", "acts.svelte.js"].map((n) => readFileSync(new URL(n, dir), "utf8")).join("\n");
const pocketFlat = pocket.replace(/\s+/gu, " ");
const flat = `${pocket}\n${shared}`.replace(/\s+/gu, " ");

describe("the Sign-in providers card on the phone (#1676)", () => {
  it("is a card headed 'Sign-in providers' in pocket.svelte", () => {
    expect(pocket).toMatch(/id="providers-card"/u);
    expect(pocket).toMatch(/<h[23][^>]*>\s*Sign-in providers\s*<\/h[23]>/u);
  });

  it("reads the preview and posts the removal, through the shared acts or its own calls", () => {
    // acts.svelte.js already holds the wire (readProviderLinks, the remove post);
    // the phone screen must use it, not merely sit beside it.
    expect(pocketFlat).toMatch(/readProviderLinks|\/api\/admin\/provider-links["'`]/u);
    expect(pocketFlat).toMatch(/removeProviderLinks|\/api\/admin\/provider-links\/remove/u);
  });

  it("offers the primary administrator with a password 'remove every link…', as a button", () => {
    expect(pocketFlat).toMatch(/<button[^>]*onclick=[^>]*>\s*remove every link(…|&hellip;)/u);
  });

  it("shows another administrator a quiet line naming the primary, not a button", () => {
    expect(pocketFlat).toMatch(/<span class="[^"]*\bnote\b[^"]*">\s*only the primary administrator, \{[^}]+\}, can do this\s*<\/span>/u);
  });

  it("shows a primary with no password a link to Settings → Sign-in methods", () => {
    expect(pocketFlat).toMatch(/<a href="\/settings#sign-in-methods">set a password in Settings first<\/a>/u);
  });

  it("asks for 'your current password' in the card's confirm", () => {
    const start = pocket.indexOf('id="providers-card"');
    expect(start).toBeGreaterThan(-1);
    const card = pocket.slice(start, start + 8000).replace(/\s+/gu, " ");
    expect(card).toMatch(/your current password/u);
    expect(card).toMatch(/type="password"/u);
    expect(card).toMatch(/autocomplete="current-password"/u);
  });

  it("gives the result lines as the desk does", () => {
    expect(flat).toMatch(/Setup links? mailed to/u);
    expect(flat).toMatch(/people with no other way in/u);
    expect(flat).toMatch(/have a password and needed nothing/u);
    expect(flat).toMatch(/<h4>not mailed<\/h4>/u);
    expect(flat).toMatch(/send again/u);
    expect(flat).toMatch(/still the configured provider/u);
  });

  it("shows the sign-in state words on the phone's People rows too", () => {
    expect(flat).toMatch(/password set/u);
    expect(flat).toMatch(/setup link sent (·|&middot;) good until/u);
    expect(flat).toMatch(/link lapsed .{0,40}(·|&middot;) no way in/u);
  });
});
