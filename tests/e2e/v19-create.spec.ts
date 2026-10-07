import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { settleArrival } from "./support/arrival";
import { gotoCreate } from "./support/keyboard";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * #456: the create form, proven against the real engine — the wiring was
 * built before any API was reachable and has never carried a real save.
 */

/* #730: this proving ground is removed at the end of the test that makes it,
   so it is not still in the sky when a later spec measures one. */
const HOUSEHOLD = "Creation Proving Ground";
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

test("the create form saves a real item into the orbit", async ({ page }) => {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  /* #1080: the sweep's hard delete is an instance-admin power. */
  await ensureWorkerAdministrator(page);
  households.track(await seedHousehold(page));

  try {
    /* #856: waits for the mount that attaches the listeners, not just for
       `load` — `fill()` and the chip click below both need them. */
    await gotoCreate(page);
    const dueDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    if (test.info().project.name.startsWith("mobile")) {
      /* #1120, proposal §2.5: a phone's create is the pocket's own form,
         where the section is a required choice (#1058: none is chosen for
         you), and a save approaches the new item on its belt. */
      const form = page.getByRole("form", { name: "New entry" });
      await form.getByRole("textbox", { name: "name", exact: true }).fill("Gutter clearing proving");
      await form.getByRole("button", { name: "service" }).click();
      await form.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
      await form.getByLabel("due date").fill(dueDate);
      await page.getByRole("button", { name: "Add to orbit" }).click();

      await expect(page).toHaveURL(/\/item\/[0-9a-f-]{36}$/);
      await expect(page.getByRole("heading", { name: "Gutter clearing proving" })).toBeVisible();
      await expect(page.locator(".item-card")).toContainText("T−20d");

      // And the orbit lists it where it needs attention.
      await page.goto("/home");
      const row = page.locator(".pocket .pk-below .p-row", { hasText: "Gutter clearing proving" });
      await expect(row).toBeVisible();
      await expect(row).toContainText("T−20d");
    } else {
      await page.locator("#f-name").fill("Gutter clearing proving");
      await page.locator('#types button[data-type="service"]').click();
      // #1058b/#1069: the section has no default on the desk either — the
      // save button stays disabled until one is chosen.
      await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
      await page.locator("#f-date").fill(dueDate);
      await page.locator(".btn-primary").click();

      // Saved and returned to the orbit, where the new item needs attention.
      await expect(page).toHaveURL(/\/home$/);
      const row = page.locator(".item", { hasText: "Gutter clearing proving" });
      await expect(row).toBeVisible();
      await expect(row).toContainText("T−20d");
    }
  } finally {
    await households.sweep(page);
  }
});

/**
 * #1251: the title ships empty, so an item cannot be saved under a name
 * nobody gave it. On the desk the heading field arrives focused with a
 * "Name this entry" placeholder and the save waits for a name; the phone's
 * own form already refuses an empty name in the same words, pinned here.
 */
test("the create form will not save an entry nobody has named", async ({ page }) => {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  households.track(await seedHousehold(page));

  try {
    await gotoCreate(page);
    const dueDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    if (test.info().project.name.startsWith("mobile")) {
      const form = page.getByRole("form", { name: "New entry" });
      await form.getByRole("button", { name: "service" }).click();
      await form.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
      await form.getByLabel("due date").fill(dueDate);
      const save = page.getByRole("button", { name: "Add to orbit" });
      await expect(save).toBeDisabled();
      await expect(page.locator("#pk-refusal")).toHaveText("not yet — give it a name");
      await form.getByRole("textbox", { name: "name", exact: true }).fill("Gutter clearing proving");
      await expect(save).toBeEnabled();
    } else {
      const name = page.locator("#f-name");
      await expect(name).toBeFocused();
      await expect(name).toHaveValue("");
      await expect(name).toHaveAttribute("placeholder", "Name this entry");
      await page.locator('#types button[data-type="service"]').click();
      await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
      await page.locator("#f-date").fill(dueDate);
      const save = page.locator(".btn-primary");
      await expect(save).toBeDisabled();
      await expect(page.locator("#save-note")).toHaveText("not yet — give it a name");
      await name.fill("Gutter clearing proving");
      await expect(save).toBeEnabled();
    }
  } finally {
    await households.sweep(page);
  }
});

/* A real, structurally valid PDF: the upload route refuses a stub. */
const DOCUMENT = "chromium-synthetic.pdf";
const DOCUMENT_BYTES = readFileSync(resolve(__dirname, "../support/fixtures", DOCUMENT));

/** The desk form, filled and saved with a document picked. */
async function saveDeskEntryWithDocument(page: Page, name: string): Promise<void> {
  await gotoCreate(page);
  /* The drop target opens this hidden picker; setting it is the same change. */
  await page.locator('#card input[type="file"]').setInputFiles({ name: DOCUMENT, mimeType: "application/pdf", buffer: DOCUMENT_BYTES });
  await page.locator("#f-name").fill(name);
  await page.locator('#types button[data-type="document"]').click();
  await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
  await page.locator(".btn-primary").click();
}

/** The saved item's id, read back by its title. */
async function itemIdOf(page: Page, householdId: string, title: string): Promise<string | null> {
  const response = await page.request.get("/api/workspace");
  if (!response.ok()) return null;
  const { workspace } = (await response.json()) as { workspace: { households: Array<{ id: string; items: Array<{ id: string; title: string }> }> } };
  return workspace.households.find((one) => one.id === householdId)?.items.find((item) => item.title === title)?.id ?? null;
}

/**
 * #1245: a document picked on the desk's /create is attached to the item it
 * saves — it used to be dropped with "documents are not wired up yet".
 */
test("a document picked on the create form is attached to the saved item", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the pocket's form still says it does not keep documents (#1245 open question)");
  test.setTimeout(90_000);
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  const household = households.track(await seedHousehold(page));

  try {
    const name = "Boiler cover proving";
    await saveDeskEntryWithDocument(page, name);
    await expect.poll(() => itemIdOf(page, household.id, name), { timeout: 15_000 }).not.toBeNull();
    const itemId = (await itemIdOf(page, household.id, name)) as string;
    await expect.poll(async () => {
      const response = await page.request.get(`/api/households/${household.id}/items/${itemId}/documents`);
      if (!response.ok()) return `http_${response.status()}`;
      const { documents } = (await response.json()) as { documents: Array<{ displayName: string }> };
      return documents.map((one) => one.displayName).join(",");
    }, { timeout: 30_000 }).toContain(DOCUMENT);
  } finally {
    await households.sweep(page);
  }
});
