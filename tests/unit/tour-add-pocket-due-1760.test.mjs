// @vitest-environment happy-dom
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SELECTORS } from "../../web/src/lib/tour/chapters/02-add.js";
import { web } from "./v19-tour-test-kit.mjs";

/*
 * #1760: on a phone the Add chapter must find the due-date control. #1468
 * made it a button in EntryForm.svelte, so a selector written for an input
 * matches nothing and the film ends with TourControlMissing.
 *
 * The page is built from the real EntryForm.svelte: each field the chapter
 * names is taken, tag and id, from the markup that declares it, and placed
 * under #pocket-entry as the pocket route does (`{uid}` becomes "pk1").
 */
const FORM = readFileSync(web("src/routes/create/EntryForm.svelte"), "utf8");

function realFieldTag(suffix) {
  const found = FORM.match(new RegExp(`<(input|button|select|textarea)\\b[^>]*\\bid="\\{uid\\}-${suffix}"`, "u"));
  expect(found, `EntryForm.svelte declares no element with id "{uid}-${suffix}"`).not.toBeNull();
  return found[1];
}

function drawPocketForm() {
  const cells = ["name", "due", "cost"].map((suffix) => {
    const tag = realFieldTag(suffix);
    return `<${tag} id="pk1-${suffix}"></${tag}>`;
  });
  document.body.innerHTML = `<div id="pocket-entry"><div class="pc-form">${cells.join("")}</div></div>`;
}

describe("the Add chapter's pocket due control (#1760)", () => {
  it("the pocket due selector finds the due control the real form draws", () => {
    drawPocketForm();
    expect(
      document.querySelector(SELECTORS.POCKET.due),
      `the pocket "due" beat names "${SELECTORS.POCKET.due}", which matches nothing in EntryForm's due control`,
    ).not.toBeNull();
  });

  it("the due control it finds is the button that opens the calendar", () => {
    drawPocketForm();
    expect(document.querySelector(SELECTORS.POCKET.due)?.tagName).toBe("BUTTON");
  });

  it("the other pocket fields still resolve (guard: the fault is the due beat alone)", () => {
    drawPocketForm();
    expect(document.querySelector(SELECTORS.POCKET.name)).not.toBeNull();
    expect(document.querySelector(SELECTORS.POCKET.cost)).not.toBeNull();
  });
});
