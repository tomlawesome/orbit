import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1262 (owner, 2026-10-06): the plain sign-out is ONE press in all three
 * menus -- home's account card, Chrome.svelte's panel and the pocket's
 * hatch -- not arm-then-fire. Each still refuses a second, concurrent
 * signOut() while one is in flight (#1151 W1-R7). "Sign out of every
 * device" in settings keeps its two taps; it is not checked here.
 *
 * #1355: the press and its guard are written once, in
 * $lib/sign-out.svelte.js; each menu hands it only what follows.
 *
 * Source checks, as v19-home-signout-inflight-guard.test.mjs does: a
 * `.svelte` file needs the compiler this suite does not pull in.
 */
const read = (path) => readFileSync(resolve(import.meta.dirname, "../..", path), "utf8");
const HOME = read("web/src/routes/home/+page.svelte");
const CHROME = read("web/src/lib/Chrome.svelte");
const HATCH = read("web/src/lib/pocket/Hatch.svelte");
const LEAVE = read("web/src/lib/flight/Leave.svelte");
const SIGN_OUT = read("web/src/lib/sign-out.svelte.js");

/** @param {string} src @param {string} head */
const body = (src, head) => src.slice(src.indexOf(head), src.indexOf(head) + 900);

describe("#1262: the plain sign-out is one press", () => {
  it("the shared press signs out at once, guarded while in flight", () => {
    expect(SIGN_OUT).not.toMatch(/armedOut/u);
    expect(SIGN_OUT).not.toMatch(/tap again to sign out/u);
    const fn = body(SIGN_OUT, "async function press()");
    expect(fn).toMatch(/if \(signingOut\) return;/u);
    expect(fn).toMatch(/signingOut = true;/u);
  });

  it("home signs out on the first press, and never says 'tap again'", () => {
    expect(HOME).not.toMatch(/armedOut/u);
    expect(HOME).not.toMatch(/tap again to sign out/u);
    expect(HOME).toMatch(/const signOut = createSignOut\(/u);
  });

  it("Chrome.svelte signs out on the first press, guarded while in flight", () => {
    expect(CHROME).not.toMatch(/armedOut/u);
    expect(CHROME).not.toMatch(/tap again to sign out/u);
    expect(CHROME).toMatch(/const signOut = createSignOut\(/u);
    expect(CHROME).toMatch(/<button class="signout" onclick=\{signOut\.press\} disabled=\{signOut\.signingOut\}>/u);
  });

  it("the hatch's sign-out is a plain pill, guarded while in flight", () => {
    expect(HATCH).not.toMatch(/tap again to sign out/u);
    expect(HATCH).not.toMatch(/import ArmButton/u);
    expect(HATCH).toMatch(/const signOut = createSignOut\(/u);
    expect(HATCH).toMatch(/onclick=\{signOut\.press\} disabled=\{signOut\.signingOut\}>sign out →/u);
  });

  it("the hatch's sheet is off history before its goodbye starts (#1673)", () => {
    const after = body(HATCH, "const signOut = createSignOut(");
    expect(after.indexOf("await closeSheet();")).toBeGreaterThan(-1);
    expect(after.indexOf("await closeSheet();")).toBeLessThan(after.indexOf("onsignedout(redirectTo)"));
  });

  it("home readies the descent's world when its menu opens, gently", () => {
    // The descent is the shared Leave.svelte (#1253); home asks it to ready
    // its world, and it does so gently.
    expect(HOME).toMatch(/const readyDescent = \(\) => leave\?\.ready\(\);/u);
    expect(body(LEAVE, "export function ready()")).toMatch(/flight\?\.readyWorld\(\{ hurry: true, gentle: true \}\)/u);
    expect(HOME).toMatch(/<button class="orb"[^>]*onclick=\{readyDescent\}/u);
  });
});
