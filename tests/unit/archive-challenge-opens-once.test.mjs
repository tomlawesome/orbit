import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * The archive's "sign in again" challenge opens once, in its final place
 * (pipeline 2382, desktop-firefox, v19-archive.spec.ts "a wrong passphrase
 * is refused").
 *
 * It used to open while the act was still on its busy screen ("writing",
 * "looking", "bringing"), then ask GET /api/auth/methods, and only when that
 * answered step the act back to its form -- which draws the challenge again
 * in a new place, with a new password field. A reader (or Playwright) who had
 * started typing into the first field lost what they typed, and the confirm
 * button stayed disabled. The cure: learn the sign-in methods first, step the
 * act back, and only then open the challenge, all in one turn.
 *
 * Svelte components are not mounted in this suite, so the order is pinned on
 * the source of both dialects' `guarded`.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const CONTROLLER = "web/src/routes/household/[id]/archive-controller.svelte.js";
// #1354: one controller holds `guarded` for both layouts; each must call it.
const FILES = [
  "web/src/routes/household/[id]/DeskArchive.svelte",
  "web/src/routes/household/[id]/PocketArchive.svelte",
];

/** The body of `async function guarded(...) { ... }`, up to the next top-level function. */
function guardedOf(source) {
  const start = source.indexOf("async function guarded(");
  expect(start, "guarded() is where the challenge opens").toBeGreaterThan(-1);
  const end = source.indexOf("\n  }\n", start);
  return source.slice(start, end);
}

describe.each(FILES)("%s: uses the shared controller", (file) => {
  it("takes its acts from createArchiveController", () => {
    expect(readFileSync(resolve(ROOT, file), "utf8")).toMatch(/createArchiveController\(/);
  });

  it("holds no guarded() of its own", () => {
    expect(readFileSync(resolve(ROOT, file), "utf8")).not.toMatch(/function guarded\(/);
  });
});

describe(`${CONTROLLER}: the archive challenge opens once, in its final place`, () => {
  const source = readFileSync(resolve(ROOT, CONTROLLER), "utf8");
  const guarded = guardedOf(source);

  it("knows how the reader proves it is them before it opens the challenge", () => {
    const methods = guarded.indexOf("readSignInMethods()");
    const opens = guarded.indexOf("challengeOpen = true");
    expect(methods).toBeGreaterThan(-1);
    expect(opens).toBeGreaterThan(methods);
  });

  it("steps the act back to its screen before the challenge opens, not after", () => {
    const hold = guarded.indexOf("hold()");
    const opens = guarded.indexOf("challengeOpen = true");
    expect(hold).toBeGreaterThan(-1);
    expect(opens).toBeGreaterThan(hold);
  });

  it("no act moves its phase after guarded() settles, which would redraw an open challenge", () => {
    expect(source).not.toMatch(/"archive_(export|import)"\)\.then\(/);
    for (const file of FILES) {
      expect(readFileSync(resolve(ROOT, file), "utf8")).not.toMatch(/"archive_(export|import)"\)\.then\(/);
    }
    expect(source).not.toMatch(/"archive_import"\);\s*\n\s*if \(inPhase === "looking"\)/);
  });
});
