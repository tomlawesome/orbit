import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-R11: Reader.svelte's full-screen page re-requests the page via a
 * fresh <img src>, independent of the sheet's own already-loaded thumbnail,
 * so it can fail on its own (a transient drop, the document expiring
 * between the thumbnail load and the full-screen open). The <img> had only
 * onload, no onerror at all, so a failed re-fetch left the browser's bare
 * broken-image glyph with `problem` never set and no message.
 *
 * The fix adds onerror, setting the same `problem` state the component
 * already shows via `{#if problem}<p class="p-error" role="alert">`
 * (pinned by remove()'s own failure path already).
 */

const READER = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/reading/Reader.svelte"),
  "utf8",
);

describe("#1151 W1-R11: Reader's full-screen <img> has an onerror handler", () => {
  it("the img tag carries both onload and onerror", () => {
    const img = READER.slice(READER.indexOf("<img bind:this={img}"), READER.indexOf("<img bind:this={img}") + 900);
    expect(img).toMatch(/onload=\{/u);
    expect(img).toMatch(/onerror=\{\(\) => \{/u);
    /* #1300: the same words now also answer a page fetch that fails, so
       they live in one constant both paths set. */
    expect(img).toMatch(/problem = UNDRAWN;/u);
    expect(READER).toMatch(/const UNDRAWN = "this page could not be drawn/u);
  });

  it("the error renders through the component's existing alert pattern", () => {
    expect(READER).toMatch(/\{#if problem\}<p class="p-error" role="alert">\{problem\}<\/p>\{\/if\}/u);
  });
});
