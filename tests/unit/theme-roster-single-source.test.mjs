import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1331: source-reading tripwires. The roster lives in web/src/lib/theme.js;
 * the readers of it import it rather than keeping their own copy, and two
 * stray copies the issue found (a second dark set in the preferences route,
 * and a near-miss copy of the star-chart ground on the home desk) stay gone.
 */

const WEB_SRC = resolve(import.meta.dirname, "../../web/src");
const PACK_IDS = ["starchart", "afterdark", "clouds", "dawn", "retrograde"];

/** @param {string} dir @returns {string[]} */
function filesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      found.push(...filesUnder(path));
    } else {
      found.push(path);
    }
  }
  return found;
}

const files = filesUnder(WEB_SRC);

/** @param {string} source */
function packLiteralsIn(source) {
  const named = new Set();
  for (const id of PACK_IDS) {
    if (new RegExp(`["'\`]${id}["'\`]`).test(source)) named.add(id);
  }
  return [...named];
}

describe("stray copies stay gone (#1331)", () => {
  it("finds files to check at all", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no file under web/src/ holds #070d1f", () => {
    const hits = files.filter((p) => /#070d1f/i.test(readFileSync(p, "utf8")));
    expect(hits.map((p) => p.slice(WEB_SRC.length + 1))).toEqual([]);
  });

  it("no file under web/src/ keeps a DARK_PACKS set", () => {
    const hits = files.filter((p) => readFileSync(p, "utf8").includes("DARK_PACKS"));
    expect(hits.map((p) => p.slice(WEB_SRC.length + 1))).toEqual([]);
  });
});

describe("the roster's readers import theme.js and spell out no roster (#1331)", () => {
  const readers = [
    "lib/theme-swatches.js",
    "routes/settings/helm.js",
    "lib/tour/emphasis.js",
    "lib/sun/furnace.js",
    "routes/home/skies.js",
  ];

  for (const rel of readers) {
    const source = readFileSync(resolve(WEB_SRC, rel), "utf8");

    it(`${rel} imports from theme.js`, () => {
      expect(source).toMatch(/from\s+["'][^"']*\/theme\.js["']/);
    });

    it(`${rel} spells out at most one pack id as a string literal`, () => {
      expect(packLiteralsIn(source).length, `${rel} names several packs`).toBeLessThanOrEqual(1);
    });
  }
});
