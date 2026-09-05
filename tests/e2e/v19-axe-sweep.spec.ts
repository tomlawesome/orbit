import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { cleanupHousehold, sessionHeaders } from "./support/households";

/**
 * #496: a full axe sweep across every SIGNED-IN v19 route, in both dialects.
 *
 * signed-out.spec.ts:119-128 already covers the door itself; this file picks
 * up everything behind it. Both Playwright projects run by default
 * (playwright.config.ts), which matters here specifically because `/home`
 * draws one of two dialects chosen by viewport (gravity-well dial on desktop,
 * the pocket dial on mobile) — the other routes are dialect-blind, but
 * running them twice costs little and is never wrong.
 *
 * `/mobile` is not swept on its own: web/src/routes/mobile/+page.js is a bare
 * 308 redirect onto `/home` (the pocket dialect moved onto home's own URL,
 * CON-10/#430), so there is no second screen there to check — `/home`'s own
 * tests already cover what renders.
 *
 * Each test signs in as "Orbit Administrator" fresh (the disposable OIDC
 * provider's identity list, same as v19-tour.spec.ts) and asserts one route
 * or one overlay state, so a failing axe rule points straight at what was on
 * screen. Where a violation is real, the assertion is left failing rather
 * than filtered or skipped — see the individual `expect` calls below.
 */

const READER = "Orbit Administrator";
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function signIn(page: Page, returnTo: string) {
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("link", { name: READER }).click();
}

/**
 * The station backdrop's layers (`$lib/backdrops/station.js`) are pure
 * decoration and already `aria-hidden`: constellation names, "0 ITEMS"
 * satellite captions, bearing marks. axe still measures their contrast, and
 * WCAG 1.4.3 exempts decorative text, so they are excluded here rather than
 * lifted -- the chart pen is faint on purpose.
 */
const DECORATIVE_BACKDROP = '.layer[aria-hidden="true"]';

async function axeCheck(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .exclude(DECORATIVE_BACKDROP)
    .analyze();
  expect(results.violations).toEqual([]);
}

/**
 * Lands on `/home` and settles it into a known base state: the tour
 * dismissed if it happened to be showing (a fresh instance or a reset record
 * from another run would otherwise leak into every other assertion here),
 * and one dial visible. Every other `/home` state below builds on this.
 */
async function settleHome(page: Page) {
  await expect(page).toHaveURL(/\/home$/, { timeout: 30_000 });
  await page
    .waitForResponse(
      (response) => response.url().includes("/api/settings/tour") && response.request().method() === "GET",
      { timeout: 30_000 },
    )
    .catch(() => {});
  const card = page.locator(".tourcard");
  if (await card.count()) {
    await page.locator("#tour-skip").click();
    await expect(card).toHaveCount(0);
  }
  await expect(page.locator(".dialwrap, .mdial").filter({ visible: true })).toHaveCount(1);
}

/**
 * A household of the signed-in reader's own, through the same
 * `household.create` / `item.upsert` commands v19-entry.spec.ts and
 * v19-create.spec.ts use. Named distinctively (#496's own prefix plus a
 * random id) since other specs may run against the same shared stack at the
 * same time.
 */
async function seedHousehold(page: Page, options: { withItem?: boolean } = {}) {
  const name = `axe-sweep-${randomUUID()}`;
  const householdId = randomUUID();
  const sectionId = randomUUID();
  const headers = { ...(await sessionHeaders(page)), "content-type": "application/json" };

  const created = await page.request.post("/api/workspace/commands", {
    headers,
    data: {
      type: "household.create",
      household: {
        id: householdId,
        name,
        timezone: "Europe/London",
        currency: "GBP",
        memberCount: 1,
        canManage: true,
        onboardingComplete: true,
        sections: [{ id: sectionId, name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    },
  });
  if (!created.ok()) throw new Error(`#496: could not seed household "${name}" (${created.status()})`);

  let itemId: string | undefined;
  if (options.withItem) {
    itemId = randomUUID();
    const dueDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    const itemCreated = await page.request.post("/api/workspace/commands", {
      headers,
      data: {
        type: "item.upsert",
        householdId,
        item: {
          id: itemId,
          sectionId,
          title: "axe-sweep item",
          currency: "GBP",
          scheduleKind: "service",
          dueDate,
          recurrenceMonths: 12,
          status: "active",
        },
        activity: { id: randomUUID(), itemId, kind: "created", occurredAt: new Date().toISOString() },
      },
    });
    if (!itemCreated.ok()) {
      throw new Error(`#496: could not seed item for "${name}" (${itemCreated.status()})`);
    }
  }

  return { id: householdId, name, itemId };
}

/** #730: every household this file makes is removed, even when the test fails. */
async function cleanup(page: Page, household: { id: string; name: string }) {
  await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
}

/**
 * Signs in, seeds a household of the reader's own and settles on the dial.
 * Without a household `/home` is the adrift screen and draws no dial at all,
 * so on a fresh instance every `/home` state here would fail in settleHome
 * (caught the first time the file ran against a stack no other spec had
 * seeded). Callers clean up in `finally`.
 */
async function arriveWithHousehold(page: Page) {
  await signIn(page, "/home");
  const household = await seedHousehold(page);
  await page.goto("/home");
  await settleHome(page);
  return household;
}

test.describe("the signed-in v19 sweep", () => {
  test("/home has no automated WCAG A/AA violations", async ({ page }) => {
    const household = await arriveWithHousehold(page);
    try {
      await axeCheck(page);
    } finally {
      await cleanup(page, household);
    }
  });

  // `button.orb`, `#nstar`, `#edge-health` and `#keydrawer` are the DESKTOP
  // chrome (home.css scopes them under `.desk`); the pocket dialect draws its
  // own account trigger (`.morb`, pocket.svelte) and has no drawers of its
  // own at all. Confirmed by running these against mobile-chromium first:
  // every one of the four times out with "element is not visible" rather
  // than finding a pocket equivalent, so there is nothing there for axe to
  // examine on that dialect.
  test("/home account panel open has no automated WCAG A/AA violations", async ({ page, isMobile }) => {
    test.skip(isMobile, "the account panel is desk-only chrome; the pocket dialect has no drawers");
    const household = await arriveWithHousehold(page);
    try {
      await page.locator("button.orb").click();
      await expect(page.locator("button.orb")).toHaveAttribute("aria-expanded", "true");
      await axeCheck(page);
    } finally {
      await cleanup(page, household);
    }
  });

  test("/home add-to-orbit drawer open has no automated WCAG A/AA violations", async ({ page, isMobile }) => {
    test.skip(isMobile, "the create drawer is desk-only chrome; the pocket dialect has no drawers");
    const household = await arriveWithHousehold(page);
    try {
      await page.locator("#nstar").click();
      await expect(page.locator("#nstar")).toHaveAttribute("aria-expanded", "true");
      await axeCheck(page);
    } finally {
      await cleanup(page, household);
    }
  });

  test("/home system-status drawer open has no automated WCAG A/AA violations", async ({ page, isMobile }) => {
    test.skip(isMobile, "the status drawer is desk-only chrome; the pocket dialect has no drawers");
    const household = await arriveWithHousehold(page);
    try {
      await page.locator("#edge-health").click();
      await expect(page.locator("#edge-health")).toHaveAttribute("aria-expanded", "true");
      await axeCheck(page);
    } finally {
      await cleanup(page, household);
    }
  });

  // The chart-key drawer only exists once the reader belongs to a household
  // (`{#if !view?.emptySky}`, web/src/routes/home/+page.svelte), so this one
  // seeds its own rather than depending on whatever the shared instance
  // happens to hold.
  test("/home chart-key drawer open has no automated WCAG A/AA violations", async ({ page, isMobile }) => {
    test.skip(isMobile, "the key drawer is desk-only chrome; the pocket dialect has no drawers");
    // Seeding, an axe pass over a chart-heavy dial, and cleanup have occasionally
    // outrun the 30s default against the shared stack; give this one room.
    test.setTimeout(60_000);
    await signIn(page, "/home");
    const household = await seedHousehold(page);
    try {
      await page.goto("/home");
      await settleHome(page);
      const handle = page.locator("#keydrawer button.handle");
      await handle.click();
      await expect(handle).toHaveAttribute("aria-expanded", "true");
      await axeCheck(page);
    } finally {
      await cleanup(page, household);
    }
  });

  // Forces the first-run walk the way "take the walk again" does
  // (PUT /api/settings/tour {tourSeenAt:null}), same as v19-tour.spec.ts, then
  // restores it by skipping — leaving the record as "taken" again so a later
  // arrival on this reader, in this file or another, does not meet an
  // unexpected walk.
  test("/home first-run tour overlay has no automated WCAG A/AA violations", async ({ page }) => {
    await signIn(page, "/home");
    await expect(page).toHaveURL(/\/home$/, { timeout: 30_000 });
    const headers = { ...(await sessionHeaders(page)), "content-type": "application/json" };
    const reset = await page.request.put("/api/settings/tour", { headers, data: { tourSeenAt: null } });
    if (!reset.ok()) throw new Error(`#496: could not reset the tour record (${reset.status()})`);

    await page.goto("/home");
    const card = page.locator(".tourcard");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveAttribute("data-tour-stop", "1", { timeout: 30_000 });

    await axeCheck(page);

    await page.locator("#tour-skip").click();
    await expect(card).toHaveCount(0);
  });

  const PLAIN_ROUTES: Array<{ path: string; ready: (page: Page) => Promise<unknown> }> = [
    { path: "/due-next", ready: (page) => expect(page.getByRole("heading", { name: "Due next" })).toBeVisible() },
    { path: "/documents", ready: (page) => expect(page.getByRole("heading", { name: "Documents" })).toBeVisible() },
    { path: "/inbox", ready: (page) => expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible() },
    { path: "/create", ready: (page) => expect(page.locator("#f-name")).toBeVisible() },
    { path: "/settings", ready: (page) => expect(page.getByRole("heading", { name: "Settings" })).toBeVisible() },
    { path: "/settings/mail", ready: (page) => expect(page.locator(".relay-card")).toBeVisible() },
    { path: "/admin", ready: (page) => expect(page.getByRole("heading", { name: "Operational state" })).toBeVisible() },
    {
      path: "/administration",
      ready: (page) => expect(page.getByRole("heading", { name: "Administration" })).toBeVisible(),
    },
  ];

  for (const route of PLAIN_ROUTES) {
    test(`${route.path} has no automated WCAG A/AA violations`, async ({ page }) => {
      await signIn(page, route.path);
      await route.ready(page);
      await axeCheck(page);
    });
  }

  test("/household/[id] has no automated WCAG A/AA violations", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page, "/home");
    const household = await seedHousehold(page);
    try {
      await page.goto(`/household/${household.id}`);
      await expect(page.getByRole("heading", { name: household.name })).toBeVisible();
      await axeCheck(page);
    } finally {
      await cleanup(page, household);
    }
  });

  test("/item/[id] has no automated WCAG A/AA violations", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page, "/home");
    const household = await seedHousehold(page, { withItem: true });
    try {
      await page.goto(`/item/${household.itemId}`);
      await expect(page.getByRole("heading", { name: "axe-sweep item" })).toBeVisible();
      await axeCheck(page);
    } finally {
      await cleanup(page, household);
    }
  });
});
