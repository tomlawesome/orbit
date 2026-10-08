import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * The item route renders in the browser only (+page.js `ssr = false`), so
 * the body is drawn before .belt-page exists. #1249 scoped belt.css's body
 * rule to html:has(.belt-page), background and its .4s transition with it:
 * the body was first drawn with no background (white), and when the belt
 * arrived the background faded to the night over .4s. The axe sweep on
 * mobile WebKit measured the item card's quiet text against that grey (CI
 * pipeline 2251, 4.29:1 and 4.24:1; locally 3.73:1, #1320), and every
 * reader saw a white flash fade in.
 *
 * The night must be the body's from its first style, as every other route's
 * sheet has it (inbox.css, settings.css, household.css: a bare `html body`);
 * only the belt's stage rules (height, overflow) stay scoped to the page.
 */

const BELT_CSS = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/item/[[id]]/belt.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** Every declaration block whose selector list is exactly `selector`. */
function blocksOf(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...BELT_CSS.matchAll(new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]);
}

describe("the belt's body is night from its first style", () => {
  it("sets the background and ink on a bare html body, not behind :has(.belt-page)", () => {
    const bare = blocksOf("html body").join(";");
    expect(bare).toMatch(/background:\s*var\(--bg\)/);
    expect(bare).toMatch(/(^|[;{\s])color:\s*var\(--ink\)/);
  });

  it("leaves no background or ink to the scoped rule, where they would fade in as the belt arrives", () => {
    for (const block of blocksOf("html:has(.belt-page) body")) {
      expect(block).not.toMatch(/background\s*:/);
      expect(block).not.toMatch(/(^|[;{\s])color\s*:/);
    }
  });

  it("keeps #1249's scroll lock on the belt page only", () => {
    const bare = blocksOf("html body").join(";");
    expect(bare).not.toMatch(/overflow\s*:/);
    expect(blocksOf("html:has(.belt-page) body").join(";")).toMatch(/overflow:\s*hidden/);
  });
});
