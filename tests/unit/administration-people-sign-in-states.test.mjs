import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1676 round 3 (design/v19/provider-removal/round-3/README.md, "The People
 * rows gain no sign-in state"): round 2's scene 7 put a sign-in state on every
 * People row (password set, setup link sent · good until, link lapsed · no way
 * in) and a "removed today" suffix on the removed provider. Round 3 drops all
 * of it; the result reports the one-off event and People's own "send a new
 * setup link…" remains the way to anyone still without a password. This file
 * replaces the round 2 test of the same name and pins those words absent, on
 * the desk and the phone. Source text.
 */
const dir = new URL("../../web/src/routes/administration/", import.meta.url);
const files = ["+page.svelte", "pocket.svelte", "words.js", "acts.svelte.js", "providers.js"];
const sources = Object.fromEntries(files.map((name) => [name, readFileSync(new URL(name, dir), "utf8").replace(/\s+/gu, " ")]));

describe("People rows carry no sign-in state (#1676 round 3)", () => {
  it.each([
    ["password set", /password set\b/u],
    ["setup link sent · good until <date>", /setup link sent (?:·|&middot;) good until/u],
    ["link lapsed <date> · no way in", /link lapsed .{0,40}(?:·|&middot;) no way in/u],
    ["no links · removed today at <time>", /no links (?:·|&middot;) removed today at/u],
    ["N setup link(s) still to send: names", /setup links? still to send:/u],
    ["the per-person state from the answer", /\bsignIn(?:Words)?\b/u],
  ])("says nothing like '%s'", (_label, pattern) => {
    for (const [name, text] of Object.entries(sources)) expect(text, name).not.toMatch(pattern);
  });

  it("does not read people or removed from the provider-links answer", () => {
    for (const [name, text] of Object.entries(sources)) {
      expect(text, name).not.toMatch(/links\.people\b|\.removed\b/u);
    }
  });
});
