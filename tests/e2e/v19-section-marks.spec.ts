import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { cleanupHousehold, sessionHeaders } from "./support/households";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * #867 — the add → swap → save → manifest journey.
 *
 * A user-named section is assigned a mark on arrival (the first asterism
 * the household has not worn), the owner can swap it from the tray the
 * Sections card opens, the choice saves with the whole list, and the same
 * mark then prints beside the section's own entries on the manifest
 * (/home's corridor).
 *
 * UNRUN. This needs the docker-compose stack (a real Postgres and a signed
 * -in session) the way every other tests/e2e spec does; standing that stack
 * up was out of scope for the session that wrote this file. Written to the
 * same pattern v19-keyboard.spec.ts's `signIn`/`seedHousehold`/`cleanup`
 * use, so it should run unmodified once the stack is available —
 * `pnpm test:e2e -- v19-section-marks`.
 */

test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, "desktop Sections card only; the pocket dialect is #849's own file");
});

/* #1080: this worker's own administrator, resolved lazily (worker env only). */
const READER = () => workerAccount("administrator");

async function signIn(page: Page, returnTo: string) {
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("link", { name: READER() }).click();
  /* #1080: waits for the session, then holds administrator access. */
  await ensureWorkerAdministrator(page);
}

/**
 * A household with just the real default sections — no user section yet,
 * so the Sections card's "+ add a section" is the thing under test.
 */
async function seedHousehold(page: Page) {
  const name = `section-marks-${randomUUID()}`;
  const householdId = randomUUID();
  const headers = { ...(await sessionHeaders(page)), "content-type": "application/json" };
  const created = await page.request.post("/api/workspace/commands", {
    headers,
    data: {
      type: "household.create",
      household: {
        id: householdId,
        name,
        timezone: "Europe/London",
        currency: "GBP",
        memberCount: 1,
        canManage: true,
        onboardingComplete: true,
        sections: [{ id: "home", name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    },
  });
  if (!created.ok()) throw new Error(`#867: could not seed household "${name}" (${created.status()})`);
  return { id: householdId, name };
}

async function cleanup(page: Page, household: { id: string; name: string }) {
  await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
}

test("add → swap → save → manifest shows it", async ({ page }) => {
  test.setTimeout(60_000);
  await signIn(page, "/home");
  const household = await seedHousehold(page);
  try {
    await page.goto(`/household/${household.id}`);
    await expect(page.locator(".c-sections")).toBeVisible({ timeout: 30_000 });

    // ── add: a new row wears the first figure the pen has not used ──────
    await page.locator(".addsec").click();
    const row = page.locator(".sec").last();
    const swapButton = row.locator("button.mark.swap");
    // #867 ratified design: a lone new section always wears "hook", and its
    // tray opens on arrival (owner, 2026-09-16: "shown open on Allotment,
    // the row just added").
    await expect(swapButton).toHaveAttribute("aria-expanded", "true");
    const rowId = (await swapButton.getAttribute("id"))?.replace("swap-", "");
    expect(rowId).toBeTruthy();

    // ── swap: pick a different asterism from the tray ───────────────────
    const tray = page.locator('[role="radiogroup"][aria-label="Marks the pen has not used"]').last();
    await expect(tray).toBeVisible();
    const kite = tray.locator(`#swap-${rowId}-kite`);
    await kite.click();
    await expect(kite).toHaveAttribute("aria-checked", "true");
    await expect(swapButton).toHaveAttribute("style", /--sec-blue/); // kite's own ink

    // Name the section — required before it round-trips through the manifest.
    await row.locator("input[aria-label='Section name']").fill("Allotment");

    // ── save: the whole list, including the swap ─────────────────────────
    await page.locator(".savebar .btn").click();
    await expect(page.locator(".said.show")).toBeVisible();

    // An entry in the new section, so the manifest has something to show.
    const headers = { ...(await sessionHeaders(page)), "content-type": "application/json" };
    const itemId = randomUUID();
    const dueDate = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const itemCreated = await page.request.post("/api/workspace/commands", {
      headers,
      data: {
        type: "item.upsert",
        householdId: household.id,
        item: {
          id: itemId, sectionId: rowId, title: "Allotment shed lock", currency: "GBP",
          scheduleKind: "service", dueDate, recurrenceMonths: 12, status: "active",
        },
        activity: { id: randomUUID(), itemId, kind: "created", occurredAt: new Date().toISOString() },
      },
    });
    expect(itemCreated.ok()).toBe(true);

    // ── manifest: the same mark, beside the entry ────────────────────────
    await page.goto("/home");
    const entry = page.locator(".item", { hasText: "Allotment shed lock" });
    await expect(entry).toBeVisible({ timeout: 30_000 });
    await expect(entry.locator(".mark svg")).toBeVisible();
    await expect(entry.locator(".mark")).toHaveAttribute("style", /--sec-blue/);
  } finally {
    await cleanup(page, household);
  }
});
