import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-Q7: +error.svelte hand-duplicated six filters/gradients as
 * F_B6/F_B1/F_B3/G_DOPPLER/G_DOPPLER_SOFT/G_STREAMG string constants, byte
 * identical to the live <defs> block a few hundred lines further down —
 * the one a designer would actually edit. Nothing kept the two in sync.
 *
 * The fix captures the live <defs> element's own innerHTML at build time
 * (the same outerHTML-capture idiom already used for srcLensarcs and the
 * other live sources) and passes that one captured string to every raster
 * job, instead of hand-picked combinations of the six dead constants. An
 * SVG filter/gradient a given job's cropped document never references
 * simply goes unused — harmless.
 */

const ERROR_PAGE = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/+error.svelte"),
  "utf8",
);

describe("#1151 W1-Q7: the rasteriser reads the live <defs>, not a hand-synced copy", () => {
  it("binds the live <defs> element", () => {
    expect(ERROR_PAGE).toMatch(/<defs bind:this=\{liveDefs\}>/u);
    expect(ERROR_PAGE).toMatch(/let liveDefs;/u);
  });

  it("build() requires liveDefs before doing anything, same as the other live sources", () => {
    expect(ERROR_PAGE).toMatch(/if \(!world \|\| !srcLensarcs \|\| !srcLensedArch \|\| !srcPhoton \|\| !srcSmearNear \|\| !srcSmearTidal \|\| !liveDefs\) return;/u);
  });

  it("captures defsHTML from liveDefs.innerHTML and every job uses it", () => {
    expect(ERROR_PAGE).toMatch(/const defsHTML = liveDefs\.innerHTML;/u);
    const matches = [...ERROR_PAGE.matchAll(/`notfound-[a-z-]+\$\{k\}`, [^,]+, defsHTML,/gu)];
    expect(matches.length).toBe(6);
  });

  it("the six hand-duplicated filter/gradient string constants are gone", () => {
    for (const name of ["F_B6", "F_B1", "F_B3", "G_DOPPLER", "G_DOPPLER_SOFT", "G_STREAMG"]) {
      expect(ERROR_PAGE).not.toContain(`const ${name}`);
    }
  });
});
