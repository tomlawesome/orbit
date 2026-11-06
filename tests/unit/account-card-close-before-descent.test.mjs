import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #1689: the account card is one component on two hosts, and on both the host
 * closes it as the sign-out goes ahead, before the descent begins -- never left
 * standing over the flight (#1262), and never open while the page disperses
 * (the dispersing rule and the card's open rule must not meet). Read from the
 * sources, as sign-out-one-click.test.mjs does.
 */
const read = (/** @type {string} */ file) => readFileSync(resolve(import.meta.dirname, "../../web/src", file), "utf8");

/** The callback handed to createSignOut( ... ), up to its closing "});". @param {string} source */
function signOutCallback(source) {
  const from = source.indexOf("createSignOut(");
  expect(from).toBeGreaterThan(-1);
  return source.slice(from, source.indexOf("\n  });", from));
}

describe("the card is closed before the descent", () => {
  it("Chrome closes it, then descends", () => {
    const body = signOutCallback(read("lib/Chrome.svelte"));
    const closed = body.search(/\bopen = false;/u);
    const descent = body.search(/await descendFrom\(/u);
    expect(closed).toBeGreaterThan(-1);
    expect(descent).toBeGreaterThan(closed);
  });

  it("home closes it, then descends", () => {
    const body = signOutCallback(read("routes/home/+page.svelte"));
    const closed = body.search(/\bcloseAccount\(\);/u);
    const descent = body.search(/await leave\?\.descendFrom\(/u);
    expect(closed).toBeGreaterThan(-1);
    expect(descent).toBeGreaterThan(closed);
    expect(read("routes/home/+page.svelte")).toMatch(/function closeAccount\(\) \{\s*accountOpen = false;/u);
  });

  it("home.css's light-pack card gloss names the card under .desk only, so it never reaches Chrome's", () => {
    const css = read("routes/home/home.css");
    for (const line of css.split("\n").filter((l) => /^\[data-theme=(dawn|clouds)\] :is\(/u.test(l) && /\.account\b/u.test(l))) {
      expect(line).toMatch(/\.desk \.account\b/u);
    }
  });
});
