import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { APP } from "../fidelity/pocket-states.js";
import { onPhone, signedIn, withDecorationHidden } from "./a11y-support.js";
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

/*
 * #1774: the household export is a background job, and the card shows it.
 * Both projects (desk and phone). The engine's three routes are intercepted as
 * workspace-writes.js does: GET /api/households/{id}/portable-archives answers
 * whatever `server.state` holds, the POST answers 202 with a pending job, the
 * retry POST answers 200. No new fixture scene. The card polls the GET every
 * 2 s while a job is live; each test moves `server.state` and waits for the
 * card to follow.
 *
 * Not asserted, on purpose: any push notification or "Sent to you lately"
 * entry for "ready" (open for the owner), and the card's component internals.
 */

const EXPORT_SETTLE = 20_000;
const GIB = 1_073_741_824;
const READY = { id: "a-1774", expiresAt: "2026-12-01T00:00:00Z", includesDocuments: true, downloadUrl: "/api/portable-archives/a-1774/download", keepPerHousehold: 2 };
const job = (/** @type {string} */ status, /** @type {object} */ extra = {}) => ({
  id: "job-1774", status, bytesDone: null, bytesTotal: null, createdAt: "2026-11-25T10:00:00Z",
  failureCode: null, failureMessage: null, canRetry: true, ...extra,
});
const FAILED_WORDS = "Orbit restarted while writing this archive; try again";

/**
 * @param {import("@playwright/test").Page} page
 * @param {{ export: object | null, latest: object | null }} initial
 */
async function exportJobRoutes(page, initial) {
  const server = {
    state: initial,
    /** @type {object[]} */ starts: [],
    /** @type {object[]} */ retries: [],
    /** @type {number} */ reads: 0,
  };
  await page.route(`${APP}/api/households/${HARLOW}/portable-archives`, guardedRoute(async (route) => {
    if (route.request().method() === "GET") {
      server.reads += 1;
      await route.fulfill({ json: server.state });
      return;
    }
    server.starts.push(route.request().postDataJSON());
    server.state = { export: job("pending"), latest: server.state.latest };
    await route.fulfill({ status: 202, json: { export: job("pending") } });
  }));
  await page.route(`${APP}/api/households/${HARLOW}/portable-archives/*/retry`, guardedRoute(async (route) => {
    server.retries.push(route.request().postDataJSON());
    server.state = { export: job("pending"), latest: server.state.latest };
    await route.fulfill({ status: 200, json: { export: job("pending") } });
  }));
  return server;
}

/** @param {import("@playwright/test").Page} page @param {boolean} phone */
function exportCard(page, phone) {
  const card = phone ? page.locator('section[data-hh="archive"]') : page.locator(".c-archive");
  const panel = phone ? page.locator("#hh-panel-out") : page.locator("#arch-panel-out");
  return {
    card,
    panel,
    download: card.getByRole("link", { name: phone ? "download" : "download the file" }),
    startButton: card.getByRole("button", { name: phone ? "export this system" : "write an archive →" }),
    passphrase: card.getByLabel("a passphrase for the file"),
  };
}

/** @param {import("@playwright/test").Page} page @param {boolean} phone */
async function openCard(page, phone) {
  await signedIn(`/household/${HARLOW}`, "any-dialect")(page);
  const c = exportCard(page, phone);
  await expect(c.card).toBeVisible({ timeout: EXPORT_SETTLE });
  return c;
}

test.describe("the export as a background job (#1774)", () => {
  test.describe.configure({ timeout: 90_000 });

  test("start: queued at once with no download, then the writing line with its numbers, then ready with one download and (pocket) the toast once", async ({ page }, testInfo) => {
    const phone = onPhone(testInfo);
    const server = await exportJobRoutes(page, { export: null, latest: null });
    const c = await openCard(page, phone);
    await c.startButton.click();
    await c.card.getByLabel("a passphrase for the file").fill(PASSPHRASE);
    await c.card.getByLabel("the passphrase again").fill(PASSPHRASE);
    const act = c.card.getByRole("button", { name: /write the archive/ }).first();
    await act.click(); // arm
    await act.click(); // fire

    /* Queued within one poll, and nothing to download yet. */
    await expect(c.panel).toContainText("queued", { timeout: EXPORT_SETTLE });
    await expect(c.panel).toContainText("Orbit is finishing another archive first");
    await expect(c.download).toHaveCount(0);
    expect(server.starts).toHaveLength(1);
    expect(server.starts[0]).toMatchObject({ passphrase: PASSPHRASE });

    server.state = { export: job("processing", { bytesDone: GIB, bytesTotal: 4 * GIB }), latest: null };
    await expect(c.panel).toContainText("writing the archive", { timeout: EXPORT_SETTLE });
    await expect(c.panel).toContainText(" of ");
    await expect(c.panel).toContainText("25%");
    await expect(c.download).toHaveCount(0);

    server.state = { export: job("completed", { bytesDone: 4 * GIB, bytesTotal: 4 * GIB }), latest: READY };
    await expect(c.download).toHaveCount(1, { timeout: EXPORT_SETTLE });
    await expect(c.download).toHaveAttribute("href", READY.downloadUrl);
    await expect(c.panel).toContainText("ready until");
    if (phone) {
      /* The wake: once, and only because the page saw the job complete. */
      await expect(page.getByText(/the archive is written/)).toHaveCount(1);
    }
    /* The poll stops once nothing is live: no further reads. */
    const reads = server.reads;
    await page.waitForTimeout(5_000);
    expect(server.reads - reads, "no polling once completed").toBeLessThanOrEqual(1);
  });

  test("a reload while the job is writing opens the card in writing, not at rest", async ({ page }, testInfo) => {
    const phone = onPhone(testInfo);
    await exportJobRoutes(page, { export: job("processing", { bytesDone: GIB, bytesTotal: 4 * GIB }), latest: null });
    const c = await openCard(page, phone);
    await expect(c.panel).toContainText("writing the archive", { timeout: EXPORT_SETTLE });
    await expect(c.panel).toContainText("25%");
    await expect(c.startButton).toHaveCount(0);
  });

  test("a reload with no job but a kept archive opens the card in written, with its download", async ({ page }, testInfo) => {
    const phone = onPhone(testInfo);
    await exportJobRoutes(page, { export: null, latest: READY });
    const c = await openCard(page, phone);
    await expect(c.download).toHaveCount(1, { timeout: EXPORT_SETTLE });
    await expect(c.download).toHaveAttribute("href", READY.downloadUrl);
    await expect(c.panel).toContainText("ready until");
    await expect(c.startButton).toHaveCount(0);
  });

  test("a reload while queued opens the card in queued", async ({ page }, testInfo) => {
    const phone = onPhone(testInfo);
    await exportJobRoutes(page, { export: job("retry"), latest: null });
    const c = await openCard(page, phone);
    await expect(c.panel).toContainText("queued", { timeout: EXPORT_SETTLE });
    await expect(c.download).toHaveCount(0);
  });

  test("a failed job says why and offers exactly one control, try again, which sends expectedStatus failed and goes to queued", async ({ page }, testInfo) => {
    const phone = onPhone(testInfo);
    const server = await exportJobRoutes(page, { export: job("failed", { failureCode: "archive_export_interrupted", failureMessage: FAILED_WORDS, canRetry: true }), latest: null });
    const c = await openCard(page, phone);
    await expect(c.panel).toContainText(`not written — ${FAILED_WORDS}`, { timeout: EXPORT_SETTLE });
    await expect(c.panel.getByRole("button")).toHaveCount(1);
    await expect(c.passphrase).toHaveCount(0);
    const retry = c.panel.getByRole("button", { name: "try again" });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect.poll(() => server.retries.length, { timeout: EXPORT_SETTLE }).toBe(1);
    expect(server.retries[0]).toMatchObject({ expectedStatus: "failed" });
    await expect(c.panel).toContainText("queued", { timeout: EXPORT_SETTLE });
  });

  test("a failed job whose key is gone offers write it again, which opens the form and sends no retry", async ({ page }, testInfo) => {
    const phone = onPhone(testInfo);
    const server = await exportJobRoutes(page, { export: job("failed", { failureCode: "archive_metadata_damaged", failureMessage: "Orbit can't export: an item's stored details are damaged", canRetry: false }), latest: null });
    const c = await openCard(page, phone);
    await expect(c.panel).toContainText("not written — Orbit can't export", { timeout: EXPORT_SETTLE });
    await expect(c.panel.getByRole("button")).toHaveCount(1);
    await expect(c.panel.getByRole("button", { name: "try again" })).toHaveCount(0);
    await c.panel.getByRole("button", { name: "write it again" }).click();
    await expect(c.passphrase).toBeVisible({ timeout: EXPORT_SETTLE });
    expect(server.retries).toEqual([]);
  });

  test("accessibility: the progress line keeps role status, the failure line role alert, and axe passes in each state", async ({ page }, testInfo) => {
    const phone = onPhone(testInfo);
    const server = await exportJobRoutes(page, { export: job("pending"), latest: null });
    const c = await openCard(page, phone);
    const axeCheck = async (/** @type {string} */ state) => {
      const results = await withDecorationHidden(page, () => new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .include(phone ? 'section[data-hh="archive"]' : ".c-archive")
        .analyze());
      expect(results.violations, state).toEqual([]);
    };

    await expect(c.card.getByRole("status").filter({ hasText: "queued" })).toBeVisible({ timeout: EXPORT_SETTLE });
    await axeCheck("queued");

    server.state = { export: job("processing", { bytesDone: GIB, bytesTotal: 4 * GIB }), latest: null };
    await expect(c.card.getByRole("status").filter({ hasText: "writing the archive" })).toBeVisible({ timeout: EXPORT_SETTLE });
    await axeCheck("writing");

    server.state = { export: job("completed", { bytesDone: 4 * GIB, bytesTotal: 4 * GIB }), latest: READY };
    await expect(c.download).toHaveCount(1, { timeout: EXPORT_SETTLE });
    await axeCheck("ready");

    server.state = { export: job("failed", { failureCode: "archive_export_interrupted", failureMessage: FAILED_WORDS }), latest: null };
    await page.reload();
    await expect(c.card.getByRole("alert").filter({ hasText: "not written" })).toBeVisible({ timeout: EXPORT_SETTLE });
    await axeCheck("failed");
  });
});
