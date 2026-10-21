import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * R6 (R4-FR1): readAdminScreen() gives `failed.session` when the sign-in
 * session read failed or never answered. Both layouts show that the way they
 * show other failed panels: a note with a "try again" button wired to the
 * layout's retry (desk `rereadScreen`, phone `tryAgain`). Static scan, the
 * same shape as administration-failed-reads-screens.test.mjs.
 */

/** @param {string} rel */
const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

/** Every match of `needle` in `src`, as the text from the match to `reach` characters on. */
/** @param {string} src @param {RegExp} needle @param {number} reach */
function windowsAfter(src, needle, reach) {
  /** @type {string[]} */
  const out = [];
  for (const m of src.matchAll(new RegExp(needle, "g"))) out.push(src.slice(m.index, m.index + reach));
  return out;
}

describe.each([
  ["desk (+page.svelte)", "web/src/routes/administration/+page.svelte", /onclick=\{rereadScreen\}/],
  ["phone (pocket.svelte)", "web/src/routes/administration/pocket.svelte", /onclick=\{tryAgain\}/],
])("administration %s names a failed session read (R6)", (_label, file, retry) => {
  it("reads failed.session", () => {
    expect(read(file)).toMatch(/failed\.session\b/);
  });

  it("offers 'try again' beside the failed session note, wired to the retry", () => {
    const hits = windowsAfter(read(file), /failed\.session\b/, 700);
    expect(hits.length, `${file} never reads failed.session`).toBeGreaterThan(0);
    expect(hits.some((w) => /try again/.test(w) && retry.test(w)), `${file}: no 'try again' wired to the retry after failed.session`).toBe(true);
  });
});
