import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import * as belt from "../../web/src/lib/data/belt.js";
import { THEME_TABLE } from "../../web/src/lib/theme.js";

/*
 * #1403 D2: dead web and lib code, pinned ABSENT by file and export name.
 * Each pin names the exact thing so it cannot match an ADR or a doc. What
 * stays is pinned too, so the removal cannot over-reach.
 */

const root = resolve(import.meta.dirname, "../..");
const has = (path) => existsSync(resolve(root, path));
const read = (path) => readFileSync(resolve(root, path), "utf8");

describe("src/lib modules with no caller are gone", () => {
  it.each([
    "src/lib/dial-geometry.ts",
    "src/lib/dial-geometry.test.ts",
    "src/lib/notifications.ts",
    "src/lib/notifications.test.ts",
    "src/lib/maintenance-view.ts",
    "src/lib/maintenance-view.test.ts",
  ])("%s does not exist", (path) => {
    expect(has(path)).toBe(false);
  });

  it("the live maintenance-view (the server-side one the maintenance screen reads) stays", () => {
    expect(has("web/src/lib/server/maintenance-view.js")).toBe(true);
  });
});

describe("belt.js keeps only what home's drawer and the review sheets read", () => {
  it.each(["documentRowOf", "documentPreviewStateOf", "suggestionPapersOf", "plateOfName", "kindOf"])(
    "still exports %s",
    (name) => {
      expect(typeof belt[name]).toBe("function");
    },
  );

  it.each(["beltManifestOf", "suggestionRowOf", "whenOf", "BELT_BAND"])("no longer exports %s", (name) => {
    expect(belt).not.toHaveProperty(name);
  });

  it("workspace.js no longer exports readBelt", () => {
    const source = read("web/src/lib/data/workspace.js");
    expect(source).not.toMatch(/export\s+(?:async\s+)?function\s+readBelt\b/u);
    expect(source).not.toMatch(/export\s+const\s+readBelt\b/u);
  });

  it("the readBelt-only suggestion test file is gone", () => {
    expect(has("tests/unit/workspace-belt-suggestion.test.js")).toBe(false);
  });
});

describe("the tour's stops.js and emphasis.js are gone", () => {
  it.each(["web/src/lib/tour/stops.js", "web/src/lib/tour/emphasis.js"])("%s does not exist", (path) => {
    expect(has(path)).toBe(false);
  });

  it.each(["tests/unit/v19-tour-emphasis.test.mjs", "tests/unit/v19-tour-stops.test.mjs"])(
    "its own test %s does not exist",
    (path) => {
      expect(has(path)).toBe(false);
    },
  );

  it("the five chapter tests no longer import stops.js", () => {
    for (const name of ["arrive", "add", "below-the-dial", "other-households", "paper-by-post"]) {
      expect(read(`tests/unit/v19-tour-chapter-${name}.test.mjs`)).not.toMatch(/tour\/stops\.js|TOUR_STOPS/u);
    }
  });

  it("no theme roster row carries an `emphasis` field", () => {
    expect(THEME_TABLE.length).toBeGreaterThan(0);
    for (const row of THEME_TABLE) expect(row, row.id).not.toHaveProperty("emphasis");
  });
});

describe("the old single-slot held-completion stash shape is not read (two copies)", () => {
  it("lib/data/held-completion.js: no `parsed.command` single-slot arm and no todaysShape rewrite", () => {
    const source = read("web/src/lib/data/held-completion.js");
    expect(source).not.toMatch(/parsed\.command/u);
    expect(source).not.toMatch(/todaysShape/u);
  });

  it("home/pocket.svelte: its stash reader has no `parsed.command` single-slot arm", () => {
    expect(read("web/src/routes/home/pocket.svelte")).not.toMatch(/parsed\.command/u);
  });
});
