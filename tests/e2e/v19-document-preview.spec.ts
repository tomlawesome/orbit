import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister, sessionHeaders } from "./support/households";
import { settleArrival } from "./support/arrival";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";
import { householdDateFromToday } from "./support/household-dates";
import { SETTLE } from "./support/settle";

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
 *
 * ADR-0039 (#1610): only this real-upload proof stays on the stack. Page
 * turning, the reader, the failed-turn lines and the removed-paper line run
 * against the fixture app, in web/tests/rig/v19-document-preview.spec.js.
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
  const seeded = await page.evaluate(async ({ householdName, dueDate }) => {
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
  }, { householdName: name, dueDate: householdDateFromToday(20) });
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

/** #1319: an item's home drawer, opened by its address -- the desk's view
 *  under its row, the phone's open row. */
async function openDrawer(page: Page, itemId: string) {
  await page.goto(`/home?item=${itemId}`);
  if (test.info().project.name.startsWith("mobile")) {
    const row = page.locator(`.pocket .pk-below [data-row-key="${itemId}"]`);
    await expect(row).toHaveAttribute("data-open", "", { timeout: SETTLE });
    return row;
  }
  const drawer = page.locator(`[id="${itemId}-view"]`);
  await expect(drawer).toBeVisible({ timeout: SETTLE });
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
  await expect(paper).toBeVisible({ timeout: SETTLE });
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
    await expect(card).toHaveClass(/snap/, { timeout: SETTLE });
    await expect(card.getByRole("img", { name: "Page one of preview-proving.pdf" })).toBeVisible();
    // #1300: the fixture is one page -- the pager says so, with no arrows,
    // and no honest state's foot word.
    await expect(card.locator(".pager .pgn")).toHaveText("one page");
    await expect(card.getByRole("button", { name: /next page|previous page/i })).toHaveCount(0);
    await expect(card.getByText(/\b\d+\s*(of|\/)\s*\d+\b/)).toHaveCount(0);
    await expect(card.locator(".rcfoot")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(card).toBeHidden({ timeout: SETTLE });
    // The card goes; the drawer it came from stays.
    await expect(drawer).toBeVisible();
  } finally {
    await households.sweep(page);
  }
});
