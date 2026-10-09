import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { householdRegister, sessionHeaders } from "./support/households";
import { settleArrival } from "./support/arrival";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";
import { syntheticNumberedPageWidth, syntheticPdfWithNumberedPages } from "../support/generated-pdf-documents";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * #1088: the document preview — owner-decisions.md §18. A document is never
 * the centred body; pressing a paper opens create-v3's reading card beside
 * the item card instead. This proves the shape end to end: a real upload
 * through the real pipeline renders a real page (chromium-synthetic.pdf, the
 * same fixture v19-document-extraction uses — real font-encoded Chromium
 * output, not something a stub could echo back), Esc closes the card, and a
 * removed file shows its own honest line with no page at all.
 */
/* This file runs with reduced motion, and must: a paper's mark breathes on an
   infinite `belt-halobreath` alternate (belt.css:257, scale .9 -> 1.14), so the
   seat's bounding box never settles and Playwright's actionability wait never
   returns -- `locator.click` hangs until the test's own timeout kills it, and
   the error then surfaces on whatever ran next, which is the cleanup. Nothing
   about the product is wrong: a real pointer clicks a moving target fine.
   Reduced motion is the belt's own first-class mode (`.belt-page *{animation:
   none!important}`, belt.css:432) and stops every breath without changing what
   the preview draws, so the assertions below are the same in either mode. The
   one real difference is #1088's 900ms focus beat, which reduced motion makes
   instant by design (+page.svelte's `reducedMotion() ? 0 : 900`). */
test.use({ reducedMotion: "reduce" });

const HOUSEHOLD_PREFIX = "Preview Proving Ground";
const FIXTURE_PATH = resolve(__dirname, "../support/fixtures/chromium-synthetic.pdf");
const households = householdRegister();

async function signInAsAdmin(page: Page) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: "Orbit Administrator" }).click();
  await settleArrival(page);
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
        title: "Preview proving item",
        currency: "GBP",
        dueDate,
        recurrenceMonths: 12,
      },
      activity: { id: crypto.randomUUID(), itemId, occurredAt: new Date().toISOString() },
    });
    return { itemId, householdId };
  }, name);
  households.track({ id: seeded.householdId, name });
  return seeded;
}

/** Uploads the real PDF fixture through the real per-item route, and hands
 *  back the document the pipeline finished on — scanned, encrypted, and
 *  either available or rejected, never left mid-flight. */
async function uploadDocument(
  page: Page,
  householdId: string,
  itemId: string,
  filename: string,
  bytes: Buffer = readFileSync(FIXTURE_PATH),
): Promise<{ id: string; lifecycle: string }> {
  const headers = { ...(await sessionHeaders(page)), "x-orbit-filename": encodeURIComponent(filename) };
  const response = await page.request.post(
    `/api/households/${householdId}/items/${itemId}/documents`,
    { headers, data: bytes },
  );
  if (!response.ok()) throw new Error(`upload failed: ${response.status()} ${await response.text()}`);
  const body = (await response.json()) as { document: { id: string; lifecycle: string } };
  return body.document;
}

/** #1300: the words a page-turner's number shows, without the screen
 *  reader's own "page " (an .sr-only span) in front of them. */
async function shownText(locator: Locator): Promise<string> {
  return locator.evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    for (const hidden of copy.querySelectorAll(".sr-only")) hidden.remove();
    return (copy.textContent ?? "").trim();
  });
}

test("pressing a paper opens the preview, and Esc closes it", async ({ page }) => {
  test.setTimeout(60_000);
  await signInAsAdmin(page);
  const { itemId, householdId } = await seedHouseholdWithItem(page);

  try {
    const doc = await uploadDocument(page, householdId, itemId, "preview-proving.pdf");
    expect(doc.lifecycle).toBe("available");

    await page.goto(`/item/${itemId}`);
    await expect(page.getByRole("heading", { name: "Preview proving item" })).toBeVisible();

    const paper = page.getByRole("button", { name: /preview-proving\.pdf/ });
    await expect(paper).toBeVisible();
    await paper.click();

    if (test.info().project.name.startsWith("mobile")) {
      /* #1120, proposal §2.3/§18: on a phone the paper raises the preview
         sheet, named for the document, with the page nearly edge to edge. */
      const sheet = page.getByRole("dialog", { name: "preview-proving.pdf" });
      await expect(sheet).toBeVisible();
      // The real page, rendered by the real endpoint — not a placeholder.
      await expect(sheet.locator(".bp-page")).toHaveClass(/shown/, { timeout: 20_000 });
      await expect(sheet.getByRole("img", { name: "Page one of preview-proving.pdf" })).toBeVisible();
      // #1300: the fixture is one page -- the pager says so, with no arrows.
      await expect(sheet.locator(".pager .pgn")).toHaveText("one page");
      await expect(sheet.getByRole("button", { name: /next|previous|page \d/i })).toHaveCount(0);
      await expect(sheet.getByText(/\b\d+\s*(of|\/)\s*\d+\b/)).toHaveCount(0);

      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden({ timeout: 2_000 });
      return;
    }

    const readcard = page.locator("#readcard");
    await expect(readcard).toBeVisible();
    // The real page, rendered by the real endpoint — not a placeholder.
    await expect(readcard).toHaveClass(/snap/, { timeout: 20_000 });
    await expect(readcard.locator(".sheet img")).toBeVisible();
    // #1300: the fixture is one page -- the pager says so, with no arrows,
    // and no honest state's foot word.
    await expect(readcard.locator(".pager .pgn")).toHaveText("one page");
    await expect(readcard.getByRole("button", { name: /next page|previous page/i })).toHaveCount(0);
    await expect(readcard.locator(".rcfoot")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(page.locator("#readcard")).toHaveCount(0, { timeout: 2_000 });
  } finally {
    await households.sweep(page);
  }
});

/* §18: "The page is a button. Pressing it opens the reader" -- on the desk
   and on the phone alike (#1298: the desk's page was a plain picture, so
   only the phone ever reached the reader). */
test("pressing the page opens the reader over the belt, and Esc closes it", async ({ page }) => {
  test.setTimeout(60_000);
  await signInAsAdmin(page);
  const { itemId, householdId } = await seedHouseholdWithItem(page);

  try {
    await uploadDocument(page, householdId, itemId, "reader-proving.pdf");
    await page.goto(`/item/${itemId}`);
    await expect(page.getByRole("heading", { name: "Preview proving item" })).toBeVisible();
    await page.getByRole("button", { name: /reader-proving\.pdf/ }).first().click();

    const pageButton = page.getByRole("button", { name: "Read reader-proving.pdf" });
    await expect(pageButton).toBeEnabled({ timeout: 20_000 });
    await pageButton.click();

    const reader = page.getByRole("dialog", { name: "reader-proving.pdf, Preview proving item" });
    await expect(reader).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(reader).toBeHidden({ timeout: 2_000 });
  } finally {
    await households.sweep(page);
  }
});

/* #1301: a click off the page closes the reader and the preview card
   together, and the next paper pressed opens the preview card again -- not
   the reader. The reader's own controls and its page are not "off". Desk
   only: on the phone the preview is a sheet that closes itself (#1072). */
test("on the desk, a click off the reader returns to the belt, the reader's own controls do not, and the next press opens the preview first", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the pocket's preview is a sheet with its own close (#1072)");
  test.setTimeout(60_000);
  await signInAsAdmin(page);
  const { itemId, householdId } = await seedHouseholdWithItem(page);

  try {
    await uploadDocument(page, householdId, itemId, "reader-closing.pdf");
    await page.goto(`/item/${itemId}`);
    await expect(page.getByRole("heading", { name: "Preview proving item" })).toBeVisible();
    const paper = page.getByRole("button", { name: /reader-closing\.pdf/ }).first();
    const pageButton = page.getByRole("button", { name: "Read reader-closing.pdf" });
    const reader = page.getByRole("dialog", { name: "reader-closing.pdf, Preview proving item" });

    await paper.click();
    await expect(pageButton).toBeEnabled({ timeout: 20_000 });
    await pageButton.click();
    await expect(reader).toBeVisible();

    /* The reader's own controls keep it open. */
    await reader.getByRole("button", { name: "Zoom in" }).click();
    await expect(reader).toBeVisible();
    await expect(reader.locator(".rd-pct")).not.toHaveText("100%");
    await reader.getByRole("button", { name: "fit" }).click();
    await expect(reader).toBeVisible();
    await reader.getByRole("img", { name: /reader-closing\.pdf/ }).click();
    await expect(reader).toBeVisible();

    /* Off the page: the stage's own edge, beside the fitted page. */
    const stage = await reader.locator(".rd-stage").boundingBox();
    if (!stage) throw new Error("the reader's stage has no box");
    await page.mouse.click(stage.x + 4, stage.y + stage.height / 2);
    await expect(reader).toBeHidden({ timeout: 2_000 });
    await expect(pageButton).toBeHidden({ timeout: 2_000 });

    /* The same paper again: the preview card first, not the reader. */
    await paper.click();
    await expect(pageButton).toBeEnabled({ timeout: 20_000 });
    await expect(reader).toBeHidden();
  } finally {
    await households.sweep(page);
  }
});

test("a removed document shows its own line, honestly, and no page", async ({ page }) => {
  test.setTimeout(60_000);
  await signInAsAdmin(page);
  const { itemId, householdId } = await seedHouseholdWithItem(page);

  try {
    const doc = await uploadDocument(page, householdId, itemId, "removed-proving.pdf");
    expect(doc.lifecycle).toBe("available");

    // Soft-delete: pending_deletion, kept 30 days, restore-only (#1054).
    const headers = await sessionHeaders(page);
    const deleted = await page.request.delete(`/api/documents/${doc.id}`, { headers });
    if (!deleted.ok()) throw new Error(`delete failed: ${deleted.status()} ${await deleted.text()}`);

    await page.goto(`/item/${itemId}`);
    const paper = page.getByRole("button", { name: /removed-proving\.pdf/ });
    await expect(paper).toBeVisible();
    await paper.click();

    if (test.info().project.name.startsWith("mobile")) {
      /* #1120, §18 on a phone: the preview sheet holds the plate still and
         says so, with `restore` as its one word. */
      const sheet = page.getByRole("dialog", { name: "removed-proving.pdf" });
      await expect(sheet).toBeVisible();
      await expect(sheet.locator(".bp-line")).toHaveText("Removed");
      // Never a fabricated page: no page and no image of one.
      await expect(sheet.locator(".bp-page")).toHaveCount(0);
      await expect(sheet.getByRole("img")).toHaveCount(0);
      await expect(sheet.getByRole("button", { name: "restore" })).toBeVisible();
      return;
    }

    const readcard = page.locator("#readcard");
    await expect(readcard).toBeVisible();
    await expect(readcard.locator(".focusline")).toHaveText("Removed");
    // Never a fabricated page: the sheet does not exist at all here.
    await expect(readcard.locator(".sheet")).toHaveCount(0);
    await expect(readcard.getByRole("button", { name: "restore" })).toBeVisible();
  } finally {
    await households.sweep(page);
  }
});

/* #1300: page turning, as design/v19/document-card/round-2 and round-6 have
   it -- a round arrow either side of the page, only where there is a page
   that way; ← → PageUp PageDown Home End; "page N of M" in the reader's
   head and "N of M" in its foot, the foot a polite live region heard as
   "page N of M"; a one-page file says "one page" and has no arrows. Desk and
   phone share the reader. The three-page file is synthetic and made here;
   each of its pages is its own width, so the drawn picture's own width says
   which page the server actually drew, not only what the foot claims. */
test("the reader turns a multi-page document to its last page and back, by arrows and by keys", async ({ page }) => {
  test.setTimeout(90_000);
  await signInAsAdmin(page);
  const { itemId, householdId } = await seedHouseholdWithItem(page);

  try {
    await uploadDocument(page, householdId, itemId, "pages-proving.pdf", syntheticPdfWithNumberedPages(3));
    await page.goto(`/item/${itemId}`);
    await expect(page.getByRole("heading", { name: "Preview proving item" })).toBeVisible();
    await page.getByRole("button", { name: /pages-proving\.pdf/ }).first().click();
    const pageButton = page.getByRole("button", { name: "Read pages-proving.pdf" });
    await expect(pageButton).toBeEnabled({ timeout: 20_000 });
    await pageButton.click();

    const reader = page.getByRole("dialog", { name: "pages-proving.pdf, Preview proving item" });
    await expect(reader).toBeVisible();
    const head = reader.locator(".rd-name .rd-of");
    const foot = reader.locator(".rd-page");
    const previous = reader.getByRole("button", { name: "Previous page" });
    const next = reader.getByRole("button", { name: "Next page" });
    const picture = reader.getByRole("img", { name: /pages-proving\.pdf/ });
    /** The page the reader says it is on, and the one the server drew. */
    const onPage = async (n: number) => {
      await expect(head).toHaveText(`· page ${n} of 3`);
      await expect.poll(() => shownText(foot)).toBe(`${n} of 3`);
      await expect(foot).toHaveText(`page ${n} of 3`);
      await expect(foot).toHaveAttribute("aria-live", "polite");
      await expect(picture).toHaveAccessibleName(`Page ${n} of pages-proving.pdf`, { timeout: 20_000 });
      await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete ? img.naturalWidth : 0), { timeout: 20_000 })
        .toBe(Math.round(syntheticNumberedPageWidth(n) * (1_200 / 792)));
      await expect(previous).toHaveCount(n > 1 ? 1 : 0);
      await expect(next).toHaveCount(n < 3 ? 1 : 0);
    };

    await onPage(1);
    await next.click();
    await onPage(2);
    await next.click();
    await onPage(3);
    await previous.click();
    await onPage(2);

    await page.keyboard.press("End");
    await onPage(3);
    await page.keyboard.press("ArrowLeft");
    await onPage(2);
    await page.keyboard.press("Home");
    await onPage(1);
    await page.keyboard.press("PageDown");
    await onPage(2);
    await page.keyboard.press("ArrowRight");
    await onPage(3);
    // Past the end stays on the last page; before the start on the first.
    await page.keyboard.press("ArrowRight");
    await onPage(3);
    await page.keyboard.press("PageUp");
    await onPage(2);
    await page.keyboard.press("PageUp");
    await onPage(1);
    await page.keyboard.press("ArrowLeft");
    await onPage(1);

    await page.keyboard.press("Escape");
    await expect(reader).toBeHidden({ timeout: 2_000 });
  } finally {
    await households.sweep(page);
  }
});

test("a one-page document's reader says \"one page\" and has no arrows", async ({ page }) => {
  test.setTimeout(60_000);
  await signInAsAdmin(page);
  const { itemId, householdId } = await seedHouseholdWithItem(page);

  try {
    await uploadDocument(page, householdId, itemId, "one-page-proving.pdf");
    await page.goto(`/item/${itemId}`);
    await expect(page.getByRole("heading", { name: "Preview proving item" })).toBeVisible();
    await page.getByRole("button", { name: /one-page-proving\.pdf/ }).first().click();
    const pageButton = page.getByRole("button", { name: "Read one-page-proving.pdf" });
    await expect(pageButton).toBeEnabled({ timeout: 20_000 });
    await pageButton.click();

    const reader = page.getByRole("dialog", { name: "one-page-proving.pdf, Preview proving item" });
    await expect(reader).toBeVisible();
    await expect(reader.getByRole("img", { name: "Page 1 of one-page-proving.pdf" })).toBeVisible({ timeout: 20_000 });
    await expect(reader.locator(".rd-page")).toHaveText("one page");
    await expect(reader.locator(".rd-name .rd-of")).toHaveText("· one page");
    await expect(reader.getByRole("button", { name: /previous page|next page/i })).toHaveCount(0);
    // The keys turn nothing either.
    await page.keyboard.press("End");
    await expect(reader.locator(".rd-page")).toHaveText("one page");
  } finally {
    await households.sweep(page);
  }
});

/* #1300, round 6: under the preview's page, before the reader opens, a small
   pager -- "1 of 3", an arrow each way only where there is a page that way --
   turns the page in place, by press and (on the desk) by key. The reader
   opens on the preview's page, and a turn in the reader turns the preview
   too. */
test("the preview's pager turns a multi-page document in place, and the reader opens on its page", async ({ page }) => {
  test.setTimeout(90_000);
  const mobile = test.info().project.name.startsWith("mobile");
  await signInAsAdmin(page);
  const { itemId, householdId } = await seedHouseholdWithItem(page);

  try {
    await uploadDocument(page, householdId, itemId, "pager-proving.pdf", syntheticPdfWithNumberedPages(3));
    await page.goto(`/item/${itemId}`);
    await expect(page.getByRole("heading", { name: "Preview proving item" })).toBeVisible();
    await page.getByRole("button", { name: /pager-proving\.pdf/ }).first().click();
    const pageButton = page.getByRole("button", { name: "Read pager-proving.pdf" });
    await expect(pageButton).toBeEnabled({ timeout: 20_000 });

    const card = mobile ? page.getByRole("dialog", { name: "pager-proving.pdf" }) : page.locator("#readcard");
    const number = card.locator(".pager .pgn");
    const previous = card.getByRole("button", { name: "Previous page" });
    const next = card.getByRole("button", { name: "Next page" });
    const picture = pageButton.locator("img");
    /** The page the pager says, and the one the server drew under it. */
    const onPage = async (n: number) => {
      await expect.poll(() => shownText(number)).toBe(`${n} of 3`);
      await expect(number).toHaveText(`page ${n} of 3`);
      await expect(number).toHaveAttribute("aria-live", "polite");
      await expect(picture).toHaveAttribute("alt", `Page ${n === 1 ? "one" : n} of pager-proving.pdf`, { timeout: 20_000 });
      await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete ? img.naturalWidth : 0), { timeout: 20_000 })
        .toBe(Math.round(syntheticNumberedPageWidth(n) * (1_200 / 792)));
      await expect(previous).toHaveCount(n > 1 ? 1 : 0);
      await expect(next).toHaveCount(n < 3 ? 1 : 0);
    };

    await onPage(1);
    await next.click();
    await onPage(2);
    // By keyboard, so the arrow has focus on every engine (WebKit does not
    // focus a pressed button): when it goes, focus moves to the one left.
    await next.focus();
    await page.keyboard.press("Enter");
    await onPage(3);
    await expect(previous).toBeFocused();
    await previous.click();
    await onPage(2);

    if (!mobile) {
      // The desk's keys turn the preview, never the belt under it.
      await page.keyboard.press("End");
      await onPage(3);
      await page.keyboard.press("Home");
      await onPage(1);
      await page.keyboard.press("ArrowRight");
      await onPage(2);
      await expect(page.getByRole("heading", { name: "Preview proving item" })).toBeVisible();
    }

    // The reader opens on the preview's page...
    await pageButton.click();
    const reader = page.getByRole("dialog", { name: "pager-proving.pdf, Preview proving item" });
    await expect(reader).toBeVisible();
    await expect(reader.locator(".rd-name .rd-of")).toHaveText("· page 2 of 3");
    await expect(reader.getByRole("img", { name: "Page 2 of pager-proving.pdf" })).toBeVisible({ timeout: 20_000 });
    // ...and a turn there turns the preview too.
    await reader.getByRole("button", { name: "Next page" }).click();
    await expect(reader.locator(".rd-name .rd-of")).toHaveText("· page 3 of 3");
    await page.keyboard.press("Escape");
    await expect(reader).toBeHidden({ timeout: 2_000 });
    await onPage(3);
  } finally {
    await households.sweep(page);
  }
});

test("a one-page document's preview pager says \"one page\" and has no arrows", async ({ page }) => {
  test.setTimeout(60_000);
  const mobile = test.info().project.name.startsWith("mobile");
  await signInAsAdmin(page);
  const { itemId, householdId } = await seedHouseholdWithItem(page);

  try {
    await uploadDocument(page, householdId, itemId, "one-pager-proving.pdf");
    await page.goto(`/item/${itemId}`);
    await expect(page.getByRole("heading", { name: "Preview proving item" })).toBeVisible();
    await page.getByRole("button", { name: /one-pager-proving\.pdf/ }).first().click();
    await expect(page.getByRole("button", { name: "Read one-pager-proving.pdf" })).toBeEnabled({ timeout: 20_000 });

    const card = mobile ? page.getByRole("dialog", { name: "one-pager-proving.pdf" }) : page.locator("#readcard");
    await expect(card.locator(".pager .pgn")).toHaveText("one page");
    await expect(card.locator(".pager button")).toHaveCount(0);
    if (!mobile) {
      await page.keyboard.press("End");
      await expect(card.locator(".pager .pgn")).toHaveText("one page");
    }
  } finally {
    await households.sweep(page);
  }
});
