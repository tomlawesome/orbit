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
 * the item card instead. #1319 (§34): the belt retired, and the paper is
 * pressed in the item's home drawer; the card stands beside the drawer, or
 * as the bottom sheet under 1200px (v19-home-drawer.spec.ts proves where). This proves the shape end to end: a real upload
 * through the real pipeline renders a real page (chromium-synthetic.pdf, the
 * same fixture v19-document-extraction uses — real font-encoded Chromium
 * output, not something a stub could echo back), Esc closes the card, and a
 * removed file shows its own honest line with no page at all.
 */
/* This file runs with reduced motion. It was written for the belt, whose
   paper marks breathed forever, so Playwright's actionability wait never
   settled on them; the belt retired with #1319 and the papers are pressed
   in home's drawer now. Reduced motion still makes the preview's 900ms focus
   beat instant (PreviewCard.svelte), and changes nothing the preview draws,
   so the assertions below are the same in either mode. */
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

/** #1319: an item's home drawer, opened by its address -- the desk's view
 *  under its row, the phone's open row. */
async function openDrawer(page: Page, itemId: string) {
  await page.goto(`/home?item=${itemId}`);
  if (test.info().project.name.startsWith("mobile")) {
    const row = page.locator(`.pocket .pk-below [data-row-key="${itemId}"]`);
    await expect(row).toHaveAttribute("data-open", "", { timeout: 20_000 });
    return row;
  }
  const drawer = page.locator(`[id="${itemId}-view"]`);
  await expect(drawer).toBeVisible({ timeout: 20_000 });
  return drawer;
}

/** The preview card a paper opens (lib/reading/PreviewCard.svelte): beside
 *  the drawer on a wide desk, the bottom sheet under 1200px. Named for the
 *  file, and its page once it has more than one -- never the reader, whose
 *  name adds the item's. */
const previewOf = (page: Page, filename: string) =>
  page.getByRole("dialog", { name: new RegExp(`^${filename.replace(/[.]/g, "\\.")}(, page \\d+ of \\d+)?$`) });

/** Opens the item's drawer and presses the paper in it; hands back the
 *  drawer, the paper's row and the preview card. */
async function openPaper(page: Page, itemId: string, filename: string) {
  const drawer = await openDrawer(page, itemId);
  const paper = drawer.getByRole("button", { name: `Open ${filename}` });
  await expect(paper).toBeVisible({ timeout: 20_000 });
  await paper.click();
  const card = previewOf(page, filename);
  await expect(card).toBeVisible();
  return { drawer, paper, card };
}

/* #1319: the paper is pressed in the item's home drawer (it used to be on
   the belt); the card is the same on the desk and the phone. */
test("pressing a paper opens the preview, and Esc closes it", async ({ page }) => {
  test.setTimeout(60_000);
  await signInAsAdmin(page);
  const { itemId, householdId } = await seedHouseholdWithItem(page);

  try {
    const doc = await uploadDocument(page, householdId, itemId, "preview-proving.pdf");
    expect(doc.lifecycle).toBe("available");

    const { drawer, card } = await openPaper(page, itemId, "preview-proving.pdf");
    // The real page, rendered by the real endpoint — not a placeholder.
    await expect(card).toHaveClass(/snap/, { timeout: 20_000 });
    await expect(card.getByRole("img", { name: "Page one of preview-proving.pdf" })).toBeVisible();
    // #1300: the fixture is one page -- the pager says so, with no arrows,
    // and no honest state's foot word.
    await expect(card.locator(".pager .pgn")).toHaveText("one page");
    await expect(card.getByRole("button", { name: /next page|previous page/i })).toHaveCount(0);
    await expect(card.getByText(/\b\d+\s*(of|\/)\s*\d+\b/)).toHaveCount(0);
    await expect(card.locator(".rcfoot")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(card).toBeHidden({ timeout: 2_000 });
    // The card goes; the drawer it came from stays.
    await expect(drawer).toBeVisible();
  } finally {
    await households.sweep(page);
  }
});

/* §18: "The page is a button. Pressing it opens the reader" -- on the desk
   and on the phone alike (#1298: the desk's page was a plain picture, so
   only the phone ever reached the reader). Over home now (#1319). */
test("pressing the page opens the reader over home, and Esc closes it", async ({ page }) => {
  test.setTimeout(60_000);
  await signInAsAdmin(page);
  const { itemId, householdId } = await seedHouseholdWithItem(page);

  try {
    await uploadDocument(page, householdId, itemId, "reader-proving.pdf");
    await openPaper(page, itemId, "reader-proving.pdf");

    const pageButton = page.getByRole("button", { name: "Read reader-proving.pdf" });
    await expect(pageButton).toBeEnabled({ timeout: 20_000 });
    await pageButton.click();

    const reader = page.getByRole("dialog", { name: "reader-proving.pdf, Preview proving item" });
    await expect(reader).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/home\\?item=${itemId}`));
    await page.keyboard.press("Escape");
    await expect(reader).toBeHidden({ timeout: 2_000 });
  } finally {
    await households.sweep(page);
  }
});

/* #1301: a click off the page closes the reader and the preview card
   together, and the next paper pressed opens the preview card again -- not
   the reader. The reader's own controls and its page are not "off". Desk
   only: on the phone the preview is a sheet that closes itself (#1072).
   #1319: the drawer stays open under both. */
test("on the desk, a click off the reader returns to the drawer, the reader's own controls do not, and the next press opens the preview first", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the pocket's preview is a sheet with its own close (#1072)");
  test.setTimeout(60_000);
  await signInAsAdmin(page);
  const { itemId, householdId } = await seedHouseholdWithItem(page);

  try {
    await uploadDocument(page, householdId, itemId, "reader-closing.pdf");
    const { drawer, paper } = await openPaper(page, itemId, "reader-closing.pdf");
    const pageButton = page.getByRole("button", { name: "Read reader-closing.pdf" });
    const reader = page.getByRole("dialog", { name: "reader-closing.pdf, Preview proving item" });

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
    await expect(drawer).toBeVisible();

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

    /* #1319: the drawer lists it still, and its card holds still and says
       so, with `restore` as its one word (desk and phone alike). */
    const { card } = await openPaper(page, itemId, "removed-proving.pdf");
    await expect(card.locator(".focusline")).toHaveText("Removed");
    // Never a fabricated page: no page and no image of one.
    await expect(card.locator(".sheet")).toHaveCount(0);
    await expect(card.getByRole("img")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Restore removed-proving.pdf" })).toBeVisible();
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
    await openPaper(page, itemId, "pages-proving.pdf");
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
    await openPaper(page, itemId, "one-page-proving.pdf");
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
    const { drawer } = await openPaper(page, itemId, "pager-proving.pdf");
    const pageButton = page.getByRole("button", { name: "Read pager-proving.pdf" });
    await expect(pageButton).toBeEnabled({ timeout: 20_000 });

    const card = previewOf(page, "pager-proving.pdf");
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
      // The desk's keys turn the preview, never home under it.
      await page.keyboard.press("End");
      await onPage(3);
      await page.keyboard.press("Home");
      await onPage(1);
      await page.keyboard.press("ArrowRight");
      await onPage(2);
      await expect(drawer).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/home\\?item=${itemId}$`));
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
    await openPaper(page, itemId, "one-pager-proving.pdf");
    await expect(page.getByRole("button", { name: "Read one-pager-proving.pdf" })).toBeEnabled({ timeout: 20_000 });

    const card = previewOf(page, "one-pager-proving.pdf");
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
