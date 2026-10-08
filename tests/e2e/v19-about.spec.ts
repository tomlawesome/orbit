import { expect, test, type Page } from "@playwright/test";
import { settleArrival } from "./support/arrival";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { sessionHeaders } from "./support/households";
import { seedHousehold } from "./support/signed-in";
import { answerPushWithoutAService } from "./support/webkit-push";
import { workerAccount } from "./support/worker-identity";
import { createRequire } from "node:module";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * About (#1256): any signed-in member reaches it from the account menu --
 * no admin gate, because the credits must reach everyone who uses what they
 * credit -- and a signed-out visitor is not served it at all (owner, answer
 * 7: no About on the sign-in door).
 */

/* The Milky Way's credit, found by the picture it credits rather than by its
   name: the name is what the page shows and changes with it (163731d3 added
   the work's title), and its id is the one the page itself derives. */
type Picture = { name: string; files: string[]; changes?: string };
type Entry = { id: string; name: string };
/* Loaded, not imported: the root tsconfig keeps allowJs off, and these two
   are plain data the page is drawn from. */
const load = createRequire(__filename);
const { CREDITS, FONTS, SIDECARS } = load("../../web/src/lib/about/credits.js") as { CREDITS: Picture[]; FONTS: unknown[]; SIDECARS: unknown[] };
const { creditsView } = load("../../web/src/lib/about/group.js") as {
  creditsView: (input: { pictures: Picture[]; fonts: unknown[]; sidecars: unknown[]; libraries: null }) => { groups: { entries: Entry[] | null }[] };
};
const GALAXY = CREDITS.find((credit) => credit.files.includes("flight/world/galaxy-2k.webp"));
if (!GALAXY?.changes) throw new Error("#1256: the galaxy picture's credit, or its changes line, is missing from credits.js");
const GALAXY_ID = creditsView({ pictures: CREDITS, fonts: FONTS, sidecars: SIDECARS, libraries: null })
  .groups.flatMap((group) => group.entries ?? []).find((entry) => entry.name === GALAXY.name)?.id;

/** The account menu this width draws: the desk's card, or the pocket's hatch. */
async function openMenu(page: Page, phone: boolean) {
  if (!phone) {
    await page.locator("button.orb").click();
    return page.locator("#account");
  }
  await page.locator("button.porb").click();
  const hatch = page.locator('.p-sheet-layer:has(nav[aria-label="Go to"])');
  await expect(hatch).toHaveClass(/open/);
  return hatch;
}

async function signInAs(page: Page, account: string) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: account }).click();
  await settleArrival(page);
}

/**
 * household.create makes the member its owner, never an instance
 * administrator, so the hard delete support/households.ts's cleanup ends
 * with is refused (403). Scheduling the deletion is the half an owner may
 * do, as settings-notification-history.spec.ts does.
 */
async function scheduleHouseholdDeletion(page: Page, householdId: string, name: string) {
  const response = await page.request.post(`/api/households/${householdId}/lifecycle`, {
    headers: await sessionHeaders(page),
    data: { action: "delete", confirmation: name },
  });
  if (response.status() === 404 || response.status() === 409) return;
  if (!response.ok()) throw new Error(`#1256: could not schedule cleanup of "${name}" (${response.status()})`);
}

test("a member opens About from the menu and sees the three cards", async ({ page, browser, isMobile }) => {
  test.setTimeout(120_000);
  await claimInstanceAsAdministrator(browser);
  await signInAs(page, workerAccount("member"));
  const household = await seedHousehold(page, "About");
  try {
    await page.goto("/settings");
    /* #1125: on a phone settings is its own layout and the desk's .cards are display:none. */
    await expect(page.locator(isMobile ? ".st-pocket .p-card" : ".helm-page .cards").first()).toBeVisible({ timeout: 30_000 });

    const about = (await openMenu(page, isMobile)).getByRole("link", { name: "About" });
    await expect(about).toBeVisible();
    await about.click();

    await expect(page).toHaveURL(/\/about$/);
    await expect(page).toHaveTitle("Orbit — about");
    const screen = page.locator(".about-page");
    for (const card of ["This Orbit", "Credits", "Licences"]) {
      await expect(screen.getByRole("heading", { level: 2, name: card })).toBeVisible();
    }

    /* Card 1 answered from the running stack: every row has a value. */
    const orbit = screen.locator("section.orbit");
    await expect(orbit.locator(".kv")).toHaveCount(7, { timeout: 30_000 });
    await expect(orbit.locator(".kv", { hasText: "PostgreSQL" }).locator("b")).toHaveText(/^\d+(\.\d+)*$/);
    await expect(orbit).not.toContainText("not shown");

    /* Card 2's index and the pictures it must credit; card 3 lists each licence once. */
    const index = screen.getByRole("navigation", { name: "Credits index" });
    await expect(index.getByRole("link")).toHaveText([new RegExp(`^Pictures · ${CREDITS.length}$`), /^Fonts · 3$/, /^Libraries · (\d+|—)$/, /^Sidecar images · 4$/]);
    expect(GALAXY_ID, "#1256: the galaxy credit has no id on the page").toBeTruthy();
    const galaxy = screen.locator(`[id="${GALAXY_ID}"]`);
    await expect(galaxy.locator("b")).toHaveText(GALAXY.name);
    await expect(galaxy.locator("small", { hasText: "changed:" })).toBeVisible();
    await expect(galaxy).toContainText(`changed: ${GALAXY.changes}`);
    const licences = await screen.locator("section.licences .kv b").allTextContents();
    expect(new Set(licences).size).toBe(licences.length);

    /* The menu's own row lights on this page. */
    await expect((await openMenu(page, isMobile)).getByRole("link", { name: "About" })).toHaveAttribute("aria-current", "page");
  } finally {
    await scheduleHouseholdDeletion(page, household.id, household.name);
  }
});

test("a signed-out visitor is not served /about or its API", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("/about");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fabout$/);
    await expect(page.locator(".about-page")).toHaveCount(0);

    const api = await context.request.get("/api/about");
    expect(api.status()).toBe(401);
    expect(await api.text()).not.toMatch(/sha256|postgres|tika|clamav|ollama/i);
  } finally {
    await context.close();
  }
});
