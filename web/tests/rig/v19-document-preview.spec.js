import { expect, test } from "@playwright/test";

import { SETTLE } from "../../../tests/e2e/support/settle";
import { APP, onPhone } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Locator} Locator */
/** @typedef {import("@playwright/test").Page} Page */

/*
 * #1088, #1300, #1319, #1501, #1559, moved to the rig (ADR-0039, #1610): the
 * document preview and reader. A paper is pressed in its item's home drawer
 * (the open row on a phone); the preview card stands beside the drawer on a
 * wide desk and is the bottom sheet under 1200px; pressing its page opens the
 * reader over home. Desk and phone alike unless a test says so.
 *
 * What stays on the stack, in tests/e2e/v19-document-preview.spec.ts: "pressing
 * a paper opens the preview, and Esc closes it" with a REAL upload, which is
 * the one proof that a real PDF goes through the scan, the encryption and the
 * sandboxed renderer and comes out as a page in the card. This file carries
 * the same journey's screen behaviour from the fixture app.
 *
 * Deleted with a lower test named (not ported): the drawn picture's own width
 * says which page the server drew, a check of the real renderer, which
 * tests/integration/document-lifecycle.test.ts:1497 ("draws the page asked
 * for and carries the page count") proves with the same numbered PDF. Here the
 * picture's accessible name ("Page 2 of ...") and the request the browser
 * sent carry which page was asked for.
 *
 * FIXTURE STATES THIS FILE NEEDS THAT DO NOT EXIST YET (the tests fail until
 * they do; nothing here fakes them):
 *   THREE_PAGE_PAPER  a third document on item i-svc, "three-page-proving.pdf",
 *                     lifecycle stored/clean/ready, whose preview route
 *                     answers ?page=1, 2 and 3 with X-Orbit-Page-Count: 3
 *                     (a page past the third is the real route's 404). Today
 *                     every fixture document is one page.
 *   REMOVED_PAPER     a fourth document on item i-svc, "removed-proving.pdf",
 *                     lifecycle pending_deletion, recoverable, kept 30 days,
 *                     so the card holds still with its "Removed" line and
 *                     Restore.
 * The one-page tests use the fixture's own MOT certificate.
 *
 * Reduced motion, as the original: the preview's 900 ms focus beat is then
 * instant and nothing the preview draws changes.
 */
test.use({ baseURL: APP, reducedMotion: "reduce" });

const ONE_PAGE_PAPER = { item: "i-mot", itemTitle: "Car MOT — Volvo V60", file: "MOT certificate 2025" };
const THREE_PAGE_PAPER = { item: "i-svc", itemTitle: "Car full service", file: "three-page-proving.pdf" };
const REMOVED_PAPER = { item: "i-svc", itemTitle: "Car full service", file: "removed-proving.pdf" };

/** @typedef {{ item: string, itemTitle: string, file: string }} Paper */

/** The words a page-turner's number shows, without the screen reader's own
 *  "page " (an .sr-only span) in front of them (#1300).
 * @param {Locator} locator */
async function shownText(locator) {
  return locator.evaluate((el) => {
    const copy = /** @type {HTMLElement} */ (el.cloneNode(true));
    for (const hidden of copy.querySelectorAll(".sr-only")) hidden.remove();
    return (copy.textContent ?? "").trim();
  });
}

/** The picture is drawn: complete and with a width.
 * @param {Locator} picture */
const drawn = (picture) =>
  expect.poll(() => picture.evaluate((/** @type {HTMLImageElement} */ img) => (img.complete ? img.naturalWidth : 0)), { timeout: SETTLE })
    .toBeGreaterThan(0);

/** #1319: an item's home drawer, opened by its address -- the desk's view
 *  under its row, the phone's open row.
 * @param {Page} page @param {string} itemId @param {import("@playwright/test").TestInfo} info */
async function openDrawer(page, itemId, info) {
  await page.goto(`/home?item=${itemId}`);
  if (onPhone(info)) {
    const row = page.locator(`.pocket .pk-below [data-row-key="${itemId}"]`);
    await expect(row).toHaveAttribute("data-open", "", { timeout: SETTLE });
    return row;
  }
  const drawer = page.locator(`[id="${itemId}-view"]`);
  await expect(drawer).toBeVisible({ timeout: SETTLE });
  return drawer;
}

/** The preview card a paper opens (lib/reading/PreviewCard.svelte): named for
 *  the file, and its page once it has more than one -- never the reader, whose
 *  name adds the item's.
 * @param {Page} page @param {string} file */
const previewOf = (page, file) =>
  page.getByRole("dialog", { name: new RegExp(`^${file.replace(/[.]/g, "\\.")}(, page \\d+ of \\d+)?$`) });

/** The reader's dialog, named for the file and its item.
 * @param {Page} page @param {Paper} paper */
const readerOf = (page, paper) => page.getByRole("dialog", { name: `${paper.file}, ${paper.itemTitle}` });

/** Opens the item's drawer and presses the paper in it.
 * @param {Page} page @param {Paper} paper @param {import("@playwright/test").TestInfo} info */
async function openPaper(page, paper, info) {
  const drawer = await openDrawer(page, paper.item, info);
  const pressed = drawer.getByRole("button", { name: `Open ${paper.file}` });
  await expect(pressed).toBeVisible({ timeout: SETTLE });
  await pressed.click();
  const card = previewOf(page, paper.file);
  await expect(card).toBeVisible();
  return { drawer, paper: pressed, card };
}

/** Opens the reader from the card: the page is a button (§18).
 * @param {Page} page @param {Paper} paper */
async function openReader(page, paper) {
  const pageButton = page.getByRole("button", { name: `Read ${paper.file}` });
  await expect(pageButton).toBeEnabled({ timeout: SETTLE });
  await pageButton.click();
  const reader = readerOf(page, paper);
  await expect(reader).toBeVisible();
  return { pageButton, reader };
}

/* #1319: the paper is pressed in the item's home drawer; the card is the same
   on the desk and the phone. */
test("pressing a paper opens the preview, and Esc closes it", async ({ page }, testInfo) => {
  const { drawer, card } = await openPaper(page, ONE_PAGE_PAPER, testInfo);
  await expect(card).toHaveClass(/snap/, { timeout: SETTLE });
  await expect(card.getByRole("img", { name: `Page one of ${ONE_PAGE_PAPER.file}` })).toBeVisible();
  // #1300: the fixture is one page -- the pager says so, with no arrows, and
  // no honest state's foot word.
  await expect(card.locator(".pager .pgn")).toHaveText("one page");
  await expect(card.getByRole("button", { name: /next page|previous page/i })).toHaveCount(0);
  await expect(card.getByText(/\b\d+\s*(of|\/)\s*\d+\b/)).toHaveCount(0);
  await expect(card.locator(".rcfoot")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(card).toBeHidden({ timeout: SETTLE });
  // The card goes; the drawer it came from stays.
  await expect(drawer).toBeVisible();
});

/* §18: "The page is a button. Pressing it opens the reader" -- on the desk and
   on the phone alike (#1298). Over home now (#1319). */
test("pressing the page opens the reader over home, and Esc closes it", async ({ page }, testInfo) => {
  await openPaper(page, ONE_PAGE_PAPER, testInfo);
  const { reader } = await openReader(page, ONE_PAGE_PAPER);
  await expect(page).toHaveURL(new RegExp(`/home\\?item=${ONE_PAGE_PAPER.item}`));
  await page.keyboard.press("Escape");
  await expect(reader).toBeHidden({ timeout: SETTLE });
});

/* #1301: a click off the page closes the reader and the preview card together,
   and the next paper pressed opens the preview card again -- not the reader.
   The reader's own controls and its page are not "off". Desk only: on the
   phone the preview is a sheet that closes itself (#1072). #1319: the drawer
   stays open under both. */
test("on the desk, a click off the reader returns to the drawer, the reader's own controls do not, and the next press opens the preview first", async ({ page }, testInfo) => {
  test.skip(onPhone(testInfo), "the pocket's preview is a sheet with its own close (#1072)");
  const { drawer, paper } = await openPaper(page, ONE_PAGE_PAPER, testInfo);
  const { pageButton, reader } = await openReader(page, ONE_PAGE_PAPER);

  /* The reader's own controls keep it open. */
  await reader.getByRole("button", { name: "Zoom in" }).click();
  await expect(reader).toBeVisible();
  await expect(reader.locator(".rd-pct")).not.toHaveText("100%");
  await reader.getByRole("button", { name: "fit" }).click();
  await expect(reader).toBeVisible();
  await reader.getByRole("img", { name: new RegExp(ONE_PAGE_PAPER.file) }).click();
  await expect(reader).toBeVisible();

  /* Off the page: the stage's own edge, beside the fitted page. */
  const stage = await reader.locator(".rd-stage").boundingBox();
  if (!stage) throw new Error("the reader's stage has no box");
  await page.mouse.click(stage.x + 4, stage.y + stage.height / 2);
  await expect(reader).toBeHidden({ timeout: SETTLE });
  await expect(pageButton).toBeHidden({ timeout: SETTLE });
  await expect(drawer).toBeVisible();

  /* The same paper again: the preview card first, not the reader. */
  await paper.click();
  await expect(pageButton).toBeEnabled({ timeout: SETTLE });
  await expect(reader).toBeHidden();
});

test("a removed document shows its own line, honestly, and no page", async ({ page }, testInfo) => {
  /* #1319: the drawer lists it still, and its card holds still and says so,
     with `restore` as its one word (desk and phone alike). */
  const { card } = await openPaper(page, REMOVED_PAPER, testInfo);
  await expect(card.locator(".focusline")).toHaveText("Removed");
  // Never a fabricated page: no page and no image of one.
  await expect(card.locator(".sheet")).toHaveCount(0);
  await expect(card.getByRole("img")).toHaveCount(0);
  await expect(card.getByRole("button", { name: `Restore ${REMOVED_PAPER.file}` })).toBeVisible();
});

/* #1300: page turning, as design/v19/document-card/round-2 and round-6 have it
   -- a round arrow either side of the page, only where there is a page that
   way; ← → PageUp PageDown Home End; "page N of M" in the reader's head and "N
   of M" in its foot, the foot a polite live region heard as "page N of M"; a
   one-page file says "one page" and has no arrows. Desk and phone share the
   reader. */
test("the reader turns a multi-page document to its last page and back, by arrows and by keys", async ({ page }, testInfo) => {
  await openPaper(page, THREE_PAGE_PAPER, testInfo);
  const { reader } = await openReader(page, THREE_PAGE_PAPER);
  const head = reader.locator(".rd-name .rd-of");
  const foot = reader.locator(".rd-page");
  const previous = reader.getByRole("button", { name: "Previous page" });
  const next = reader.getByRole("button", { name: "Next page" });
  const picture = reader.getByRole("img", { name: new RegExp(THREE_PAGE_PAPER.file.replace(/[.]/g, "\\.")) });
  /** The page the reader says it is on, and the one it drew (the picture's
   *  own name, which says which page it was asked for).
   * @param {number} n */
  const onPage = async (n) => {
    await expect(head).toHaveText(`· page ${n} of 3`, { timeout: SETTLE });
    await expect.poll(() => shownText(foot), { timeout: SETTLE }).toBe(`${n} of 3`);
    await expect(foot).toHaveText(`page ${n} of 3`, { timeout: SETTLE });
    await expect(foot).toHaveAttribute("aria-live", "polite");
    await expect(picture).toHaveAccessibleName(`Page ${n} of ${THREE_PAGE_PAPER.file}`, { timeout: SETTLE });
    await drawn(picture);
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
  await expect(reader).toBeHidden({ timeout: SETTLE });
});

test("a one-page document's reader says \"one page\" and has no arrows", async ({ page }, testInfo) => {
  await openPaper(page, ONE_PAGE_PAPER, testInfo);
  const { reader } = await openReader(page, ONE_PAGE_PAPER);
  /* The reader's <img> carries its alt from the moment it opens, before the
     reader's own render of the page has arrived, so it is "visible" at once
     and says nothing about the page. The count ("one page") arrives with that
     render, in the same step as the picture's source: wait for the drawn
     picture, then read the words. */
  await drawn(reader.getByRole("img", { name: "Page 1 of " + ONE_PAGE_PAPER.file }));
  await expect(reader.locator(".rd-page")).toHaveText("one page");
  await expect(reader.locator(".rd-name .rd-of")).toHaveText("· one page");
  await expect(reader.getByRole("button", { name: /previous page|next page/i })).toHaveCount(0);
  // The keys turn nothing either.
  await page.keyboard.press("End");
  await expect(reader.locator(".rd-page")).toHaveText("one page");
});

/* #1300, round 6: under the preview's page, before the reader opens, a small
   pager -- "1 of 3", an arrow each way only where there is a page that way --
   turns the page in place, by press and (on the desk) by key. The reader opens
   on the preview's page, and a turn in the reader turns the preview too. */
test("the preview's pager turns a multi-page document in place, and the reader opens on its page", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  const { drawer } = await openPaper(page, THREE_PAGE_PAPER, testInfo);
  const pageButton = page.getByRole("button", { name: `Read ${THREE_PAGE_PAPER.file}` });
  await expect(pageButton).toBeEnabled({ timeout: SETTLE });

  const card = previewOf(page, THREE_PAGE_PAPER.file);
  const number = card.locator(".pager .pgn");
  const previous = card.getByRole("button", { name: "Previous page" });
  const next = card.getByRole("button", { name: "Next page" });
  const picture = pageButton.locator("img");
  /** The page the pager says, and the one drawn under it.
   * @param {number} n */
  const onPage = async (n) => {
    await expect.poll(() => shownText(number)).toBe(`${n} of 3`);
    await expect(number).toHaveText(`page ${n} of 3`);
    await expect(number).toHaveAttribute("aria-live", "polite");
    await expect(picture).toHaveAttribute("alt", `Page ${n === 1 ? "one" : n} of ${THREE_PAGE_PAPER.file}`, { timeout: SETTLE });
    await drawn(picture);
    await expect(previous).toHaveCount(n > 1 ? 1 : 0);
    await expect(next).toHaveCount(n < 3 ? 1 : 0);
  };

  await onPage(1);
  await next.click();
  await onPage(2);
  // By keyboard, so the arrow has focus on every engine (WebKit does not focus
  // a pressed button): when it goes, focus moves to the one left.
  await next.focus();
  await page.keyboard.press("Enter");
  await onPage(3);
  await expect(previous).toBeFocused();
  await previous.click();
  await onPage(2);

  if (!phone) {
    // The desk's keys turn the preview, never home under it.
    await page.keyboard.press("End");
    await onPage(3);
    await page.keyboard.press("Home");
    await onPage(1);
    await page.keyboard.press("ArrowRight");
    await onPage(2);
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/home\\?item=${THREE_PAGE_PAPER.item}$`));
  }

  // The reader opens on the preview's page...
  await pageButton.click();
  const reader = readerOf(page, THREE_PAGE_PAPER);
  await expect(reader).toBeVisible();
  await expect(reader.locator(".rd-name .rd-of")).toHaveText("· page 2 of 3");
  await expect(reader.getByRole("img", { name: `Page 2 of ${THREE_PAGE_PAPER.file}` })).toBeVisible({ timeout: SETTLE });
  // ...and a turn there turns the preview too.
  await reader.getByRole("button", { name: "Next page" }).click();
  await expect(reader.locator(".rd-name .rd-of")).toHaveText("· page 3 of 3");
  await page.keyboard.press("Escape");
  await expect(reader).toBeHidden({ timeout: SETTLE });
  await onPage(3);
});

test("a one-page document's preview pager says \"one page\" and has no arrows", async ({ page }, testInfo) => {
  await openPaper(page, ONE_PAGE_PAPER, testInfo);
  await expect(page.getByRole("button", { name: `Read ${ONE_PAGE_PAPER.file}` })).toBeEnabled({ timeout: SETTLE });

  const card = previewOf(page, ONE_PAGE_PAPER.file);
  await expect(card.locator(".pager .pgn")).toHaveText("one page");
  await expect(card.locator(".pager button")).toHaveCount(0);
  if (!onPhone(testInfo)) {
    await page.keyboard.press("End");
    await expect(card.locator(".pager .pgn")).toHaveText("one page");
  }
});

/* #1501: the preview image is asked for once per page, however many parts of
   the screen show it. The pager flaked on WebKit because every turn in the
   reader fetched the same page twice (once for the reader, once for the card
   under it), and opening the reader fetched again the page the card already
   held. Each fetch is a sandboxed server render, so a duplicate is a second
   render queued behind the first. These count the requests the browser sends
   to the preview image route; the picture and words are checked too, so a fix
   that stops asking by drawing nothing cannot pass. */

/** Counts the browser's requests for a document's preview image, by page
 *  (`?page=` absent is page one). Start it before the card opens.
 * @param {Page} page */
function watchPreviewRequests(page) {
  /** @type {number[]} */
  const asked = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!/^\/api\/documents\/[^/]+\/preview$/.test(url.pathname)) return;
    asked.push(Number(url.searchParams.get("page") ?? "1"));
  });
  return {
    total: () => asked.length,
    /** @param {number} n */
    forPage: (n) => asked.filter((one) => one === n).length,
    all: () => [...asked],
  };
}

test("each page turn in the reader asks the server for that page's picture once", async ({ page }, testInfo) => {
  const asked = watchPreviewRequests(page);
  await openPaper(page, THREE_PAGE_PAPER, testInfo);
  const { reader } = await openReader(page, THREE_PAGE_PAPER);
  const picture = reader.getByRole("img", { name: new RegExp(THREE_PAGE_PAPER.file.replace(/[.]/g, "\\.")) });
  /** @param {number} n */
  const shown = async (n) => {
    await expect(reader.locator(".rd-name .rd-of")).toHaveText(`· page ${n} of 3`, { timeout: SETTLE });
    await expect(picture).toHaveAccessibleName(`Page ${n} of ${THREE_PAGE_PAPER.file}`, { timeout: SETTLE });
    await drawn(picture);
  };
  await shown(1);

  /** One turn of the reader, and how many requests it cost.
   * @param {number} to @param {() => Promise<void>} press */
  const turn = async (to, press) => {
    const before = asked.total();
    const beforePage = asked.forPage(to);
    await press();
    await shown(to);
    expect(asked.total() - before, `requests for turning to page ${to}: ${asked.all().slice(before)}`).toBe(1);
    expect(asked.forPage(to) - beforePage, `requests for page ${to}`).toBe(1);
  };

  await turn(2, () => reader.getByRole("button", { name: "Next page" }).click());
  await turn(3, () => reader.getByRole("button", { name: "Next page" }).click());
  await turn(2, () => reader.getByRole("button", { name: "Previous page" }).click());
  await turn(1, () => page.keyboard.press("Home"));
});

test("opening the reader on the page the card shows asks for no page again, and shows that picture and count", async ({ page }, testInfo) => {
  const asked = watchPreviewRequests(page);
  await openPaper(page, THREE_PAGE_PAPER, testInfo);
  const pageButton = page.getByRole("button", { name: `Read ${THREE_PAGE_PAPER.file}` });
  await expect(pageButton).toBeEnabled({ timeout: SETTLE });

  /* The card on page 1, drawn: opening the reader here must not ask again. */
  const cardPicture = pageButton.locator("img");
  await drawn(cardPicture);

  /* Both starting pages are checked: page 1 as it opens, then page 2 after the
     card's own pager has turned to it. */
  const reader = readerOf(page, THREE_PAGE_PAPER);
  const readerPicture = reader.getByRole("img", { name: new RegExp(THREE_PAGE_PAPER.file.replace(/[.]/g, "\\.")) });
  /** @param {number} n */
  const readerShows = async (n) => {
    await expect(reader.locator(".rd-name .rd-of")).toHaveText(`· page ${n} of 3`, { timeout: SETTLE });
    await expect(readerPicture).toHaveAccessibleName(`Page ${n} of ${THREE_PAGE_PAPER.file}`, { timeout: SETTLE });
    await drawn(readerPicture);
  };

  for (const n of [1, 2]) {
    if (n === 2) {
      await previewOf(page, THREE_PAGE_PAPER.file).getByRole("button", { name: "Next page" }).click();
      await expect(cardPicture).toHaveAttribute("alt", `Page 2 of ${THREE_PAGE_PAPER.file}`, { timeout: SETTLE });
      await drawn(cardPicture);
    }
    const before = asked.total();
    await pageButton.click();
    await expect(reader).toBeVisible();
    await readerShows(n);
    expect(asked.total() - before, `requests on opening the reader at page ${n}: ${asked.all().slice(before)}`).toBe(0);
    await page.keyboard.press("Escape");
    await expect(reader).toBeHidden({ timeout: SETTLE });
  }
});

/* #1501 (owner's ruling): when a turn's picture fails to load, the reader says
   so in place of the picture. It never shows the new page's number over the old
   page's picture -- the words and the image must agree. No same-page retry
   control is required. The wording is a generic failure line (the card already
   says "could not draw"); this asks only that it read as a failure to load.
   The service worker is blocked so `page.route` sees the request on every
   engine. */
const LOAD_FAILURE = /could not (be )?draw|couldn.t (be )?(draw|load)|failed to load|could not load|unable to load/i;

/** From here the server cannot draw page 2: the test's own fault.
 * @param {Page} page */
async function failPageTwo(page) {
  await page.route(/\/api\/documents\/[^/]+\/preview\?page=2$/, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "document_preview_failed", message: "Orbit could not draw that document" } }),
    }));
}

test.describe("a failed page turn", () => {
  test.use({ serviceWorkers: "block" });

  test("in the reader shows a load failure in place of the picture, never the new page number over the old picture", async ({ page }, testInfo) => {
    await openPaper(page, THREE_PAGE_PAPER, testInfo);
    const { reader } = await openReader(page, THREE_PAGE_PAPER);
    const picture = reader.getByRole("img", { name: new RegExp(THREE_PAGE_PAPER.file.replace(/[.]/g, "\\.")) });
    await expect(picture).toHaveAccessibleName(`Page 1 of ${THREE_PAGE_PAPER.file}`, { timeout: SETTLE });
    await drawn(picture);

    await failPageTwo(page);
    await reader.getByRole("button", { name: "Next page" }).click();

    /* A failure reads as one, inside the reader... */
    await expect(reader.getByText(LOAD_FAILURE)).toBeVisible({ timeout: SETTLE });
    /* ...and the old page's picture is gone: no "Page 1" image left under a
       head or foot that says page 2. */
    await expect(reader.getByRole("img", { name: new RegExp(`^Page 1 of ${THREE_PAGE_PAPER.file.replace(/[.]/g, "\\.")}$`) })).toHaveCount(0);
    const claimsPageTwo = await reader.locator(".rd-name .rd-of").textContent();
    if (claimsPageTwo?.includes("page 2")) {
      await expect(reader.getByRole("img", { name: new RegExp(`^Page \\w+ of ${THREE_PAGE_PAPER.file.replace(/[.]/g, "\\.")}$`) })).toHaveCount(0);
    }
  });

  /* #1559 (the preview card's side of #1501): the owner ruled "we just show a
     generic failed to load thing". On the preview card the card says so in
     place of the picture, reusing its existing failure wording, and never
     shows the new page's number ("2 of 3") over the old page's picture. */
  test("on the preview card shows a load failure in place of the picture, never the new page number over the old picture", async ({ page }, testInfo) => {
    await openPaper(page, THREE_PAGE_PAPER, testInfo);
    await expect(page.getByRole("button", { name: `Read ${THREE_PAGE_PAPER.file}` })).toBeEnabled({ timeout: SETTLE });

    const card = previewOf(page, THREE_PAGE_PAPER.file);
    const number = card.locator(".pager .pgn");
    const escaped = THREE_PAGE_PAPER.file.replace(/[.]/g, "\\.");
    /* The card's first page names its picture "Page one"; later ones "Page 2". */
    const firstPicture = card.getByRole("img", { name: new RegExp(`^Page (1|one) of ${escaped}$`) });
    await expect(firstPicture).toBeVisible({ timeout: SETTLE });
    await drawn(firstPicture);
    await expect.poll(() => shownText(number)).toBe("1 of 3");

    await failPageTwo(page);
    await card.getByRole("button", { name: "Next page" }).click();

    /* A failure reads as one, inside the card... */
    await expect(card.getByText(LOAD_FAILURE)).toBeVisible({ timeout: SETTLE });
    /* ...and the old page's picture is gone: no "Page 1" image left under a
       pager that says page 2. */
    await expect(card.getByRole("img", { name: new RegExp(`^Page (1|one) of ${escaped}$`) })).toHaveCount(0);
    if ((await shownText(number)) === "2 of 3") {
      await expect(card.getByRole("img", { name: new RegExp(`^Page \\w+ of ${escaped}$`) })).toHaveCount(0);
    }
  });
});
