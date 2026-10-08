import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister, sessionHeaders } from "./support/households";
import { settleArrival } from "./support/arrival";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * #1319 (owner-decisions §34; design/v19/belt-purpose/round-3/
 * f-preview-beside-tracked.html): home's item drawer holds everything the
 * belt did. A document in it opens its preview beside the drawer on a wide
 * screen (the bottom sheet on a phone), Escape or a press off it removes it
 * and leaves the drawer open, and pressing the page opens the reader over
 * home. The foot row's snooze and complete act from the drawer itself.
 *
 * Stage 2 (design/v19/belt-purpose/round-8/m-colour-per-option.html):
 * the pencil puts the drawer's own rows into edit mode, a chosen value
 * opens the chooser card beside the drawer (the bottom sheet on a phone),
 * Escape takes the chooser and then the edit; snooze opens the calendar
 * ("snooze until"); complete asks for its date, cost and notes in the rows
 * and records them.
 *
 * A real upload through the real pipeline, as v19-document-preview.spec.ts
 * does, so the page drawn is a real render, not a placeholder.
 */
/* Reduced motion: the preview's 900ms focus beat is instant, and nothing
   breathes under Playwright's actionability wait (v19-document-preview's
   own reason). The assertions hold in either mode. */
test.use({ reducedMotion: "reduce" });

const HOUSEHOLD_PREFIX = "Drawer Proving Ground";
const TITLE = "Drawer proving item";
const NOTE = "Book the early slot.";
const FIXTURE_PATH = resolve(__dirname, "../support/fixtures/chromium-synthetic.pdf");
const households = householdRegister();

async function signIn(page: Page) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
}

/** A household of its own (household.create makes it the one home shows)
 *  with one item, due in 20 days so the phone's manifest lists it too. */
async function seedHouseholdWithItem(page: Page): Promise<{ itemId: string; householdId: string; dueDate: string }> {
  const name = `${HOUSEHOLD_PREFIX} ${randomUUID().slice(0, 8)}`;
  const seeded = await page.evaluate(async ({ householdName, title, note }) => {
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
        title,
        currency: "GBP",
        dueDate,
        recurrenceMonths: 12,
        notes: note,
      },
      activity: { id: crypto.randomUUID(), itemId, occurredAt: new Date().toISOString() },
    });
    return { itemId, householdId, dueDate };
  }, { householdName: name, title: TITLE, note: NOTE });
  households.track({ id: seeded.householdId, name });
  return seeded;
}

/** The real PDF fixture through the real per-item route. */
async function uploadDocument(page: Page, householdId: string, itemId: string, filename: string) {
  const headers = { ...(await sessionHeaders(page)), "x-orbit-filename": encodeURIComponent(filename) };
  const response = await page.request.post(
    `/api/households/${householdId}/items/${itemId}/documents`,
    { headers, data: readFileSync(FIXTURE_PATH) },
  );
  if (!response.ok()) throw new Error(`upload failed: ${response.status()} ${await response.text()}`);
  const body = (await response.json()) as { document: { id: string; lifecycle: string } };
  return body.document;
}

/** The calendar's day 15 of next month: always ahead of today. */
function dayNextMonth(): RegExp {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15));
  const month = next.toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
  return new RegExp(`^\\w+ 15 ${month} ${next.getUTCFullYear()}`);
}

/** The item as the server holds it now. */
async function itemOf(page: Page, householdId: string, itemId: string) {
  return page.evaluate(async ({ householdId, itemId }) => {
    const response = await fetch("/api/workspace", { credentials: "same-origin", cache: "no-store" });
    const body = (await response.json()) as {
      workspace: { households: { id: string; items?: { id: string; dueDate?: string | null; snoozedUntil?: string | null; provider?: string | null }[] }[] };
    };
    return body.workspace.households.find((one) => one.id === householdId)?.items?.find((one) => one.id === itemId) ?? null;
  }, { householdId, itemId });
}

test.afterEach(async ({ page }) => {
  await households.sweep(page);
});

/* #1319 stage 3b: the belt retired, and its address with it. `/item/<id>`
   is answered on the server with `/home?item=<id>`, so an old link, a
   reminder or a bookmark lands in that item's drawer; bare `/item` lands on
   home. */
test.describe("the belt's old address", () => {
  test("/item/<id> lands on /home?item=<id> with that drawer open", async ({ page, isMobile }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const { itemId } = await seedHouseholdWithItem(page);

    const response = await page.request.get(`/item/${itemId}`, { maxRedirects: 0 });
    expect(response.status()).toBe(308);
    expect(response.headers().location).toBe(`/home?item=${itemId}`);

    await page.goto(`/item/${itemId}`);
    await expect(page).toHaveURL(new RegExp(`/home\\?item=${itemId}$`));
    if (isMobile) {
      await expect(page.locator(`.pocket .pk-below [data-row-key="${itemId}"]`))
        .toHaveAttribute("data-open", "", { timeout: 20_000 });
    } else {
      const drawer = page.locator(`[id="${itemId}-view"]`);
      await expect(drawer).toBeVisible({ timeout: 20_000 });
      await expect(drawer.getByText(NOTE)).toBeVisible();
    }

    await page.goto("/item");
    await expect(page).toHaveURL(/\/home$/);
  });
});

test.describe("on the desk", () => {
  test.skip(({ isMobile }) => isMobile, "the desk's drawer; the phone's is below");

  /* #1305: the dial callout's documents chip opens the item's own drawer
     with its real documents. It used to open a dialog of the mockup's two
     made-up papers under whichever item's name. (The phone's dial has no
     callout, so no chip.) */
  test("the dial's documents chip opens the item's drawer at its real documents", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const { itemId, householdId } = await seedHouseholdWithItem(page);
    await uploadDocument(page, householdId, itemId, "chip-proving.pdf");

    await page.goto("/home");
    const body = page.locator(`.body-link[data-body="${itemId}"]`);
    await expect(body).toHaveAttribute("data-docs", "1", { timeout: 20_000 });
    /* The markup is drawn before home's listeners are bound (#1064): a
       synthetic mouseenter sent in that gap is heard by nobody, and there is
       no second one. Wait for the screen to be able to answer. */
    await expect(page.locator("body[data-home-ready]")).toBeAttached();
    await body.dispatchEvent("mouseenter");
    const chip = page.locator(".callout.show .chip");
    await expect(chip).toHaveText("◆ 1 document");
    await chip.click();

    const drawer = page.locator(`[id="${itemId}-view"]`);
    await expect(drawer).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(new RegExp(`/home\\?item=${itemId}$`));
    const paper = drawer.getByRole("button", { name: "Open chip-proving.pdf" });
    await expect(paper).toBeFocused();
    await expect(drawer.locator("[data-doc-row]")).toHaveCount(1);
    /* nothing made up, anywhere on the screen */
    await expect(page.getByText("service-invoice-2026.pdf")).toHaveCount(0);
    await expect(page.locator("#docview")).toHaveCount(0);
  });

  test("a document opens its preview beside the drawer; the page opens the reader; Escape walks back", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const { itemId, householdId } = await seedHouseholdWithItem(page);
    const doc = await uploadDocument(page, householdId, itemId, "drawer-proving.pdf");
    expect(doc.lifecycle).toBe("available");

    await page.goto(`/home?item=${itemId}`);
    const row = page.locator(`a.item[id="${itemId}"]`);
    const drawer = page.locator(`[id="${itemId}-view"]`);
    await expect(drawer).toBeVisible({ timeout: 20_000 });
    /* the drawer is the item now: no way onward to the belt */
    await expect(drawer.getByRole("link", { name: "manage this item →" })).toHaveCount(0);
    /* notes above documents (owner, 2026-10-08) */
    await expect(drawer.locator("h4")).toHaveText(["notes", "documents"]);
    await expect(drawer.getByText(NOTE)).toBeVisible();

    /* level the row a little below the page's 84px gutter, so the card's
       top has the row's top to sit level with */
    await row.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 120));
    const paper = drawer.getByRole("button", { name: "Open drawer-proving.pdf" });
    await paper.click();

    const card = page.getByRole("dialog", { name: /^drawer-proving\.pdf/ });
    await expect(card).toBeVisible();
    await expect(paper).toHaveAttribute("aria-current", "true");
    const pageButton = card.getByRole("button", { name: "Read drawer-proving.pdf" });
    await expect(pageButton).toBeEnabled({ timeout: 20_000 });
    await expect(card.getByRole("img", { name: "Page one of drawer-proving.pdf" })).toBeVisible();

    /* round 3 (F): beside the drawer, its top level with the item card's */
    const width = page.viewportSize()?.width ?? 0;
    if (width >= 1200) {
      const [rowBox, cardBox, drawerBox] = await Promise.all([row.boundingBox(), card.boundingBox(), drawer.boundingBox()]);
      expect(Math.abs((cardBox?.y ?? 0) - (rowBox?.y ?? 0)), "the card's top is not level with the item card's").toBeLessThan(2);
      expect(cardBox?.x ?? 0, "the card is not beside the drawer").toBeGreaterThan((drawerBox?.x ?? 0) + (drawerBox?.width ?? 0));
    }

    /* the page opens the reader over home */
    await pageButton.click();
    const reader = page.getByRole("dialog", { name: `drawer-proving.pdf, ${TITLE}` });
    await expect(reader).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/home\\?item=${itemId}`));

    /* Escape closes the reader onto the page that opened it… */
    await page.keyboard.press("Escape");
    await expect(reader).toBeHidden();
    await expect(pageButton).toBeFocused();
    /* …then the card, at once, onto the row that opened it; the drawer stays */
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(paper).toBeFocused();
    await expect(drawer).toBeVisible();

    /* a press off the card removes it too, and leaves the drawer open */
    await paper.click();
    await expect(card).toBeVisible();
    await page.mouse.click((page.viewportSize()?.width ?? 1280) - 8, (page.viewportSize()?.height ?? 720) - 8);
    await expect(card).toHaveCount(0);
    await expect(drawer).toBeVisible();
  });

  test("snooze and complete act from the drawer's foot row", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    const { itemId, householdId, dueDate } = await seedHouseholdWithItem(page);

    await page.goto(`/home?item=${itemId}`);
    const drawer = page.locator(`[id="${itemId}-view"]`);
    await expect(drawer).toBeVisible({ timeout: 20_000 });
    const acts = drawer.getByRole("group", { name: `Actions for ${TITLE}` });
    await expect(acts.getByRole("button")).toHaveText(["snooze", "complete", "attach a document", "retire"]);
    await expect(drawer.getByRole("button", { name: "Edit this item" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Copy link" })).toBeVisible();

    /* snooze opens the calendar beside the drawer; a day picked snoozes */
    await acts.getByRole("button", { name: `Snooze ${TITLE}` }).click();
    const calendar = page.getByRole("dialog", { name: /snooze until/i });
    await expect(calendar).toBeVisible();
    await calendar.getByRole("button", { name: "Next month" }).click();
    await calendar.getByRole("button", { name: dayNextMonth() }).click();
    await expect(calendar).toHaveCount(0);
    await expect(drawer.getByText("snoozed until")).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => (await itemOf(page, householdId, itemId))?.snoozedUntil ?? null).not.toBeNull();

    /* complete asks in the rows: the date (today), the cost, the notes as
       they were; record sends it and the next orbit comes round */
    await drawer.getByRole("group", { name: `Actions for ${TITLE}` })
      .getByRole("button", { name: `Complete ${TITLE}` }).click();
    const completing = drawer.getByRole("group", { name: `Completing ${TITLE}` });
    await expect(completing.getByRole("button")).toHaveText(["record", "cancel"]);
    await expect(drawer.getByRole("button", { name: /^completed on: / })).toBeFocused();
    await expect(drawer.getByRole("textbox", { name: "notes" })).toHaveText(NOTE);
    await completing.getByRole("button", { name: "record" }).click();
    await expect(page.getByText(/^Completed · next due/).first()).toBeAttached();
    await expect.poll(async () => (await itemOf(page, householdId, itemId))?.dueDate, { timeout: 15_000 })
      .not.toBe(dueDate);
  });

  test("the pencil edits the drawer's own rows; Escape takes the chooser, then the edit", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    const { itemId, householdId } = await seedHouseholdWithItem(page);

    await page.goto(`/home?item=${itemId}`);
    const drawer = page.locator(`[id="${itemId}-view"]`);
    await expect(drawer).toBeVisible({ timeout: 20_000 });
    const pencil = drawer.getByRole("button", { name: "Edit this item" });
    await pencil.click();
    await expect(pencil).toHaveAttribute("aria-pressed", "true");
    /* the title edits in the row's head; save and cancel stand in the pills' place */
    await expect(page.locator(`[id="${itemId}"]`).getByRole("textbox", { name: "title" })).toBeFocused();
    await expect(drawer.getByRole("group", { name: `Editing ${TITLE}` }).getByRole("button")).toHaveText(["save", "cancel"]);

    /* the due date opens the calendar beside the drawer; Escape takes it
       away and hands focus back to the value */
    const due = drawer.getByRole("button", { name: /^due: / });
    await due.click();
    const calendar = page.getByRole("dialog", { name: /due date/i });
    await expect(calendar).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(calendar).toHaveCount(0);
    await expect(due).toBeFocused();
    /* the second Escape cancels the edit and leaves the drawer open */
    await page.keyboard.press("Escape");
    await expect(drawer.getByRole("group", { name: `Actions for ${TITLE}` })).toBeVisible();
    await expect(pencil).toBeFocused();

    /* typed in place, saved through the item */
    await pencil.click();
    const provider = drawer.getByRole("textbox", { name: "provider" });
    await provider.click();
    await page.keyboard.type("Northgate Services");
    await drawer.getByRole("group", { name: `Editing ${TITLE}` }).getByRole("button", { name: "save" }).click();
    await expect(drawer.getByText("Northgate Services")).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => (await itemOf(page, householdId, itemId))?.provider ?? null).toBe("Northgate Services");
  });
});

test.describe("on the phone", () => {
  test.skip(({ isMobile }) => !isMobile, "the phone's drawer; the desk's is above");

  test("a document in the drawer opens the preview as the bottom sheet", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const { itemId, householdId } = await seedHouseholdWithItem(page);
    await uploadDocument(page, householdId, itemId, "drawer-proving.pdf");

    await page.goto(`/home?item=${itemId}`);
    const row = page.locator(`.pocket .pk-below [data-row-key="${itemId}"]`);
    await expect(row).toHaveAttribute("data-open", "", { timeout: 20_000 });
    /* the foot row, as the desk's */
    await expect(row.getByRole("group", { name: `Actions for ${TITLE}` }).getByRole("button"))
      .toHaveText(["snooze", "complete", "attach a document", "retire"]);
    await expect(row.getByRole("link", { name: /^Open / })).toHaveCount(0);

    const paper = row.getByRole("button", { name: "Open drawer-proving.pdf" });
    await expect(paper).toBeVisible({ timeout: 20_000 });
    await paper.tap();
    const sheet = page.getByRole("dialog", { name: /^drawer-proving\.pdf/ });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Read drawer-proving.pdf" })).toBeEnabled({ timeout: 20_000 });
    /* the bottom sheet: fixed to the foot of the screen */
    const box = await sheet.boundingBox();
    const height = page.viewportSize()?.height ?? 0;
    expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) - height)).toBeLessThan(2);

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(row).toHaveAttribute("data-open", "");

    /* stage 2: the pencil edits the rows, the title in the row's head; the
       due date's calendar is the bottom sheet; Escape takes it, then the edit */
    await row.getByRole("button", { name: "Edit this item" }).tap();
    /* the title is live in the row's head; its button is put away meanwhile */
    await expect(row.getByRole("textbox", { name: "title" })).toBeFocused();
    await expect(row.locator("[data-row-face]")).toBeHidden();
    await row.getByRole("button", { name: /^due: / }).tap();
    const calendar = page.getByRole("dialog", { name: /due date/i });
    await expect(calendar).toBeVisible();
    const sheetBox = await calendar.boundingBox();
    expect(Math.abs((sheetBox?.y ?? 0) + (sheetBox?.height ?? 0) - height)).toBeLessThan(2);
    await page.keyboard.press("Escape");
    await expect(calendar).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(row.getByRole("group", { name: `Actions for ${TITLE}` })).toBeVisible();
    await expect(row).toHaveAttribute("data-open", "");
  });
});
