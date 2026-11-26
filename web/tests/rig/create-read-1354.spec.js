import { expect, test } from "@playwright/test";

import { APP } from "../fidelity/pocket-states.js";
import { pickImportance } from "./importance-support.js";

/*
 * #1354 part 3: what the create screen shows while it reads a picked document,
 * pinned on the desk (the #readcard lane) and the phone (the .pc-reading card)
 * BEFORE the reading flow of both moves into one controller
 * (web/src/routes/create/read-controller.svelte.js). This spec passes before
 * and after the move: the same two requests per pick, the same words while
 * reading, on success, refusal, scanner unavailable (#1593's 503) and failure.
 * The server is mocked with page.route; no stack.
 */

test.use({
  serviceWorkers: async ({}, use, testInfo) => {
    await use(testInfo.project.use.browserName === "webkit" ? "block" : "allow");
  },
});

const DOCUMENT = "chromium-synthetic.pdf";
const DOCUMENT_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2048, 32), Buffer.from("%%EOF\n")]);
const REASON = "That file is not a PDF or image we can keep";
const onPhone = () => test.info().project.name.includes("phone");
const pdf = () => ({ name: DOCUMENT, mimeType: "application/pdf", buffer: DOCUMENT_BYTES });

const SVG_PAGE = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="85" height="120"><rect width="85" height="120" fill="#fff"/></svg>').toString("base64");
const DRAWN = {
  status: 200, contentType: "application/x-ndjson; charset=utf-8",
  body: `${JSON.stringify({ stage: "scanned", scanned: true })}\n${JSON.stringify({ stage: "preview", mediaType: "image/svg+xml", pageCount: 1, bytes: SVG_PAGE })}\n`,
};
const json = (/** @type {number} */ status, /** @type {object} */ body) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const inspection = (/** @type {object} */ body) => json(200, body);
const NOTHING = { extracted: true, suggestions: [], attachmentDisposition: "attachable" };

/** @param {import("@playwright/test").Page} page */
async function gotoCreate(page) {
  await page.goto(`${APP}/create`, { waitUntil: "load" });
  await page.locator("#card[data-ready]").waitFor({ state: "attached" });
}

/**
 * Answers the preview and the inspection for this page and counts the requests
 * each got. `hold` (a promise) keeps both back until it resolves.
 * @param {import("@playwright/test").Page} page
 * @param {{ preview?: object, inspect?: object, hold?: Promise<unknown> }} answers
 */
async function answered(page, { preview = DRAWN, inspect = inspection(NOTHING), hold } = {}) {
  const asked = { preview: 0, inspect: 0 };
  await page.route("**/item-document-preview", async (route) => {
    asked.preview += 1;
    await hold;
    await route.fulfill(/** @type {any} */ (preview));
  });
  await page.route("**/item-document-inspection", async (route) => {
    asked.inspect += 1;
    await hold;
    await route.fulfill(/** @type {any} */ (inspect));
  });
  return asked;
}

/** @param {import("@playwright/test").Page} page */
const pick = (page) => (onPhone()
  ? page.getByRole("form", { name: "New entry" }).locator('input[type="file"]')
  : page.locator('#card input[type="file"]')).setInputFiles(pdf());
/** @param {import("@playwright/test").Page} page */
const lane = (page) => (onPhone() ? page.getByRole("form", { name: "New entry" }).locator(".pc-reading") : page.locator("#readcard"));
/** @param {import("@playwright/test").Page} page @param {string} name */
const field = (page, name) => (onPhone()
  ? page.getByRole("form", { name: "New entry" }).getByRole("textbox", { name })
  : page.locator({ provider: "#f-provider", reference: "#f-ref", cost: "#f-cost" }[/** @type {"provider"} */ (name)]));
/** @param {import("@playwright/test").Page} page */
const add = (page) => (onPhone() ? page.getByRole("button", { name: "Add to orbit" }) : page.locator(".btn-primary"));
/** Everything but the file filled in, so only the file can hold Add. @param {import("@playwright/test").Page} page */
async function fillEntry(page) {
  const form = page.getByRole("form", { name: "New entry" });
  if (onPhone()) await form.getByRole("textbox", { name: "name", exact: true }).fill("Reading proving");
  else await page.locator("#f-name").fill("Reading proving");
  await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
  await pickImportance(page);
}
/** "scanned clean" as a reader sees it (the desk keeps its hidden words in the page). @param {import("@playwright/test").Page} page */
const scanSaid = (page) => (onPhone() ? lane(page).getByText("scanned clean") : page.locator("#rc-scan"));
/** @param {import("@playwright/test").Page} page */
const pageOne = (page) => (onPhone() ? lane(page).getByRole("img", { name: `Page one of ${DOCUMENT}` }) : page.locator("#sheet-page"));

test("reading words show while both requests are out, then the page and the fields land", async ({ page }) => {
  /** @type {() => void} */
  let release = () => undefined;
  const hold = new Promise((resolve) => { release = () => resolve(undefined); });
  const asked = await answered(page, {
    hold,
    inspect: inspection({
      extracted: true, attachmentDisposition: "attachable",
      suggestions: [
        { field: "provider", value: "British Gas", source: "document_text", confidence: "medium" },
        { field: "cost", value: "144.00", source: "document_text", confidence: "medium" },
      ],
    }),
  });
  await gotoCreate(page);
  await pick(page);

  const card = lane(page);
  await expect(card).toContainText("Reading your document");
  await expect(card).toContainText("Checking this file for viruses…");
  await expect(card).toContainText("orbit is reading the pages it was given");
  await expect(card).toContainText("nothing is saved, and nothing is assumed");
  await expect(card).toContainText(DOCUMENT);
  await expect(scanSaid(page)).toBeHidden();
  await expect(field(page, "provider")).toHaveValue("");
  await expect.poll(() => [asked.preview, asked.inspect]).toEqual([1, 1]);

  release();
  await expect(pageOne(page)).toBeVisible();
  await expect(card).toContainText(/page one/i);
  await expect(scanSaid(page)).toBeVisible();
  await expect(card).toContainText("the fields marked ◆ from document are what orbit read across into the form");
  await expect(field(page, "provider")).toHaveValue("British Gas");
  await expect(field(page, "cost")).toHaveValue("144.00");
  expect([asked.preview, asked.inspect], "one preview and one read per pick").toEqual([1, 1]);
});

test("a read that finds nothing says so and leaves the fields alone", async ({ page }) => {
  await answered(page);
  await gotoCreate(page);
  await field(page, "provider").fill("typed by hand");
  await pick(page);
  await expect(pageOne(page)).toBeVisible();
  await expect(lane(page)).toContainText("orbit read the pages and found nothing to carry across");
  await expect(field(page, "provider")).toHaveValue("typed by hand");
});

test("a suggestion never overwrites what was typed", async ({ page }) => {
  await answered(page, {
    inspect: inspection({
      extracted: true, attachmentDisposition: "attachable",
      suggestions: [
        { field: "provider", value: "British Gas", source: "document_text", confidence: "medium" },
        { field: "reference", value: "BG-1", source: "document_text", confidence: "medium" },
      ],
    }),
  });
  await gotoCreate(page);
  await field(page, "reference").fill("MY-OWN-REF");
  await pick(page);
  await expect(field(page, "provider")).toHaveValue("British Gas");
  await expect(field(page, "reference")).toHaveValue("MY-OWN-REF");
});

test("a file the read refuses stays in the entry, marked refused in the server's words, and holds Add", async ({ page }) => {
  await answered(page, { inspect: inspection({ extracted: false, suggestions: [], attachmentDisposition: "rejected", message: REASON }) });
  await gotoCreate(page);
  await pick(page);
  await fillEntry(page);
  const card = lane(page);
  await expect(card).toContainText("Orbit refused this file.");
  await expect(card).toContainText(REASON);
  await expect(card).toContainText(DOCUMENT);
  await expect(card).toContainText("refused");
  await expect(add(page)).toHaveAttribute("aria-disabled", "true");
  await card.getByRole("button", { name: /not this one|remove it/ }).click();
  await expect(add(page)).not.toHaveAttribute("aria-disabled", "true");
});

test("a malware verdict on the preview refuses the file in the lane's words", async ({ page }) => {
  await answered(page, { preview: json(422, { error: { code: "document_malware_detected", message: "Orbit refused it" } }) });
  await gotoCreate(page);
  await pick(page);
  const card = lane(page);
  await expect(card).toContainText("Orbit refused this file.");
  await expect(card).toContainText("it did not pass what orbit checks before keeping a file");
  await expect(card).toContainText("choose another document");
  await expect(pageOne(page)).toHaveCount(onPhone() ? 0 : 1);
  await expect(add(page)).toHaveAttribute("aria-disabled", "true");
});

test("scanner unavailable (#1593's 503): no page, the held line, the file still attached", async ({ page }) => {
  await answered(page, {
    preview: json(503, { error: { code: "document_scanner_unreachable", message: "The scanner is down" } }),
    inspect: inspection(NOTHING),
  });
  await gotoCreate(page);
  await pick(page);
  const card = lane(page);
  await expect(card).toContainText("The scanner couldn't be reached, Admin have been notified");
  await expect(card).not.toContainText("Orbit refused this file.");
  await expect(scanSaid(page)).toBeHidden();
  await expect(card).toContainText(DOCUMENT);
  await fillEntry(page);
  await expect(add(page)).not.toHaveAttribute("aria-disabled", "true");
  if (onPhone()) await expect(card.getByRole("img")).toHaveCount(0);
});

test("a scan that timed out says so, not that admins were told", async ({ page }) => {
  await answered(page, { preview: json(504, { error: { code: "document_scanner_timeout", message: "Slow" } }) });
  await gotoCreate(page);
  await pick(page);
  const card = lane(page);
  await expect(card).toContainText("The scanner didn’t answer in time.");
  await expect(card).toContainText("orbit checks it again then");
  await expect(card).not.toContainText("Admin have been notified");
});

test("a page that cannot be drawn is said in the lane's words once the read is done", async ({ page }) => {
  await answered(page, { preview: json(422, { error: { code: "document_preview_failed", message: "Orbit could not draw that document" } }) });
  await gotoCreate(page);
  await pick(page);
  const card = lane(page);
  await expect(card).toContainText("Orbit could not draw a picture of this document.");
  await expect(card).toContainText(/could not turn it into a page/i);
  await expect(card).not.toContainText("Orbit refused this file.");
});

test("a read that fails says it could not read, with the server's words, and the page still lands", async ({ page }) => {
  await answered(page, { inspect: json(500, { error: { code: "inspection_failed", message: "The reader fell over" } }) });
  await gotoCreate(page);
  await pick(page);
  await expect(pageOne(page)).toBeVisible();
  const card = lane(page);
  await expect(card).toContainText("orbit could not read the pages this time");
  await expect(card).toContainText("The reader fell over");
  await expect(card).not.toContainText("Orbit refused this file.");
});

test("a file too large to read is said so in the lane", async ({ page }) => {
  await answered(page, { inspect: json(413, { error: { code: "document_too_large", message: "big" } }) });
  await gotoCreate(page);
  await pick(page);
  await expect(lane(page)).toContainText("this file is too large to send");
});

test("not this one: the file and what it suggested leave, and nothing more is asked", async ({ page }) => {
  const asked = await answered(page, {
    inspect: inspection({
      extracted: true, attachmentDisposition: "attachable",
      suggestions: [{ field: "provider", value: "British Gas", source: "document_text", confidence: "medium" }],
    }),
  });
  await gotoCreate(page);
  await pick(page);
  await expect(field(page, "provider")).toHaveValue("British Gas");
  await lane(page).getByRole("button", { name: "not this one" }).click();
  await expect(field(page, "provider")).toHaveValue("");
  if (onPhone()) await expect(lane(page)).toHaveCount(0);
  else await expect(page.locator("body")).not.toHaveClass(/\bdoc\b/);
  expect([asked.preview, asked.inspect]).toEqual([1, 1]);
});

test("picking again reads the new file and takes the first file's suggestions with it", async ({ page }) => {
  let reads = 0;
  const asked = await answered(page);
  await page.route("**/item-document-inspection", async (route) => {
    reads += 1;
    if (reads === 1) {
      return route.fulfill(inspection({
        extracted: true, attachmentDisposition: "attachable",
        suggestions: [{ field: "provider", value: "First Provider", source: "document_text", confidence: "medium" }],
      }));
    }
    return route.fallback();
  });
  await gotoCreate(page);
  await pick(page);
  await expect(field(page, "provider")).toHaveValue("First Provider");
  await pick(page);
  await expect(field(page, "provider")).toHaveValue("");
  await expect(lane(page)).toContainText("orbit read the pages and found nothing to carry across");
  expect(asked.preview).toBe(2);
});

test("desk: a document dropped on the zone is read like a picked one", async ({ page }) => {
  test.skip(onPhone(), "the phone has no drop zone");
  const asked = await answered(page);
  await gotoCreate(page);
  const files = await page.evaluateHandle(({ name, bytes }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], name, { type: "application/pdf" }));
    return transfer;
  }, { name: DOCUMENT, bytes: DOCUMENT_BYTES.toString("base64") });
  await page.locator("#dropzone").dispatchEvent("dragover", { dataTransfer: files });
  await page.locator("#dropzone").dispatchEvent("drop", { dataTransfer: files });
  await expect(page.locator("#readcard")).toContainText(DOCUMENT);
  await expect(pageOne(page)).toBeVisible();
  await expect(page.locator("#readcard")).toContainText("orbit read the pages and found nothing to carry across");
  expect([asked.preview, asked.inspect]).toEqual([1, 1]);
});
