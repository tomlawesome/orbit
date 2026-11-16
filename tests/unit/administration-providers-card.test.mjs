import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1676: the Administration "Sign-in providers" card, round 3, direction T
 * "the one line" (ratified by the owner 2026-11-04; design/v19/provider-removal/
 * round-3/README.md and t-the-one-line.html). The card is made only of parts
 * already on the page: a .kv row per removable provider, the .mailboxform
 * confirm, .adminproblem lines.
 *
 * Source text, like v19-administration-no-inert-buttons: the page and the
 * modules beside it are read together, so where a word lives is the builder's
 * choice but the words and the wire are pinned. Words are the mock-up's,
 * exactly. Round 2's words (remove every link…, days, typed host, state pill,
 * NOT MAILED result block) are pinned absent.
 */
const dir = new URL("../../web/src/routes/administration/", import.meta.url);
const page = readFileSync(new URL("+page.svelte", dir), "utf8");
const all = readdirSync(dir)
  .filter((name) => /\.(svelte|js)$/u.test(name) && !name.includes("server"))
  .map((name) => readFileSync(new URL(name, dir), "utf8"))
  .join("\n");
const flat = all.replace(/\s+/gu, " ");
const tick = "(?:'|’|&rsquo;|&#39;)";

describe("the Sign-in providers card (#1676, round 3)", () => {
  it("is a card headed 'Sign-in providers', in the page, with nothing beside the head", () => {
    expect(page).toMatch(/id="providers-card"/u);
    expect(page).toMatch(/<h[23]>\s*Sign-in providers\s*<\/h[23]>/u);
    const start = page.indexOf('id="providers-card"');
    const head = page.slice(start, start + 600);
    expect(head).toMatch(/class="cardhead"\s*>\s*<h[23]>\s*Sign-in providers\s*<\/h[23]>\s*<\/div>/u);
  });

  it("sits under People, beside Public contact", () => {
    const providers = page.indexOf('id="providers-card"');
    const contact = page.indexOf("<h2>Public contact</h2>");
    expect(providers).toBeGreaterThan(-1);
    expect(contact).toBeGreaterThan(-1);
    expect(Math.abs(providers - contact)).toBeLessThan(6000);
  });

  it("reads the preview from /api/admin/provider-links", () => {
    expect(all).toMatch(/["'`]\/api\/admin\/provider-links["'`]/u);
  });

  it("is absent when nothing is removable (no empty card)", () => {
    const start = page.indexOf('id="providers-card"');
    expect(start).toBeGreaterThan(-1);
    // the card's own opening tag sits directly inside a condition on there
    // being a removable row: not any neighbouring {#if}, not a negated one
    const before = page.slice(Math.max(0, start - 400), start);
    expect(before).toMatch(/\{#if\s+providerRows\(\s*providers\s*\)\.length(?:\s*>\s*0)?\s*\}\s*<(?:div|section)\b[^<>{}]*$/u);
  });

  it("lists only providers that are off with links left: a configured provider has no row", () => {
    expect(flat).toMatch(/!\s*[\w.]+\.configured\b/u);
    expect(flat).not.toMatch(/still the configured provider/u);
  });

  it("draws each removable provider as a .kv row: host, '<b>off</b> · N linked · K without a password', then the act", () => {
    const start = page.indexOf('id="providers-card"');
    const window = page.slice(start, start + 8000).replace(/\s+/gu, " ");
    expect(`${window} ${flat}`).toMatch(/class="kv"/u);
    expect(flat).toMatch(/<b>off<\/b> (?:·|&middot;) \{[^}]+\} linked (?:·|&middot;) \{[^}]+\} without a password/u);
    expect(flat).toMatch(/<button[^>]*>\s*remove links(…|&hellip;)\s*<\/button>/u);
  });

  it("offers no head count, state pill, subtext of names or foot line", () => {
    expect(flat).not.toMatch(/\bproviders? (?:·|&middot;) \{[^}]+\} links?\b/u);
    expect(flat).not.toMatch(/CONFIGURED|NO LINKS/u);
    expect(flat).not.toMatch(/remove every link/u);
  });

  it("shows another administrator a quiet line naming the primary administrator, as a note and not a button", () => {
    expect(flat).toMatch(/<span class="note">\s*only the primary administrator, \{[^}]+\}, can do this\s*<\/span>/u);
  });

  it("shows a primary administrator with no password a link to Settings → Sign-in methods", () => {
    expect(flat).toMatch(
      /<span class="note">\s*<a href="\/settings#sign-in-methods">set a password in Settings first<\/a>\s*<\/span>/u,
    );
  });

  it("opens the confirm as the page's mailboxform: the note, 'your password', the two-tap red button, cancel", () => {
    expect(flat).toMatch(/class="mailboxform"/u);
    expect(flat).toMatch(/class="mailboxnote"/u);
    expect(flat).toMatch(/\{[^}]+\} (?:have|has) no password, so each is mailed a setup link good for \{?[^}\s]+\}? days\./u);
    expect(flat).toMatch(new RegExp(`You signed in through it today, so you${tick}ll be signed out too\\.`, "u"));
    expect(flat).toMatch(/your password/u);
    expect(flat).toMatch(/type="password"/u);
    expect(flat).toMatch(/autocomplete="current-password"/u);
    expect(flat).toMatch(/class="placerow mailboxrow"/u);
    expect(flat).toMatch(/dangerbtn/u);
    expect(flat).toMatch(/remove \{[^}]+\} links/u);
    expect(flat).toMatch(/tap again to remove \{[^}]+\} links/u);
    expect(flat).toMatch(/<button[^>]*>\s*cancel\s*<\/button>/u);
  });

  it("asks for no days and no typed host: the confirm's one field is the password", () => {
    const start = page.indexOf('id="providers-card"');
    const contact = page.indexOf("<h2>Public contact</h2>", start);
    const end = contact > start ? contact : start + 8000;
    const inputs = [...page.slice(start, end).matchAll(/<input\b[^>]*>/gu)].map((m) => m[0]);
    expect(inputs.length).toBeLessThanOrEqual(1);
    for (const input of inputs) expect(input).toMatch(/type="password"/u);
    // The card's own label only: other cards on the page rightly say "your current password".
    expect(page.slice(start, end)).not.toMatch(/your current password/u);
    expect(flat).not.toMatch(/type the host|type the provider|retype the host/u);
  });

  it("posts the issuer, mailStranded and the password to /api/admin/provider-links/remove", () => {
    expect(all).toMatch(/\/api\/admin\/provider-links\/remove/u);
    expect(all).toMatch(/mailStranded:\s*true/u);
    expect(all).toMatch(/currentPassword/u);
    expect(all).toMatch(/\bissuer\b/u);
  });

  it("refuses with one problem line and opens nothing when outgoing mail isn't set up", () => {
    expect(flat).toMatch(
      new RegExp(
        `not started (?:—|&mdash;) outgoing mail isn${tick}t set up, and .{0,40}need a setup link\\. Set it up under .{0,80}Mail<.{0,20} first\\.`,
        "u",
      ),
    );
  });

  it("gives the result in the row's own words: 'removed · N links · <time>' in the .on style", () => {
    expect(flat).toMatch(/<b class="on">removed<\/b> (?:·|&middot;) \{[^}]+\} links? (?:·|&middot;) /u);
  });

  it("reports the mailing with People's green line, and lists only people not mailed, each with 'send again'", () => {
    expect(flat).toMatch(/Setup links? sent to/u);
    expect(flat).toMatch(/Setup link sent to \{[^}]+\} of \{[^}]+\} people, valid until/u);
    expect(flat).toMatch(/class="adminproblem ok"/u);
    expect(flat).toMatch(/class="adminproblem"/u);
    expect(flat).toMatch(/not sent (?:—|&mdash;) /u);
    expect(flat).toMatch(/class="retry"[^>]*>\s*send again\s*<\/button>/u);
  });

  it("carries none of round 2's result block", () => {
    for (const gone of [
      /Setup links? mailed to/u,
      /people with no other way in/u,
      /have a password and needed nothing/u,
      /<h4>not mailed<\/h4>/u,
      /nothing to send/u,
    ]) {
      expect(flat).not.toMatch(gone);
    }
  });

  it("has no button in the card that does nothing when pressed", () => {
    const start = page.indexOf('id="providers-card"');
    const window = page.slice(start, start + 6000);
    const inCard = [...window.matchAll(/<button\b([^>]*)>/gu)].map((m) => m[1]);
    expect(inCard.length).toBeGreaterThan(0);
    for (const attributes of inCard) {
      expect(attributes, `inert button in the providers card: ${attributes}`).toMatch(/\bonclick=|type="submit"/u);
    }
  });
});
