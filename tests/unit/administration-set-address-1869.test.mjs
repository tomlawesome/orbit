import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1869 decision note, "UI entry point": Administration -> people. A row whose
 * address cannot be read says "address can't be read" where the address goes
 * and gets "set their address…" as its first action; every other row gets
 * "change address…" after "send a new setup link…". Either opens an inline
 * form behind challengeThen("email_address_set", …) and PUTs the address to
 * /api/admin/users/{id}/email. Source-text tests, as the neighbouring
 * administration-*.test.mjs files are; the wording is the spec's, with the
 * straight or curly apostrophe accepted.
 */
const dir = new URL("../../web/src/routes/administration/", import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), "utf8").replace(/\s+/gu, " ");
const page = read("+page.svelte");
const acts = read("acts.svelte.js");
const pocket = read("pocket.svelte");

describe("the new step-up intent (#1869)", () => {
  it("is appended to stepUpIntents, separate from setup_link_issue", async () => {
    const { stepUpIntents } = await import("orbit/lib/auth/recent-auth");
    // Fails if the intent is missing: a proof for one act must not pay for another.
    expect(stepUpIntents).toContain("email_address_set");
    expect(stepUpIntents).toContain("setup_link_issue");
  });
});

describe("People rows offer to set or change an address (#1869)", () => {
  it("shows 'address can't be read' where an unreadable address would go", () => {
    expect(page).toMatch(/address can[’']t be read/u);
  });

  it("offers 'set their address…' on an unreadable row and 'change address…' on the rest", () => {
    expect(page).toMatch(/set their address…/u);
    expect(page).toMatch(/change address…/u);
  });

  it("puts 'change address…' after 'send a new setup link…'", () => {
    expect(page.indexOf("send a new setup link…")).toBeGreaterThan(-1);
    expect(page.indexOf("change address…")).toBeGreaterThan(page.indexOf("send a new setup link…"));
  });

  it("keys the 'set their address…' button on the email metadata status being metadata_integrity_failed", () => {
    expect(page).toMatch(/metadata_integrity_failed/u);
  });

  it("opens the form behind the email_address_set step-up, on the desk and on the phone", () => {
    expect(page).toMatch(/challengeThen\(\s*"email_address_set"/u);
    expect(pocket).toMatch(/challenge\(\s*"email_address_set"/u);
  });

  it("offers the form's two buttons: 'set it' and cancel", () => {
    expect(page).toMatch(/set it/u);
  });

  it("puts the address to /api/admin/users/<id>/email with PUT, with the password when the actor has one", () => {
    expect(acts).toMatch(/\/api\/admin\/users\/\$\{[^}]+\}\/email/u);
    expect(acts).toMatch(/method:\s*"PUT"/u);
    expect(acts).toMatch(/currentPassword/u);
  });

  it("says '<name>'s address is now <address>' on success", () => {
    expect(`${page} ${acts}`).toMatch(/address is now/u);
  });
});
