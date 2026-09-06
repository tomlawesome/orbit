import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_THEME, THEME_PACKS, themeOrDefault } from "../../web/src/lib/theme.js";

/*
 * #865: atlas left the visible roster at #480 but its tokens and its place in
 * four hand-written copies of the roster stayed, and two of those four
 * disagreed about the default (`starchart` vs `afterdark`). web/src/lib/
 * theme.js is now the one list and the one default; Chrome.svelte,
 * settings/+page.svelte and tour/emphasis.js all import it directly.
 *
 * app.html's pre-paint script is the one reader that cannot import it — it
 * runs synchronously before first paint, and any import would be the flash
 * it exists to prevent — so it keeps a literal copy instead. This file reads
 * that copy straight out of the raw HTML, the same way
 * tests/unit/v19-pack-contrast.test.mjs reads packs.css straight out of its
 * raw file rather than importing it, and asserts the two agree: a change to
 * one without the other fails here rather than shipping a sixth theme that
 * only half the product knows about.
 */

const APP_HTML = readFileSync(resolve(import.meta.dirname, "../../web/src/app.html"), "utf8");

describe("the theme roster, from one source (#865)", () => {
  it("no longer lists atlas", () => {
    expect(THEME_PACKS).not.toContain("atlas");
  });

  it("defaults to after dark", () => {
    expect(DEFAULT_THEME).toBe("afterdark");
  });

  it("app.html's pre-paint script names exactly this roster", () => {
    const match = /localStorage\.getItem\("orbit-theme"\);\s*\n\s*if \(t && \[([^\]]+)\]/.exec(APP_HTML);
    expect(match, "app.html's pre-paint script roster array").toBeTruthy();
    const roster = match[1].split(",").map((entry) => entry.trim().replace(/^"|"$/g, ""));
    expect(roster).toEqual(THEME_PACKS);
  });

  it("app.html's <html> starts on the same default the roster names", () => {
    const match = /<html lang="en" data-theme="([\w-]+)">/.exec(APP_HTML);
    expect(match, "app.html's <html data-theme>").toBeTruthy();
    expect(match[1]).toBe(DEFAULT_THEME);
  });
});

describe("themeOrDefault (#865)", () => {
  it("honours a preference that is still on the roster", () => {
    for (const theme of THEME_PACKS) expect(themeOrDefault(theme)).toBe(theme);
  });

  it("resolves a removed theme (atlas) to after dark", () => {
    expect(themeOrDefault("atlas")).toBe(DEFAULT_THEME);
  });

  it("resolves a string that was never a theme to after dark", () => {
    expect(themeOrDefault("not-a-real-pack")).toBe(DEFAULT_THEME);
  });

  it("resolves nothing stored at all to after dark", () => {
    expect(themeOrDefault(null)).toBe(DEFAULT_THEME);
    expect(themeOrDefault(undefined)).toBe(DEFAULT_THEME);
  });
});
