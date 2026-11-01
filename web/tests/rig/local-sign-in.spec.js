import { expect, test } from "@playwright/test";

import { bodyClassSeen, witnessBodyClasses } from "../../../tests/e2e/support/arrival";
import { cardLayerSamples, watchCardLayer } from "../../../tests/e2e/support/card-layer";
import { SETTLE } from "../../../tests/e2e/support/settle";
import { APP, door } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Page} Page */
/** @typedef {import("@playwright/test").Locator} Locator */

/*
 * NO SIGN-IN CARD OVER ANY ARRIVAL STAGE (#1271), moved to the rig
 * (ADR-0039, #1610) from tests/e2e/local-sign-in.spec.ts.
 *
 * On a local-only instance the door draws its sign-in card from the PUBLIC
 * availability answer, whoever is signed in -- so a reader who has gone
 * through the door carries a `.ringcard` layer into the arrival, over the
 * newcomer's sky, where it can sit on top of the drawer and take its clicks.
 * #1263 stopped drawing it once the arrival leaves the door (Arrival.svelte's
 * `past-door`, arrival.css). At every stage: no `.ringcard` is drawn while the
 * newcomer's frame is, and the stage's own main control is what a click at its
 * centre reaches.
 *
 * What stays on the stack, in tests/e2e/local-sign-in.spec.ts: the claim from
 * the container's log, the first administrator, signing out for real and the
 * password sign-in. They need the unclaimed instance, the log and a real
 * session cookie.
 *
 * Every test starts on the local-only door (`login` / `local-card`: a claimed
 * instance with no provider, the card up) so the availability answer that
 * draws the card is in place for the arrival that follows it, and then walks
 * the fixture app's own arrival addresses (`/?arrival=newcomer`, with
 * `&drawer=1` for the drawer open). Those answer the data; the launch marker
 * the card's own departure writes still decides whether the climb flies
 * (Arrival.svelte: "the fixture replaces the DATA, never the trigger").
 *
 * The stack version walked an empty instance for the climb, the landing and
 * the no-climb arrival; the fixture newcomer has five systems out there, so
 * the drawer is opened by `drawer=1` where an empty instance opens it itself.
 * The assertions are the stack version's own.
 */
test.use({ baseURL: APP });

/**
 * No sign-in card layer is drawn, now, and none was drawn at any change while
 * the newcomer's frame was up.
 * @param {Page} page
 * @param {string} where
 */
async function expectNoCardLayer(page, where) {
  await expect(page.locator(".nf"), `${where}: the newcomer's frame is not up`).toBeAttached();
  const drawn = await page.evaluate(
    () => [...document.querySelectorAll(".ringcard")].filter((layer) => layer.getClientRects().length > 0).length,
  );
  expect(drawn, `${where}: a sign-in card layer is drawn over the arrival`).toBe(0);
  const samples = await cardLayerSamples(page);
  /* A watcher that never ran cannot pass: the page changed at least once
     while it was looking (T-Q34, L-Q3). */
  expect(samples.changes, `${where}: the card-layer watcher saw no change to the page, so its silence says nothing`).toBeGreaterThan(0);
  expect(samples.drawn, `${where}: a sign-in card layer was drawn at ${samples.drawn} samples of the page`).toBe(0);
}

/**
 * A click at the control's centre lands on the control itself, not on a layer
 * above it.
 * @param {Page} page
 * @param {Locator} control
 * @param {string} where
 */
async function expectClickReaches(page, control, where) {
  await control.scrollIntoViewIfNeeded();
  await expect.poll(async () => control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (!hit) return "nothing at the control's centre";
    if (hit.closest(".ringcard")) return "the sign-in card layer";
    return element === hit || element.contains(hit) ? "the control" : `something else: <${hit.tagName.toLowerCase()} class="${hit.className}">`;
  }), { message: `${where}: a click at the control's centre`, timeout: 10_000 }).toBe("the control");
}

test("no sign-in card sits over the climb, or the drawer it lands on", async ({ page }) => {
  test.setTimeout(120_000);
  await watchCardLayer(page);
  await witnessBodyClasses(page);

  await door("login", "local-card")(page);
  /* The card's own departure writes the launch marker, so the arrival flies:
     the only road that crosses from the card to the climb. It leaves for its
     returnTo, which names the fixture arrival with its drawer open; the write
     it makes is answered here, as the local sign-in would on the stack. */
  await page.goto(`/login?returnTo=${encodeURIComponent("/?arrival=newcomer&drawer=1")}`);
  await expect(page.locator("#idbtn")).toHaveText("Sign in");
  await page.route("**/api/auth/local/login", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.fill("#idemail", "ned@harlow.example");
  await page.fill("#idpassword", "a fixture password");
  await page.locator("#idbtn").click();

  await expect(page).toHaveURL(/\/\?arrival=newcomer/);
  await expect.poll(() => bodyClassSeen(page, "showwarp"), { timeout: SETTLE }).toBe(true);
  await expect(page.locator(".nf")).toBeAttached();
  /* mid-climb */
  await expectNoCardLayer(page, "the climb");

  /* landed: the card with the drawer open */
  await expect(page.locator("body")).toHaveClass(/\bbelong\b/, { timeout: 40_000 });
  await expectNoCardLayer(page, "the landing");
  await expectClickReaches(page, page.locator(".nf .belong #hhname"), "the drawer's name field");
  await expectClickReaches(page, page.locator("#gobtn"), "the drawer's Create");
  await expectClickReaches(page, page.getByRole("button", { name: "name your own system" }), "the drawer's handle");
});

test("no sign-in card sits over the arrival with no climb owed", async ({ page }) => {
  await watchCardLayer(page);
  await door("login", "local-card")(page);
  await page.goto("/?arrival=newcomer&drawer=1");

  await expect(page.getByRole("heading", { name: "where do you belong?" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("body")).toHaveClass(/\bbelong\b/);
  await expectNoCardLayer(page, "the arrival, no climb");
  /* the north star's "create" opens the drawer too; the stars' layer is
     drawn after it and must not take its click (#1277) */
  await expectClickReaches(page, page.locator(".nf .nstar"), "the north star");
  await expectClickReaches(page, page.locator(".nf .belong #hhname"), "the drawer's name field");
  await expectClickReaches(page, page.locator("#gobtn"), "the drawer's Create");
  await expectClickReaches(page, page.getByRole("button", { name: "name your own system" }), "the drawer's handle");

  /* and the handle really works, which a layer over it would prevent */
  await page.getByRole("button", { name: "name your own system" }).click();
  await expect(page.getByRole("button", { name: "name your own system" })).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "name your own system" }).click();
  await expect(page.locator(".nf .belong #hhname")).toBeVisible();
});

test("no sign-in card sits over the chooser and the count", async ({ page }) => {
  await watchCardLayer(page);
  await door("login", "local-card")(page);
  await page.goto("/?arrival=newcomer");

  await expect(page.getByRole("heading", { name: "where do you belong?" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("body")).toHaveClass(/\bbelong\b/);
  await expect(page.locator(".nf .disc")).toBeVisible();
  await expectNoCardLayer(page, "the chooser");
  await expectClickReaches(page, page.getByRole("button", { name: "Request to join Harlow Home" }), "a system's ask to join");
  await expectClickReaches(page, page.getByRole("button", { name: "name your own system" }), "the drawer's handle");
  /* the handle opens the drawer, and the drawer's field takes the click too */
  const handle = page.getByRole("button", { name: "name your own system" });
  if ((await handle.getAttribute("aria-expanded")) !== "true") await handle.click();
  await expectClickReaches(page, page.locator(".nf .belong #hhname"), "the drawer's name field");
});

test("no sign-in card sits over an invited reader's landing", async ({ page }) => {
  test.setTimeout(120_000);
  await watchCardLayer(page);
  await witnessBodyClasses(page);
  /* MISSING FIXTURE STATE, by this name (pocket-states.js has none, so this
     test fails here until it exists). It must give, on `/`:
       - the local-only door's availability answer (as `login` / `local-card`),
         so the card that must not be carried over exists to be carried;
       - `GET /api/auth/session` answering authenticated, with
         `activeHouseholdId` set, `justJoined: true` and `visibleHouseholds`
         holding two systems (`{ id, name, requested: false }`), which is what
         makes the arrival an invited reader's landing (stage.js
         `isInvitedLanding`) rather than a member's hand-on;
       - `/home` answered with a blank page, so the landing's hand-on at the
         beat the chooser would stand on leaves nothing to judge and the climb
         is judged before it.
     The arrival it reaches is `/`, landed on and left running (the climb). */
  await door("arrival", "invited-landing-local-only")(page);
  await expect.poll(() => bodyClassSeen(page, "showwarp"), { timeout: SETTLE }).toBe(true);
  await expect(page.locator(".nf")).toBeAttached();
  await expectNoCardLayer(page, "the invited climb");
});
