import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister, sessionHeaders } from "./support/households";
import { settleArrival } from "./support/arrival";
import { resetDatabaseBetweenSpecFiles } from "./support/database";

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
      item: {
        id: itemId,
        sectionId,
        title: "Preview proving item",
        currency: "GBP",
        scheduleKind: "service",
        dueDate,
        recurrenceMonths: 12,
        status: "active",
      },
      activity: { id: crypto.randomUUID(), itemId, kind: "created", occurredAt: new Date().toISOString() },
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
): Promise<{ id: string; lifecycle: string }> {
  const bytes = readFileSync(FIXTURE_PATH);
  const headers = { ...(await sessionHeaders(page)), "x-orbit-filename": encodeURIComponent(filename) };
  const response = await page.request.post(
    `/api/households/${householdId}/items/${itemId}/documents`,
    { headers, data: bytes },
  );
  if (!response.ok()) throw new Error(`upload failed: ${response.status()} ${await response.text()}`);
  const body = (await response.json()) as { document: { id: string; lifecycle: string } };
  return body.document;
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

    const readcard = page.locator("#readcard");
    await expect(readcard).toBeVisible();
    // The real page, rendered by the real endpoint — not a placeholder.
    await expect(readcard).toHaveClass(/snap/, { timeout: 20_000 });
    await expect(readcard.locator(".sheet img")).toBeVisible();
    // #1088: no page counter and no arrows — Orbit records no page count,
    // so the foot holds nothing while the page is showing normally.
    await expect(readcard.locator(".rcfoot")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(page.locator("#readcard")).toHaveCount(0, { timeout: 2_000 });
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
