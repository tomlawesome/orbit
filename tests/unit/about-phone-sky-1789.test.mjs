// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";
import { ABOUT_FIXTURE } from "../../web/src/lib/data/fixtures/about.js";

/*
 * #1789 W-F6 / W-F9, owner ruling "own phone sky" (lows-g2-rulings.md): About
 * on a phone is the one pocket page on a flat colour, because the desk sky
 * (PageSky) hides under the pocket query and About mounts nothing else. The
 * ruling: About mounts the pocket kit's own sky ($lib/pocket/Sky.svelte,
 * `.p-sky`), first in its markup, inside a wrapper drawn only under the pocket
 * query (display:none on the desk), grain off; PageSky stays for the desk.
 *
 * A unit test has no layout, so "drawn only under the pocket query" is read
 * from the stylesheet the page ships: the wrapper is hidden by default and
 * shown inside `(max-width:839.98px), (max-height:479.98px)`.
 */

const PAGE = "routes/about/+page.svelte";
const POCKET_QUERY = "@media (max-width:839.98px), (max-height:479.98px)";
const page = createPageLoader("about-phone-sky-1789", { stub: (file) => /\/Chrome\.svelte$/.test(file) });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ about: ABOUT_FIXTURE }), { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(() => { page.unmount(); vi.unstubAllGlobals(); });
afterAll(() => page.teardown());

async function open() {
  const { flushSync } = await page.mount(PAGE, { data: { libraries: null, releaseNotes: null } }, { url: "http://localhost/about" });
  await settle();
  flushSync();
}

/** The page's own rules: about.css and the component's <style>, if any. */
const stylesheet = () => {
  const read = (/** @type {string} */ path) => readFileSync(new URL(`../../web/src/routes/about/${path}`, import.meta.url), "utf8");
  const svelte = read("+page.svelte");
  return `${read("about.css")}\n${/<style[^>]*>([\s\S]*?)<\/style>/.exec(svelte)?.[1] ?? ""}`;
};

/** Splits the pocket media block out of the sheet. @param {string} css */
function splitPocket(css) {
  const start = css.indexOf(POCKET_QUERY);
  if (start < 0) return { base: css, pocket: "" };
  const open = css.indexOf("{", start);
  let depth = 1;
  let end = open + 1;
  while (end < css.length && depth > 0) { depth += css[end] === "{" ? 1 : css[end] === "}" ? -1 : 0; end += 1; }
  return { base: css.slice(0, start) + css.slice(end), pocket: css.slice(open + 1, end - 1) };
}

/** Every declaration block whose selector names `.cls`. @param {string} css @param {string} cls */
const declarationsFor = (css, cls) => [...css.matchAll(new RegExp(`[^{}]*\\.${cls}(?![\\w-])[^{}]*\\{([^}]*)\\}`, "g"))].map((one) => one[1]);

describe("About on a phone has the pocket sky (#1789 W-F6/W-F9)", () => {
  it("mounts the pocket kit's sky, with the desk's PageSky still there for the desk", async () => {
    await open();
    expect(document.querySelector(".about-page .p-sky"), "the pocket sky, as every other pocket screen mounts it").not.toBeNull();
    expect(document.querySelector(".about-page .sky"), "the desk sky stays for the desk").not.toBeNull();
  });

  it("puts the pocket sky first in the page's markup, without grain", async () => {
    await open();
    const root = /** @type {HTMLElement} */ (document.querySelector(".about-page"));
    const sky = /** @type {HTMLElement} */ (root.querySelector(".p-sky"));
    expect(sky, "the pocket sky").toBeTruthy();
    const first = [...root.children][0];
    expect(first === sky || first.contains(sky), "the pocket sky comes first, behind everything").toBe(true);
    expect(root.querySelector(".grain, [class*=grain]"), "signed-in pocket screens carry no grain").toBeNull();
  });

  it("draws the pocket sky only under the pocket query: hidden on the desk, shown on a phone", async () => {
    await open();
    const sky = /** @type {HTMLElement} */ (document.querySelector(".about-page .p-sky"));
    expect(sky, "the pocket sky").toBeTruthy();
    const wrapper = sky.parentElement;
    expect(wrapper && !wrapper.classList.contains("about-page"), "the sky sits inside a wrapper the desk can hide").toBe(true);
    const cls = [...(wrapper?.classList ?? [])][0];
    expect(cls, "the wrapper has a class to hide it by").toBeTruthy();

    const { base, pocket } = splitPocket(stylesheet());
    expect(declarationsFor(base, cls).some((block) => /display\s*:\s*none/.test(block)), "hidden by default (the desk)").toBe(true);
    expect(declarationsFor(pocket, cls).some((block) => /display\s*:\s*(?!none)\w/.test(block)), "shown under the pocket query").toBe(true);
  });
});
