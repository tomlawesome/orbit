import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1633 design note, "The confirmation": giving or removing administrator
 * access is challenged like the setup link, under its own step-up intent, and
 * PUT /api/admin/users checks the actor's recent authentication before it
 * calls setInstanceAdministrator. Source-text tests, as
 * administration-set-address-1869.test.mjs is; the route's behaviour against
 * a real database is tests/integration/admin-set-administrator-1633.test.ts.
 */
const flat = (/** @type {string} */ text) => text.replace(/\s+/gu, " ");
const web = (/** @type {string} */ path) => flat(readFileSync(new URL(`../../web/${path}`, import.meta.url), "utf8"));
const route = web("src/routes/api/admin/users/+server.js");
const page = web("src/routes/administration/+page.svelte");
const pocket = web("src/routes/administration/pocket.svelte");

describe("the administrator_set step-up intent (#1633)", () => {
  it("is in stepUpIntents, beside setup_link_issue and not instead of it", async () => {
    const { stepUpIntents } = await import("orbit/lib/auth/recent-auth");
    // Fails while the intent is missing: a proof for the setup link must not pay for an elevation.
    expect(stepUpIntents).toContain("administrator_set");
    expect(stepUpIntents).toContain("setup_link_issue");
    /* The first import of the server module is slow on a loaded host. */
  }, 120_000);
});

describe("PUT /api/admin/users asks for recent authentication (#1633)", () => {
  it("accepts the actor's currentPassword in the administrator update", () => {
    const schema = /const administratorUpdateSchema = z\.object\(\{([^}]*)\}\)/u.exec(route)?.[1] ?? "";
    expect(schema, "administratorUpdateSchema is where it was").toMatch(/administrator: z\.boolean\(\)/u);
    expect(schema).toMatch(/currentPassword: z\.string\(\)\.optional\(\)/u);
  });

  it("checks administrator_set recent authentication before it changes anyone's access", () => {
    const put = /export const PUT = write\(async \(event, session\) => \{(.*?)\n?\}\);/u.exec(route)?.[1] ?? "";
    expect(put, "the PUT handler is where it was").toMatch(/setInstanceAdministrator\(/u);
    const check = put.search(/await requireRecentAuthentication\(event, session, \w+, "administrator_set"\)/u);
    expect(check, "the PUT calls requireRecentAuthentication with administrator_set").toBeGreaterThan(-1);
    expect(check).toBeLessThan(put.indexOf("setInstanceAdministrator("));
  });
});

describe("the People card challenges before the band opens (#1633)", () => {
  it("opens the band behind the administrator_set step-up on the desk and on the phone", () => {
    expect(page).toMatch(/challengeThen\(\s*"administrator_set"/u);
    expect(pocket).toMatch(/challenge\(\s*"administrator_set"/u);
  });
});
