import { expect, test } from "@playwright/test";

import { APP, onPhone, signedIn } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Page} Page */

/*
 * SIGNING OUT PLAYS THE DESCENT, ALL THE WAY TO THE DUSK (#1262, #1253), moved
 * to the rig (ADR-0039, #1611) from tests/e2e/sign-out-descent.spec.ts.
 *
 * #1262: the owner signed out from home's menu on a real GPU and the page
 * stuck: the descent played, the menu stayed open over it, and the dusk and its
 * /logout never came. #1253 (owner, 2026-10-07): "signing out should always
 * play the reverse flight. No matter where you are." With the motion on, the
 * reader must see the menu go, the descent start and end, the dusk, the
 * address /logout and "Sign back in" -- from home and from another page.
 *
 * The fixture app has no session, and its /api/auth/logout runs the real
 * engine code, so each test answers that one write itself with "no provider
 * session to end" (`redirectTo: null`, what a local-only instance answers);
 * everything the page does after the answer is the product's own. The provider
 * half of the sign-out (the end-session address) is in
 * tests/integration/auth-session-contracts.test.ts.
 *
 * THE WORLD, FORCED (test-only, nothing in the product). This host has no
 * GPU: fitness.js refuses software renderers, so the WebGL2 path would never
 * run here. `forceWorld` makes the browser look fit from inside the page so
 * the voyage is made and drawn beneath the descent. Where the browser has no
 * WebGL2 the same run walks the canvas fallback.
 *
 * Home's walk keeps the stack version's arrival: the launch marker set before
 * the page loads, the ascent waited out, so the world is readied on the page
 * that signs out. /settings is reached plainly, as it was.
 */
test.use({ baseURL: APP });

/* Desk from 901px (home/+page.svelte DESK); below it the pocket's hatch,
   whose sign-out plays the same descent (owner, 2026-10-07, on an iPhone:
   "the dice didn't happen in reverse"). The owner's window was narrow, so a
   narrow desk is walked as well as a wide one. The phone project walks the
   phone size once, the desktop project the two desk widths. */
const WIDTHS = [
  { label: "phone-narrow", width: 400, height: 860 },
  { label: "narrow desk", width: 960, height: 760 },
  { label: "wide desk", width: 1280, height: 800 },
];

/** @param {Page} page */
async function forceWorld(page) {
  await page.addInitScript(() => {
    if (typeof WebGL2RenderingContext === "undefined") return;
    const proto = WebGL2RenderingContext.prototype;
    const getParameter = proto.getParameter;
    proto.getParameter = /** @type {typeof proto.getParameter} */ (function (/** @type {number} */ p) {
      if (p === 0x9246 /* UNMASKED_RENDERER_WEBGL */) return "e2e forced renderer";
      return getParameter.call(this, p);
    });
    const readPixels = /** @type {(...a: unknown[]) => void} */ (proto.readPixels);
    proto.readPixels = /** @type {typeof proto.readPixels} */ (function (/** @type {unknown[]} */ ...a) {
      if (a[2] === 1 && a[3] === 1) return;
      return readPixels.apply(this, a);
    });
    const getContext = /** @type {(...a: unknown[]) => unknown} */ (HTMLCanvasElement.prototype.getContext);
    HTMLCanvasElement.prototype.getContext = /** @type {typeof HTMLCanvasElement.prototype.getContext} */ (function (/** @type {unknown} */ type, /** @type {Record<string, unknown> | undefined} */ attrs) {
      if (type === "webgl2" && attrs) {
        const { failIfMajorPerformanceCaveat: _drop, ...rest } = attrs;
        return getContext.call(this, type, rest);
      }
      return getContext.call(this, type, attrs);
    });
  });
}

/**
 * What the descent drew on, recorded from inside the page at its warp.
 * @param {Page} page
 */
async function watchDescent(page) {
  await page.addInitScript(() => {
    const seen = { world: false, warp: false, withdraw: 0, farewell: 0 };
    /** @type {any} */ (window).__descent = seen;
    const watch = () => new MutationObserver(() => {
      const b = document.body;
      if (!seen.withdraw && b.classList.contains("withdrawing")) seen.withdraw = performance.now();
      if (!seen.farewell && b.classList.contains("farewell")) seen.farewell = performance.now();
      if (b.classList.contains("showwarp") && b.classList.contains("dispersing")) {
        seen.warp = true;
        const gl = document.getElementById("warpgl");
        if (gl && gl.isConnected && gl.style.visibility !== "hidden") seen.world = true;
      }
    }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    if (document.body) watch(); else addEventListener("DOMContentLoaded", watch);
  });
}

/**
 * The write this test owns: the sign-out, answered as a local-only instance
 * answers it (no provider session to end).
 * @param {Page} page
 */
async function answerSignOut(page) {
  await page.route("**/api/auth/logout*", (route) => route.fulfill({ json: { redirectTo: null }, headers: { "cache-control": "no-store" } }));
}

/**
 * Opens whichever menu this width draws and returns it and its sign-out control.
 * @param {Page} page @param {boolean} desk @param {string} pocketOrb
 */
async function openMenu(page, desk, pocketOrb) {
  if (desk) {
    await page.locator("button.orb").click();
    const menu = page.locator("#account");
    await expect(menu).toHaveClass(/open/);
    return { menu, signOut: menu.locator("button.signout") };
  }
  await page.locator(pocketOrb).click();
  const menu = page.locator('.p-sheet-layer:has(nav[aria-label="Go to"])');
  await expect(menu).toHaveClass(/open/);
  return { menu, signOut: menu.getByRole("button", { name: /sign out/ }) };
}

/** The dusk itself, drawn (toBeVisible alone ignores opacity: the dusk is on the page from the first beat at opacity 0). @param {Page} page @param {string} tag */
const duskArrives = (page, tag) => expect.poll(() => page.evaluate(() => {
  const d = document.getElementById("dusk");
  return d ? getComputedStyle(d).opacity : "absent";
}), { message: `${tag}: the dusk never arrived`, timeout: 30_000 }).toBe("1");

for (const size of WIDTHS) {
  for (const world of [true, false]) {
    test(`sign out from home's menu reaches the dusk (${size.label}, ${world ? "world forced" : "as the browser is"})`, async ({ page }, info) => {
      test.setTimeout(240_000);
      const phone = onPhone(info);
      const desk = size.width >= 901;
      test.skip(phone && desk, "a phone has no desk");
      test.skip(phone && !world, "a phone walks it once");
      test.skip(!phone && !desk, "the phone size is the phone project's");
      if (!phone) await page.setViewportSize({ width: size.width, height: size.height });
      if (world) await forceWorld(page);
      await watchDescent(page);
      await answerSignOut(page);
      const errors = /** @type {string[]} */ ([]);

      /* The reader arrives the way a real sign-in does, with the launch marker
         set (arrival.js), so home plays its ascent first and readies the
         flight's world on that same page, as the owner's had. */
      await page.addInitScript(() => sessionStorage.setItem("orbit-launch", "departed"));
      await signedIn("/home", "rest")(page);
      await page.waitForFunction(() => !document.body.classList.contains("launching"), null, { timeout: 150_000 });
      page.on("pageerror", (e) => errors.push(String(e)));
      const { menu, signOut } = await openMenu(page, desk, "#morb");
      await menu.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));

      const clicked = Date.now();
      /* one click (owner, 2026-10-06): the plain sign-out no longer arms */
      await signOut.click();

      /* the menu closes by itself as the sign-out starts */
      if (desk) await expect.soft(menu, "#1262: the menu is still open after sign-out started").not.toHaveClass(/open/);
      else await expect(menu, "#1262: the menu is still open after sign-out started").toBeHidden();
      await duskArrives(page, "#1262");
      const dusk = Date.now() - clicked;
      await expect(page, "#1262: the address never became /logout").toHaveURL(/\/logout$/, { timeout: 30_000 });
      const away = Date.now() - clicked;
      await expect(page.getByRole("link", { name: "Sign back in" })).toBeVisible();

      const drawn = await page.evaluate(() => /** @type {any} */ (window).__descent ?? null);
      const took = drawn && drawn.withdraw && drawn.farewell ? Math.round(drawn.farewell - drawn.withdraw) : null;
      console.log(`#1262 ${info.project.name} ${size.label}: descent ${drawn?.warp ? (drawn.world ? "over the WebGL2 world" : "on the canvas") : "not seen"}; dusk ${dusk} ms, /logout ${away} ms after the press; descent ${took ?? "-"} ms`);
      /* The descent is not timed (#1447): how long its frames take depends on
         the machine, and the behaviour is that it plays, reaches the dusk and
         leaves for /logout, all asserted above. Its time is logged, not judged.
         It must still be seen to start and end, in the right order. */
      expect(took, "#1262: the descent was not seen to start and end").not.toBeNull();
      expect(took ?? 0, "#1262: the descent ended before it started").toBeGreaterThan(0);
      if (desk && world && info.project.name === "rig-desktop") {
        expect(drawn?.world, "#1262: the forced world was not drawn beneath the descent").toBe(true);
      }
      expect(errors, "#1262: the page threw during the sign-out").toEqual([]);
    });
  }
}

/*
 * #1253: Chrome's menu (every desk page but home) revoked and then walked to
 * /logout with no descent, so the dusk was never flown to. Signed out from
 * /settings, with the motion on, the reader must see the descent start and
 * end, the dusk, the address /logout and "Sign back in", as from home.
 */
for (const size of WIDTHS.filter((s) => s.label !== "narrow desk")) {
  test(`sign out from another page's menu plays the descent (${size.label})`, async ({ page }, info) => {
    const phone = onPhone(info);
    const desk = size.width >= 901;
    test.skip(phone && desk, "a phone has no desk");
    test.skip(!phone && !desk, "the phone size is the phone project's");
    if (!phone) await page.setViewportSize({ width: size.width, height: size.height });
    await watchDescent(page);
    await answerSignOut(page);
    const errors = /** @type {string[]} */ ([]);

    await signedIn("/settings", "any-dialect")(page);
    page.on("pageerror", (e) => errors.push(String(e)));
    const { menu, signOut } = await openMenu(page, desk, "button.porb");
    await menu.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));

    await signOut.click();

    /* the menu closes as the sign-out starts (#1262) */
    if (desk) await expect.soft(menu, "#1253: the menu is still open after sign-out started").not.toHaveClass(/open/);
    else await expect(menu, "#1253: the menu is still open after sign-out started").toBeHidden();
    await duskArrives(page, "#1253");
    /* and the page has left with the descent (home's own beats): settings'
       content, the desk's or the phone's, is not left standing over the
       dusk. Its main region and the menu's orb or top bar are looked for where drawn (the desk's
       .page, the phone's main), and at least one must be drawn at all, or
       a width whose other dialect is display:none would pass for nothing. */
    await expect.poll(() => page.evaluate(() => {
      const drawn = [...document.querySelectorAll("main, [role=main], .orb, .p-chrome")]
        .filter((el) => el.getClientRects().length > 0 && !el.closest("#dusk"));
      const standing = drawn.filter((el) => {
        for (/** @type {Element | null} */ let e = el; e; e = e.parentElement) {
          const c = getComputedStyle(e);
          if (c.visibility === "hidden" || c.opacity === "0") return false;
        }
        return true;
      });
      return drawn.length === 0 ? "nothing drawn" : standing.length ? "still showing" : "gone";
    }), { message: "#1253: the page is still showing over the dusk", timeout: 30_000 }).toBe("gone");
    await expect(page, "#1253: the address never became /logout").toHaveURL(/\/logout$/, { timeout: 30_000 });
    await expect(page.getByRole("link", { name: "Sign back in" })).toBeVisible();

    const drawn = await page.evaluate(() => /** @type {any} */ (window).__descent ?? null);
    expect(drawn?.withdraw && drawn?.farewell, "#1253: the descent was not seen to start and end").toBeTruthy();
    expect((drawn?.farewell ?? 0) - (drawn?.withdraw ?? 0), "#1253: the descent ended before it started").toBeGreaterThan(0);
    expect(errors, "#1253: the page threw during the sign-out").toEqual([]);
  });
}
