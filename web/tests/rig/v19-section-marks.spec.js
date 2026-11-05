import { expect, test } from "@playwright/test";

import { APP, onPhone, RIG_EXPECT_MS, RIG_TEST_MS, signedIn } from "./a11y-support.js";
import { pickImportance } from "./importance-support.js";

/*
 * #867, moved to the rig (ADR-0039, #1611) from tests/e2e/v19-section-marks.spec.ts
 * (written unrun there, which is why it is walked here for the first time): the
 * add -> swap -> save -> manifest journey.
 *
 * A user-named section is assigned a mark on arrival (the first asterism the
 * household has not worn), the owner can swap it from the tray the Sections
 * card opens, the choice saves with the whole list, and the same mark then
 * prints beside the section's own entries on the manifest (/home's corridor).
 *
 * The household is the fixture's Harlow Home (the reader owns it), at the state
 * `/household/hh-harlow-1` / `saves-kept`: the fixture server holds this
 * browser's sections save and its item save (the `keep-saves` scene), so the
 * create form offers the new section and home, which reads on the server, draws
 * both. The stack test made the entry by the command API; here it is made the
 * way a reader makes it, on /create. No write is answered by the test: the
 * fixture's own answer to a sections save is the workspace with it kept.
 */
test.use({ baseURL: APP });
test.describe.configure({ timeout: RIG_TEST_MS });

test.beforeEach(({}, testInfo) => {
  test.skip(onPhone(testInfo), "desktop Sections card only; the pocket dialect is #849's own file");
});

test("add → swap → save → manifest shows it", async ({ page }) => {
  await signedIn("/household/hh-harlow-1", "saves-kept")(page);
  await expect(page.locator(".c-sections")).toBeVisible({ timeout: RIG_EXPECT_MS });

  // ── add: a new row wears the first figure the pen has not used ──────
  await page.locator(".addsec").click();
  const row = page.locator(".sec").last();
  const swapButton = row.locator("button.mark.swap");
  // #867 ratified design: a new section's tray opens on arrival (owner,
  // 2026-09-16: "shown open on Allotment, the row just added").
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
  const saved = page.waitForRequest((request) => request.url().endsWith("/api/workspace/commands") && request.method() === "POST"
    && request.postDataJSON()?.type === "sections.replace" && !request.postDataJSON()?.dryRun);
  await page.locator(".savebar .btn").click();
  const sent = (await saved).postDataJSON();
  expect(sent.sections.find((/** @type {{ id: string }} */ one) => one.id === rowId)?.name).toBe("Allotment");
  await expect(page.locator(".said.show")).toBeVisible();

  // An entry in the new section, so the manifest has something to show.
  await page.goto(`${APP}/create`);
  await page.locator("#card[data-ready]").waitFor({ state: "attached" });
  await page.locator("#f-name").fill("Allotment shed lock");
  await page.locator('#types button[data-type="service"]').click();
  await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Allotment" }).click();
  await pickImportance(page);
  await page.locator("#f-date").fill("2026-09-12");
  await page.locator(".btn-primary").click();
  await expect(page).toHaveURL(/\/home(\?item=[^&]+)?$/);

  // ── manifest: the same mark, beside the entry ────────────────────────
  await page.goto(`${APP}/home`);
  const entry = page.locator(".item", { hasText: "Allotment shed lock" });
  await expect(entry).toBeVisible({ timeout: RIG_EXPECT_MS });
  await expect(entry.locator(".mark svg")).toBeVisible();
  await expect(entry.locator(".mark")).toHaveAttribute("style", /--sec-blue/);
});
