import { expect, test, type Page } from "@playwright/test";
import { claimCodeFromLog, stackLog } from "./support/bootstrap";
import { bodyClassSeen, witnessBodyClasses } from "./support/arrival";
import { resetDatabaseBetweenSpecFiles } from "./support/database";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * AN ORBIT WITH NO IDENTITY PROVIDER AT ALL (#916, ADR-0022, ADR-0023 §1).
 *
 * The whole reason M7 exists: an operator who has no OIDC provider, and no
 * intention of running one, installs Orbit and uses it. This is that person's
 * entire first hour, walked end to end -- claim the instance from the code in
 * the container's log, become the first administrator, sign out, and sign
 * back in with the password they just chose.
 *
 * It runs against compose/docker-compose.local-only.yml, where
 * `ORBIT_AUTH_OIDC=false` and no provider sidecar exists at all, so nothing
 * here can be quietly carried by the provider the ordinary acceptance stack
 * has. `scripts/test-e2e-local.sh --profile local-only` and the
 * `smoke_local_only` job in .gitlab-ci.yml are the two callers;
 * tests/e2e/local-only-specs.txt is the list they share.
 *
 * ORDER AND ISOLATION, for the same reason bootstrap-protection.spec.ts has a
 * note about it: the claim happens once per stack, so the unclaimed state
 * belongs to whichever file runs first. #1077's reset is silent in this
 * profile and has to be -- claim.setup.ts skips itself where there is no
 * provider, so no seed is ever taken, and this file's own precondition is an
 * instance nobody has claimed. In this profile that is this one -- it sorts ahead of
 * `signed-out`, and the two projects run in declaration order, so the claim
 * is desktop's. Mobile would meet an instance this run had already claimed,
 * which is why the file is desktop-only: nothing in it renders differently on
 * a phone, and the door's own layout is covered where layout is the subject.
 */

const DESKTOP_PROJECT = "desktop-chromium";

/**
 * The first administrator this profile creates. The address is deliberately
 * the same literal tests/e2e/signed-out.spec.ts probes with: that spec's
 * point is that an address which exists and one which does not are answered
 * identically, and it can only make that claim if one of the addresses it
 * tries is real here.
 */
const ADMINISTRATOR = {
  email: "administrator@example.invalid",
  displayName: "Orbit Local Administrator",
  password: "orbit-e2e-local-only-placeholder",
};

test.describe.configure({ mode: "serial", retries: 0 });

test.beforeAll(async ({ request }) => {
  test.skip(
    test.info().project.name !== DESKTOP_PROJECT,
    "the unclaimed state exists once per stack, so this file runs under one project",
  );
  /* The whole-suite run is the oidc profile, where this journey has no
     meaning: the provider claims the instance, and the door has no local
     card. Skip the file there, so that the one stack that can walk it (the
     local-only lane) is the only one judged. */
  const availability = await (await request.get("/api/auth/availability")).json() as { methods: { oidc: boolean } };
  test.skip(availability.methods.oidc, "provider configured: this journey runs in the local-only profile");
});

/**
 * Sign-out, as the product's own control performs it
 * (`signOut` in web/src/lib/data/workspace.js, called by Chrome.svelte's
 * two-tap button): read the CSRF token off the session, then POST it. Driven
 * from the page rather than through the button because Chrome only exists on
 * a screen this administrator cannot reach yet -- they have no household, and
 * hooks.server.js sends a household-less session to the arrival -- and
 * creating one to press a button would be testing the arrival. The button
 * itself is walked in v19-screen-reader.spec.ts.
 */
async function signOut(page: Page): Promise<void> {
  const status = await page.evaluate(async () => {
    const session = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
    const { csrfToken } = (await session.json()) as { csrfToken: string };
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "x-csrf-token": csrfToken },
    });
    return response.status;
  });
  expect(status).toBe(200);
}

test("the operator claims a provider-less Orbit and becomes its administrator", async ({ page, request }) => {
  test.setTimeout(120_000);

  const before = await (await request.get("/api/auth/availability")).json() as {
    claimed: boolean; methods: { local: boolean; oidc: boolean; localAccounts: boolean };
  };
  expect(
    before.claimed,
    "this instance is already claimed, so the claim journey cannot be walked. This file "
      + "has to run first in the local-only profile -- see tests/e2e/local-only-specs.txt.",
  ).toBe(false);
  /* The profile itself, asserted rather than assumed: no provider, and no
     local account yet either. A stack that had quietly kept OIDC on would
     make everything below prove something else. */
  expect(before.methods.oidc, "this is not a local-only stack: OIDC is configured").toBe(false);
  expect(before.methods.local).toBe(true);
  expect(before.methods.localAccounts).toBe(false);

  /* THE CODE, off the container's own log, which is the only place it is
     (ADR-0022 §1) and exactly where the card tells the operator to look. */
  const code = claimCodeFromLog(stackLog());
  expect(code, "no claim notice in the stack's log: has orbit-app started?").toBeDefined();

  await page.goto("/login");
  await expect(page.locator("#claimcode")).toBeVisible();
  /* No gate: there is no provider to offer, and nobody to sign in as. */
  await expect(page.locator("#gate")).toHaveCount(0);

  await page.fill("#claimcode", code as string);
  await page.locator("#claimbtn").click();

  /* THE CREATE CARD, revealed by the claim: the identity of the first
     administrator. And no provider line under it, because there is no
     provider -- the ruling puts that line there only when there is one. */
  await expect(page.locator("#idname")).toBeVisible();
  await expect(page.locator(".card .quietline")).toHaveCount(0);
  await page.fill("#idemail", ADMINISTRATOR.email);
  await page.fill("#idname", ADMINISTRATOR.displayName);
  await page.fill("#idpassword", ADMINISTRATOR.password);
  await expect(page.locator("#idbtn")).toHaveText("Create");
  await page.locator("#idbtn").click();

  /* Signed in, and landed on the first-run arrival -- the same place an
     identity provider's callback would have put them. */
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  const session = await page.request.get("/api/auth/session");
  expect(session.ok()).toBe(true);
  expect((await session.json()) as { user: { displayName: string } })
    .toMatchObject({ user: { displayName: ADMINISTRATOR.displayName } });

  /* The instance is claimed once and for all, and it now has a password on
     it -- which is the fact the door needs to offer local sign-in at all. */
  const after = await (await request.get("/api/auth/availability")).json() as {
    claimed: boolean; methods: { localAccounts: boolean };
  };
  expect(after.claimed).toBe(true);
  expect(after.methods.localAccounts).toBe(true);
});

test("signing out really ends the session", async ({ page }) => {
  await page.goto("/");
  await signOut(page);

  /* Gone on the server, not just forgotten by the tab: the next request for a
     gated screen is turned away at the hook, before any of it is sent. */
  const gated = await page.request.get("/settings", { maxRedirects: 0 });
  expect(gated.status()).toBe(303);
  expect(gated.headers()["location"]).toBe("/login?returnTo=%2Fsettings");
  const session = await page.request.get("/api/auth/session");
  expect(session.status()).toBe(401);
});

test("and the password signs them back in", async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto("/login");

  /* A CLAIMED LOCAL-ONLY INSTANCE, for real this time. v19-first-run-door
     .spec.ts asserts this face against a stubbed availability answer, because
     the ordinary stack cannot be in this state; here the instance genuinely
     is, and the card in the ring is what it genuinely draws. */
  await expect(page.locator("#idemail")).toBeVisible();
  await expect(page.locator("#idpassword")).toBeVisible();
  await expect(page.locator("#idname")).toHaveCount(0);
  await expect(page.locator("#gate")).toHaveCount(0);
  await expect(page.locator("#idbtn")).toHaveText("Sign in");

  /* The wrong password first, because "it signed me in" is only worth
     something if something else would not have. One sentence back, naming
     neither the field nor the account (ADR-0023 §4). */
  await page.fill("#idemail", ADMINISTRATOR.email);
  await page.fill("#idpassword", `${ADMINISTRATOR.password}-not`);
  await page.locator("#idbtn").click();
  await expect(page.locator(".err.shown")).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/auth/session")).status()).toBe(401);

  /* And then the right one. */
  await page.fill("#idpassword", ADMINISTRATOR.password);
  await page.locator("#idbtn").click();

  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  const session = await page.request.get("/api/auth/session");
  expect(session.ok()).toBe(true);
  expect((await session.json()) as { user: { displayName: string } })
    .toMatchObject({ user: { displayName: ADMINISTRATOR.displayName } });
});

/*
 * ══ NO SIGN-IN CARD OVER ANY ARRIVAL STAGE (#1271) ═══════════════════════
 *
 * On a local-only instance the door draws its sign-in card from the PUBLIC
 * availability answer, whoever is signed in -- so a reader who has gone
 * through the door carries a `.ringcard` layer into the arrival, over the
 * newcomer's sky, where it can sit on top of the drawer and take its clicks.
 * #1263 stopped drawing it once the arrival leaves the door
 * (Arrival.svelte's `past-door`, arrival.css); nothing walked it on a stack
 * where it can exist. The oidc profile cannot: its door has no local card.
 *
 * The administrator above belongs to nothing, so this is the empty
 * instance's newcomer. The stages a local-only reader can reach:
 *   · the climb the sign-in card's own departure owes (launch marker set);
 *   · the arrival with no climb owed (a refresh, a bookmark, a Back), drawer
 *     open because there is nothing to ask to join;
 *   · the same with systems on the sky -- the count and the chooser -- which
 *     this stack cannot hold without making a household the next spec's
 *     privacy checks would then see, so the workspace read is answered in the
 *     browser (the way v19-first-run-door.spec.ts answers availability);
 *   · an invited reader's first landing, the session's `justJoined` stubbed
 *     for the same reason.
 * At every one: no `.ringcard` is drawn while the newcomer's frame is, and
 * the stage's own main control is what a click at its centre reaches.
 */

/** Signs in with the local password, from the door's own route, with no launch owed. */
async function signInWithoutLaunch(page: Page): Promise<void> {
  await page.goto("/login");
  const status = await page.evaluate(async ({ email, password }) => {
    const response = await fetch("/api/auth/local/login", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    return response.status;
  }, ADMINISTRATOR);
  expect(status).toBe(200);
}

/**
 * Frame by frame, from inside the page: is any `.ringcard` drawn (has a box)
 * while the newcomer's own frame (`.nf`) is in the document? Sampled every
 * animation frame because the climb is seconds long and a poll from outside
 * can miss it whole (the same reason witnessBodyClasses is an observer).
 */
async function watchCardLayer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = { frames: 0, drawn: 0 };
    (window as unknown as { __orbitCardLayer: typeof seen }).__orbitCardLayer = seen;
    const sample = () => {
      if (document.querySelector(".nf")) {
        seen.frames += 1;
        if ([...document.querySelectorAll(".ringcard")].some((layer) => layer.getClientRects().length > 0)) seen.drawn += 1;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function cardLayerSamples(page: Page): Promise<{ frames: number; drawn: number }> {
  return page.evaluate(() => (window as unknown as { __orbitCardLayer: { frames: number; drawn: number } }).__orbitCardLayer);
}

/** No sign-in card layer is drawn, now, and none was in any frame the newcomer's frame was up. */
async function expectNoCardLayer(page: Page, where: string): Promise<void> {
  await expect(page.locator(".nf"), `${where}: the newcomer's frame is not up`).toBeAttached();
  const drawn = await page.evaluate(
    () => [...document.querySelectorAll(".ringcard")].filter((layer) => layer.getClientRects().length > 0).length,
  );
  expect(drawn, `${where}: a sign-in card layer is drawn over the arrival`).toBe(0);
  const samples = await cardLayerSamples(page);
  expect(samples.frames, `${where}: the frame sampler never saw the newcomer's frame`).toBeGreaterThan(0);
  expect(samples.drawn, `${where}: a sign-in card layer was drawn in ${samples.drawn} of ${samples.frames} frames`).toBe(0);
}

/** A click at the control's centre lands on the control itself, not on a layer above it. */
async function expectClickReaches(page: Page, control: ReturnType<Page["locator"]>, where: string): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  await expect.poll(async () => control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (!hit) return "nothing at the control's centre";
    if (hit.closest(".ringcard")) return "the sign-in card layer";
    return element === hit || element.contains(hit) ? "the control" : `something else: <${hit.tagName.toLowerCase()} class="${hit.className}">`;
  }), { message: `${where}: a click at the control's centre`, timeout: 10_000 }).toBe("the control");
}

const NO_HOUSEHOLD_SKY = {
  version: 1,
  householdLanding: "choose",
  activeHouseholdId: null,
  households: [],
  recoverableHouseholds: [],
  visibleHouseholds: [
    { id: "hh-stub-1", name: "Stub Harbour", requested: false },
    { id: "hh-stub-2", name: "Stub Cottage", requested: false },
  ],
};

test("no sign-in card sits over the climb, or the drawer it lands on", async ({ page }) => {
  test.setTimeout(120_000);
  await watchCardLayer(page);
  await witnessBodyClasses(page);

  /* The card's own departure: it writes the launch marker, so the arrival
     flies. This is the only road that crosses from the card to the climb. */
  await page.goto("/login");
  await expect(page.locator("#idbtn")).toHaveText("Sign in");
  await page.fill("#idemail", ADMINISTRATOR.email);
  await page.fill("#idpassword", ADMINISTRATOR.password);
  await page.locator("#idbtn").click();

  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await expect.poll(() => bodyClassSeen(page, "showwarp"), { timeout: 20_000 }).toBe(true);
  await expect(page.locator(".nf")).toBeAttached();
  /* mid-climb */
  await expectNoCardLayer(page, "the climb");

  /* landed: the card with the drawer already open, an empty instance */
  await expect(page.locator("body")).toHaveClass(/\bbelong\b/, { timeout: 40_000 });
  await expectNoCardLayer(page, "the landing");
  await expectClickReaches(page, page.locator(".nf .belong #hhname"), "the drawer's name field");
  await expectClickReaches(page, page.locator("#gobtn"), "the drawer's Create");
  await expectClickReaches(page, page.getByRole("button", { name: "name your own system" }), "the drawer's handle");
});

test("no sign-in card sits over the arrival with no climb owed", async ({ page }) => {
  await watchCardLayer(page);
  await signInWithoutLaunch(page);
  await page.goto("/");

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
  await signInWithoutLaunch(page);
  await page.route("**/api/workspace", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ workspace: NO_HOUSEHOLD_SKY }) }));
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "where do you belong?" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("body")).toHaveClass(/\bbelong\b/);
  await expect(page.locator(".nf .disc")).toBeVisible();
  await expectNoCardLayer(page, "the chooser");
  await expectClickReaches(page, page.getByRole("button", { name: "Request to join Stub Harbour" }), "a system's ask to join");
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
  await signInWithoutLaunch(page);
  /* The invited landing hands on to /home at the beat the chooser would
     stand on; with the session stubbed it has nowhere real to go, so that
     navigation is answered with a blank page and the climb is judged before it. */
  await page.route("**/home", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>home</title>" }));
  await page.route("**/api/auth/session", async (route) => {
    const real = await route.fetch();
    const session = await real.json() as Record<string, unknown>;
    await route.fulfill({
      response: real,
      json: { ...session, activeHouseholdId: "hh-stub-1", justJoined: true, visibleHouseholds: NO_HOUSEHOLD_SKY.visibleHouseholds },
    });
  });
  await page.goto("/");
  await expect.poll(() => bodyClassSeen(page, "showwarp"), { timeout: 20_000 }).toBe(true);
  await expect(page.locator(".nf")).toBeAttached();
  await expectNoCardLayer(page, "the invited climb");
});
