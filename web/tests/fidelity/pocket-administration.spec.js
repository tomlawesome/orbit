import { expect, test } from "@playwright/test";
import { openRow, settle } from "./pocket-states.js";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * ADMINISTRATION ON A PHONE (#1123, proposal §2.12 and §2.11; owner decisions
 * §25 and §19; review round §1.1, §2.6), in a real browser at 390x844 with
 * touch on. The fixture harness answers people, systems and the mockup's
 * machinery rows; the states it cannot reach (a system on the clock, document
 * jobs, alerts) are given here as the routes would answer them.
 *   · a tap opens a row's acts in place, and they are real named buttons
 *   · a system on the clock keeps `restore` on show; `delete now` sits in
 *     its opened row and wakes only for the name typed exactly
 *   · a failed document job says why, and offers retry, with no interaction
 *   · alerts stand first; the jump strip is plain links, not tabs
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const NOW = Date.parse("2026-08-13T12:00:00.000Z");
const at = (/** @type {number} */ minutes) => new Date(NOW - minutes * 60000).toISOString();
const ahead = (/** @type {number} */ days) => new Date(NOW + days * 86400000).toISOString();
const JOBS = [
  { id: "f1", kind: "scan", status: "failed", attempts: 5, lastErrorCode: "scanner_unavailable", nextAttemptAt: null, createdAt: at(40), updatedAt: at(6) },
  { id: "d1", kind: "encrypt", status: "completed", attempts: 1, lastErrorCode: null, nextAttemptAt: null, createdAt: at(90), updatedAt: at(88) },
];

/**
 * @param {import("@playwright/test").Page} page
 * @param {{ alerts?: boolean }} [options]
 */
async function open(page, { alerts = false } = {}) {
  await page.route(`${APP}/api/admin/operations`, (route) =>
    route.fulfill({ json: { operations: { documentJobs: JOBS, documentJobCounts: {} } } }));
  await page.route(`${APP}/api/workspace`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.workspace.recoverableHouseholds = [{ id: "hh-gone-1", name: "Aunt May’s Cottage", deleteAfter: ahead(13) }];
    await route.fulfill({ response, json: body });
  });
  if (alerts) {
    await page.route(`${APP}/api/admin/recovery-bundle`, (route) =>
      route.fulfill({ json: { recoveryBundle: { exported: false, exportedAt: null } } }));
  }
  await page.goto(`${APP}/administration`, { waitUntil: "load" });
  await page.waitForSelector(".ad-pocket [data-ad=people] .p-row");
  await settle(page);
}

/** @param {import("@playwright/test").Page} page @param {string} scope @param {string} text */
const row = (page, scope, text) => page.locator(`${scope} .p-row`, { hasText: text }).first();

test("a tap opens a person's row, naming its acts; your own row has none", async ({ page }) => {
  await open(page);
  /* At rest every row is shut: its acts are hidden, out of the page. */
  await expect(page.locator(".ad-pocket [data-row-panel]:not([hidden])")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disable Emma Lawson" })).toHaveCount(0);
  const emma = row(page, "[data-ad=people]", "Emma Lawson");
  await openRow(page, emma);
  await expect(emma.getByRole("button", { name: "Place Emma Lawson in a system" })).toBeVisible();
  await expect(emma.getByRole("button", { name: "Send Emma Lawson a new setup link" })).toBeVisible();
  await expect(emma.getByRole("button", { name: "Disable Emma Lawson" })).toBeVisible();
  /* Your own row has none. */
  await expect(row(page, "[data-ad=people]", "· you").locator("[data-row-acts]")).toHaveCount(0);
});

test("disable arms before it fires", async ({ page }) => {
  /* The fixture instance has no database to write to: answer the write. */
  await page.route(`${APP}/api/admin/users`, (route) =>
    route.request().method() === "PATCH" ? route.fulfill({ json: { ok: true } }) : route.fallback());
  await open(page);
  const emma = row(page, "[data-ad=people]", "Emma Lawson");
  await openRow(page, emma);
  await emma.getByRole("button", { name: "Disable Emma Lawson" }).click();
  await expect(emma.getByRole("button", { name: "tap again to disable Emma Lawson" })).toBeVisible();
  await emma.getByRole("button", { name: "tap again to disable Emma Lawson" }).click();
  await expect(page.locator(".p-wake-host [role=status]")).toContainText("Emma Lawson is disabled");
  /* The screen re-reads after the write; let that settle before the page goes. */
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a system on the clock keeps restore on show; delete now sits in its opened row", async ({ page }) => {
  await open(page);
  const clock = row(page, "[data-ad=systems]", "Aunt May");
  /* Round 3 §3.9: the meta is the state and the days; the date is the panel's. */
  await expect(clock.locator(".meta")).toHaveText("deleted · 13 days left");
  await expect(page.getByRole("button", { name: "Restore Aunt May’s Cottage" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete Aunt May’s Cottage now, for good" })).toHaveCount(0);

  await openRow(page, clock);
  await expect(clock.locator("[data-row-panel] .p-kv").first()).toHaveText(/gone for good\s*26 Aug/);
  await clock.getByRole("button", { name: "Delete Aunt May’s Cottage now, for good" }).click();
  await clock.getByRole("button", { name: "tap again to delete Aunt May’s Cottage now, for good" }).click();
  const sheet = page.getByRole("dialog", { name: /Delete Aunt May’s Cottage now/ });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Nothing comes back after this");
  await expect(sheet.getByRole("button", { name: "delete for good" })).toBeDisabled();
  await sheet.getByLabel(/type the system’s name exactly/i).fill("Aunt May’s Cottage");
  await expect(sheet.getByRole("button", { name: "delete for good" })).toBeEnabled();
});

test("a failed document job says why and offers retry, with no interaction", async ({ page }) => {
  await open(page);
  const card = page.locator(".ad-pocket [data-ad=documents]");
  const failed = card.locator(".p-row").filter({ hasText: "FAILED" });
  await expect(failed).toContainText("Virus scan");
  /* Round 3 §3.9 and §8: the reason alone at rest; the tries and when it was last tried are the panel's. */
  await expect(failed.locator(".meta")).toHaveText("couldn’t reach the scanner");
  await expect(page.getByRole("button", { name: "Retry the virus scan" })).toBeVisible();
  await openRow(page, failed);
  await expect(failed.locator("[data-row-panel] .p-kv").first()).toHaveText(/tries\s*5/);
  await expect(failed.locator("[data-row-panel] .p-kv").nth(1)).toHaveText(/last tried\s*6m ago/);
  /* Kind only, never a document's name (owner, 2026-09-19); one retry, on the failed row only. */
  await expect(card.getByRole("button", { name: /^Retry/ })).toHaveCount(1);
  /* And it is told at the top of the page. */
  await expect(page.locator(".ad-pocket .ad-tells a", { hasText: "1 job failed" })).toHaveAttribute("href", "#ad-documents");
});

test("a row's meta is its data alone; the rest is the panel's first line", async ({ page }) => {
  await open(page);
  await expect(page.locator(".ad-pocket .ad-sub")).toHaveText("5 people · 5 systems");
  /* People: the email alone at rest; the systems they are in, once opened. */
  const emma = row(page, "[data-ad=people]", "Emma Lawson");
  await expect(emma.locator(".meta")).not.toContainText("·");
  await expect(emma.locator(".meta")).not.toContainText("system");
  await openRow(page, emma);
  await expect(emma.locator("[data-row-panel] .p-kv").first()).toHaveText("owns 2 systems");
  /* Systems: members and items at rest; the owner, once opened. */
  const lawson = row(page, "[data-ad=systems]", "Lawson Home");
  await expect(lawson.locator(".meta")).toHaveText(/^\d+ members? · \d+ items?$/);
  await openRow(page, lawson);
  await expect(lawson.locator("[data-row-panel] .p-kv").first()).toHaveText(/owner\s*Tom Lawson/);
  /* The public contact and the rotate row carry no sentence at rest. */
  await expect(page.locator(".ad-pocket [data-ad=contact] .p-row .meta")).toHaveCount(0);
  await expect(row(page, "[data-ad=mail]", "every address").locator(".meta")).toHaveCount(0);
  /* The jobs card has no foot, and the version is one line with no promise (10b). */
  await expect(page.locator(".ad-pocket [data-ad=documents]")).not.toContainText("most recently");
  await expect(page.locator(".ad-pocket .ad-strip")).toHaveText("ORBIT 1.3.0 · PREVIEW · FD6A7E6");
});

test("alerts stand first, and the jump strip is links, not tabs", async ({ page }) => {
  await open(page, { alerts: true });
  const first = page.locator(".ad-pocket main > section, .ad-pocket main > .ad-alerts").first();
  await expect(first).toHaveAttribute("data-ad", "alerts");
  await expect(first).toContainText("No recovery bundle exported");
  await first.getByRole("button", { name: "what to do" }).click();
  await expect(page.getByRole("dialog", { name: "No recovery bundle exported" })).toContainText("orbit export-recovery-bundle");

  const strip = page.getByRole("navigation", { name: "Jump to a card" });
  await expect(strip.getByRole("tab")).toHaveCount(0);
  for (const [word, id] of [["people", "ad-people"], ["systems", "ad-systems"], ["documents", "ad-documents"]]) {
    await expect(strip.getByRole("link", { name: word })).toHaveAttribute("href", `#${id}`);
  }
});

test("invite someone is a sheet, and never shows a link", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "invite someone" }).click();
  const sheet = page.getByRole("dialog", { name: "Invite someone" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel("email")).toBeVisible();
  await expect(sheet.getByLabel("display name")).toBeVisible();
  await sheet.getByRole("button", { name: "One day more" }).click();
  await expect(sheet.locator("output")).toHaveText("8 days");
  await expect(sheet).toContainText("The link is never shown here.");
  await expect(sheet.locator("a[href*='setup']")).toHaveCount(0);
});

/* The panel is tightest at 360: three acts must still sit wholly on the row
   once opened, none spilling past its edge. */
test.describe("at 360", () => {
  test.use({ viewport: { width: 360, height: 780 } });
  test("people's three acts fit the opened row", async ({ page }) => {
    await open(page);
    await expect(page.locator(".ad-pocket [data-row-panel]:not([hidden])")).toHaveCount(0);
    const emma = row(page, "[data-ad=people]", "Emma Lawson");
    await openRow(page, emma);
    await expect(emma.getByRole("button", { name: "Place Emma Lawson in a system" })).toBeVisible();
    await expect(emma.getByRole("button", { name: "Send Emma Lawson a new setup link" })).toBeVisible();
    await expect(emma.getByRole("button", { name: "Disable Emma Lawson" })).toBeVisible();
    const spill = await emma.locator("[data-row-acts]").evaluate((tray) =>
      [...tray.querySelectorAll("button")].some((b) => b.getBoundingClientRect().right > tray.getBoundingClientRect().right + 0.5));
    expect(spill).toBe(false);
  });
});
