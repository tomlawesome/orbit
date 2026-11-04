import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1676: the phone Administration screen carries the same "Sign-in providers"
 * card as the desk, round 3 direction T (design/v19/provider-removal/round-3/
 * README.md; 390px shots: the card, confirm, result one not). Same words and
 * structure as the desk. Source text, like administration-providers-card.test.mjs.
 * The card itself must be in pocket.svelte; words may come from words.js /
 * acts.svelte.js / providers.js, which the desk shares.
 */
const dir = new URL("../../web/src/routes/administration/", import.meta.url);
const pocket = readFileSync(new URL("pocket.svelte", dir), "utf8");
const shared = ["words.js", "acts.svelte.js", "providers.js"].map((n) => readFileSync(new URL(n, dir), "utf8")).join("\n");
const pocketFlat = pocket.replace(/\s+/gu, " ");
const flat = `${pocket}\n${shared}`.replace(/\s+/gu, " ");
const tick = "(?:'|’|&rsquo;|&#39;)";

describe("the Sign-in providers card on the phone (#1676, round 3)", () => {
  it("is a card headed 'Sign-in providers' in pocket.svelte, with nothing beside the head", () => {
    expect(pocket).toMatch(/id="providers-card"/u);
    expect(pocket).toMatch(/<h[23][^>]*>\s*Sign-in providers\s*<\/h[23]>/u);
    const start = pocket.indexOf('id="providers-card"');
    expect(pocket.slice(start, start + 600)).toMatch(/class="cardhead"\s*>\s*<h[23][^>]*>\s*Sign-in providers\s*<\/h[23]>\s*<\/div>/u);
  });

  it("is absent when nothing is removable", () => {
    const start = pocket.indexOf('id="providers-card"');
    expect(start).toBeGreaterThan(-1);
    expect(pocket.slice(Math.max(0, start - 400), start)).toMatch(/\{#if\b[^}]*\}/u);
  });

  it("reads the preview and posts the removal, through the shared acts or its own calls", () => {
    expect(pocketFlat).toMatch(/readProviderLinks|\/api\/admin\/provider-links["'`]/u);
    expect(pocketFlat).toMatch(/removeProviderLinks|\/api\/admin\/provider-links\/remove/u);
  });

  it("lists only providers that are off: a configured provider has no row", () => {
    expect(flat).toMatch(/!\s*[\w.]+\.configured\b/u);
    expect(flat).not.toMatch(/still the configured provider/u);
  });

  it("draws the provider as a .kv row '<b>off</b> · N linked · K without a password' with 'remove links…' as a button", () => {
    expect(pocketFlat).toMatch(/class="kv"/u);
    expect(flat).toMatch(/<b>off<\/b> (?:·|&middot;) \{[^}]+\} linked (?:·|&middot;) \{[^}]+\} without a password/u);
    expect(pocketFlat).toMatch(/<button[^>]*onclick=[^>]*>\s*remove links(…|&hellip;)/u);
    expect(flat).not.toMatch(/remove every link/u);
  });

  it("shows another administrator a quiet line naming the primary, not a button", () => {
    expect(pocketFlat).toMatch(/<span class="[^"]*\bnote\b[^"]*">\s*only the primary administrator, \{[^}]+\}, can do this\s*<\/span>/u);
  });

  it("shows a primary with no password a link to Settings → Sign-in methods", () => {
    expect(pocketFlat).toMatch(/<a href="\/settings#sign-in-methods">set a password in Settings first<\/a>/u);
  });

  it("opens the confirm as the mailboxform: the note, 'your password', the two-tap red button, cancel", () => {
    const start = pocket.indexOf('id="providers-card"');
    expect(start).toBeGreaterThan(-1);
    expect(flat).toMatch(/class="mailboxform"/u);
    expect(flat).toMatch(/class="mailboxnote"/u);
    expect(flat).toMatch(/\{[^}]+\} (?:have|has) no password, so each is mailed a setup link good for \{?[^}\s]+\}? days\./u);
    expect(flat).toMatch(new RegExp(`You signed in through it today, so you${tick}ll be signed out too\\.`, "u"));
    const card = pocket.slice(start, start + 8000).replace(/\s+/gu, " ");
    expect(card).toMatch(/your password/u);
    expect(card).toMatch(/type="password"/u);
    expect(card).toMatch(/autocomplete="current-password"/u);
    expect(card).not.toMatch(/your current password/u);
    expect(flat).toMatch(/dangerbtn/u);
    expect(flat).toMatch(/remove \{[^}]+\} links/u);
    expect(flat).toMatch(/tap again to remove \{[^}]+\} links/u);
    expect(flat).toMatch(/<button[^>]*>\s*cancel\s*<\/button>/u);
  });

  it("refuses with one problem line when outgoing mail isn't set up", () => {
    expect(flat).toMatch(new RegExp(`not started (?:—|&mdash;) outgoing mail isn${tick}t set up, and .{0,40}need a setup link\\.`, "u"));
  });

  it("gives the result as the desk does: the row says removed; People's green line; one problem line and 'send again' per person not mailed", () => {
    expect(flat).toMatch(/<b class="on">removed<\/b> (?:·|&middot;) \{[^}]+\} links? (?:·|&middot;) /u);
    expect(flat).toMatch(/Setup links? sent to/u);
    expect(flat).toMatch(/Setup link sent to \{[^}]+\} of \{[^}]+\} people, valid until/u);
    expect(flat).toMatch(/not sent (?:—|&mdash;) /u);
    expect(flat).toMatch(/send again/u);
    for (const gone of [/Setup links? mailed to/u, /people with no other way in/u, /<h4>not mailed<\/h4>/u, /nothing to send/u]) {
      expect(flat).not.toMatch(gone);
    }
  });

  it("asks for no days and no typed host: the confirm's one field is the password", () => {
    const start = pocket.indexOf('id="providers-card"');
    const card = pocket.slice(start, start + 6000);
    const inputs = [...card.matchAll(/<input\b[^>]*>/gu)].map((m) => m[0]);
    const types = inputs.filter((i) => /type="password"/u.test(i));
    expect(types.length).toBe(1);
    expect(inputs.filter((i) => /type="(?:number|text)"/u.test(i))).toEqual([]);
  });
});
