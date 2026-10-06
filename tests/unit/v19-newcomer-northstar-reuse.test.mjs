import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-Q1: Newcomer's "create" button inlined its own <svg><g
 * class="glint"> with the identical circle/path/circle markup as
 * NorthStarMark.svelte's classic glint, instead of rendering
 * <NorthStarMark/> the way home/+page.svelte and pocket/NorthStar.svelte
 * both already do. Two consequences: a future edit to the glint, or to the
 * retrograde/clouds theme variants NorthStarMark also carries, silently
 * missed this one button; and the retrograde/clouds packs already show the
 * plain classic glint here while every other north-star handle in the app
 * switches form.
 */

const NEWCOMER = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/arrival/Newcomer.svelte"),
  "utf8",
);

describe("#1151 W1-Q1: Newcomer's create button reuses NorthStarMark", () => {
  it("imports the shared component", () => {
    expect(NEWCOMER).toMatch(/import NorthStarMark from "\$lib\/NorthStarMark\.svelte";/u);
  });

  it("the nstar button renders it, same shape as home/+page.svelte and pocket/NorthStar.svelte", () => {
    expect(NEWCOMER).toMatch(/<button class="nstar" type="button" onclick=\{openDrawer\}>\s*\n\s*<NorthStarMark \/>\s*\n\s*<span>create<\/span>/u);
  });

  it("no longer inlines the glint's own path data", () => {
    expect(NEWCOMER).not.toContain("M 0 -12 L 1.7 -1.7 L 12 0 L 1.7 1.7 L 0 12 L -1.7 1.7 L -12 0 L -1.7 -1.7 Z");
  });
});
