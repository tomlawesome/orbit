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
      await expect(opened).toHaveAttribute("data-open", "", { timeout: 20_000 });
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
      await expect(page.locator(`[id="${itemId}-view"]`)).toBeVisible({ timeout: 20_000 });
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
    const dueDate = householdDateFromToday(20);
    if (test.info().project.name.startsWith("mobile")) {
      const form = page.getByRole("form", { name: "New entry" });
      await form.getByRole("button", { name: "service" }).click();
      await form.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
      await form.getByLabel("due date").fill(dueDate);
      const save = page.getByRole("button", { name: "Add to orbit" });
      await expect(save).toHaveAttribute("aria-disabled", "true");
      await expect(page.locator("#pk-refusal")).toHaveText("not yet — give it a name");
      await form.getByRole("textbox", { name: "name", exact: true }).fill("Gutter clearing proving");
      await expect(save).not.toHaveAttribute("aria-disabled", "true");
    } else {
      const name = page.locator("#f-name");
      await expect(name).toBeFocused();
      await expect(name).toHaveValue("");
      await expect(name).toHaveAttribute("placeholder", "Name this entry");
      await page.locator('#types button[data-type="service"]').click();
      await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
      await page.locator("#f-date").fill(dueDate);
      const save = page.locator(".btn-primary");
      await expect(save).toHaveAttribute("aria-disabled", "true");
      await expect(page.locator("#save-note")).toHaveText("not yet — give it a name");
      await name.fill("Gutter clearing proving");
      await expect(save).not.toHaveAttribute("aria-disabled", "true");
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
  const response = await page.request.get("/api/workspace");
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
      await expect(opened).toHaveAttribute("data-open", "", { timeout: 20_000 });
      await expect(opened).toContainText(name);
    }
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
      await expect(page.locator("body")).toHaveClass(/\bsnap\b/, { timeout: 20_000 });
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
 * #1316 W1-F3: a second document dropped on the desk's form is a new read, so
 * what the first one suggested must not outlive it. The inspection answer is
 * fixed per file name, so the marks do not depend on a document processor.
 */
async function answerInspectionPerFile(page: Page, answers: Record<string, object>): Promise<void> {
  await page.route("**/item-document-inspection", (route) => {
    const sent = decodeURIComponent(route.request().headers()["x-orbit-filename"] ?? "");
    const body = answers[sent] ?? { extracted: false, suggestions: [], attachmentDisposition: "attachable" };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

const readOf = (provider?: string) => ({
  extracted: true,
  attachmentDisposition: "attachable",
  suggestions: provider ? [{ field: "provider", value: provider, source: "document_text", confidence: "medium" }] : [],
});

test.describe("the desk's create form reads a second picked document", () => {
  /* #1196: the inspection answer is a `page.route` mock, which a service worker
     on WebKit would bypass; kept out as the phone's reading tests do. */
  test.use({
    serviceWorkers: async ({}, use, testInfo) => {
      await use(testInfo.project.use.defaultBrowserType === "webkit" ? "block" : "allow");
    },
  });

  for (const [title, second, expected] of [
    ["a second document replaces the provider the first one suggested", "British Gas", "British Gas"],
    ["a second document that suggests nothing leaves the provider empty and unmarked", undefined, ""],
  ] as const) {
    test(`the desk's create form: ${title}`, async ({ page }) => {
      test.skip(test.info().project.name.startsWith("mobile"), "the pocket clears its suggestions on a second pick already");
      test.setTimeout(90_000);
      await signInWithHousehold(page);

      try {
        await answerInspectionPerFile(page, { "invoice-a.pdf": readOf("Aviva"), "invoice-b.pdf": readOf(second) });
        await gotoCreate(page);
        const picker = page.locator('#card input[type="file"]');
        const provider = page.locator("#f-provider");
        const field = page.locator("#field-provider");

        await picker.setInputFiles({ name: "invoice-a.pdf", mimeType: "application/pdf", buffer: DOCUMENT_BYTES });
        await expect(provider).toHaveValue("Aviva", { timeout: 20_000 });
        await expect(field).toHaveClass(/\bsugg\b/);

        await picker.setInputFiles({ name: "invoice-b.pdf", mimeType: "application/pdf", buffer: DOCUMENT_BYTES });
        await expect(page.locator("#rc-file")).toContainText("invoice-b.pdf");
        // The second read settles on its own before anything is asserted of it.
        await expect(page.locator("#readcard")).not.toHaveAttribute("data-reading", "true", { timeout: 45_000 });
        await expect(provider).toHaveValue(expected);
        await expect(provider).not.toHaveValue("Aviva");
        if (second) await expect(field).toHaveClass(/\bsugg\b/);
        else await expect(field).not.toHaveClass(/\bsugg\b/);
      } finally {
        await households.sweep(page);
      }
    });
  }
});

/**
 * #1243: the quick add in the north star's drawer is a real way in for a
 * document. Its box opens the file picker when clicked and takes a file
 * dropped on it; either way the full form opens with the file already in its
 * reading lane. It used to be a dashed label that did neither.
 */
test("the quick add's box takes a document by click or by drop, and opens the full form with it", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the north star's drawer is the desk's; the pocket creates from its own sheet");
  test.setTimeout(90_000);
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  households.track(await seedHousehold(page));

  const openQuickAdd = async () => {
    await page.goto("/home");
    await settleArrival(page);
    await page.locator("#nstar").click();
    await expect(page.locator("#createdrawer")).toHaveClass(/\bopen\b/);
  };
  const expectFormHoldsDocument = async () => {
    await expect(page).toHaveURL(/\/create$/);
    await expect(page.locator("body")).toHaveClass(/\bdoc\b/);
    await expect(page.locator("#rc-file")).toContainText(DOCUMENT);
  };

  try {
    await openQuickAdd();
    const chooser = page.waitForEvent("filechooser");
    await page.locator("#cdrop").click();
    await (await chooser).setFiles({ name: DOCUMENT, mimeType: "application/pdf", buffer: DOCUMENT_BYTES });
    await expectFormHoldsDocument();

    await openQuickAdd();
    const dataTransfer = await page.evaluateHandle(({ name, bytes }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], name, { type: "application/pdf" }));
      return transfer;
    }, { name: DOCUMENT, bytes: [...DOCUMENT_BYTES] });
    await page.locator("#cdrop").dispatchEvent("dragover", { dataTransfer });
    await page.locator("#cdrop").dispatchEvent("drop", { dataTransfer });
    await expectFormHoldsDocument();
  } finally {
    await households.sweep(page);
  }
});

/**
 * #1243, the way into the quick add: the north star pressed before home goes
 * live. Home is drawn by the server long before readHome() has resolved and
 * its behaviour is bound (#1064), and a press on the star inside that window
 * used to be dropped with nothing to replay it -- the drawer simply never
 * opened. The test above caught it in CI (pipeline 2236): its click landed
 * about 150 ms before /api/workspace answered.
 *
 * The workspace read is held back so the window is wide enough to press into
 * on purpose, and the press waits until that read has been asked for, which
 * is after home's own mount has started listening for a missed press.
 *
 * On WebKit a request the service worker handles skips Playwright's route
 * (#1235, as in v19-keyboard.spec.ts), so the held read answered at once,
 * the press was never awaited and the test timed out (#1315). Nothing here
 * is about the worker, so on WebKit it is kept out.
 */
test.describe(() => {
  test.use({
    serviceWorkers: async ({}, use, testInfo) => {
      await use(testInfo.project.use.defaultBrowserType === "webkit" ? "block" : "allow");
    },
  });

  test("the north star pressed before home goes live still opens the quick add", async ({ page }) => {
    test.skip(test.info().project.name.startsWith("mobile"), "the north star's drawer is the desk's; the pocket creates from its own sheet");
    test.setTimeout(60_000);
    await answerPushWithoutAService(page);
    await page.goto("/api/auth/login?returnTo=/home");
    await page.getByRole("link", { name: workerAccount("administrator") }).click();
    await settleArrival(page);
    await ensureWorkerAdministrator(page);
    households.track(await seedHousehold(page));

    try {
      let asked: () => void = () => {};
      const workspaceAsked = new Promise<void>((resolve) => { asked = resolve; });
      await page.route("**/api/workspace", async (route) => {
        asked();
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        await route.continue().catch(() => {});
      });
      await page.goto("/home");
      await workspaceAsked;
      await expect(page.locator("body[data-home-ready]")).toHaveCount(0);
      await page.locator("#nstar").click();
      await expect(page.locator("#createdrawer")).toHaveClass(/\bopen\b/, { timeout: 20_000 });
      await expect(page.locator("#nstar")).toHaveAttribute("aria-expanded", "true");
    } finally {
      await page.unroute("**/api/workspace").catch(() => {});
      await households.sweep(page);
    }
  });
});

/**
 * #1279: the phone's create form reads a picked document as the desk does
 * (design/v19/create-phone-reading.html, owner's "14a"). The reading card
 * lands straight under TYPE in place of the "add a document" row, page one
 * lands on its sheet -- drawn for real by the preview route -- and the read
 * fills the empty fields marked "◆ from document", never over what was
 * typed. The inspection answer is fixed here, so the marks do not depend on
 * whether the stack has a document processor.
 */
async function signInWithHousehold(page: Page): Promise<void> {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  households.track(await seedHousehold(page));
}

/** @param body the inspection route's answer for this page */
async function answerInspection(page: Page, body: object): Promise<void> {
  await page.route("**/item-document-inspection", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}

/* #1196: both phone tests stage the document read with a `page.route` mock,
   and Playwright does not route a request the service worker handles (its
   documentation says to block service workers wherever routing is relied on).
   On mobile WebKit the mock applied only until Orbit's worker took the page, so
   the reading card drew the real server's "found nothing to carry across"
   instead of the mocked read. Nothing here is about the worker, so on WebKit it
   is kept out -- the same cure as v19-feedback-recovery.spec.ts and
   v19-mail-review.spec.ts; Chromium already routes these requests. */
test.describe("the phone's create form reads a picked document", () => {
  test.use({
    serviceWorkers: async ({}, use, testInfo) => {
      await use(testInfo.project.use.defaultBrowserType === "webkit" ? "block" : "allow");
    },
  });

  test("the phone's create form shows page one and fills the fields the read found", async ({ page }) => {
    test.skip(!test.info().project.name.startsWith("mobile"), "the desk's lane is proven above (#1245)");
    test.setTimeout(90_000);
    await signInWithHousehold(page);

    try {
      await answerInspection(page, {
        extracted: true, attachmentDisposition: "attachable",
        suggestions: [
          { field: "provider", value: "British Gas", source: "document_text", confidence: "medium" },
          { field: "reference", value: "BG-88214-HC", source: "document_text", confidence: "medium" },
          { field: "cost", value: "144.00", source: "document_text", confidence: "medium" },
        ],
      });
      await gotoCreate(page);
      const form = page.getByRole("form", { name: "New entry" });
      const reference = form.getByRole("textbox", { name: "reference" });
      await reference.fill("MY-OWN-REF");

      await form.locator('input[type="file"]').setInputFiles({ name: DOCUMENT, mimeType: "application/pdf", buffer: DOCUMENT_BYTES });
      const card = form.locator(".pc-reading");
      await expect(card).toBeVisible();
      await expect(card).toContainText(DOCUMENT);
      await expect(form.getByRole("button", { name: /add a document/ })).toHaveCount(0);
      // Straight under TYPE, ahead of the fields it fills.
      const above = await card.evaluate((el) => el.previousElementSibling?.querySelector(".pc-kinds") !== null);
      expect(above).toBe(true);

      // Page one lands, a real picture drawn from the file, and the head says so.
      const sheet = card.getByRole("img", { name: `Page one of ${DOCUMENT}` });
      await expect(sheet).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => sheet.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await expect(card.getByRole("heading")).toHaveText(/page one/i);
      await expect(card).toContainText("Page one of the file you added");
      await expect(card).toContainText("scanned clean");

      // The read fills the empty fields and marks them; what was typed stays.
      await expect(card).toContainText("the fields marked ◆ from document are what orbit read across into the form");
      const provider = form.getByRole("textbox", { name: "provider" });
      const cost = form.getByRole("textbox", { name: "cost" });
      await expect(provider).toHaveValue("British Gas");
      await expect(cost).toHaveValue("144.00");
      await expect(reference).toHaveValue("MY-OWN-REF");
      await expect(form.locator(".pc-field.sugg")).toHaveCount(2);
      /* `has` is queried from inside the field, so a locator rooted at the form
         never matches there; the field is found by its label's own word. */
      await expect(form.locator(".pc-field.sugg", { hasText: "provider" })).toContainText("◆ from document");

      // Typing in a marked field accepts it: the mark clears, the value stays.
      await provider.fill("British Gas Services");
      await expect(form.locator(".pc-field.sugg")).toHaveCount(1);

      // "not this one": the file and what it still suggested leave the entry.
      await card.getByRole("button", { name: "not this one" }).click();
      await expect(card).toHaveCount(0);
      await expect(form.locator(".pc-field.sugg")).toHaveCount(0);
      await expect(cost).toHaveValue("");
      await expect(provider).toHaveValue("British Gas Services");
      await expect(reference).toHaveValue("MY-OWN-REF");
      await expect(form.getByRole("button", { name: /add a document/ })).toBeVisible();
    } finally {
      await households.sweep(page);
    }
  });

  /**
   * #1279, amended by #1316 (owner answer 6a): a file the upload would
   * refuse is marked refused in the phone's reading card, with the server's
   * words, and STAYS in the entry; Add is held until the file is replaced or
   * removed, and "add a document" is not offered while it is held.
   */
  test("the phone's create form says when a picked document is refused, and keeps it until it is replaced or removed", async ({ page }) => {
    test.skip(!test.info().project.name.startsWith("mobile"), "the desk's refusal shares the same read (#1245)");
    test.setTimeout(90_000);
    await signInWithHousehold(page);

    try {
      await answerInspection(page, { extracted: false, suggestions: [], attachmentDisposition: "rejected", message: "That file is not a PDF or image we can keep" });
      await gotoCreate(page);
      const form = page.getByRole("form", { name: "New entry" });
      await form.locator('input[type="file"]').setInputFiles({ name: DOCUMENT, mimeType: "application/pdf", buffer: DOCUMENT_BYTES });

      const card = form.locator(".pc-reading");
      await expect(card).toContainText("Orbit refused this file.", { timeout: 20_000 });
      await expect(card).toContainText("That file is not a PDF or image we can keep");
      await expect(card).toContainText(DOCUMENT);
      await expect(card).toContainText(/KB · refused/);
      await expect(card.getByRole("img")).toHaveCount(0);
      // The file is still in the entry, so it can be removed or replaced, and Add is held.
      await expect(page.getByRole("button", { name: "Add to orbit" })).toHaveAttribute("aria-disabled", "true");
      await expect(card.getByRole("button", { name: /not this one|remove/i })).toHaveCount(1);
      await card.getByRole("button", { name: /not this one|remove/i }).click();
      await expect(form.getByRole("button", { name: /add a document/ })).toBeVisible();
    } finally {
      await households.sweep(page);
    }
  });
});

/**
 * #1244: a file dragged over the desk's drop zone shows it has registered
 * (design/v19/create-dragover.html, owner's "8a yes"). Real DragEvents
 * carrying a real File, dispatched through the zone's own child the way the
 * mockup was exercised: the flicker trap (dragenter zone, dragenter child,
 * dragleave zone) must leave the zone locked, an off-target drop must be
 * refused rather than handed to the browser, and the drop itself takes the
 * file and says so in the polite live region.
 */
test("dragging a file over the drop zone shows it has registered", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the pocket's document row is a tap target with no drag (#1244 build notes)");
  test.setTimeout(90_000);
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  households.track(await seedHousehold(page));

  try {
    await gotoCreate(page);
    const body = page.locator("body");
    const zone = page.locator("#dropzone");
    const files = await page.evaluateHandle(({ name, bytes }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], name, { type: "application/pdf" }));
      return transfer;
    }, { name: DOCUMENT, bytes: DOCUMENT_BYTES.toString("base64") });
    const start = page.url();

    // Armed: over the page, not yet the zone.
    await page.locator("#card").dispatchEvent("dragenter", { dataTransfer: files });
    await expect(body).toHaveClass(/\bdragging\b/);
    await expect(body).not.toHaveClass(/\bover\b/);
    await expect(zone.locator('.dz-hint [data-when="arm"]')).toBeVisible();

    // Locked, and it holds while the pointer crosses the zone's own words.
    await zone.dispatchEvent("dragenter", { dataTransfer: files });
    await zone.locator(".dz-main [data-when=rest]").dispatchEvent("dragenter", { dataTransfer: files });
    await zone.dispatchEvent("dragleave", { dataTransfer: files });
    await expect(body).toHaveClass(/\bover\b/);
    await expect(zone.locator('.dz-main [data-when="lock"]')).toBeVisible();
    await expect(zone.locator('.dz-main [data-when="lock"]')).toHaveText("release to add it");
    await expect(page.locator("#dz-live")).toHaveText("Release to add the document");

    // Off the zone, a drop is refused rather than opened by the browser.
    const refused = await page.evaluate((transfer) => {
      const target = document.querySelector("#f-name") as HTMLElement;
      const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer });
      target.dispatchEvent(over);
      const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
      target.dispatchEvent(drop);
      return { over: over.defaultPrevented, effect: transfer.dropEffect, drop: drop.defaultPrevented };
    }, files);
    expect(refused).toEqual({ over: true, effect: "none", drop: true });
    expect(page.url()).toBe(start);
    await expect(body).not.toHaveClass(/\b(dragging|over)\b/);
    await expect(body).not.toHaveClass(/\bdoc\b/);

    // The drop on the zone takes the file, settles, and says so.
    await zone.dispatchEvent("dragenter", { dataTransfer: files });
    await zone.locator(".dz-main [data-when=rest]").dispatchEvent("drop", { dataTransfer: files });
    await expect(body).toHaveClass(/\bdoc\b/);
    await expect(body).not.toHaveClass(/\b(dragging|over)\b/);
    await expect(zone).toHaveClass(/\blanded\b/);
    await expect(page.locator("#dz-held-name")).toHaveText(DOCUMENT);
    await expect(page.locator("#dz-live")).toHaveText(`${DOCUMENT} added. Reading it in the lane on the right.`);

    // With a document held, the zone offers a swap.
    await zone.dispatchEvent("dragenter", { dataTransfer: files });
    await expect(zone.locator('.dz-main [data-when="swap"]')).toBeVisible();
    await expect(page.locator("#dz-live")).toHaveText("Release to swap the document");
  } finally {
    await households.sweep(page);
  }
});

/**
 * #1246: "Add to orbit" closes the form and lands on the main screen at the
 * saved item — never a "Saved" line on a form left open. #1319: on the
 * phone too, which used to open the new item on the belt; both land on
 * /home?item=<new id> with that item's drawer open.
 */
test("add to orbit closes the form and lands on the saved item", async ({ page }) => {
  test.setTimeout(90_000);
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  const household = households.track(await seedHousehold(page));

  try {
    const name = "Home insurance proving";
    /* A dated save lands on its row in the schedule; the undated one is
       proven by the next test (#1281). */
    const keyDate = householdDateFromToday(20);
    const pocket = test.info().project.name.startsWith("mobile");
    await (pocket ? savePocketEntryWithDocument : saveDeskEntryWithDocument)(page, name, keyDate);
    await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/, { timeout: 30_000 });
    const itemId = new URL(page.url()).searchParams.get("item");
    expect(itemId).toBe(await itemIdOf(page, household.id, name));
    if (pocket) {
      await expect(page.getByRole("form", { name: "New entry" })).toHaveCount(0);
      const opened = page.locator(`.pocket .pk-below [data-row-key="${itemId}"]`);
      await expect(opened).toHaveAttribute("data-open", "", { timeout: 20_000 });
      await expect(opened).toContainText(name);
    } else {
      await expect(page.locator("#save-note")).toHaveCount(0);
      await expect(page.locator(".item", { hasText: name })).toBeVisible();
      await expect(page.locator(`[id="${itemId}-view"]`)).toBeVisible({ timeout: 20_000 });
    }
  } finally {
    await households.sweep(page);
  }
});

/**
 * #1281: the key date is optional, and an item saved without one still lands
 * on its own row -- at the corridor's foot, under the quiet "no date" rule
 * where undated suggestions sit -- open, exactly as a dated save does. The
 * dial places by days to the sun, so it draws no body for it.
 */
test("add to orbit lands an undated item on its row under the no-date rule", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"),
    "the no-date rule is the desk corridor's; the phone's undated save landing open is \"a document picked on the create form is attached to the saved item\"");
  test.setTimeout(90_000);
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  const household = households.track(await seedHousehold(page));

  try {
    const name = "Washing machine warranty proving";
    await saveDeskEntryWithDocument(page, name);
    await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/, { timeout: 30_000 });
    const itemId = new URL(page.url()).searchParams.get("item") as string;
    expect(itemId).toBe(await itemIdOf(page, household.id, name));

    const row = page.locator(`.manifest a.item[id="${itemId}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect(row).toContainText(name);

    const rule = page.locator(".manifest .corridor .month", { hasText: "no date" });
    await expect(rule).toHaveCount(1);
    await expect(rule).toContainText("1 kept without a date");
    // The nearest rule above the row is the no-date one, not a month's or today's.
    const ruleAbove = await row.evaluate((el) => {
      for (let at = el.previousElementSibling; at; at = at.previousElementSibling) {
        if (at.matches(".month, .today")) return at.textContent?.trim() ?? "";
      }
      return null;
    });
    expect(ruleAbove).toMatch(/^no date/);

    await expect(page.locator(`[data-body="${itemId}"]`)).toHaveCount(0);
  } finally {
    await households.sweep(page);
  }
});

/* The tests below stage their failure or hold with `page.route` (a document
   POST that fails once; an item write held mid-save), and on WebKit a request
   from a page Orbit's service worker controls skips Playwright's route
   (#1196, #1235), so the save went straight through. Nothing here is about
   the worker, so on WebKit it is kept out, as in the describes above. */
test.describe(() => {
  test.use({
    serviceWorkers: async ({}, use, testInfo) => {
      await use(testInfo.project.use.defaultBrowserType === "webkit" ? "block" : "allow");
    },
  });

  /**
   * #1316 (owner, 2026-10-13): creating an item with a document is
   * all-or-nothing. The document is staged first (POST
   * /api/households/:id/documents) and the item is sent afterwards in one
   * command that carries `documentIds`. When the stage fails no item is kept;
   * the member sees the most accurate reason available; the form keeps
   * everything entered, the file included; and trying again re-sends the same
   * document id (and the same item id), so nothing is stored twice. This
   * replaces W1-F1/F2, whose half-landed create (the item saved, its document
   * not) can no longer happen. Both dialects: the desk (#save-note) and the
   * phone's pocket (.pk-problem).
   */
  test("a create whose document failed saves no item and can be retried under the same document id", async ({ page }) => {
    test.setTimeout(120_000);
    await answerPushWithoutAService(page);
    await page.goto("/api/auth/login?returnTo=/home");
    await page.getByRole("link", { name: workerAccount("administrator") }).click();
    await settleArrival(page);
    await ensureWorkerAdministrator(page);
    const household = households.track(await seedHousehold(page));

    const pocket = test.info().project.name.startsWith("mobile");
    const upserts: Array<{ itemId: string; documentIds: string[] | undefined }> = [];
    const stagePosts: Array<{ name: string; documentId: string | undefined; itemId: string | undefined }> = [];
    const attachPosts: string[] = [];
    let stageAnswers = 0;

    /* The real saves only: the live checks carry `dryRun: true`. */
    page.on("request", (request) => {
      if (request.method() !== "POST" || !request.url().includes("/api/workspace/commands")) return;
      const body = request.postDataJSON() as { type?: string; dryRun?: boolean; item?: { id?: string }; documentIds?: string[] };
      if (body.type === "item.upsert" && !body.dryRun && body.item?.id) upserts.push({ itemId: body.item.id, documentIds: body.documentIds });
    });
    /* The create no longer attaches onto a saved item: that route is the home drawer's. */
    await page.route(/\/api\/households\/[^/]+\/items\/[^/]+\/documents$/, async (route) => {
      if (route.request().method() === "POST") attachPosts.push(route.request().url());
      return route.fallback();
    });
    /* The first stage POST fails; the retry goes through to the real route. */
    await page.route(/\/api\/households\/[^/]+\/documents$/, async (route) => {
      const request = route.request();
      if (request.method() !== "POST") return route.fallback();
      stagePosts.push({
        name: decodeURIComponent(request.headers()["x-orbit-filename"] ?? ""),
        documentId: request.headers()["x-orbit-document-id"],
        itemId: request.headers()["x-orbit-item-id"],
      });
      stageAnswers += 1;
      if (stageAnswers === 1) {
        return route.fulfill({
          status: 500, contentType: "application/json",
          body: JSON.stringify({ error: { code: "document_store_down", message: "The document store is down" } }),
        });
      }
      return route.fallback();
    });

    try {
      const name = "Retry after a failed document proving";
      const add = pocket ? page.getByRole("button", { name: "Add to orbit" }) : page.locator(".btn-primary");
      const note = pocket ? page.locator(".pk-problem") : page.locator("#save-note");
      const nameField = pocket
        ? page.getByRole("form", { name: "New entry" }).getByRole("textbox", { name: "name", exact: true })
        : page.locator("#f-name");
      const heldFile = pocket ? page.locator(".pc-reading") : page.locator("#dz-held-name");

      await (pocket ? savePocketEntryWithDocument : saveDeskEntryWithDocument)(page, name);

      // The document failed to stage: no item was sent, none is kept.
      await expect.poll(() => stagePosts.length, { timeout: 30_000 }).toBe(1);
      await expect(note).toBeVisible();
      await expect(note).toContainText("The document store is down");
      await expect(note).not.toContainText(/recorded|another try|changed on another device/);
      expect(upserts).toHaveLength(0);
      expect(await itemIdOf(page, household.id, name)).toBeNull();

      // Everything entered stays, the file included, and Add can be pressed again.
      await expect(nameField).toHaveValue(name);
      await expect(heldFile).toContainText(DOCUMENT);
      await expect(add).not.toHaveAttribute("aria-disabled", "true");

      await add.click();
      await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/, { timeout: 30_000 });

      const itemId = new URL(page.url()).searchParams.get("item") as string;
      expect(stagePosts).toHaveLength(2);
      expect(stagePosts[0].documentId).toBeTruthy();
      expect(stagePosts[1].documentId).toBe(stagePosts[0].documentId);
      expect(stagePosts[1].name).toBe(DOCUMENT);
      expect(upserts).toEqual([{ itemId, documentIds: [stagePosts[0].documentId] }]);
      // The ciphertext is sealed under the draft item's id, so both stages name the id the one command used.
      expect(stagePosts.map((one) => one.itemId)).toEqual([itemId, itemId]);
      expect(attachPosts).toHaveLength(0);
      expect(itemId).toBe(await itemIdOf(page, household.id, name));
      await expect.poll(async () => {
        const response = await page.request.get(`/api/households/${household.id}/items/${itemId}/documents`);
        if (!response.ok()) return `http_${response.status()}`;
        const { documents } = (await response.json()) as { documents: Array<{ id: string; displayName: string }> };
        return documents.map((one) => `${one.id}:${one.displayName}`).join(",");
      }, { timeout: 30_000 }).toBe(`${stagePosts[0].documentId}:${DOCUMENT}`);
    } finally {
      await page.unroute(/\/api\/households\/[^/]+\/documents$/).catch(() => {});
      await page.unroute(/\/api\/households\/[^/]+\/items\/[^/]+\/documents$/).catch(() => {});
      await households.sweep(page);
    }
  });

  /**
   * #1316 (owner answer 6a): a file the server refuses stays in the form marked
   * refused with the server's reason; no item is sent; Add is held until the
   * file is replaced or removed, and removing it lets Add save without it.
   * Both dialects. The refusal is the stage route's own 422, so the words are
   * the server's, not the test's.
   */
  test("a document the server refuses stays in the form, holds Add, and saves without it once removed", async ({ page }) => {
    test.setTimeout(120_000);
    await answerPushWithoutAService(page);
    await page.goto("/api/auth/login?returnTo=/home");
    await page.getByRole("link", { name: workerAccount("administrator") }).click();
    await settleArrival(page);
    await ensureWorkerAdministrator(page);
    const household = households.track(await seedHousehold(page));

    const pocket = test.info().project.name.startsWith("mobile");
    const REASON = "That file is not a PDF or image we can keep";
    const upserts: Array<{ itemId: string; documentIds: string[] | undefined }> = [];
    let stagePosts = 0;
    page.on("request", (request) => {
      if (request.method() !== "POST" || !request.url().includes("/api/workspace/commands")) return;
      const body = request.postDataJSON() as { type?: string; dryRun?: boolean; item?: { id?: string }; documentIds?: string[] };
      if (body.type === "item.upsert" && !body.dryRun && body.item?.id) upserts.push({ itemId: body.item.id, documentIds: body.documentIds });
    });
    await page.route(/\/api\/households\/[^/]+\/documents$/, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      stagePosts += 1;
      return route.fulfill({
        status: 422, contentType: "application/json",
        body: JSON.stringify({ error: { code: "document_unsupported_type", message: REASON } }),
      });
    });

    try {
      const name = "Refused document proving";
      const add = pocket ? page.getByRole("button", { name: "Add to orbit" }) : page.locator(".btn-primary");
      const nameField = pocket
        ? page.getByRole("form", { name: "New entry" }).getByRole("textbox", { name: "name", exact: true })
        : page.locator("#f-name");
      const heldFile = pocket ? page.locator(".pc-reading") : page.locator("#dz-held-name");

      await (pocket ? savePocketEntryWithDocument : saveDeskEntryWithDocument)(page, name);
      await expect.poll(() => stagePosts, { timeout: 30_000 }).toBe(1);

      // The file stays, marked refused, with the server's own reason; Add is held; nothing was sent.
      await expect(page.locator("body")).toContainText(REASON);
      await expect(heldFile).toContainText(DOCUMENT);
      await expect(heldFile).toContainText(/refused/i);
      await expect(add).toHaveAttribute("aria-disabled", "true");
      await expect(nameField).toHaveValue(name);
      expect(upserts).toHaveLength(0);
      await add.click({ force: true });
      await page.waitForTimeout(500);
      expect(stagePosts).toBe(1);
      expect(upserts).toHaveLength(0);
      expect(await itemIdOf(page, household.id, name)).toBeNull();

      // Removing the file lets Add save the item without it.
      await page.getByRole("button", { name: /not this one|remove/i }).first().click();
      await expect(add).not.toHaveAttribute("aria-disabled", "true", { timeout: 10_000 });
      await add.click();
      await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/, { timeout: 30_000 });
      const itemId = new URL(page.url()).searchParams.get("item") as string;
      expect(upserts).toHaveLength(1);
      expect(upserts[0].itemId).toBe(itemId);
      expect(upserts[0].documentIds === undefined || upserts[0].documentIds.length === 0).toBe(true);
      expect(stagePosts).toBe(1);
    } finally {
      await page.unroute(/\/api\/households\/[^/]+\/documents$/).catch(() => {});
      await households.sweep(page);
    }
  });

  /**
   * #1316 W1-R5: the desk's save sends the document that was picked when Add
   * was pressed. While "Adding…" shows (the document is already staged and the
   * item write is still in flight), pressing "not this one" or dropping another
   * file must not change what the save carries, nor what the zone says is
   * held: one stage POST, with the first file's name and id, and the item
   * command naming that id in `documentIds`.
   */
  const FIRST_DOCUMENT = DOCUMENT;
  const SECOND_DOCUMENT = "second-file-dropped-mid-save.pdf";

  for (const [title, interference] of [
    ["pressing 'not this one' while Adding… shows", "not this one"],
    ["dropping another file while Adding… shows", "drop"],
  ] as const) {
    test(`the desk's create form: ${title} still attaches the file that was picked`, async ({ page }) => {
      test.skip(test.info().project.name.startsWith("mobile"), "the desk's #dropzone and lane; the phone's pocket form has neither");
      test.setTimeout(120_000);
      await signInWithHousehold(page);

      /* Every id the page mints, in order, so the document id in the POST can be
         tied to the pick that made it (the id is random, minted once per pick). */
      await page.addInitScript(() => {
        const minted: string[] = [];
        (window as unknown as { __minted: string[] }).__minted = minted;
        const original = crypto.randomUUID.bind(crypto);
        crypto.randomUUID = (() => {
          const id = original();
          minted.push(id);
          return id;
        }) as typeof crypto.randomUUID;
      });

      const upserts: string[] = [];
      const upsertDocumentIds: Array<string[] | undefined> = [];
      const documentPosts: Array<{ name: string; documentId: string | undefined; itemId: string | undefined }> = [];
      let releaseItemWrite: () => void = () => {};
      const itemWriteHeld = new Promise<void>((resolveHeld) => { releaseItemWrite = resolveHeld; });
      let itemWriteSeen = false;

      /* The item write is the held reply; the live checks (`dryRun: true`) go through. */
      await page.route("**/api/workspace/commands", async (route) => {
        const request = route.request();
        const body = request.method() === "POST" ? (request.postDataJSON() as { type?: string; dryRun?: boolean; item?: { id?: string }; documentIds?: string[] }) : {};
        if (body.type !== "item.upsert" || body.dryRun) return route.fallback();
        if (body.item?.id) upserts.push(body.item.id);
        upsertDocumentIds.push(body.documentIds);
        itemWriteSeen = true;
        await itemWriteHeld;
        return route.fallback();
      });
      await page.route(/\/api\/households\/[^/]+\/documents$/, async (route) => {
        const request = route.request();
        if (request.method() !== "POST") return route.fallback();
        documentPosts.push({
          name: decodeURIComponent(request.headers()["x-orbit-filename"] ?? ""),
          documentId: request.headers()["x-orbit-document-id"],
          itemId: request.headers()["x-orbit-item-id"],
        });
        return route.fallback();
      });

      try {
        const name = `Mid-save interference proving ${interference === "drop" ? "drop" : "release"}`;
        await gotoCreate(page);
        await page.locator('#card input[type="file"]').setInputFiles({ name: FIRST_DOCUMENT, mimeType: "application/pdf", buffer: DOCUMENT_BYTES });
        await expect(page.locator("#dz-held-name")).toHaveText(FIRST_DOCUMENT);
        await expect(page.locator("#rc-file")).toContainText(FIRST_DOCUMENT);
        const mintedAtFirstPick = await page.evaluate(() => [...(window as unknown as { __minted: string[] }).__minted]);

        await page.locator("#f-name").fill(name);
        await page.locator('#types button[data-type="document"]').click();
        await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
        await page.locator(".btn-primary").click();

        // The item write is held: the form is mid-save.
        await expect.poll(() => itemWriteSeen, { timeout: 20_000 }).toBe(true);
        await expect(page.locator(".btn-primary")).toContainText("Adding…");
        // The file was staged before the item was sent: one POST, for the first file.
        expect(documentPosts).toHaveLength(1);
        expect(documentPosts[0].name).toBe(FIRST_DOCUMENT);

        if (interference === "not this one") {
          await page.locator("#rc-drop").click();
        } else {
          const files = await page.evaluateHandle(({ fileName, bytes }) => {
            const transfer = new DataTransfer();
            transfer.items.add(new File([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], fileName, { type: "application/pdf" }));
            return transfer;
          }, { fileName: SECOND_DOCUMENT, bytes: DOCUMENT_BYTES.toString("base64") });
          const zone = page.locator("#dropzone");
          await zone.dispatchEvent("dragenter", { dataTransfer: files });
          await zone.locator(".dz-main [data-when=rest]").dispatchEvent("drop", { dataTransfer: files });
        }

        // Whatever the form did with it, the zone still names the file the save is carrying.
        await expect(page.locator("#dz-held-name")).toHaveText(FIRST_DOCUMENT);

        releaseItemWrite();
        await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/, { timeout: 30_000 });
        const itemId = new URL(page.url()).searchParams.get("item") as string;
        expect(upserts).toEqual([itemId]);

        // Exactly one stage POST, for the first file, under the id its pick minted,
        // and the one item command binds that same id.
        await page.waitForTimeout(1_000);
        expect(documentPosts).toHaveLength(1);
        expect(documentPosts[0].name).toBe(FIRST_DOCUMENT);
        const postedId = documentPosts[0].documentId as string;
        expect(postedId).toBeTruthy();
        expect(postedId).not.toBe(itemId);
        expect(mintedAtFirstPick).toContain(postedId);
        expect(upsertDocumentIds).toEqual([[postedId]]);
        expect(documentPosts[0].itemId, "the stage names the draft item the command saves").toBe(itemId);
      } finally {
        releaseItemWrite();
        await page.unroute("**/api/workspace/commands").catch(() => {});
        await page.unroute(/\/api\/households\/[^/]+\/documents$/).catch(() => {});
        await households.sweep(page);
      }
    });
  }
});
