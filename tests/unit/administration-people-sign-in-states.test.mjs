import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1676 scene 7 ("people afterwards") of the ratified mock-up
 * (design/v19/provider-removal/round-2/s-the-providers-card.html): People
 * rows end in each person's sign-in state, and the removed provider's row
 * reads on. Words are the mock-up's, exactly. Source text, as
 * administration-providers-card.test.mjs; page.svelte and the modules beside
 * it are read together. The wire is pinned in
 * tests/integration/provider-link-people-states.test.ts (people[].signIn,
 * removed[]).
 */
const dir = new URL("../../web/src/routes/administration/", import.meta.url);
const all = ["+page.svelte", "words.js", "acts.svelte.js"]
  .map((name) => readFileSync(new URL(name, dir), "utf8"))
  .join("\n")
  .replace(/\s+/gu, " ");

describe("People sign-in states on the desk (#1676 scene 7)", () => {
  it("reads the per-person state from the provider-links answer", () => {
    expect(all).toMatch(/signIn/u);
    expect(all).toMatch(/\.removed\b/u);
  });

  it.each([
    ["password set", /password set/u],
    ["setup link sent · good until <date>", /setup link sent (·|&middot;) good until/u],
    ["link lapsed <date> · no way in", /link lapsed .{0,40}(·|&middot;) no way in/u],
    ["removed provider: no links · removed today at <time>", /no links (·|&middot;) removed today at/u],
    ["removed provider: N setup link(s) still to send: names", /setup links? still to send:/u],
  ])("says '%s'", (_label, pattern) => {
    expect(all).toMatch(pattern);
  });

  it("distinguishes the three live states by the answer's state names", () => {
    for (const state of ["password", "setup-link", "lapsed"]) expect(all).toContain(`"${state}"`);
  });
});
