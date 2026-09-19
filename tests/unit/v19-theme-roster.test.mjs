import { readdirSync, readFileSync } from "node:fs";
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

/*
 * #1047: the residue #865 left behind. atlas was renamed to clouds before that
 * pack shipped, and a `[data-theme=atlas]` selector matches nothing rather
 * than failing, so seven route stylesheets kept rules that silently did not
 * apply — six of them losing the clouds pack its light treatment entirely.
 * That survived #865, #1045 and a full v19 rebuild unnoticed, because nothing
 * ever compared the selectors against the roster.
 *
 * So this walks every stylesheet and component under web/src/ and asserts that
 * every pack a `[data-theme=...]` selector names is one theme.js declares. The
 * next rename leaves no silent residue: it fails here instead.
 */

const WEB_SRC = resolve(import.meta.dirname, "../../web/src");

/** @param {string} dir @returns {string[]} */
function styleSourcesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      found.push(...styleSourcesUnder(path));
    } else if (entry.name.endsWith(".css") || entry.name.endsWith(".svelte")) {
      found.push(path);
    }
  }
  return found;
}

/* The attribute-selector form only. app.html's `<html data-theme="afterdark">`
   is a real attribute on real markup, not a selector, and is covered above. */
const THEME_SELECTOR = /\[data-theme=["']?([\w-]+)["']?\]/g;


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

describe("every [data-theme=...] selector names a pack that exists (#1047)", () => {
  const sources = styleSourcesUnder(WEB_SRC);

  it("finds stylesheets to check at all", () => {
    /* guards the walk itself: a broken path would otherwise pass vacuously */
    expect(sources.length).toBeGreaterThan(20);
  });

  it("names no pack the roster does not declare", () => {
    /** @type {string[]} */
    const strays = [];
    for (const path of sources) {
      const source = readFileSync(path, "utf8");
      for (const [, pack] of source.matchAll(THEME_SELECTOR)) {
        if (!THEME_PACKS.includes(pack)) {
          strays.push(`${path.slice(WEB_SRC.length + 1)}: [data-theme=${pack}]`);
        }
      }
    }
    expect(strays, "selectors naming a pack theme.js does not declare").toEqual([]);
  });
});
