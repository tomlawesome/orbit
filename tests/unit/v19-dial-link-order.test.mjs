import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1460: bodies are painted largest first so a small one never hides under a
 * big neighbour, but that is paint order only. The desk's links are the tab
 * stops and the screen-reader order, and must stay in chart.js's order
 * (soonest due first). The visible circles are a separate, aria-hidden group.
 */
const PAGE = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/home/+page.svelte"),
  "utf8",
);

/** The `{#each ...}` header of the block that renders each tag. */
const eachBefore = (/** @type {string} */ marker) => {
  const at = PAGE.indexOf(marker);
  expect(at, `${marker} is rendered`).toBeGreaterThan(-1);
  const head = PAGE.lastIndexOf("{#each ", at);
  return PAGE.slice(head, PAGE.indexOf("}", head) + 1);
};

describe("#1460: the desk dial's link order follows the chart, not size", () => {
  it("renders the links from bodies in chart order", () => {
    expect(eachBefore('<a class="body-link"')).toMatch(/\{#each bodies as b \(b\.id\)\}/u);
  });
  it("paints the visible bodies largest first, hidden from assistive tech", () => {
    expect(eachBefore('class="body-vis"')).toMatch(/\.sort\(\(a, b\) => b\.size - a\.size\)/u);
    expect(PAGE).toMatch(/<g class="body-vis"[^>]*aria-hidden="true"/u);
  });
  it("never sorts the links", () => {
    for (const m of PAGE.matchAll(/\{#each [^}]*sort[^}]*\}[\s\S]{0,200}/gu)) {
      expect(m[0]).not.toContain('<a class="body-link"');
    }
  });
});
