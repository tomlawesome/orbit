import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * #1568: the desk review card prints a retry suggestion's own `message`
 * (for an interrupted approval: "Your earlier approval was cut short after
 * the item was recorded. Try once more to finish it.") in its quiet `.twotap`
 * slot. This suite has no component-mounting harness for the page, so this is
 * a source-level check in the shape of desk-phone-small-drifts.test.mjs: loose
 * about formatting, strict that the line is gated on the retry classification
 * and prints `receipt.message` inside a `.twotap` element.
 */

const PAGE = readFileSync(new URL("../../web/src/routes/inbox/+page.svelte", import.meta.url), "utf8");

describe("the desk inbox card's retry line (#1568)", () => {
  it("prints receipt.message in the .twotap slot when the classification is retry", () => {
    const gated = /\{#if[^}]*classification\s*===\s*["']retry["'][^}]*\}\s*<div[^>]*class="twotap"[^>]*>\s*\{receipt\.message\}\s*<\/div>/;
    expect(PAGE).toMatch(gated);
  });
});
