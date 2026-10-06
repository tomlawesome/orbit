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
 * Source checks, as v19-home-signout-inflight-guard.test.mjs does: a
 * `.svelte` file needs the compiler this suite does not pull in.
 */
const read = (path) => readFileSync(resolve(import.meta.dirname, "../..", path), "utf8");
const HOME = read("web/src/routes/home/+page.svelte");
const CHROME = read("web/src/lib/Chrome.svelte");
const HATCH = read("web/src/lib/pocket/Hatch.svelte");

/** @param {string} src @param {string} head */
const body = (src, head) => src.slice(src.indexOf(head), src.indexOf(head) + 900);

describe("#1262: the plain sign-out is one press", () => {
  it("home signs out on the first press, and never says 'tap again'", () => {
    expect(HOME).not.toMatch(/armedOut/u);
    expect(HOME).not.toMatch(/tap again to sign out/u);
    expect(body(HOME, "async function tapSignOut()")).toMatch(/if \(signingOut\) return;/u);
  });

  it("Chrome.svelte signs out on the first press, guarded while in flight", () => {
    expect(CHROME).not.toMatch(/armedOut/u);
    expect(CHROME).not.toMatch(/tap again to sign out/u);
    const fn = body(CHROME, "async function tapSignOut()");
    expect(fn).toMatch(/if \(signingOut\) return;/u);
    expect(fn).toMatch(/signingOut = true;/u);
    expect(CHROME).toMatch(/<button class="signout" onclick=\{tapSignOut\} disabled=\{signingOut\}>/u);
  });

  it("the hatch's sign-out is a plain pill, guarded while in flight", () => {
    expect(HATCH).not.toMatch(/tap again to sign out/u);
    expect(HATCH).not.toMatch(/import ArmButton/u);
    const fn = body(HATCH, "async function leave()");
    expect(fn).toMatch(/if \(signingOut\) return;/u);
    expect(fn).toMatch(/signingOut = true;/u);
  });

  it("home readies the descent's world when its menu opens, gently", () => {
    expect(HOME).toMatch(/readyFlight\(\{ hurry: true, gentle: true \}\)/u);
    expect(HOME).toMatch(/<button class="orb"[^>]*onclick=\{readyDescent\}/u);
  });
});
