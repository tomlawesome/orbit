#!/usr/bin/env node
/**
 * One-off capture for the docs screenshot placeholders (#1176). Not a test:
 * it takes no baseline and makes no pass/fail judgement, it just photographs
 * the fixture app in a handful of states and writes PNGs into docs/images/.
 *
 * Reuses the fidelity gate's own recipe (playwright.config.js's webServer,
 * screens.spec.js's capture()) for how the fixture app is started and
 * brought to a settled frame, trimmed to only what a plain screenshot needs
 * — no mockup comparison, no baseline diff.
 *
 * Run once from web/: `node tests/fidelity/capture-docs-screenshots.mjs`.
 * Needs web/build already built with web-build-stamp (pnpm build) and no
 * other process on the port below.
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../..");
const repoRoot = resolve(webRoot, "..");
const outDir = resolve(repoRoot, "docs/images");
mkdirSync(outDir, { recursive: true });

// Deliberately not 4173/5174 (playwright.config.js's own pair): this can run
// alongside a real fidelity gate on the same host without photographing, or
// colliding with, someone else's server.
const PORT = process.env.DOCS_SHOT_PORT ?? "4198";
const APP = `http://127.0.0.1:${PORT}`;

async function waitForServer(url, timeoutMs = 120_000) {
  const start = Date.now();
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${url}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

// The same fake-but-complete configuration playwright.config.js hands the
// fixture server: obviously-placeholder values, never anything resembling a
// real credential, so the real boot path runs rather than being bypassed.
const server = spawn("node", ["build/index.js"], {
  cwd: webRoot,
  env: {
    ...process.env,
    PORT,
    ORBIT_FIXTURES: "1",
    ORBIT_CONFIG_SCHEMA_VERSION: "1",
    APP_URL: APP,
    SESSION_SECRET: "ab".repeat(32),
    OIDC_ISSUER: "https://docs-shots.invalid/oidc",
    OIDC_CLIENT_ID: "docs-shots-placeholder-client-id",
    OIDC_CLIENT_SECRET: "docs-shots-placeholder-client-secret",
    DATABASE_URL: "postgres://docs-shots:docs-shots@127.0.0.1:5999/docs-shots",
    DOCUMENT_KEK: "cd".repeat(32),
    DOCUMENT_SCAN_MODE: "disabled",
    MIGRATE_ON_START: "false",
    WORKER_ENABLED: "false",
    IMAP_ENABLED: "false",
  },
  stdio: ["ignore", "ignore", "inherit"],
});

async function withPage(browser, { reducedMotion = null } = {}, run) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    timezoneId: "UTC",
  });
  const page = await context.newPage();
  // The default dark pack (screens.spec.js's own default), set through the
  // app's pre-paint mechanism so it is in force in the first painted pixel.
  await page.addInitScript(() => {
    try { localStorage.setItem("orbit-theme", "starchart"); } catch { /* storage refused: default pack stands */ }
  });
  // The sign-in door's own two questions (#788, #869): answered "healthy and
  // configured" for every capture, the way the fidelity gate answers them,
  // so a screen that stands on the door's ring never photographs its
  // held-dawn loading state instead.
  await page.route("**/api/health", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"status":"ready"}' }));
  await page.route("**/api/auth/availability", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ configured: true, phase: "running", contactAddress: null }),
    }));
  if (reducedMotion) await page.emulateMedia({ reducedMotion });
  await run(page);
  await context.close();
}

/** Settles once the sky overlays' once-off rasterisation has actually painted (#499, #501). */
const grainSettled = () =>
  [...document.querySelectorAll(".grain[data-rasterised], .world[data-rasterised]")].every(
    (el) => el.dataset.rasterised === "ready",
  );

async function finishLoad(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(grainSettled);
}

const shots = [];
async function shoot(page, locator, file) {
  const path = resolve(outDir, file);
  await locator.scrollIntoViewIfNeeded();
  await locator.screenshot({ path });
  shots.push(file);
  console.log(`wrote docs/images/${file}`);
}

await waitForServer(`${APP}/login`);
const browser = await chromium.launch();

try {
  // README: first-run setup wizard — the arrival card that asks for name,
  // time zone and currency and admits to the four default sections in its
  // one closing note line (CreateSystem.svelte).
  await withPage(browser, {}, async (page) => {
    await page.goto(`${APP}/?arrival=create`, { waitUntil: "load" });
    await page.waitForFunction(() =>
      document.body.classList.contains("lit")
      && document.body.classList.contains("showform")
      && Boolean(document.querySelector(".card")));
    await finishLoad(page);
    await shoot(page, page.locator(".card"), "first-run-sections-step.png");
  });

  // Administration screens, all at rest (#472/#475's ISS backdrop drifts on
  // a clock Playwright's animation freeze cannot reach — reduced motion
  // holds it, as the fidelity gate's own administration entry does).
  const adminSettle = () =>
    Boolean(document.querySelector(".person"))
    && Boolean(document.querySelector(".system svg"))
    && Boolean(document.querySelector(".station .att"));

  await withPage(browser, { reducedMotion: "reduce" }, async (page) => {
    await page.goto(`${APP}/administration`, { waitUntil: "load" });
    await page.waitForFunction(adminSettle);
    await finishLoad(page);
    await shoot(page, page.locator("form.localuser:not(.resend)"), "admin-add-local-user.png");
  });

  await withPage(browser, { reducedMotion: "reduce" }, async (page) => {
    // Under fixtures GET /api/admin/mailbox answers { mailbox: null } (the
    // route's own fixture branch), which hides the "set up mailbox…" button
    // entirely (+page.svelte: `{#if view.mailbox && !editing}`). Answering an
    // unconfigured-but-present mailbox, the shape setMailboxSettings would
    // hand back before anything is saved, is what puts the button — and then
    // the real empty settings form behind it — on the screen.
    await page.route(`${APP}/api/admin/mailbox`, (route) =>
      route.fulfill({
        json: {
          mailbox: {
            configured: false, enabled: false, host: "", port: 993, accountUser: "", mailbox: "INBOX",
            tlsServerName: "", providerProfile: "mailcow", authMethod: "password",
            trustedRecipientHeader: "", trustedAuthservId: "", effectiveAuthservId: "",
            pollSeconds: 300, verificationState: "unverified", verifiedAt: null,
            aliasPattern: null, credentialSetAt: null, credentialSetBy: null,
            hasPassword: false, hasAliasKey: false, version: null,
            health: { status: "unknown", smtp: "unknown", imap: "unknown", checkedAt: null, credentialLocked: false },
          },
        },
      }));
    await page.goto(`${APP}/administration`, { waitUntil: "load" });
    await page.waitForFunction(adminSettle);
    await finishLoad(page);
    await page.getByRole("button", { name: "set up mailbox…" }).click();
    const form = page.locator("#mail-card form.mailboxform");
    await form.waitFor({ state: "visible" });
    await shoot(page, form, "admin-mailbox-settings-form.png");
  });

  // The three "additive" notice cards (#956, #941, #968): absent under the
  // plain fixture (their routes answer null and the card renders nothing),
  // so each is reached the same way pocket-administration.spec.js reaches
  // the recovery-bundle one — answering the one route that card reads.
  await withPage(browser, { reducedMotion: "reduce" }, async (page) => {
    await page.route(`${APP}/api/admin/recovery-bundle`, (route) =>
      route.fulfill({ json: { recoveryBundle: { exported: false, exportedAt: null } } }));
    await page.goto(`${APP}/administration`, { waitUntil: "load" });
    await page.waitForFunction(adminSettle);
    await finishLoad(page);
    const card = page.locator(".card.wide.rotation", { has: page.locator("h2", { hasText: "No recovery bundle exported" }) });
    await card.waitFor({ state: "visible" });
    await shoot(page, card, "admin-no-recovery-bundle.png");
  });

  await withPage(browser, { reducedMotion: "reduce" }, async (page) => {
    await page.route(`${APP}/api/admin/documents/health`, (route) =>
      route.fulfill({
        json: {
          health: {
            metadata: {
              locked: true, lockedItems: 7, lockedReceipts: 2,
              damagedValues: 0, damagedItems: 0, damagedReceipts: 0,
            },
          },
        },
      }));
    await page.goto(`${APP}/administration`, { waitUntil: "load" });
    await page.waitForFunction(adminSettle);
    await finishLoad(page);
    const card = page.locator(".card.wide.rotation", { has: page.locator("h2", { hasText: "Encrypted details are locked" }) });
    await card.waitFor({ state: "visible" });
    await shoot(page, card, "admin-encrypted-details-locked.png");
  });

  await withPage(browser, { reducedMotion: "reduce" }, async (page) => {
    await page.route(`${APP}/api/admin/documents/rotation`, (route) =>
      route.fulfill({
        json: { rotation: { inProgress: true, startedAt: "2026-09-29T10:00:00.000Z", secondKeyLoaded: true } },
      }));
    await page.goto(`${APP}/administration`, { waitUntil: "load" });
    await page.waitForFunction(adminSettle);
    await finishLoad(page);
    const card = page.locator(".card.wide.rotation", { has: page.locator("h2", { hasText: "Document key rotation in progress" }) });
    await card.waitFor({ state: "visible" });
    await shoot(page, card, "admin-key-rotation-in-progress.png");
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${shots.length} screenshot(s) written to docs/images/.`);
