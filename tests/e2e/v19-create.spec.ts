import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { settleArrival } from "./support/arrival";
import { gotoCreate } from "./support/keyboard";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";
import { householdDateFromToday } from "./support/household-dates";
import { SETTLE } from "./support/settle";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * #456: the create form, proven against the real engine — the wiring was
 * built before any API was reachable and has never carried a real save.
 *
 * What is left here is the engine's half: the real save, the real attach and
 * the real photo. The form's own screens (drop zone, reading lane, refusals,
 * landing) moved to the rig, web/tests/rig/v19-create.spec.js (ADR-0039, #1609).
 */

/* #730: this proving ground is removed at the end of the test that makes it,
   so it is not still in the sky when a later spec measures one. Each one has
   its own suffix: a household's name is unique across the instance, so two
   copies of this file running at once (--repeat-each, with several workers)
   would otherwise refuse each other's seed with "a removed household already
   uses this name" in the moment between one's schedule and hard delete. */
const HOUSEHOLD = "Creation Proving Ground";
const households = householdRegister();

async function seedHousehold(page: Page): Promise<{ id: string; name: string }> {
  return await page.evaluate(async (baseName) => {
    const householdName = `${baseName} ${crypto.randomUUID().slice(0, 8)}`;
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
    const dueDate = householdDateFromToday(20);
    if (test.info().project.name.startsWith("mobile")) {
      /* #1120, proposal §2.5: a phone's create is the pocket's own form,
         where the section is a required choice (#1058: none is chosen for
         you), and a save lands on home with the new item's drawer open
         (#1319, owner-decisions §34: the belt it used to approach retired). */
      const form = page.getByRole("form", { name: "New entry" });
      await form.getByRole("textbox", { name: "name", exact: true }).fill("Gutter clearing proving");
      await form.getByRole("button", { name: "service" }).click();
      await form.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
      await form.getByLabel("due date").fill(dueDate);
      await page.getByRole("button", { name: "Add to orbit" }).click();

      await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/);
      const itemId = new URL(page.url()).searchParams.get("item") as string;
      const opened = page.locator(`.pocket .pk-below [data-row-key="${itemId}"]`);
      await expect(opened).toHaveAttribute("data-open", "", { timeout: SETTLE });
      await expect(opened).toContainText("Gutter clearing proving");
      await expect(opened).toContainText("T−20d");

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

      // Saved and returned to the orbit at the new item (#1246), where it
      // needs attention.
      await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/);
      const itemId = new URL(page.url()).searchParams.get("item") as string;
      const row = page.locator(".item", { hasText: "Gutter clearing proving" });
      await expect(row).toBeVisible();
      await expect(row).toContainText("T−20d");
      await expect(page.locator(`[id="${itemId}-view"]`)).toBeVisible({ timeout: SETTLE });
    }
  } finally {
    await households.sweep(page);
  }
});

/* A real, structurally valid PDF: the upload route refuses a stub. */
const DOCUMENT = "chromium-synthetic.pdf";
const DOCUMENT_BYTES = readFileSync(resolve(__dirname, "../support/fixtures", DOCUMENT));

/** The pocket's form, filled and saved with a document picked (#1245, 11a). */
async function savePocketEntryWithDocument(page: Page, name: string, keyDate?: string): Promise<void> {
  await gotoCreate(page);
  const form = page.getByRole("form", { name: "New entry" });
  /* "add a document" opens this hidden picker; setting it is the same change. */
  await form.locator('input[type="file"]').setInputFiles({ name: DOCUMENT, mimeType: "application/pdf", buffer: DOCUMENT_BYTES });
  // The reading card holds the paper, and no longer says it will not be kept.
  await expect(form.locator(".pc-reading")).toContainText(DOCUMENT);
  await expect(form).not.toContainText("does not read or keep documents");
  await form.getByRole("textbox", { name: "name", exact: true }).fill(name);
  await form.getByRole("button", { name: "document", exact: true }).click();
  await form.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
  /* a document's key date is "expires on" (EntryForm.svelte) */
  if (keyDate) await form.locator('input[id$="-due"]').fill(keyDate);
  await page.getByRole("button", { name: "Add to orbit" }).click();
}

/** The desk form, filled and saved with a document picked. */
async function saveDeskEntryWithDocument(page: Page, name: string, keyDate?: string): Promise<void> {
  await gotoCreate(page);
  /* The drop target opens this hidden picker; setting it is the same change. */
  await page.locator('#card input[type="file"]').setInputFiles({ name: DOCUMENT, mimeType: "application/pdf", buffer: DOCUMENT_BYTES });
  await page.locator("#f-name").fill(name);
  await page.locator('#types button[data-type="document"]').click();
  await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
  if (keyDate) await page.locator("#f-date").fill(keyDate);
  await page.locator(".btn-primary").click();
}

/** The saved item's id, read back by its title. */
async function itemIdOf(page: Page, householdId: string, title: string): Promise<string | null> {
  const response = await page.request.get("/api/workspace", { maxRetries: 2 });
  if (!response.ok()) return null;
  const { workspace } = (await response.json()) as { workspace: { households: Array<{ id: string; items: Array<{ id: string; title: string }> }> } };
  return workspace.households.find((one) => one.id === householdId)?.items.find((item) => item.title === title)?.id ?? null;
}

/**
 * #1245: a document picked on /create is attached to the item it saves — the
 * desk's used to be dropped with "documents are not wired up yet", and the
 * phone's with "was not kept" until the owner's 11a ruling (2026-10-07).
 */
test("a document picked on the create form is attached to the saved item", async ({ page }) => {
  test.setTimeout(90_000);
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  const household = households.track(await seedHousehold(page));

  try {
    const name = "Boiler cover proving";
    const pocket = test.info().project.name.startsWith("mobile");
    await (pocket ? savePocketEntryWithDocument : saveDeskEntryWithDocument)(page, name);
    // The pocket lands on home once the document is on it (§2.5; #1319).
    if (pocket) await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect.poll(() => itemIdOf(page, household.id, name), { timeout: 15_000 }).not.toBeNull();
    const itemId = (await itemIdOf(page, household.id, name)) as string;
    /* #1281: this save has no key date, and the pocket opens its drawer on
       home all the same (#1319: the drawer opens any item) -- the address
       and the open row are the item just saved. The desk's undated landing
       is "add to orbit lands an undated item on its row under the no-date
       rule", below. */
    if (pocket) {
      expect(new URL(page.url()).searchParams.get("item")).toBe(itemId);
      const opened = page.locator(`.pocket .pk-below [data-row-key="${itemId}"]`);
      await expect(opened).toHaveAttribute("data-open", "", { timeout: SETTLE });
      await expect(opened).toContainText(name);
    }
    await expect.poll(async () => {
      const response = await page.request.get(`/api/households/${household.id}/items/${itemId}/documents`, { maxRetries: 2 });
      if (!response.ok()) return `http_${response.status()}`;
      const { documents } = (await response.json()) as { documents: Array<{ displayName: string }> };
      return documents.map((one) => one.displayName).join(",");
    }, { timeout: 30_000 }).toContain(DOCUMENT);
  } finally {
    await households.sweep(page);
  }
});

async function signInWithHousehold(page: Page): Promise<{ id: string; name: string }> {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  return households.track(await seedHousehold(page));
}

/** @param body the inspection route's answer for this page */
async function answerInspection(page: Page, body: object): Promise<void> {
  await page.route("**/item-document-inspection", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}

/**
 * #1245, the §14 walk (design/v19/create-v3.html's `doc` → `snap`): the
 * moment a document is picked the lanes split and "Reading your document"
 * breathes; page one lands on the top sheet as soon as it is drawn, while
 * the read is still running; the read settles on its own, without the page
 * ever having waited for it. The sheet used to be a sketched placeholder
 * nothing reached, and the owner saw the lane sit on "Focusing on the
 * anomaly" for good.
 */
test.describe(() => {
  /* The preview and the read are held with `page.route`, which a request from
     a page Orbit's service worker controls skips on WebKit (#1196, #1235); kept
     out there, as in the describes below. */
  test.use({
    serviceWorkers: async ({}, use, testInfo) => {
      await use(testInfo.project.use.defaultBrowserType === "webkit" ? "block" : "allow");
    },
  });

  test("picking a document shows its front page while the read runs alongside", async ({ page }) => {
    test.skip(test.info().project.name.startsWith("mobile"), "the pocket's reading card is proven by its own tests below (#1279)");
    test.setTimeout(90_000);
    await answerPushWithoutAService(page);
    await page.goto("/api/auth/login?returnTo=/home");
    await page.getByRole("link", { name: workerAccount("administrator") }).click();
    await settleArrival(page);
    await ensureWorkerAdministrator(page);
    households.track(await seedHousehold(page));

    // The lane says "reading" until both requests of a pick have answered: the
    // preview draws page one (the heading becomes "Page one"), the inspection
    // settles the read (`data-reading` goes). Either can win a race with the
    // assertions, so hold both, look at the lane while it is still reading, then
    // let them through.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    for (const route of ["**/item-document-preview", "**/item-document-inspection"]) {
      await page.route(route, async (request) => {
        await held;
        await request.continue();
      });
    }

    try {
      await gotoCreate(page);
      const readcard = page.locator("#readcard");
      await page.locator('#card input[type="file"]').setInputFiles({ name: DOCUMENT, mimeType: "application/pdf", buffer: DOCUMENT_BYTES });

      // The lanes split and the lane says what it is doing, straight away.
      await expect(page.locator("body")).toHaveClass(/\bdoc\b/);
      await expect(readcard).toBeVisible();
      await expect(readcard).toHaveAttribute("data-reading", "true");
      await expect(page.locator("#read-head")).toHaveText("Reading your document");
      await expect(page.locator("body")).not.toHaveClass(/\bsnap\b/);
      release();

      // Page one lands — a real picture, drawn from the file — within seconds,
      // and the heading says so.
      await expect(page.locator("body")).toHaveClass(/\bsnap\b/, { timeout: SETTLE });
      await expect(page.locator("#read-head")).toHaveText("Page one");
      const sheet = page.locator("#sheet-page");
      await expect(sheet).toBeVisible();
      await expect(sheet).toHaveAttribute("alt", `Page one of ${DOCUMENT}`);
      await expect.poll(() => sheet.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await expect(page.locator("#rc-file")).toContainText(DOCUMENT);
      await expect(page.locator("#rc-scan")).toBeVisible();

      // The read settles on its own, whatever it found (the stack may have no
      // processor), and never undoes the page.
      await expect(readcard).not.toHaveAttribute("data-reading", "true", { timeout: 45_000 });
      await expect(page.locator("body")).toHaveClass(/\bsnap\b/);
      await expect(page.locator("#rc-capline")).not.toHaveText("orbit is reading the pages it was given");

      // "not this one" takes the file out again and closes the lane.
      await page.locator("#rc-drop").click();
      await expect(page.locator("body")).not.toHaveClass(/\bdoc\b/);
      await expect(page.locator("body")).not.toHaveClass(/\bsnap\b/);
    } finally {
      release();
      await households.sweep(page);
    }
  });
});

/**
 * F3 (audit v0.3.1, G14): with reading on, a photo the read could not take
 * words from says so on both layouts, in the same sentence: the phone's card
 * as its own line under the caption, the desk's lane in #rc-honest. The file
 * stays attachable and the save carries it.
 */
test.describe("a photo with nothing to read says so, and still saves", () => {
  test.use({
    serviceWorkers: async ({}, use, testInfo) => {
      await use(testInfo.project.use.defaultBrowserType === "webkit" ? "block" : "allow");
    },
  });

  const NOTHING = "Nothing was able to be extracted from this file.";
  const PHOTO = "boiler-photo.png";
  /* A 1x1 PNG: the smallest picture the upload route accepts. */
  const PHOTO_BYTES = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  test("the card and the lane show the nothing-extracted sentence, and the save attaches the photo", async ({ page }) => {
    test.setTimeout(90_000);
    const household = await signInWithHousehold(page);
    const pocket = test.info().project.name.startsWith("mobile");

    try {
      await answerInspection(page, {
        extracted: false, suggestions: [], attachmentDisposition: "attachable", message: NOTHING,
      });
      await gotoCreate(page);
      const name = "Boiler photo proving";
      const file = { name: PHOTO, mimeType: "image/png", buffer: PHOTO_BYTES };
      if (pocket) {
        const form = page.getByRole("form", { name: "New entry" });
        await form.locator('input[type="file"]').setInputFiles(file);
        await expect(form.locator(".pc-reading .pc-honest")).toHaveText(NOTHING, { timeout: SETTLE });
        await form.getByRole("textbox", { name: "name", exact: true }).fill(name);
        await form.getByRole("button", { name: "document", exact: true }).click();
        await form.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
        await page.getByRole("button", { name: "Add to orbit" }).click();
      } else {
        await page.locator('#card input[type="file"]').setInputFiles(file);
        await expect(page.locator("#rc-honest")).toHaveText(NOTHING, { timeout: SETTLE });
        await page.locator("#f-name").fill(name);
        await page.locator('#types button[data-type="document"]').click();
        await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
        await page.locator(".btn-primary").click();
      }

      await expect.poll(() => itemIdOf(page, household.id, name), { timeout: 30_000 }).not.toBeNull();
      const itemId = (await itemIdOf(page, household.id, name)) as string;
      await expect.poll(async () => {
        const response = await page.request.get(`/api/households/${household.id}/items/${itemId}/documents`, { maxRetries: 2 });
        if (!response.ok()) return `http_${response.status()}`;
        const { documents } = (await response.json()) as { documents: Array<{ displayName: string }> };
        return documents.map((one) => one.displayName).join(",");
      }, { timeout: 30_000 }).toContain(PHOTO);
    } finally {
      await households.sweep(page);
    }
  });
});
