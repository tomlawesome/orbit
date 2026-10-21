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

/**
 * The body of every `{#if ...failed.session...}` block, up to its first `{/if}`.
 * Bounded by the block rather than a character count, so a neighbouring
 * panel's own "try again" (the People note sits right below) cannot pass for
 * the session note's.
 * @param {string} src
 */
function sessionBlocks(src) {
  return [...src.matchAll(/\{#if [^}]*failed\.session\b[^}]*\}([\s\S]*?)\{\/if\}/g)].map((m) => m[1]);
}

describe.each([
  ["desk (+page.svelte)", "web/src/routes/administration/+page.svelte", /onclick=\{rereadScreen\}/],
  ["phone (pocket.svelte)", "web/src/routes/administration/pocket.svelte", /onclick=\{tryAgain\}/],
])("administration %s names a failed session read (R6)", (_label, file, retry) => {
  it("reads failed.session", () => {
    expect(read(file)).toMatch(/failed\.session\b/);
  });

  it("offers 'try again' beside the failed session note, wired to the retry", () => {
    const blocks = sessionBlocks(read(file));
    expect(blocks.length, `${file} has no {#if ...failed.session} block`).toBeGreaterThan(0);
    expect(blocks.some((w) => /try again/.test(w) && retry.test(w)), `${file}: no 'try again' wired to the retry inside the failed.session block`).toBe(true);
  });
});
