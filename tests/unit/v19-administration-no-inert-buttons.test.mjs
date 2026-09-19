import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1052: nothing on the administration screen may be a button that does
 * nothing.
 *
 * The bug this guards was not a broken handler — it was a button ported
 * straight out of the v19 mockup with no flow behind it at all. "new system"
 * rendered, every administrator could press it, and pressing it did nothing;
 * the sibling "place in a system…" on the People card was wired and this one
 * was missed. A screen built from a drawing will keep producing these, so the
 * guard is on the shape rather than on that one button: a <button> in this
 * file either carries an `onclick`, or is the `type="submit"` of a <form>
 * that has an `onsubmit`.
 *
 * The exception list is written out in full and matched EXACTLY, the way
 * tests/unit/api-route-set-contract.test.mjs writes out its routes. A new
 * inert button fails here; so does wiring a listed one, which is the point —
 * the list shrinks deliberately and can never quietly grow.
 *
 * Source text, not a rendered page: this is a Svelte component and the point
 * is to fail in the fast unit suite the moment somebody pastes another inert
 * control in, without standing up a browser to find out.
 */
const source = readFileSync(
  new URL("../../web/src/routes/administration/+page.svelte", import.meta.url),
  "utf8",
);

/**
 * The buttons that are knowingly still inert, by the label their markup
 * carries. Each one is somebody's open issue, not an oversight.
 */
const KNOWN_INERT = [
  // The mail machinery rows' trailing action — "test this mailbox", "test the
  // relay" (#1055). /api/admin/operations/imap-test and smtp-test are live
  // routes with no caller; the composition that gives them a result line is a
  // Fable call on that issue, not a wiring job here.
  "{extra}",
];

/** Every `<button …>` opening tag, with its attributes, in source order. */
function buttonTags(text) {
  return [...text.matchAll(/<button\b([^>]*)>/gu)].map((match) => ({
    attributes: match[1],
    at: match.index ?? 0,
  }));
}

/** The `<form …>` openings that carry an `onsubmit`, and where each one ends. */
function submittingForms(text) {
  return [...text.matchAll(/<form\b[^>]*>/gu)]
    .filter((match) => /\bonsubmit=/u.test(match[0]))
    .map((match) => {
      const start = match.index ?? 0;
      const close = text.indexOf("</form>", start);
      return { start, end: close === -1 ? text.length : close };
    });
}

/** The label between a button's tags, flattened — what a reader presses. */
function labelOf(tag) {
  const close = source.indexOf("</button>", tag.at);
  const end = close === -1 ? source.length : close;
  return source.slice(source.indexOf(">", tag.at) + 1, end).replace(/\s+/gu, " ").trim();
}

const forms = submittingForms(source);

/** True when pressing this button runs something. */
function doesSomething(tag) {
  if (/\bonclick=/u.test(tag.attributes)) return true;
  return /\btype="submit"/u.test(tag.attributes)
    && forms.some((form) => tag.at > form.start && tag.at < form.end);
}

const tags = buttonTags(source);
const inert = tags.filter((tag) => !doesSomething(tag)).map(labelOf);

describe("administration screen has no inert buttons (#1052)", () => {
  it("finds the screen's buttons, so a broken scan cannot pass vacuously", () => {
    expect(tags.length).toBeGreaterThan(5);
  });

  it("has no button that does nothing when pressed, beyond the ones already filed", () => {
    expect(
      inert,
      "A <button> here has no onclick and is not the submit of a form with an onsubmit, "
        + "so pressing it does nothing — the #1052 bug. Wire it, or take it out. "
        + "If one of the listed exceptions has just been wired, remove it from KNOWN_INERT.",
    ).toEqual(KNOWN_INERT);
  });

  it("wires the new-system button the decision of 2026-09-19 asked for", () => {
    const newSystem = tags.find((tag) => labelOf(tag) === "new system");
    expect(newSystem, "the Systems card no longer has a 'new system' button").toBeDefined();
    expect(doesSomething(newSystem)).toBe(true);
  });
});
