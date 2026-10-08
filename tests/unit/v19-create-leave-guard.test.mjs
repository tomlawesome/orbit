import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-S1: the desktop create form's light-dismiss click
 * (`.stage`'s onclick in +page.svelte) called `goto(resolve("/home"))` with
 * no guard at all, so a misclick off the card discarded everything typed —
 * and nothing warned about closing the tab or following a chrome link
 * either, since no dirty check existed anywhere on this screen.
 *
 * The fix reuses `reveal()`'s own one-way "the form grows as you commit to
 * it" signal (a real name, a chosen type, a dropped document) as the dirty
 * check, rather than tracking it twice, and exposes it from `mountCreate()`
 * as `isDirty()` alongside the existing teardown. +page.svelte reads it from
 * a `beforeNavigate` guard — which also covers the light-dismiss click,
 * since `goto()` triggers the same hook — and from `beforeunload`, using the
 * browser's own `confirm()`/native prompt rather than a new sheet (no
 * desktop confirm pattern exists here the way the pocket's form has one).
 *
 * `mountCreate()` needs a DOM fixture this suite does not build for it (the
 * real markup is sizeable — card, disclose, types, sections, recurrence,
 * cost, date, save button — and is already exercised by the fidelity gate
 * and e2e, neither of which this suite runs), so this pins the wiring
 * against the files' own text, the way `v19-flight-mark-ride.test.mjs`
 * pins a `.svelte` fix it cannot import-test either.
 */

const root = resolve(import.meta.dirname, "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

describe("#1151 W1-S1: the desktop create form warns before discarding", () => {
  const behaviour = read("web/src/routes/create/create.behaviour.js");
  const page = read("web/src/routes/create/+page.svelte");

  it("mountCreate() exposes isDirty() off reveal()'s own signal", () => {
    const tail = behaviour.slice(behaviour.lastIndexOf("return {"));
    // ...and a save that landed is not something to discard: leaving for
    // /home after it must not ask.
    expect(tail).toMatch(/isDirty:\s*\(\)\s*=>\s*!committed && disclose\.classList\.contains\("open"\)/u);
    // Set once the picked document is attached too (#1245): an entry saved
    // whose file then failed to go with it still holds that file only here,
    // so leaving must still ask about it.
    expect(behaviour).toMatch(/if \(attachment\) await attachItemDocument\([^\n]*\n(?:\s*\n|\s*(?:\/\*|\*|\s)[^\n]*\n)*?\s*committed = true;/u);
    // ...and only until the next edit. Typing reaches the card as input or
    // change; a type chip, a section button and a dropped file do not, so
    // each of those paths resets the flag by hand (fix review round 4).
    expect(behaviour).toMatch(/const edited = \(\) => \{ committed = false; \};/u);
    expect(behaviour).toMatch(/on\(card, "input", edited\);\s*\n\s*on\(card, "change", edited\);/u);
    expect(behaviour).toMatch(/chosenType = [^\n]*\n\s*edited\(\);/u);
    expect(behaviour).toMatch(/chosenSection = section\.id;\s*\n\s*edited\(\);/u);
    expect(behaviour).toMatch(/attachment = file;\s*\n\s*edited\(\);/u);
    expect(tail).toMatch(/teardown:/u);
  });

  it("+page.svelte guards in-app navigation and reads isDirty()", () => {
    expect(page).toMatch(/beforeNavigate\(\(\{\s*cancel\s*\}\)\s*=>\s*\{/u);
    expect(page).toMatch(/form\?\.isDirty\(\)/u);
    expect(page).toMatch(/confirm\(/u);
  });

  it("+page.svelte warns on an actual tab close or reload too", () => {
    expect(page).toMatch(/onbeforeunload=\{onBeforeUnload\}/u);
    expect(page).toMatch(/event\.returnValue = ""/u);
  });
});
