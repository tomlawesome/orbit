import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { settleArrival } from "./support/arrival";
import { settled } from "./support/keyboard";
import { renderedFrames } from "./support/frames";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";

resetDatabaseBetweenSpecFiles();

/**
 * #1467, going Back from Add. A type pressed in the quick-add drawer is
 * carried to Add; leaving Add untouched must not ask "Discard this entry?"
 * (the carried type is not typing), and a type held from an earlier press
 * must not carry over to the next Add opened from "Something else".
 *
 * Desk only, as v19-home-quick-add-types.spec.ts: the north star's drawer is
 * the desk's.
 */
test.skip(({ isMobile }) => isMobile, "the north star's drawer is the desk's; the pocket creates from its own sheet");

const HOUSEHOLD = "Quick Add Back Proving Ground";
const households = householdRegister();

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

/** On home as it stands (no reload): the drawer opened from the north star. */
async function openDrawerHere(page: Page) {
  await settled(page);
  await page.locator("#nstar").click();
  await expect(page.locator("#createdrawer")).toHaveClass(/\bopen\b/);
}

/** A control in the drawer by its label (the drawer's controls are close,
 *  renewal, service, inspection, something else, the drop box and "open the
 *  full form"). */
function drawerControl(page: Page, label: RegExp) {
  return page.locator("#createdrawer").locator(":is(button, a[href], [role=button])").filter({ hasText: label });
}

async function addIsOpen(page: Page, why: string) {
  await expect(page, why).toHaveURL(/\/create(\?.*)?$/);
  await page.locator("#card[data-ready]").waitFor({ state: "attached", timeout: 20_000 });
}

/** Any "Discard this entry?" asking, native or drawn in the page. */
function watchForDiscardQuestion(page: Page): string[] {
  const asked: string[] = [];
  page.on("dialog", (dialog) => {
    asked.push(`native ${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss().catch(() => {});
  });
  return asked;
}

async function expectNoDiscardQuestion(page: Page, asked: string[]) {
  /* The question, if there is one, comes on the Back itself, before it
     completes. Back has landed on home (the callers wait for its address);
     wait for home to be live and the page to draw its frames, so the
     absence is judged after the Back was handled, not after a guess at how
     long that takes. */
  await settled(page);
  await renderedFrames(page);
  expect(asked, "Back from an untouched Add asked a question").toEqual([]);
  await expect(page.getByText(/discard this entry/i), "Back from an untouched Add drew a discard question").toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
}

test.afterEach(async ({ page }) => {
  await households.sweep(page);
});

test("a type pressed in the drawer, nothing typed on Add, then Back: home, and no \"Discard this entry?\"", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const asked = watchForDiscardQuestion(page);
  await page.goto("/home");
  await openDrawerHere(page);

  await drawerControl(page, /^[^a-z]*renewal\b/i).click();
  await addIsOpen(page, 'pressing "renewal" in the drawer did not open Add');
  await expect(page.locator('#types button[data-type="renewal"]')).toHaveAttribute("aria-pressed", "true");

  await page.goBack();
  await expect(page, "Back from Add did not return to home").toHaveURL(/\/home$/);
  await expectNoDiscardQuestion(page, asked);
});

test("a type held from an earlier press does not carry over to Add opened from \"Something else\"", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const asked = watchForDiscardQuestion(page);
  await page.goto("/home");
  await openDrawerHere(page);

  await drawerControl(page, /^[^a-z]*service\b/i).click();
  await addIsOpen(page, 'pressing "service" in the drawer did not open Add');
  await expect(page.locator('#types button[data-type="service"]')).toHaveAttribute("aria-pressed", "true");

  await page.goBack();
  await expect(page, "Back from Add did not return to home").toHaveURL(/\/home$/);
  await expectNoDiscardQuestion(page, asked);

  await openDrawerHere(page);
  await drawerControl(page, /something else/i).click();
  await addIsOpen(page, 'pressing "Something else" in the drawer did not open Add');
  await expect(page.locator("#types button")).not.toHaveCount(0);
  await expect(
    page.locator('#types button[aria-pressed="true"]'),
    "the earlier press's type carried over to Add opened from Something else",
  ).toHaveCount(0);
});
