import { expect, test } from "@playwright/test";

import { APP } from "../fidelity/pocket-states.js";
import { signedIn } from "./a11y-support.js";
import { guardedRoute } from "./workspace-writes.js";

/*
 * #1002: the desk archive card (DeskArchive.svelte, which reuses
 * PocketArchive.svelte's server calls, #1122). Moved from tests/e2e (ADR-0039,
 * #1611). Harlow Home is the fixture household its reader owns; Seaside
 * Cottage is the one they are a plain member of.
 *
 * What stays in tests/e2e/v19-archive.spec.ts: writing an archive and bringing
 * it into a second household with a clash staying out (real archive crypto and
 * import). Lower: a wrong passphrase is refused by the server with 422
 * archive_passphrase_invalid (tests/integration/portable-archive-stream-import.test.ts:199);
 * a member is refused the import with 403 owner_required
 * (tests/integration/portable-archive.test.ts:140,159 and authorization-matrix.test.ts:192).
 * Here: how the card behaves, and that a member is not given one.
 */

const HARLOW = "hh-harlow-1";
const SEASIDE = "hh-seaside-4551";
const PASSPHRASE = "correct-horse-battery-staple";
const SETTLE = 20_000;

test.describe("the desk card", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name.endsWith("phone"), "desktop archive card only; the pocket dialect is #1122's own");
  });

  test("an armed desk button relaxes back after 4 s without a second tap (#1342)", async ({ page }) => {
    /* The 4 s hold is the page's own timer, so the page's clock is the test's:
       installed before the screen is loaded, then stopped before the button is
       armed, so how long the browser takes between steps cannot move the hold. */
    await page.clock.install();
    await signedIn(`/household/${HARLOW}`, "any-dialect")(page);
    await expect(page.locator(".c-archive")).toBeVisible({ timeout: SETTLE });
    await page.getByRole("button", { name: "write an archive →" }).click();
    await page.getByLabel("a passphrase for the file").fill(PASSPHRASE);
    await page.getByLabel("the passphrase again").fill(PASSPHRASE);

    const armed = page.getByRole("button", { name: "tap again to write the archive" });
    await page.clock.pauseAt(new Date(Date.now() + 2_000));
    await page.getByRole("button", { name: "write the archive" }).click(); // arm
    await expect(armed).toBeVisible({ timeout: SETTLE });
    // Still armed 3.9 s into the hold ...
    await page.clock.runFor(3_900);
    await expect(armed).toBeVisible();
    // ... and relaxed once 4 s have passed, 5 s being the old hold on this screen.
    await page.clock.runFor(200);
    await expect(armed).toHaveCount(0, { timeout: SETTLE });
    await expect(page.getByRole("button", { name: "write the archive" })).toBeVisible({ timeout: SETTLE });
  });

  test("a wrong passphrase is refused in the server's words, and nothing is shown of the file", async ({ page }) => {
    /** @type {string[]} */
    const previews = [];
    await signedIn(`/household/${HARLOW}`, "any-dialect")(page);
    await page.route(`${APP}/api/portable-archives/preview`, guardedRoute(async (route) => {
      previews.push(route.request().method());
      await route.fulfill({
        status: 422,
        json: { error: { code: "archive_passphrase_invalid", message: "The passphrase or archive is invalid" } },
      });
    }));
    await expect(page.locator(".c-archive")).toBeVisible({ timeout: SETTLE });

    await page.getByRole("tab", { name: "bring one in" }).click();
    await page.getByRole("button", { name: "bring in an archive →" }).click();
    await page.locator('.c-archive input[type="file"]').setInputFiles({
      name: "orbit-archive.json",
      mimeType: "application/json",
      buffer: Buffer.from("{}"),
    });
    await page.getByLabel("the file's passphrase").fill("not-the-right-phrase-at-all");
    await page.getByRole("button", { name: "look inside" }).click();

    await expect(page.locator(".c-archive .refuse")).toBeVisible({ timeout: SETTLE });
    await expect(page.locator(".c-archive .refuse")).toContainText("The passphrase or archive is invalid");
    expect(previews).toEqual(["POST"]);
    // Refused, not merely unread: the preview never appears.
    await expect(page.locator(".c-archive .inside")).toHaveCount(0);
  });
});

test("a member who is not an owner sees no archive card", async ({ page }) => {
  await signedIn(`/household/${SEASIDE}`, "any-dialect")(page);
  /* The household page has loaded (its title is showing on whichever layout
     this is) before the absence below is believed. */
  await expect(page.getByRole("heading", { level: 1, name: "Seaside Cottage" })).toBeVisible({ timeout: SETTLE });
  await expect(page.getByRole("heading", { name: "The archive" })).toHaveCount(0);
});
