import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { settleArrival } from "./support/arrival";
import { cleanupHousehold, sessionHeaders } from "./support/households";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { homeIsLive } from "./support/keyboard";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";

resetDatabaseBetweenSpecFiles();

/* On WebKit the spec's goto to /settings cancels the worker fetch SvelteKit's
   page script started on /home's load, and its register() promise has no
   catch, so the old page's "Script service-worker.js load failed" rejection
   lands in this spec's pageerror list two seconds before the descent begins
   (trace, 2026-10-08). Nothing here is about the worker, so on WebKit it is
   kept out, as v19-keyboard.spec.ts does. */
test.use({
  serviceWorkers: async ({}, use, testInfo) => {
    await use(testInfo.project.use.defaultBrowserType === "webkit" ? "block" : "allow");
  },
});

/**
 * #1262: signing out from home's own menu, with the motion on, all the way
 * to the dusk.
 *
 * The owner signed out from home's menu on a real GPU and the page stuck:
 * the descent played, the menu stayed open over it, and the dusk and its
 * /logout never came. Every other sign-out check runs under reduced motion
 * (v19-keyboard.spec.ts) or from a sub-screen (v19-screen-reader.spec.ts),
 * so the live descent, and above all the descent over the WebGL2 world
 * (voyage.js), had never been walked to its end.
 *
 * The reader arrives the way a real sign-in does, with the launch marker set
 * (arrival.js), so home plays its ascent first and readies the flight's
 * world on that same page, as the owner's had. Then the menu, sign out, and
 * the four things the reader must see: the menu gone, the dusk, the address
 * /logout, and "Sign back in" -- and on the desk, a descent that keeps its
 * time.
 *
 * THE WORLD, FORCED (test-only, nothing in the product). This host has no
 * GPU: fitness.js refuses software renderers and the timed frame would fail
 * anyway, so the WebGL2 path would never run here. `forceWorld` below makes
 * the browser look fit from inside the page -- a renderer name that is not
 * software, no performance-caveat refusal, and a 1x1 readPixels (the only
 * size the fitness timing and warm-up syncs read) that returns at once -- so
 * the voyage is made, judged ready and drawn beneath the descent. Where the
 * browser has no WebGL2 at all (headless Firefox, WebKit here) the same run
 * walks the canvas fallback, and the spec says which it walked.
 */

const READER = () => workerAccount("administrator");

/* Desk from 901px (home/+page.svelte DESK); below it the pocket's hatch,
   whose sign-out plays the same descent (owner, 2026-10-07, on an iPhone:
   "the dice didn't happen in reverse"). The owner's window was narrow, so a
   narrow desk is walked as well as a wide one. */
const WIDTHS = [
  { label: "phone-narrow", width: 400, height: 860 },
  { label: "narrow desk", width: 960, height: 760 },
  { label: "wide desk", width: 1280, height: 800 },
];

async function forceWorld(page: Page) {
  await page.addInitScript(() => {
    if (typeof WebGL2RenderingContext === "undefined") return;
    const proto = WebGL2RenderingContext.prototype;
    const getParameter = proto.getParameter;
    proto.getParameter = function (this: WebGL2RenderingContext, p: number) {
      if (p === 0x9246 /* UNMASKED_RENDERER_WEBGL */) return "e2e forced renderer";
      return getParameter.call(this, p);
    } as typeof proto.getParameter;
    const readPixels = proto.readPixels as (...a: unknown[]) => void;
    proto.readPixels = function (this: WebGL2RenderingContext, ...a: unknown[]) {
      if (a[2] === 1 && a[3] === 1) return;
      return readPixels.apply(this, a);
    } as typeof proto.readPixels;
    const getContext = HTMLCanvasElement.prototype.getContext as (...a: unknown[]) => unknown;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: unknown, attrs?: Record<string, unknown>) {
      if (type === "webgl2" && attrs) {
        const { failIfMajorPerformanceCaveat: _drop, ...rest } = attrs;
        return getContext.call(this, type, rest);
      }
      return getContext.call(this, type, attrs);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
}

/** What the descent drew on, recorded from inside the page at its warp. */
async function watchDescent(page: Page) {
  await page.addInitScript(() => {
    const seen = { world: false, warp: false, withdraw: 0, farewell: 0 };
    (window as unknown as { __descent: typeof seen }).__descent = seen;
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

async function signIn(page: Page) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: READER() }).click();
  await ensureWorkerAdministrator(page);
  await settleArrival(page);
}

async function seedHousehold(page: Page) {
  const name = `sign-out-${randomUUID()}`;
  const id = randomUUID();
  const headers = { ...(await sessionHeaders(page)), "content-type": "application/json" };
  const created = await page.request.post("/api/workspace/commands", {
    headers,
    data: {
      type: "household.create",
      household: {
        id, name, timezone: "Europe/London", currency: "GBP", memberCount: 1, canManage: true,
        onboardingComplete: true,
        sections: [{ id: randomUUID(), name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    },
  });
  if (!created.ok()) throw new Error(`#1262: could not seed household "${name}" (${created.status()})`);
  return { id, name };
}

/** Home as a real sign-in lands on it: the launch marker set, the ascent played. */
async function arriveWithAscent(page: Page, errors: string[]) {
  await page.evaluate(() => sessionStorage.setItem("orbit-launch", "departed"));
  /* #1262: errors are counted from the home that signs out, from the moment
     it is the document. Not before: sign-in can leave the reader on a /home
     that is still loading (its pictures and first reads in flight), and this
     goto cuts that page. WebKit reports
     each in-flight load cut that way as a page error, "Fetch API cannot
     load … due to access control checks.", however the page handles it (its
     fetches are all caught), and a chunk import cut the same way rejects. */
  await page.goto("/home", { waitUntil: "commit" });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.waitForLoadState("load");
  await page.waitForFunction(() => !document.body.classList.contains("launching"), null, { timeout: 150_000 });
  await homeIsLive(page);
  const tour = page.locator("#orbit-tour-transport");
  if (await tour.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(page.locator("#orbit-tour-veil")).toBeHidden();
  }
}

/** Opens whichever menu this width draws and returns it and its sign-out control. */
async function openMenu(page: Page, desk: boolean) {
  if (desk) {
    await page.locator("button.orb").click();
    const menu = page.locator("#account");
    await expect(menu).toHaveClass(/open/);
    return { menu, signOut: menu.locator("button.signout") };
  }
  await page.locator("#morb").click();
  const menu = page.locator('.p-sheet-layer:has(nav[aria-label="Go to"])');
  await expect(menu).toHaveClass(/open/);
  return { menu, signOut: menu.getByRole("button", { name: /sign out/ }) };
}

for (const size of WIDTHS) {
  for (const world of [true, false]) {
    test(`sign out from home's menu reaches the dusk (${size.label}, ${world ? "world forced" : "as the browser is"})`, async ({ page }, info) => {
      test.setTimeout(240_000);
      const desk = size.width >= 901;
      test.skip(info.project.name.startsWith("mobile") && desk, "a phone has no desk");
      test.skip(info.project.name.startsWith("mobile") && !world, "a phone walks it once");
      if (!info.project.name.startsWith("mobile")) await page.setViewportSize({ width: size.width, height: size.height });
      if (world) await forceWorld(page);
      await watchDescent(page);
      const errors: string[] = [];

      await signIn(page);
      const household = await seedHousehold(page);
      try {
        await arriveWithAscent(page, errors);
        const { menu, signOut } = await openMenu(page, desk);
        await menu.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));

        const clicked = Date.now();
        /* one click (owner, 2026-10-06): the plain sign-out no longer arms */
        await signOut.click();

        /* the menu closes by itself as the sign-out starts */
        if (desk) await expect.soft(menu, "#1262: the menu is still open after sign-out started").not.toHaveClass(/open/, { timeout: 2_000 });
        else await expect(menu, "#1262: the menu is still open after sign-out started").toBeHidden({ timeout: 2_000 });
        /* the dusk, the address and the way back */
        /* the dusk itself, drawn (toBeVisible alone ignores opacity, and the
           dusk is on the page from the first beat at opacity 0) */
        await expect.poll(() => page.evaluate(() => {
          const d = document.getElementById("dusk");
          return d ? getComputedStyle(d).opacity : "absent";
        }), { message: "#1262: the dusk never arrived", timeout: 30_000 }).toBe("1");
        const dusk = Date.now() - clicked;
        await expect(page, "#1262: the address never became /logout").toHaveURL(/\/logout$/, { timeout: 30_000 });
        const away = Date.now() - clicked;
        await expect(page.getByRole("link", { name: "Sign back in" })).toBeVisible({ timeout: 10_000 });

        const drawn = await page.evaluate(() => (window as unknown as { __descent?: { world: boolean; warp: boolean; withdraw: number; farewell: number } }).__descent ?? null);
        const took = drawn && drawn.withdraw && drawn.farewell ? Math.round(drawn.farewell - drawn.withdraw) : null;
        console.log(`#1262 ${info.project.name} ${size.label}: descent ${drawn?.warp ? (drawn.world ? "over the WebGL2 world" : "on the canvas") : "not seen"}; dusk ${dusk} ms, /logout ${away} ms after the press; descent ${took ?? "-"} ms`);
        /* the descent keeps time (timeline.js D: farewell at 5350ms), as it
           does on dev, however slowly the frames are drawn: one waiting on
           slow frames is the fault, not a slow machine. Measured in the page,
           first beat to last, so the revocation and the browser's own speed
           at navigating are not counted. */
        expect(took, "#1262: the descent was not seen to start and end").not.toBeNull();
        /* Asked where the fault lived: over the world, whose slow frames the
           capped clock waited on (19s and more on SwiftShader). A canvas
           descent never had the cap, and in a loaded container (WebKit in
           CI's image) its frames alone can run it to 11s, so its time is
           logged above, not judged. 9s leaves the world's own frames room. */
        if (drawn?.world) expect(took ?? 0, "#1262: the descent did not keep time").toBeLessThanOrEqual(9_000);
        if (desk && world && info.project.name === "desktop-chromium") {
          expect(drawn?.world, "#1262: the forced world was not drawn beneath the descent").toBe(true);
        }
        expect(errors, "#1262: the page threw during the sign-out").toEqual([]);
      } finally {
        /* the household goes either way; the sign-out may have revoked the session carrying it */
        const live = await page.evaluate(async () => {
          const r = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
          return ((await r.json()) as { authenticated?: boolean }).authenticated === true;
        }).catch(() => false);
        if (!live) await signIn(page);
        await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
      }
    });
  }
}

/**
 * #1253 (owner, 2026-10-07): "signing out should always play the reverse
 * flight. No matter where you are." Chrome's menu (every desk page but home)
 * revoked and then walked to /logout with no descent, so the dusk was never
 * flown to. Signed out from /settings, with the motion on, the reader must
 * see the descent start and end, the dusk, the address /logout and "Sign back
 * in", as from home.
 */
for (const size of WIDTHS.filter((s) => s.label !== "narrow desk")) {
  test(`sign out from another page's menu plays the descent (${size.label})`, async ({ page }, info) => {
    test.setTimeout(240_000);
    const desk = size.width >= 901;
    test.skip(info.project.name.startsWith("mobile") && desk, "a phone has no desk");
    if (!info.project.name.startsWith("mobile")) await page.setViewportSize({ width: size.width, height: size.height });
    await watchDescent(page);
    const errors: string[] = [];

    await signIn(page);
    const household = await seedHousehold(page);
    try {
      /* Counted from /settings, once it is the document, as arriveWithAscent
         counts from home: this goto cuts the /home that signIn left loading,
         and WebKit reports each cut load as a page error however it is
         caught (CI pipeline 2248). */
      await page.goto("/settings", { waitUntil: "commit" });
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.waitForLoadState("load");
      if (desk) {
        await page.locator("button.orb").click();
      } else {
        await page.locator("button.porb").click();
      }
      const menu = desk ? page.locator("#account") : page.locator('.p-sheet-layer:has(nav[aria-label="Go to"])');
      await expect(menu).toHaveClass(/open/);
      await menu.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
      const signOut = desk ? menu.locator("button.signout") : menu.getByRole("button", { name: /sign out/ });

      await signOut.click();

      /* the menu closes as the sign-out starts (#1262) */
      if (desk) await expect.soft(menu, "#1253: the menu is still open after sign-out started").not.toHaveClass(/open/, { timeout: 2_000 });
      else await expect(menu, "#1253: the menu is still open after sign-out started").toBeHidden({ timeout: 2_000 });
      await expect.poll(() => page.evaluate(() => {
        const d = document.getElementById("dusk");
        return d ? getComputedStyle(d).opacity : "absent";
      }), { message: "#1253: the dusk never arrived", timeout: 30_000 }).toBe("1");
      /* and the page has left with the descent (home's own beats): settings'
         content, the desk's or the phone's, is not left standing over the
         dusk. Its main region and the menu's orb or top bar are looked for where drawn (the desk's
         .page, the phone's main), and at least one must be drawn at all, or
         a width whose other dialect is display:none would pass for nothing. */
      await expect.poll(() => page.evaluate(() => {
        const drawn = [...document.querySelectorAll("main, [role=main], .orb, .p-chrome")]
          .filter((el) => el.getClientRects().length > 0 && !el.closest("#dusk"));
        const standing = drawn.filter((el) => {
          for (let e: Element | null = el; e; e = e.parentElement) {
            const c = getComputedStyle(e);
            if (c.visibility === "hidden" || c.opacity === "0") return false;
          }
          return true;
        });
        return drawn.length === 0 ? "nothing drawn" : standing.length ? "still showing" : "gone";
      }), { message: "#1253: the page is still showing over the dusk", timeout: 10_000 }).toBe("gone");
      await expect(page, "#1253: the address never became /logout").toHaveURL(/\/logout$/, { timeout: 30_000 });
      await expect(page.getByRole("link", { name: "Sign back in" })).toBeVisible({ timeout: 10_000 });

      const drawn = await page.evaluate(() => (window as unknown as { __descent?: { withdraw: number; farewell: number } }).__descent ?? null);
      expect(drawn?.withdraw && drawn?.farewell, "#1253: the descent was not seen to start and end").toBeTruthy();
      expect(errors, "#1253: the page threw during the sign-out").toEqual([]);
    } finally {
      const live = await page.evaluate(async () => {
        const r = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
        return ((await r.json()) as { authenticated?: boolean }).authenticated === true;
      }).catch(() => false);
      if (!live) await signIn(page);
      await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
    }
  });
}
