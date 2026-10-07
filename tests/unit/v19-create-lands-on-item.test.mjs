import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1246: "Add to orbit" must close the form and return to the main screen,
 * with the saved item where the reader lands — not leave the form open
 * under a "Saved" line. The desk's save now goes to home's own `?item=`
 * address for the draft's id, which puts that row on screen and opens it
 * (home/+page.svelte's openFromAddress). Pinned against the file's text, as
 * v19-create-draft-id.test.mjs does; tests/e2e/v19-create.spec.ts proves
 * the journey.
 */

const behaviour = readFileSync(resolve(import.meta.dirname, "../../web/src/routes/create/create.behaviour.js"), "utf8");

describe("#1246: the desk's save closes onto the saved item", () => {
  const submitHandler = behaviour.slice(behaviour.indexOf('on(card, "submit"'));

  it("navigates to home at the draft's item on every successful save", () => {
    expect(submitHandler).toMatch(/await goto\(`\/home\?item=\$\{encodeURIComponent\(draftId\)\}`\);/u);
    expect(submitHandler).not.toMatch(/goto\("\/home"\)/u);
  });

  it("never leaves the form open under a Saved line", () => {
    expect(behaviour).not.toMatch(/`Saved\./u);
  });
});
