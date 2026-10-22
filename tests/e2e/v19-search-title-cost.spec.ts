import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { householdRegister, sessionHeaders } from "./support/households";
import { settleArrival } from "./support/arrival";
import { dismissTourIfShown, homeIsLive } from "./support/keyboard";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";
import { householdDateFromToday } from "./support/household-dates";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * #1438: a home-search result is the item's title and its cost, nothing else.
 * Before, each match drew three lines ("Insurance" / "T-1d · 16 Oct · £300.00"
 * / "◆ Your policy documents-1.pdf"). The owner's decision (2026-10-15): no
 * document names, no date, no T- countdown, on the desk and on the phone.
 * Documents stay searchable: a document-name match still finds its item, it
 * is only not shown under it.
 *
 * Desk: the results are `#explore-results` (a listbox of options, the strip's
 * accessible read) and the strip itself is `#strip`; both are taken from
 * v19-explore-search.spec.ts. Phone: the search sheet raised by `.msearch`,
 * its field `.pk-field` and its list `.pk-results [data-row-face]`, taken
 * from web/tests/fidelity/pocket-home-drawers.spec.js.
 */

const HOUSEHOLD_PREFIX = "Search Title Cost Proving Ground";
const FIXTURE_PATH = resolve(__dirname, "../support/fixtures/chromium-synthetic.pdf");
const households = householdRegister();

const TITLE = "Quillfeather home insurance";
const COST_SHOWN = "£300.00";
const OTHER_TITLE = "Quillfeather boiler service";
const DOCUMENT_NAME = "Zebrafinch policy documents-1.pdf";
const DOCUMENT_WORD = "zebrafinch";
const DUE_IN_DAYS = 12;

const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
/** Any "T-1d" / "T−12d" / "T+3d" countdown, in either minus sign. */
const COUNTDOWN = /\bT\s?[−\-+–]\s?\d+\s?d/u;
/** Any "16 Oct" / "Oct 16" style day-and-month. */
const DAY_MONTH = new RegExp(`\\b\\d{1,2}\\s(${MONTHS})\\b|\\b(${MONTHS})\\s\\d{1,2}\\b`, "u");

const isMobile = () => test.info().project.name.startsWith("mobile");

async function signInAsAdmin(page: Page) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: "Orbit Administrator" }).click();
  await settleArrival(page);
}

/** Two items: one with a cost, a due date and an uploaded document, one other. */
async function seed(page: Page) {
  const name = `${HOUSEHOLD_PREFIX} ${randomUUID().slice(0, 8)}`;
  const seeded = await page.evaluate(async ({ householdName, dueDate, title, otherTitle }) => {
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
        id: householdId, name: householdName, timezone: "Europe/London", currency: "GBP",
        memberCount: 1, canManage: true, onboardingComplete: true,
        sections: [{ id: sectionId, name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    });
    const itemId = crypto.randomUUID();
    await command({
      type: "item.upsert", householdId, kind: "renewal",
      item: { id: itemId, sectionId, title, currency: "GBP", costMinor: 30000, dueDate, recurrenceMonths: 12 },
      activity: { id: crypto.randomUUID(), itemId, occurredAt: new Date().toISOString() },
    });
    const otherId = crypto.randomUUID();
    await command({
      type: "item.upsert", householdId, kind: "service",
      item: { id: otherId, sectionId, title: otherTitle, currency: "GBP", costMinor: 12000, dueDate, recurrenceMonths: 12 },
      activity: { id: crypto.randomUUID(), itemId: otherId, occurredAt: new Date().toISOString() },
    });
    return { householdId, itemId, otherId };
  }, { householdName: name, dueDate: householdDateFromToday(DUE_IN_DAYS), title: TITLE, otherTitle: OTHER_TITLE });
  households.track({ id: seeded.householdId, name });

  const headers = { ...(await sessionHeaders(page)), "x-orbit-filename": encodeURIComponent(DOCUMENT_NAME) };
  const upload = await page.request.post(
    `/api/households/${seeded.householdId}/items/${seeded.itemId}/documents`,
    { headers, data: readFileSync(FIXTURE_PATH) },
  );
  if (!upload.ok()) throw new Error(`upload failed: ${upload.status()} ${await upload.text()}`);
  const body = (await upload.json()) as { document: { lifecycle: string } };
  expect(body.document.lifecycle).toBe("available");
  return seeded;
}

/** Goes to /home and types the query into the layout's own search. Returns
 *  the locator holding the results and the locator of one item's result. */
async function search(page: Page, query: string) {
  await page.goto("/home");
  await dismissTourIfShown(page);
  await homeIsLive(page);
  if (isMobile()) {
    await page.locator(".msearch").click();
    await page.locator(".p-sheet-layer.open .pk-field").fill(query);
    const results = page.locator(".p-sheet-layer.open .pk-results");
    return { results, one: (title: string) => results.locator("[data-row-face]").filter({ hasText: title }) };
  }
  await page.locator("#explore").fill(query);
  const results = page.locator("#explore-results");
  return { results, one: (title: string) => results.getByRole("option").filter({ hasText: title }) };
}

const readable = async (locator: Locator) => ((await locator.textContent()) ?? "").replace(/\s+/gu, " ").trim();

/** The result is the title and the cost, and not a word more. */
async function expectTitleAndCostOnly(result: Locator, title: string, cost: string) {
  await expect(result).toHaveCount(1);
  const text = await readable(result);
  expect(text).toMatch(new RegExp(`^${title}[\\s,;:·–—\\-]*${cost.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u"));
  expect(text).not.toMatch(COUNTDOWN);
  expect(text).not.toMatch(DAY_MONTH);
  expect(text).not.toContain("◆");
  expect(text.toLowerCase()).not.toContain(DOCUMENT_WORD);
  expect(text).not.toContain(".pdf");
}

/** The whole result list names no document, date or countdown. */
async function expectNothingElseAnywhere(results: Locator) {
  const text = await readable(results);
  expect(text).not.toMatch(COUNTDOWN);
  expect(text).not.toMatch(DAY_MONTH);
  expect(text).not.toContain("◆");
  expect(text.toLowerCase()).not.toContain(DOCUMENT_WORD);
  expect(text).not.toContain(".pdf");
}

test("a search result shows the item's title and cost, with no document, date or T- figure", async ({ page }) => {
  await signInAsAdmin(page);
  await seed(page);

  try {
    const { results, one } = await search(page, "quillfeather home");
    // Positive first: the item is listed, with its title and its cost.
    const result = one(TITLE);
    await expect(result).toHaveCount(1);
    await expect(result).toContainText(TITLE);
    await expect(result).toContainText(COST_SHOWN);
    await expectTitleAndCostOnly(result, TITLE, COST_SHOWN);
    await expectNothingElseAnywhere(results);
    await expect(one(OTHER_TITLE)).toHaveCount(0);

    if (!isMobile()) {
      // The strip's own drawn text too: one mark, and it carries no date or countdown.
      await expect(page.locator("#strip .match")).toHaveCount(1);
      const strip = await readable(page.locator("#strip"));
      expect(strip).not.toMatch(COUNTDOWN);
      expect(strip).not.toMatch(DAY_MONTH);
      expect(strip.toLowerCase()).not.toContain(DOCUMENT_WORD);
    }
  } finally {
    await households.sweep(page);
  }
});

test("a search for a document's name still lists its item, by title and cost only", async ({ page }) => {
  await signInAsAdmin(page);
  await seed(page);

  try {
    const { results, one } = await search(page, DOCUMENT_WORD);
    // The document-name match finds the item (the index is still fed)...
    const result = one(TITLE);
    await expect(result).toHaveCount(1, { timeout: 20_000 });
    await expect(result).toContainText(COST_SHOWN);
    // ...but not the other item, and the document's name is drawn nowhere.
    await expect(one(OTHER_TITLE)).toHaveCount(0);
    await expectTitleAndCostOnly(result, TITLE, COST_SHOWN);
    await expectNothingElseAnywhere(results);
  } finally {
    await households.sweep(page);
  }
});
