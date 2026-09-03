import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * #764: b1 and b3 in +error.svelte carried no filter region at all, so
 * WebKit fell back to the default -10% -10% 120% 120% of each user's OWN
 * bounding box and software-rasterised the lot on every repaint — the same
 * bug #498 fixed on login. Once fixed here, the only thing stopping it
 * coming back on the next edit is this test: every <filter> in the file
 * must declare its own x/y/width/height, whether as an absolute
 * (userSpaceOnUse) region or a percentage one — either is fine, "nothing
 * declared" is the bug.
 */
const SOURCE_PATH = "web/src/routes/+error.svelte";
const source = readFileSync(new URL(`../../${SOURCE_PATH}`, import.meta.url), "utf8");

// Matches each <filter ...> opening tag (self-closing content follows, but
// the region attributes live on this tag), non-greedy up to the first '>'.
const filterTags = [...source.matchAll(/<filter\b[^>]*>/g)].map((m) => m[0]);

describe("+error.svelte's filter graph", () => {
  it("has at least the filters this test knows about", () => {
    // A sanity floor so a future rewrite that deletes all the filters
    // doesn't make this suite vacuously pass.
    expect(filterTags.length).toBeGreaterThanOrEqual(5);
  });

  it("declares an explicit region on every filter — never the default", () => {
    for (const tag of filterTags) {
      const idMatch = tag.match(/\bid="([^"]+)"/);
      const id = idMatch ? idMatch[1] : tag;
      for (const attr of ["x", "y", "width", "height"]) {
        expect(tag, `${SOURCE_PATH} filter #${id} missing ${attr}=`).toMatch(
          new RegExp(`\\b${attr}="[^"]+"`),
        );
      }
    }
  });
});
