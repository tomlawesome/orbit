import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { settleArrival } from "./support/arrival";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * #455: the item view's writes, for real — a household and item seeded
 * through the same command API the product uses, then completed through the
 * v19 view, with the new orbit visible back on home.
 */

/* #730: each test removes the proving ground it seeded, so neither is left
   crowding the sky a later spec measures.

   The name carries a per-test suffix because these tests run in PARALLEL
   locally (playwright.config.ts sets fullyParallel with workers undefined off
   CI). A shared fixed name meant concurrent creates of the same household and,
   once cleanup existed, one worker hard-deleting the household another was
   still using. CI never showed it because CI pins workers to 1. Nothing
   asserts the name. */
const HOUSEHOLD_PREFIX = "Actions Proving Ground";
const households = householdRegister();

async function signInAsAdmin(page: Page) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  /* #1080: the sweep's hard delete is an instance-admin power. */
  await ensureWorkerAdministrator(page);
}

async function seedHouseholdWithItem(page: Page): Promise<{ itemId: string; householdId: string }> {
  const name = `${HOUSEHOLD_PREFIX} ${randomUUID().slice(0, 8)}`;
  const seeded = await page.evaluate(async (householdName) => {
    const sessionResponse = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
    const session = (await sessionResponse.json()) as { csrfToken: string };
    const command = async (payload: unknown) => {
      const response = await fetch("/api/workspace/commands", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`command failed: ${response.status} ${await response.text()}`);
    };
    const householdId = crypto.randomUUID();
    const sectionId = crypto.randomUUID();
    await command({
      type: "household.create",
      household: {
        id: householdId,
        name: householdName,
        timezone: "Europe/London",
        currency: "GBP",
        memberCount: 1,
        canManage: true,
        onboardingComplete: true,
        sections: [{ id: sectionId, name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    });
    const itemId = crypto.randomUUID();
    const dueDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    await command({
      type: "item.upsert",
      householdId,
      kind: "service",
      item: {
        id: itemId,
        sectionId,
        title: "Boiler service proving",
        currency: "GBP",
        dueDate,
        recurrenceMonths: 12,
      },
      activity: { id: crypto.randomUUID(), itemId, kind: "created", occurredAt: new Date().toISOString() },
    });
    return { itemId, householdId };
  }, name);
  households.track({ id: seeded.householdId, name });
  return seeded;
}

/**
 * #1014: a household with nothing on it — for the belt's own empty state,
 * reached by /item with no id at all.
 *
 * One section, no items: `household.create` requires at least one section
 * (422 `too_small` on `household.sections` without it), and that matches what
 * the empty state is actually for. A real household always has somewhere to
 * put things; what it can lack is anything to put there.
 */
async function seedEmptyHousehold(page: Page): Promise<{ householdId: string }> {
  const name = `${HOUSEHOLD_PREFIX} ${randomUUID().slice(0, 8)}`;
  const householdId = await page.evaluate(async (householdName) => {
    const sessionResponse = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
    const session = (await sessionResponse.json()) as { csrfToken: string };
    const id = crypto.randomUUID();
    const response = await fetch("/api/workspace/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({
        type: "household.create",
        household: {
          id, name: householdName, timezone: "Europe/London", currency: "GBP",
          memberCount: 1, canManage: true, onboardingComplete: true,
          sections: [{ id: crypto.randomUUID(), name: "Home", icon: "home", accent: "sage", visible: true }],
          items: [],
        },
      }),
    });
    if (!response.ok) throw new Error(`command failed: ${response.status} ${await response.text()}`);
    return id;
  }, name);
  households.track({ id: householdId, name });
  return { householdId };
}

/**
 * #1014: two items due on different dates, so the belt's own ascending-date
 * order (beltManifestOf) picks a real winner for "which one is nearest due" —
 * the earlier-due item, `soonId`.
 */
async function seedHouseholdWithTwoItems(
  page: Page,
): Promise<{ householdId: string; soonId: string; soonTitle: string; laterId: string }> {
  const name = `${HOUSEHOLD_PREFIX} ${randomUUID().slice(0, 8)}`;
  const seeded = await page.evaluate(async (householdName) => {
    const sessionResponse = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
    const session = (await sessionResponse.json()) as { csrfToken: string };
    const command = async (payload: unknown) => {
      const response = await fetch("/api/workspace/commands", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`command failed: ${response.status} ${await response.text()}`);
    };
    const householdId = crypto.randomUUID();
    const sectionId = crypto.randomUUID();
    await command({
      type: "household.create",
      household: {
        id: householdId, name: householdName, timezone: "Europe/London", currency: "GBP",
        memberCount: 1, canManage: true, onboardingComplete: true,
        sections: [{ id: sectionId, name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    });
    const soonId = crypto.randomUUID();
    const soonTitle = "Nearest due proving";
    const soonDue = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    await command({
      type: "item.upsert",
      householdId,
      kind: "service",
      item: {
        id: soonId, sectionId, title: soonTitle, currency: "GBP",
        dueDate: soonDue, recurrenceMonths: 12,
      },
      activity: { id: crypto.randomUUID(), itemId: soonId, kind: "created", occurredAt: new Date().toISOString() },
    });
    const laterId = crypto.randomUUID();
    const laterDue = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    await command({
      type: "item.upsert",
      householdId,
      kind: "service",
      item: {
        id: laterId, sectionId, title: "Later due proving", currency: "GBP",
        dueDate: laterDue, recurrenceMonths: 12,
      },
      activity: { id: crypto.randomUUID(), itemId: laterId, kind: "created", occurredAt: new Date().toISOString() },
    });
    return { householdId, soonId, soonTitle, laterId };
  }, name);
  households.track({ id: seeded.householdId, name });
  return seeded;
}

test("completing an item from the v19 view moves its orbit", async ({ page }) => {
  await signInAsAdmin(page);

  const { itemId } = await seedHouseholdWithItem(page);

  try {
    await page.goto(`/item/${itemId}`);
    await expect(page.getByRole("heading", { name: "Boiler service proving" })).toBeVisible();
    // Due in 20 days: needs attention.
    await expect(page.locator(".item-card")).toContainText("T−20d");

    const pocket = test.info().project.name.startsWith("mobile");
    if (pocket) {
      /* #1120, proposal §2.3: on a phone an item with no cost to confirm
         completes on the tap, held behind the wake's undo, and the wake names
         the next orbit it defaulted to (+recurrenceMonths). */
      await page.getByRole("group", { name: "Item actions" }).getByRole("button", { name: "complete", exact: true }).click();
      await expect(page.locator(".p-wake .msg")).toContainText(/^Completed · next due .+ · Boiler service proving$/);
    } else {
      await page.locator(".acts button", { hasText: /^complete$/ }).click();
      // The next orbit defaults to +recurrenceMonths and stays editable.
      await expect(page.locator("#a-next")).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
      await page.locator(".panel .btn-primary").click();
    }

    // The view re-reads: a year of lead time now (allow the ±1 day of month arithmetic).
    // (The pocket's completion is only sent once the wake's hold has run out.)
    await expect(page.locator(".item-card")).toContainText(/T−36[456]d/, pocket ? { timeout: 15_000 } : {});

    // And home tells the same story. On a desk the row sits in the wide orbit;
    // in the pocket dialect only attention rows are listed, and with this
    // household's one item a year out its line says nothing needs you and
    // names the item as next up, a year away.
    await page.goto("/home");
    if (pocket) {
      await expect(page.locator(".mdial svg")).toBeVisible();
      const below = page.locator(".pocket .pk-below");
      await expect(below.locator(".p-row .title", { hasText: /^Boiler service proving$/ })).toHaveCount(0);
      await expect(below.locator(".p-row", { hasText: "nothing needs you" }))
        .toContainText(/next up Boiler service proving, T−36[456]d/);
    } else {
      await expect(page.locator(`[id="${itemId}"]`)).toContainText(/T−36[456]d/);
    }
  } finally {
    await households.sweep(page);
  }
});

test("a stale version is refused and the view says so", async ({ page }) => {
  await signInAsAdmin(page);

  const { itemId, householdId } = await seedHouseholdWithItem(page);

  try {
    await page.goto(`/item/${itemId}`);
    await expect(page.getByRole("heading", { name: "Boiler service proving" })).toBeVisible();

    // Someone else reschedules while our view is open (same command API,
    // fresh version) — our copy is now stale.
    await page.evaluate(async ({ seededHouseholdId, seededItemId }) => {
      const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
      const workspace = (await (await fetch("/api/workspace", { credentials: "same-origin" })).json()).workspace;
      const household = workspace.households.find((one: { id: string }) => one.id === seededHouseholdId);
      const item = household.items.find((one: { id: string }) => one.id === seededItemId);
      const response = await fetch("/api/workspace/commands", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify({
          type: "item.reschedule",
          householdId: household.id,
          itemId: item.id,
          expectedVersion: item.version,
          dueDate: "2027-03-03",
          activity: { id: crypto.randomUUID(), itemId: item.id, kind: "rescheduled", occurredAt: new Date().toISOString(), nextDate: "2027-03-03" },
        }),
      });
      if (!response.ok) throw new Error(`rival reschedule failed: ${response.status}`);
    }, { seededHouseholdId: householdId, seededItemId: itemId });

    if (test.info().project.name.startsWith("mobile")) {
      /* #1120, proposal §2.3: on a phone the act raises its callout sheet. */
      await page.getByRole("group", { name: "Item actions" }).getByRole("button", { name: "reschedule", exact: true }).click();
      const sheet = page.getByRole("dialog", { name: /reschedule/i });
      await sheet.locator("#p-due").fill("2026-12-01");
      await sheet.getByRole("button", { name: "reschedule", exact: true }).click();
    } else {
      await page.locator(".acts button", { hasText: /^reschedule$/ }).click();
      await page.locator("#a-due").fill("2026-12-01");
      await page.locator(".panel .btn-primary").click();
    }

    // Refused in the server's own words, and the view re-reads the truth.
    await expect(page.locator(".problem")).toContainText("changed on another device");
    await expect(page.locator(".item-card")).toContainText("3 March 2027");
  } finally {
    await households.sweep(page);
  }
});

/**
 * #1014: /item is the belt's own front door — the same mounted surface as
 * /item/<id>, entered with no apex named yet. Arriving with items on the
 * household seats the nearest-due one and replaces the address to match, so
 * a reader who typed /item never sees a bare, addressless belt and Back
 * still leaves the way they came in.
 */
test("/item with no id seats the nearest-due item and rewrites the address", async ({ page }) => {
  await signInAsAdmin(page);

  const { soonId, soonTitle } = await seedHouseholdWithTwoItems(page);

  try {
    await page.goto("/item");
    await page.waitForURL(new RegExp(`/item/${soonId}$`));
    await expect(page.getByRole("heading", { name: soonTitle })).toBeVisible();
  } finally {
    await households.sweep(page);
  }
});

/**
 * #1014: a household with nothing on it is not a 404 at /item — the belt's
 * own empty-household card renders instead, with a way into the inbox.
 */
test("/item on an empty household shows the empty state, not a 404", async ({ page }) => {
  await signInAsAdmin(page);

  await seedEmptyHousehold(page);

  try {
    await page.goto("/item");
    await expect(page.getByRole("heading", { name: "Nothing in orbit yet." })).toBeVisible();
    if (test.info().project.name.startsWith("mobile")) {
      /* #1120, proposal §2.3: a phone's empty belt offers its two ways in,
         adding an item and setting up the relay that mails things in. */
      await expect(page.getByRole("link", { name: "add an item" })).toHaveAttribute("href", /\/create$/);
      await expect(page.getByRole("link", { name: "set up your relay →" })).toHaveAttribute("href", /\/settings\/mail$/);
    } else {
      await expect(page.getByRole("link", { name: "open inbox" })).toHaveAttribute("href", /\/inbox$/);
    }
    await expect(page.getByText("This page fell into a gravity well.")).toHaveCount(0);
  } finally {
    await households.sweep(page);
  }
});

/**
 * #1248: on the desk, editing widens the card from 480px to 720px and drops
 * the detail rows the form repeats; closing the panel brings both back. A
 * phone's edit is already a full-height sheet, so this is desk-only.
 */
test("editing on the desk widens the card and drops the repeated rows", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "a phone edits in a full-height sheet");
  await signInAsAdmin(page);

  const { itemId } = await seedHouseholdWithItem(page);

  try {
    await page.goto(`/item/${itemId}`);
    await expect(page.getByRole("heading", { name: "Boiler service proving" })).toBeVisible();
    const card = page.locator("#cardwrap");
    const width = async () => (await card.boundingBox())?.width ?? 0;
    expect(await width()).toBeLessThanOrEqual(480);

    await page.locator(".acts button", { hasText: /^edit$/ }).click();
    await expect.poll(width).toBeGreaterThanOrEqual(700);
    await expect(page.locator("#e-title")).toBeVisible();
    await expect(page.locator(".item-card .kv")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect.poll(width).toBeLessThanOrEqual(480);
    await expect(page.locator(".item-card .kv", { hasText: /^due/ })).toBeVisible();
  } finally {
    await households.sweep(page);
  }
});

/**
 * #1247 (owner, 2026-10-06): the card is always centred on the belt, and the
 * apex of the belt's centreline is mid-page. The card is hung by its own
 * middle on the apex, so the edit panel (#1248) growing it keeps it centred
 * rather than leaving the belt behind. The phone's card sits beneath its
 * band plate in the page's flow, so this is desk-only.
 *
 * #1302/#1315 (owner, 2026-10-08): the card never rises into the desk's top
 * strip (belt.css --belt-strip), which the search field keeps. A card tall
 * enough to meet it -- the edit form on a 14" screen -- starts under the
 * strip instead, up to 15px below centre. So the card is where centring puts
 * it, or under the strip, whichever is lower.
 */
test("on the desk the card is centred on the belt's apex, at mid-page, even while editing", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "a phone's card sits beneath its band plate");
  await signInAsAdmin(page);

  const { itemId } = await seedHouseholdWithItem(page);

  try {
    await page.goto(`/item/${itemId}`);
    await expect(page.getByRole("heading", { name: "Boiler service proving" })).toBeVisible();
    const card = page.locator("#cardwrap");
    const offCentre = async () => {
      const box = await card.boundingBox();
      const { sky, strip } = await page.evaluate(() => ({
        sky: window.innerHeight,
        strip: parseFloat(getComputedStyle(document.querySelector(".belt-page") as Element).getPropertyValue("--belt-strip")),
      }));
      return box ? Math.abs(box.y - Math.max(sky / 2 - box.height / 2, strip)) : Infinity;
    };
    const height = async () => (await card.boundingBox())?.height ?? 0;

    /* The apex is pinned inline by the belt's layout: mid-page. */
    const sky = await page.evaluate(() => window.innerHeight);
    await expect(card).toHaveCSS("top", `${Math.round(sky / 2)}px`);
    await expect.poll(offCentre).toBeLessThanOrEqual(1.5);
    const resting = await height();

    await page.locator(".acts button", { hasText: /^edit$/ }).click();
    await expect(page.locator("#e-title")).toBeVisible();
    await expect.poll(height).not.toBe(resting);
    await expect.poll(offCentre).toBeLessThanOrEqual(1.5);

    await page.keyboard.press("Escape");
    await expect(page.locator("#e-title")).toHaveCount(0);
    await expect.poll(offCentre).toBeLessThanOrEqual(1.5);
  } finally {
    await households.sweep(page);
  }
});
