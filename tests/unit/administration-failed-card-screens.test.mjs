import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * #1443: the desk and phone administration screens say so, with a "try again",
 * when the upload limit, document jobs, key rotation, metadata health or
 * recovery bundle read failed, the way they do for failed.users and the rest
 * (#1442). Static scan, the shape of administration-failed-reads-screens.test.mjs:
 * there is no component-mounting harness in this suite (no @testing-library/svelte,
 * no *.svelte.test.js), so the rendering itself is left to the browser check.
 *
 * The shape: each card reads view.failed.<key> and, next to it, offers a
 * "try again" wired to the layout's existing retry (desk rereadScreen, phone
 * tryAgain), in the same markup #1442 uses (desk: .adminproblem with a
 * .retry button; phone: .p-pill filled). A retry that fails again changes
 * something visible: the retry's catch is no longer empty.
 */

const DESK = "web/src/routes/administration/+page.svelte";
const POCKET = "web/src/routes/administration/pocket.svelte";
/** @param {string} rel */
const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
/** @param {string} src @param {RegExp} re @param {number} reach */
const windowsAfter = (src, re, reach) =>
  [...src.matchAll(new RegExp(re, "g"))].map((m) => src.slice(m.index, m.index + reach));

const KEYS = ["uploadLimit", "operations", "rotation", "metadata", "recoveryBundle"];

describe.each([
  ["desk (+page.svelte)", DESK, /onclick=\{rereadScreen\}/, /adminproblem[^>]*role="alert"|role="alert"[^>]*adminproblem/],
  ["phone (pocket.svelte)", POCKET, /onclick=\{tryAgain\}/, /p-pill filled/],
])("administration %s", (_label, file, retry, shared) => {
  it.each(KEYS)("failed.%s shows the shared failed-read markup with a try again", (key) => {
    const hits = windowsAfter(read(file), new RegExp(`\\{#if view\\.failed\\.${key}\\}`), 700).map((w) => {
      /* only this block: stop where a neighbouring failed block or card starts */
      const from = w.indexOf("}") + 1;
      const end = w.slice(from).search(/\{#if view\.failed\.|<section|<!--|<div class="card/);
      return end === -1 ? w : w.slice(0, from + end);
    });
    expect(hits.length, `${file} never reads failed.${key}`).toBeGreaterThan(0);
    expect(
      hits.some((w) => /try again/.test(w) && /tried again/.test(w) && retry.test(w) && shared.test(w)),
      `${file}: no 'try again' wired to the retry after failed.${key}`,
    ).toBe(true);
  });
});

describe("a retry that fails again is visible", () => {
  it("desk rereadScreen's catch does something", () => {
    const src = read(DESK);
    const m = /async function rereadScreen\s*\(\)\s*\{[\s\S]*?\bcatch\s*(?:\([^)]*\))?\s*\{((?:[^}*]|\*(?!\/)|\/\*[\s\S]*?\*\/)*)\}/.exec(src);
    expect(m, "rereadScreen not found").not.toBeNull();
    const catchBody = /** @type {RegExpExecArray} */ (m)[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").trim();
    expect(catchBody, "rereadScreen's catch is empty: a failed retry changes nothing").not.toBe("");
  });

  it("phone tryAgain does not swallow a failure with an empty catch", () => {
    expect(read(POCKET)).not.toMatch(/const tryAgain\s*=\s*\(\)\s*=>\s*reread\(\)\.catch\(\(\)\s*=>\s*\{\s*\}\)/);
  });
});
