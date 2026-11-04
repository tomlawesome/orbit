import { expect, test } from "@playwright/test";
import { claimCodeFromLog, claimInstanceAsAdministrator, stackLog } from "./support/bootstrap";
import { bodyClassAdds, bodyClassOrder, bodyClassSeen, witnessBodyClasses } from "./support/arrival";
import { householdRegister } from "./support/households";
import { workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { signIn } from "./support/signed-in";
import { SETTLE } from "./support/settle";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * THE FIRST-RUN DOOR, EVERYWHERE (#840).
 *
 * `/` is the only screen that ever reads GET /api/workspace and decides
 * newcomer vs. onward (web/src/lib/arrival/stage.js's
 * arrivalStageOf) -- but a signed-out reader who first tried to open /home
 * (every "start your own system" pointer on it used to lead straight to the
 * item form) was bounced by hooks.server.js to
 * `/login?returnTo=/home`, and the OIDC callback returned them to exactly
 * that path afterwards. Nothing then sent them on to the arrival: they landed
 * on /home itself, having never met the create questions at all.
 *
 * This spec is the one journey v19-arrival.spec.ts cannot be: every other
 * arrival test signs in AT `/` (through its own gate, or straight at the
 * login route with no returnTo). This one signs in with `returnTo=/home`,
 * the road #840 exists to fix, and asserts the browser ends up at `/` anyway
 * before it ever gets a household.
 *
 * ITS OWN IDENTITY, for the reason "newcomer" needed a fourth: this journey's
 * precondition is a reader who belongs to NOTHING, and the specs inside a
 * file run against one another's leavings. "Doorstep" is signed in nowhere
 * else. #1077's reset between spec files makes that easier to hold, not
 * unnecessary: within this file the identity is still the only guarantee.
 */

const OWN_SYSTEM = `Doorstep's Own ${Date.now()}`;
const households = householdRegister();
let seeded = false;

test.describe.configure({ mode: "serial" });

/*
 * The instance has to be claimed before anybody can sign in at all (#908,
 * ADR-0022): `GET /api/auth/login` answers `bootstrap_required` on an
 * unclaimed one. Every spec in a full run used to leave this to whichever
 * ran first; slice 5 shipped the helper that does it deterministically, from
 * the container's own log, so this file no longer depends on running after
 * somebody else. Idempotent -- an already-claimed instance just signs in.
 */
test.beforeAll(async ({ browser, request }) => {
  /* The local-only profile has no provider to sign the administrator in
     through, and its first run is this file's own journey below (#1263). */
  if (!(await providerConfigured(request))) return;
  await claimInstanceAsAdministrator(browser);
});

/** Whether this stack has an identity provider (the oidc profile) at all. */
async function providerConfigured(request: import("@playwright/test").APIRequestContext) {
  const availability = await (await request.get("/api/auth/availability", { maxRetries: 2 })).json() as { methods: { oidc: boolean } };
  return availability.methods.oidc;
}

/*
 * THE LOCAL FIRST RUN, ONE FLIGHT (#1263). On a provider-less instance
 * nobody has claimed: the claim card, then the first-administrator card
 * (SignIn.svelte's `submitCreate`, which writes the launch marker and goes
 * to `/`), then the newcomer's climb on `/` over an empty labelled sky, no
 * count, and the belong card with its drawer already open. Create goes to
 * /home with no marker: no dawn, no second climb.
 *
 * Runs only where that state exists: `scripts/test-e2e-local.sh --profile
 * local-only --spec tests/e2e/v19-first-run-door.spec.ts`, on a fresh stack.
 * The profile's own list claims the instance in local-sign-in.spec.ts first,
 * so in that lane (and in the oidc lane) this skips.
 */
const LOCAL_ADMINISTRATOR = {
  email: "first-run@example.invalid",
  displayName: "Orbit First Run",
  password: "orbit-e2e-first-run-placeholder",
};
const LOCAL_SYSTEM = `First Run's Own ${Date.now()}`;

test("the local first run flies once and lands on the drawer, then home without a second flight", async ({ page, request }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the unclaimed state exists once per stack: walked on the desk");
  test.skip(await providerConfigured(request), "provider configured: the local first run is the local-only profile's");
  const availability = await (await request.get("/api/auth/availability", { maxRetries: 2 })).json() as { claimed: boolean };
  test.skip(availability.claimed, "already claimed: the first run needs a fresh local-only stack");
  test.setTimeout(120_000);

  await witnessBodyClasses(page);
  const code = claimCodeFromLog(stackLog());
  expect(code, "no claim notice in the stack's log: has orbit-app started?").toBeDefined();
  await page.goto("/login");
  await page.fill("#claimcode", code as string);
  await page.locator("#claimbtn").click();
  await expect(page.locator("#idname")).toBeVisible();
  await page.fill("#idemail", LOCAL_ADMINISTRATOR.email);
  await page.fill("#idname", LOCAL_ADMINISTRATOR.displayName);
  await page.fill("#idpassword", LOCAL_ADMINISTRATOR.password);
  await page.locator("#idbtn").click();

  /* `/`, the climb once, and the card with the drawer down, unprompted */
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await expect.poll(() => bodyClassSeen(page, "showwarp"), { timeout: SETTLE }).toBe(true);
  /* the card is in the document, transparent, for the whole climb; it has
     arrived when `belong` does */
  await expect(page.locator("body")).toHaveClass(/\bbelong\b/, { timeout: 40_000 });
  await expect(page.getByRole("heading", { name: "where do you belong?" })).toBeVisible();
  const handle = page.getByRole("button", { name: "name your own system" });
  await expect(handle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".nf .belong #hhname")).toBeVisible();
  /* the owner's answer (2026-10-06): an empty instance skips the count — the
     card lands with the sky's chrome, ahead of where the count would start,
     and no count is drawn at all */
  const order = await bodyClassOrder(page);
  expect(order).toContain("instrument");
  if (order.includes("counting")) {
    expect(order.indexOf("belong"), "the card waited for the count beat").toBeLessThan(order.indexOf("counting"));
  }
  await expect(page.locator(".nf .disc")).toHaveCount(0);
  expect(await bodyClassAdds(page, "showwarp")).toBe(1);

  await page.fill("#hhname", LOCAL_SYSTEM);
  await page.locator("#gobtn").click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 30_000 });
  await expect(page.locator("#dial-name")).toHaveText(LOCAL_SYSTEM, { timeout: 30_000 });
  expect(await bodyClassSeen(page, "showwarp"), "showwarp seen on /home").toBe(false);
  expect(await bodyClassSeen(page, "showdawn"), "showdawn seen on /home").toBe(false);
});

test.afterAll(async ({ browser }) => {
  if (!seeded) return;
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    /* #1080: signIn lands on the arrival or /home, whichever a fresh worker
       administrator belongs to, and holds administrator access: the sweep's
       hard delete is an instance-admin power. */
    await signIn(page);
    await households.sweep(page);
  } finally {
    await context.close();
  }
});

test("a fresh sign-in returned to /home meets the arrival, not the item form", async ({ page, request }) => {
  test.skip(!(await providerConfigured(request)), "signs in through the identity provider");
  test.setTimeout(120_000);

  /* THE WHOLE POINT: a signed-out visit to /home is exactly what carries this
     returnTo (hooks.server.js's OPEN_ROUTES gate, then the login route's own
     redirect), and the OIDC callback returns the browser to it verbatim
     (web/src/routes/api/auth/callback/+server.js). A session with no active
     household is sent to `/` regardless of the URL it was returned to -- that
     is the server hook this spec exists to prove, not the arrival's own
     client-side decision, which every other arrival spec already covers by
     visiting `/` directly. */
  /* settle: false -- the landing IS the subject of this test. */
  await signIn(page, { account: workerAccount("doorstep"), returnTo: "/home", settle: false });
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });

  /* The newcomer's question either way (#1263): on an empty instance its
     "name your own system" drawer is already open, otherwise it opens it. */
  await expect(page.getByRole("heading", { name: "where do you belong?" })).toBeVisible({ timeout: 30_000 });
  const handle = page.getByRole("button", { name: "name your own system" });
  if ((await handle.getAttribute("aria-expanded")) !== "true") await handle.click();
  await expect(page.locator(".nf .belong #hhname")).toBeVisible();
  await expect(page.locator("#gate")).toHaveCount(0);

  /* THE CREATE, through the drawer itself -- not the seam -- because the
     point of this spec is that a first-timer returned to /home reaches this
     UI at all. */
  await page.fill("#hhname", OWN_SYSTEM);
  /* #862 round 3: the act reads `Create`, one word, and no longer grows with
     the typed name — the owner's ratified rule, so what is asserted is that
     the button is armed by a name, not that it repeats one. */
  await expect(page.locator("#gobtn")).toHaveText("Create");
  await expect(page.locator("#gobtn")).toBeEnabled();
  const zone = await page.locator("#tz").inputValue();
  const money = await page.locator("#cur").inputValue();
  await page.locator("#gobtn").click();

  /* THE LANDING: the browser actually reaches /home --
     the door handed a first-timer on, the same promise its own returnTo made
     and, before #840, never kept. */
  await expect(page).toHaveURL(/\/home$/, { timeout: 30_000 });
  await expect(page.locator("#dial-name")).toHaveText(OWN_SYSTEM);

  /* The server's own account of it: one system, theirs, with the answers the
     drawer asked for. */
  const workspace = await page.evaluate(async () => {
    const response = await fetch("/api/workspace", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`workspace read failed: ${response.status}`);
    const { workspace } = (await response.json()) as {
      workspace: { households: { id: string; name: string; canManage: boolean; onboardingComplete: boolean; timezone: string; currency: string }[] };
    };
    return workspace;
  });
  expect(workspace.households).toHaveLength(1);
  expect(workspace.households[0]).toMatchObject({
    name: OWN_SYSTEM,
    canManage: true,
    onboardingComplete: true,
    timezone: zone,
    currency: money,
  });
  households.track(workspace.households[0]);
  seeded = true;

  /* And the door hands them straight on now: household.create set this
     reader's own session onto the household it made, in the same
     transaction, so hooks.server.js never has anything left to ask. */
  await page.goto("/");
  await expect(page).toHaveURL(/\/home$/, { timeout: 30_000 });
});

/*
 * The door's cards (the claim card, the notice's link, the local-only sign-in
 * card, mixed mode, the local login line staying off, and the setup screen)
 * moved to the rig (ADR-0039, #1610): web/tests/rig/v19-first-run-door.spec.js.
 * What is left here needs a real instance: the local first run and a fresh
 * sign-in returned to /home.
 */
