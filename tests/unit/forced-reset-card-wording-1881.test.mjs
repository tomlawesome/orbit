import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { cardMessageFor } from "$lib/flight/door-state.js";

/*
 * #1881: the words the ratified mock-up fixes for the set-new-password step
 * (design/v19/password-after-refusal/round-1, direction R, the card again,
 * owner verdict 60a on 2026-11-17). Written from the issue and the round's
 * wording table before the card exists. Where a string cannot be reached
 * through a function, it is a source tripwire in the shape of
 * door-host-wiring.test.mjs: it scans Orbit's own web source (never the
 * imported copy under web/src/lib/door/) for the exact sentence, so a reword
 * fails here with the string it lost.
 */

const src = path.resolve(import.meta.dirname, "../../web/src");
const doorDir = path.join(src, "lib", "door");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(svelte|js|css|html)$/u.test(entry.name) ? [full] : [];
  });
}

const orbitSource = existsSync(src)
  ? walk(src).filter((file) => !file.startsWith(doorDir + path.sep))
  : [];
/* Only the file(s) that carry the step's heading count: the same words elsewhere in Orbit
   (the setup card's labels, its "Continue") must not satisfy a test about the new step. */
const sourceText = orbitSource
  .map((file) => readFileSync(file, "utf8"))
  .filter((text) => text.includes("Choose a new password"))
  .join("\n");

/** What the card's source says, with HTML entities for the typographic marks read as the marks. */
const readable = sourceText
  .replaceAll("&rsquo;", "’")
  .replaceAll("&mdash;", "—")
  .replaceAll("&middot;", "·")
  .replaceAll("&#8217;", "’")
  .replaceAll("&#183;", "·")
  .replaceAll("&#8212;", "—");

describe("the refusals the card speaks (mock-up wording table)", () => {
  it("answers password_unchanged in Orbit's own words, not the generic 'didn't work'", () => {
    expect(cardMessageFor("password_unchanged")).toBe(
      "That is the password that was refused. Choose a different one.",
    );
    expect(cardMessageFor("password_unchanged")).not.toBe(cardMessageFor("some_unknown_code"));
  });

  it("answers password_rejected with the line the setup card already uses", () => {
    expect(cardMessageFor("password_rejected")).toBe("That password is too short or too long.");
  });

  it("speaks a lapsed hold in the card's words, never the code", () => {
    const words = cardMessageFor("password_change_lapsed");
    expect(words).toBe(
      "This sign-in has lapsed before a new password was saved. Sign in again and choose one then.",
    );
    expect(words).not.toContain("_");
  });

  it("speaks the server's own mismatch in the same sentence as the local one", () => {
    expect(cardMessageFor("password_mismatch")).toBe("Those two passwords are not the same.");
  });

  it("never repeats a code it was handed, for the new codes too", () => {
    for (const code of ["password_unchanged", "password_change_lapsed", "password_mismatch"]) {
      expect(cardMessageFor(code)).not.toContain(code);
    }
  });
});

describe("the step's own wording is in the source (mock-up round 1, direction R)", () => {
  it("found Orbit's web source to scan", () => {
    expect(orbitSource.length).toBeGreaterThan(0);
  });

  const sentences = {
    heading: "Choose a new password",
    "note, its reason": "somebody else knew it",
    "note, its promise": "Choose a new one and you’re in.",
    "note, its opening": "A sign-in with this password was refused on",
    "rule line": "at least 12 characters · not the old one",
    "first label": "new password",
    "second label": "new password again",
    "not the same, local": "Those two passwords are not the same.",
    "lapsed, with its sign-in line": "This sign-in has lapsed before a new password was saved.",
    "lapsed, the way on": "Sign in again and choose one then.",
    pill: "Continue",
  };
  for (const [what, words] of Object.entries(sentences)) {
    it(`says the ${what}: ${JSON.stringify(words)}`, () => {
      expect(readable, `no source under web/src says ${JSON.stringify(words)}`).toContain(words);
    });
  }

  it("names the moment through formatApprovalMoment, the format the approval mail and page use", () => {
    expect(readable).toMatch(/formatApprovalMoment|refusedAt/u);
  });
});

describe("what the card must not show about the refused sign-in (mock-up: 'no names, addresses or devices')", () => {
  it("has a note sentence that names no address, device, place or count", () => {
    const note = /A sign-in with this password was refused on[^<`"]*/u.exec(readable)?.[0] ?? "";
    expect(note, "the note sentence was not found").not.toBe("");
    for (const word of [/address/iu, /device/iu, /browser/iu, /\bfrom\b/iu, /\btimes\b/iu, /location/iu]) {
      expect(note).not.toMatch(word);
    }
  });
});
