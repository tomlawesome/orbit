import { expect, test, type Locator, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { settleArrival } from "./support/arrival";
import { settled } from "./support/keyboard";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { SETTLE } from "./support/settle";

resetDatabaseBetweenSpecFiles();

/**
 * #1467 (quick-add drawer: the type buttons under the north star do nothing).
 *
 * The north star opens the quick-add drawer on the desk's home. Its controls
 * are close, renewal, service, inspection, "something else", the document
 * drop box and "open the full form" (read from a run against the unfixed
 * stack), so the issue's "four buttons" are three types plus "Something
 * else". Choosing a type must open
 * Add (`/create`) with that type already chosen; "Something else" opens Add
 * with no type chosen.
 *
 * "Chosen" is read as v19-create.spec.ts and support/keyboard.ts read it on
 * the Add form: `#types button[data-type="<type>"]` carries
 * `aria-pressed="true"`.
 *
 * Desk only, as the quick add's other specs in v19-create.spec.ts: the
 * north star's drawer is the desk's; the pocket creates from its own sheet
 * and has no drawer to choose a type in.
 */
test.skip(({ isMobile }) => isMobile, "the north star's drawer is the desk's; the pocket creates from its own sheet");

const HOUSEHOLD = "Quick Add Types Proving Ground";
const households = householdRegister();

/** The types the drawer offers, beside "Something else" (Add carries more
 *  chips; the drawer holds these three). */
const ADD_TYPES = ["service", "renewal", "inspection"] as const;
type AddType = (typeof ADD_TYPES)[number];

async function seedHousehold(page: Page): Promise<{ id: string; name: string }> {
  return await page.evaluate(async (householdName) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const householdId = crypto.randomUUID();
    const response = await fetch("/api/workspace/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({
        type: "household.create",
        household: {
          id: householdId,
          name: householdName,
          timezone: "Europe/London",
          currency: "GBP",
          memberCount: 1,
          canManage: true,
          onboardingComplete: true,
          sections: [{ id: crypto.randomUUID(), name: "Home", icon: "home", accent: "sage", visible: true }],
          items: [],
        },
      }),
    });
    if (!response.ok) throw new Error(`household.create failed: ${response.status} ${await response.text()}`);
    return { id: householdId, name: householdName };
  }, HOUSEHOLD);
}

async function signIn(page: Page) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  households.track(await seedHousehold(page));
}

/** Home, live (the first-run tour's veil put away by `settled`), with the
 *  quick-add drawer open from the north star. */
async function openQuickAdd(page: Page) {
  await page.goto("/home");
  await settled(page);
  await page.locator("#nstar").click();
  await expect(page.locator("#createdrawer")).toHaveClass(/\bopen\b/);
  await expect(page.locator("#nstar")).toHaveAttribute("aria-expanded", "true");
}

/** What the drawer offers for a type: a control inside the drawer (other
 *  than the document drop box) whose label starts with the type's word, or
 *  that is marked `data-type`. */
function drawerTypeControl(page: Page, type: AddType): Locator {
  const drawer = page.locator("#createdrawer");
  const label = new RegExp(`^[^a-z]*(?:an?\\s+)?${type}\\b`, "i");
  return drawer
    .locator(":is(button, a[href], [role=button]):not(#cdrop)")
    .filter({ hasText: label })
    .or(drawer.locator(`[data-type="${type}"]`));
}

/** The names of every control the drawer holds, for a failure message. */
async function drawerControlNames(page: Page): Promise<string[]> {
  return page.locator("#createdrawer :is(button, a[href], [role=button])").evaluateAll((els) =>
    els.map((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim()));
}

/** Add is open: its path is /create and its form is live. */
async function expectAddOpen(page: Page, why: string) {
  await expect(page, why).toHaveURL(/\/create(\?.*)?$/);
  await page.locator("#card[data-ready]").waitFor({ state: "attached", timeout: SETTLE });
}

test.afterEach(async ({ page }) => {
  await households.sweep(page);
});

test("each of the drawer's type buttons (service, renewal, inspection) opens Add with that type chosen", async ({ page }) => {
  test.setTimeout(150_000);
  await signIn(page);

  for (const type of ADD_TYPES) {
    await test.step(`the drawer's "${type}" button`, async () => {
      await openQuickAdd(page);
      const control = drawerTypeControl(page, type);
      await expect(control).toHaveCount(1);
      await control.click();

      /* Add opens (the bug: nothing happens, home stays) … */
      await expect.soft(page, `clicking "${type}" in the drawer did not open Add`).toHaveURL(/\/create(\?.*)?$/);
      await page.locator("#card[data-ready]").waitFor({ state: "attached", timeout: SETTLE }).catch(() => {});
      /* … with that type, and only that type, chosen */
      await expect.soft(page.locator(`#types button[data-type="${type}"]`)).toHaveAttribute("aria-pressed", "true");
      await expect.soft(page.locator('#types button[aria-pressed="true"]')).toHaveCount(1);
    });
  }
});

test("the drawer's \"Something else\" opens Add with no type chosen", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  await openQuickAdd(page);

  const somethingElse = page
    .locator("#createdrawer")
    .locator(":is(button, a[href], [role=button])")
    .filter({ hasText: /something else/i });
  await expect(somethingElse, `no "Something else" in the drawer; it holds ${JSON.stringify(await drawerControlNames(page))}`)
    .toHaveCount(1);
  await somethingElse.click();

  await expectAddOpen(page, 'clicking "Something else" in the drawer did not open Add');
  /* five chips, none chosen */
  await expect(page.locator("#types button")).not.toHaveCount(0);
  await expect(page.locator('#types button[aria-pressed="true"]')).toHaveCount(0);
});
