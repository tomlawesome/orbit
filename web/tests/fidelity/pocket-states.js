/*
 * EVERY STATE A PHONE CAN REACH (#1120, review round step a).
 *
 * Shared by the phone measurement check (pocket-measure.spec.js) and the
 * review round's screenshot set (pocket-review-shots.spec.js), so the two
 * always walk the same states. Not a spec: nothing here runs on its own.
 *
 * Each state says how a reader gets there from a fresh page load: the route,
 * then the taps and typing. `settle()` is called after `reach`, so
 * `reach` only has to wait for its own state to exist.
 */

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
export const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

export const PHONES = [
  { name: "390", viewport: { width: 390, height: 844 } },
  { name: "360", viewport: { width: 360, height: 780 } },
];

/** @typedef {import("@playwright/test").Page} Page */
/** @typedef {import("@playwright/test").Locator} Locator */

/**
 * Waits for the page to stop moving: the network quiet, the fonts in, and
 * every finite animation and transition finished -- the cards' rise, a
 * sheet's climb, an arm's crossfade. Infinite ones (a breathing dot, the
 * sky's drift) never finish and are not waited for. Measuring mid-fade once
 * failed text that was only ever transparent for a frame, so this waits; it
 * never excludes.
 * @param {Page} page
 */
export async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  for (let round = 0; round < 6; round++) {
    await page.waitForTimeout(120);
    const running = await page.evaluate(async () => {
      const finite = document.getAnimations().filter((a) => a.playState === "running"
        && Number.isFinite(Number(a.effect?.getComputedTiming().endTime)));
      await Promise.race([
        Promise.all(finite.map((a) => a.finished.catch(() => {}))),
        new Promise((done) => setTimeout(done, 5000)),
      ]);
      return finite.length;
    });
    if (!running) break;
  }
}

/**
 * Opens a row in place (review round §1.1): a tap on its face, then the
 * panel's unfold. The household and administration specs open rows the
 * same way.
 * @param {Page} page
 * @param {Locator} row
 */
export async function openRow(page, row) {
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await row.locator("[data-row-face]").first().tap();
  await row.locator("[data-row-panel]:not([hidden])").first().waitFor();
  await settle(page);
}

/**
 * A touch drag straight up or down from the middle of `el` (a sheet's grab
 * handle, to grow a list sheet).
 * @param {Page} page
 * @param {Locator} el
 * @param {number} dy
 */
async function drag(page, el, dy) {
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await el.boundingBox());
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x, y: from.y + (dy * i) / 8 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** @param {Page} page @param {string} path */
async function go(page, path) {
  await page.goto(`${APP}${path}`, { waitUntil: "load" });
  await settle(page);
}

/** The sheet that is up. @param {Page} page */
const sheet = (page) => page.locator(".p-sheet-layer.open .p-sheet-panel");

/** @param {Page} page */
async function sheetUp(page) {
  await sheet(page).waitFor();
}

/** @param {Page} page @param {string} scope @param {string} text */
const row = (page, scope, text) => page.locator(`${scope} [data-row]`, { hasText: text }).first();

/** Opens the hatch (the account menu) from the orb. @param {Page} page */
async function hatch(page) {
  await page.locator(".porb:visible").first().click();
  await sheetUp(page);
}

/**
 * @typedef {{
 *   route: string,
 *   state: string,
 *   reach: (page: Page) => Promise<void>,
 *   defect?: Record<string, string>,
 * }} PhoneState
 * `route` is the address the state lives on and the folder its screenshots
 * go in; `state` names it. `defect`, keyed by phone width ("390", "360") or
 * "*" for both, marks a known defect the review round's step c fixes: the
 * measurement check expects that state to fail at that width.
 */

/* ── the signed-in screens ──────────────────────────────────────────────── */

const HH = "/household/hh-lawson-1";
const SEASIDE = "/household/hh-seaside-4551";

/** @param {Page} page */
async function household(page, path = HH) {
  await go(page, path);
  await page.waitForSelector(".hh-pocket [data-row]");
}

/* A configured mailbox, so the mail card draws everything it can: the
   fixture server answers "no mailbox". */
const MAILBOX = {
  configured: true, enabled: true, host: "imap.lawson-home.example", port: 993, accountUser: "orbit@lawson-home.example",
  mailbox: "INBOX", tlsServerName: "", providerProfile: "mailcow", authMethod: "password",
  trustedRecipientHeader: "Delivered-To", trustedAuthservId: "", effectiveAuthservId: "mail.lawson-home.example",
  pollSeconds: 60, verificationState: "verified", verifiedAt: "2026-08-12T09:00:00.000Z",
  aliasPattern: "<name>-<code>@in.lawson-home.orbit", credentialSetAt: "2026-08-01T09:00:00.000Z", credentialSetBy: "Tom Lawson",
  hasPassword: true, hasAliasKey: true, version: 3,
  health: { status: "ok", smtp: "ok", imap: "ok", checkedAt: "2026-08-13T11:59:00.000Z", credentialLocked: false },
};

/**
 * Administration with a system on the clock, two jobs and every alert, as
 * pocket-administration.spec.js stands it up; with `mailbox`, a configured
 * mailbox as well.
 * @param {Page} page
 * @param {{ mailbox?: boolean }} [options]
 */
async function administration(page, { mailbox = false } = {}) {
  if (mailbox) await page.route(`${APP}/api/admin/mailbox`, (route) => route.fulfill({ json: { mailbox: MAILBOX } }));
  const NOW = Date.parse("2026-08-13T12:00:00.000Z");
  const at = (/** @type {number} */ minutes) => new Date(NOW - minutes * 60000).toISOString();
  const ahead = (/** @type {number} */ days) => new Date(NOW + days * 86400000).toISOString();
  const jobs = [
    { id: "f1", kind: "scan", status: "failed", attempts: 5, lastErrorCode: "scanner_unavailable", nextAttemptAt: null, createdAt: at(40), updatedAt: at(6) },
    { id: "d1", kind: "encrypt", status: "completed", attempts: 1, lastErrorCode: null, nextAttemptAt: null, createdAt: at(90), updatedAt: at(88) },
  ];
  await page.route(`${APP}/api/admin/operations`, (route) =>
    route.fulfill({ json: { operations: { documentJobs: jobs, documentJobCounts: {} } } }));
  await page.route(`${APP}/api/workspace`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.workspace.recoverableHouseholds = [{ id: "hh-gone-1", name: "Aunt May’s Cottage", deleteAfter: ahead(13) }];
    await route.fulfill({ response, json: body });
  });
  await page.route(`${APP}/api/admin/recovery-bundle`, (route) =>
    route.fulfill({ json: { recoveryBundle: { exported: false, exportedAt: null } } }));
  await go(page, "/administration");
  await page.waitForSelector(".ad-pocket [data-ad=people] .p-row");
}

/** @param {Page} page @param {string} text */
const adButton = (page, text) => page.locator(".ad-pocket button:visible", { hasText: text }).first();

/** @type {PhoneState[]} */
export const SIGNED_IN = [
  /* /kit: the kit's own demonstration page */
  { route: "/kit", state: "rest", reach: (page) => go(page, "/kit") },
  { route: "/kit", state: "hatch", reach: async (page) => { await go(page, "/kit"); await hatch(page); } },
  { route: "/kit", state: "pill-armed", reach: async (page) => {
    await go(page, "/kit");
    await page.getByRole("button", { name: "Remove the boiler service" }).click();
  } },
  { route: "/kit", state: "row-open", reach: async (page) => {
    await go(page, "/kit");
    await openRow(page, row(page, "[data-kit=members]", "Rob Lawson"));
  } },
  { route: "/kit", state: "sheet-callout", reach: async (page) => {
    await go(page, "/kit");
    await page.getByRole("button", { name: "callout", exact: true }).click();
    await sheetUp(page);
  } },
  { route: "/kit", state: "sheet-list", reach: async (page) => {
    await go(page, "/kit");
    await page.getByRole("button", { name: "list", exact: true }).click();
    await sheetUp(page);
  } },
  { route: "/kit", state: "sheet-list-grown", reach: async (page) => {
    await go(page, "/kit");
    await page.getByRole("button", { name: "list", exact: true }).click();
    await sheetUp(page);
    await settle(page);
    await drag(page, sheet(page).locator(".grab"), -120);
    await page.locator(".p-sheet-layer.open.grown").waitFor();
  } },
  { route: "/kit", state: "sheet-full", reach: async (page) => {
    await go(page, "/kit");
    await page.getByRole("button", { name: "full", exact: true }).click();
    await sheetUp(page);
  } },
  { route: "/kit", state: "wake", reach: async (page) => {
    await go(page, "/kit");
    await page.getByRole("button", { name: "wake", exact: true }).click();
    await page.locator(".p-wake").first().waitFor();
  } },

  /* /home: the dial, the manifest's drawers, and every sheet home raises:
     the search and the hatch. A planet opens its row (owner's answer 6a). */
  { route: "/home", state: "rest", reach: (page) => go(page, "/home") },
  { route: "/home", state: "hatch", reach: async (page) => { await go(page, "/home"); await hatch(page); } },
  { route: "/home", state: "search", reach: async (page) => {
    await go(page, "/home");
    await page.locator(".msearch").click();
    await sheetUp(page);
  } },
  { route: "/home", state: "search-results", reach: async (page) => {
    await go(page, "/home");
    await page.locator(".msearch").click();
    await sheetUp(page);
    await sheet(page).locator(".pk-field").fill("service");
  } },
  { route: "/home", state: "search-nothing", reach: async (page) => {
    await go(page, "/home");
    await page.locator(".msearch").click();
    await sheetUp(page);
    await sheet(page).locator(".pk-field").fill("xyzxyz");
  } },
  { route: "/home", state: "dial-lit", reach: async (page) => {
    await go(page, "/home");
    await page.locator(".mdial .pk-body[aria-label='Gutter clearing']").click();
    await row(page, ".pk-below", "Gutter clearing").locator("[data-row-panel]:not([hidden])").waitFor();
    await settle(page);
  } },
  { route: "/home", state: "row-open", reach: async (page) => {
    await go(page, "/home");
    const mot = row(page, ".pk-below", "Car MOT");
    await openRow(page, mot);
    await mot.locator(".paper").first().waitFor();
  } },
  { route: "/home", state: "suggestion-row-open", reach: async (page) => {
    await go(page, "/home");
    await openRow(page, row(page, ".pk-signals", "Home insurance"));
  } },
  { route: "/home", state: "suggestion-row-armed", reach: async (page) => {
    await go(page, "/home");
    const catch_ = row(page, ".pk-signals", "Home insurance");
    await openRow(page, catch_);
    await catch_.getByRole("button", { name: /^Add .* to your orbit$/ }).click();
  } },
  { route: "/home", state: "review-sheet", reach: async (page) => {
    await go(page, "/home");
    const catch_ = row(page, ".pk-signals", "Home insurance");
    await openRow(page, catch_);
    await catch_.getByRole("button", { name: "review & amend →" }).click();
    await sheetUp(page);
  } },
  { route: "/home", state: "manifest-bottom", reach: async (page) => {
    await go(page, "/home");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  } },

  /* #1083: the pocket cut of the one-take film, three states — a household
     whose tour is still due (the fixture's own tour endpoint says
     `tourSeenAt: null`), driven headless through the design's own review
     hooks (film.js's `window.__chapters`/`__jump`/`__hold`/`__pause`). */
  { route: "/home", state: "film-rest", reach: async (page) => {
    await page.route("**/api/settings/tour", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"tour":{"tourSeenAt":null}}' }));
    await go(page, "/home");
    await page.waitForFunction(() => Array.isArray(/** @type {any} */ (window).__chapters));
    await page.evaluate(() => /** @type {any} */ (window).__pause());
    await settle(page);
  } },
  { route: "/home", state: "film-hatch", reach: async (page) => {
    await page.route("**/api/settings/tour", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"tour":{"tourSeenAt":null}}' }));
    await go(page, "/home");
    await page.waitForFunction(() => Array.isArray(/** @type {any} */ (window).__chapters));
    await page.evaluate(() => {
      /** @type {any} */ (window).__hold = "sky-settings";
      /** @type {any} */ (window).__jump(10); /* chapter 11, "Your sky" */
    });
    await page.waitForFunction(() => /** @type {any} */ (window).__held === "sky-settings");
    await settle(page);
  } },
  { route: "/home", state: "film-create", reach: async (page) => {
    await page.route("**/api/settings/tour", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"tour":{"tourSeenAt":null}}' }));
    await go(page, "/home");
    await page.waitForFunction(() => Array.isArray(/** @type {any} */ (window).__chapters));
    await page.evaluate(() => {
      /** @type {any} */ (window).__hold = "add-drawer";
      /** @type {any} */ (window).__jump(1); /* chapter 2, "Add" */
    });
    await page.waitForFunction(() => /** @type {any} */ (window).__held === "add-drawer");
    await settle(page);
  } },

  /* /item/<receiptId>: the suggestion seated in the belt (#1145; round 3 §4's
     receipt page merged into it) -- its card holds the decisions and
     `review & amend →` raises the review sheet. */
  { route: "/item/r-insurance", state: "rest", reach: (page) => go(page, "/item/r-insurance") },
  { route: "/item/r-insurance", state: "review-sheet", reach: async (page) => {
    await go(page, "/item/r-insurance");
    await page.locator(".ip-amend").first().click();
    await sheetUp(page);
  } },
  /* /item: the belt and its sheets */
  { route: "/item", state: "rest", reach: (page) => go(page, "/item") },
  { route: "/item/i-mot", state: "rest", reach: (page) => go(page, "/item/i-mot") },
  { route: "/item/i-mot", state: "hatch", reach: async (page) => { await go(page, "/item/i-mot"); await hatch(page); } },
  { route: "/item/i-mot", state: "find", reach: async (page) => {
    await go(page, "/item/i-mot");
    await page.locator(".ip-find").click();
    await sheetUp(page);
  } },
  { route: "/item/i-mot", state: "find-results", reach: async (page) => {
    await go(page, "/item/i-mot");
    await page.locator(".ip-find").click();
    await sheetUp(page);
    await sheet(page).locator(".bp-field-find").fill("service");
  } },
  ...["complete", "reschedule", "snooze", "edit"].map((act) => ({
    route: "/item/i-mot", state: act,
    reach: async (/** @type {Page} */ page) => {
      await go(page, "/item/i-mot");
      await page.locator(".ip-acts button:visible", { hasText: act }).first().click();
      await sheetUp(page);
    },
  })),
  { route: "/item/i-mot", state: "retire", reach: async (page) => {
    await go(page, "/item/i-mot");
    await page.locator(".ip-acts button:visible", { hasText: /retire/i }).first().click();
  } },
  { route: "/item/i-mot", state: "documents", reach: async (page) => {
    await go(page, "/item/i-mot");
    await page.locator(".ip-docs").click();
    await sheetUp(page);
  } },
  { route: "/item/i-mot", state: "document-preview", reach: async (page) => {
    await go(page, "/item/i-mot");
    await page.locator(".ip-docs").click();
    await sheetUp(page);
    await settle(page);
    await sheet(page).locator("[data-row-face]").first().click();
    await sheet(page).locator(".bp-page.shown, .bp-honest").first().waitFor();
  } },

  /* /create: the form, its expanded reminders, a refusal, and leaving it */
  { route: "/create", state: "rest", reach: async (page) => {
    await go(page, "/create");
    await page.locator("#pocket-entry").waitFor();
  } },
  { route: "/create", state: "reminders-sheet", reach: async (page) => {
    await go(page, "/create");
    await page.locator(".pc-remind").click();
    await sheetUp(page);
  } },
  { route: "/create", state: "filled", reach: async (page) => {
    await go(page, "/create");
    await page.locator(".pc-chip", { hasText: "renewal" }).first().click();
    await page.getByRole("textbox", { name: "name", exact: true }).fill("Home insurance renewal with a long provider name");
    await page.locator(".pc-sec", { hasText: "Home" }).first().click();
  } },
  { route: "/create", state: "cost-refused", reach: async (page) => {
    await go(page, "/create");
    await page.getByRole("textbox", { name: "name", exact: true }).fill("Boiler service");
    await page.locator(".pc-sec", { hasText: "Home" }).first().click();
    await page.getByRole("textbox", { name: "cost", exact: true }).fill("lots");
    await page.locator(".pk-refusal", { hasText: "dot for pence" }).waitFor();
  } },
  { route: "/create", state: "leave-sheet", reach: async (page) => {
    await go(page, "/create");
    await page.getByRole("textbox", { name: "name", exact: true }).fill("Boiler service");
    await page.locator(".pk-never").click();
    await sheetUp(page);
  } },

  /* /inbox: the review lane, its arms and the review sheet, the failed lane */
  { route: "/inbox", state: "rest", reach: (page) => go(page, "/inbox") },
  { route: "/inbox", state: "add-armed", reach: async (page) => {
    await go(page, "/inbox");
    await page.locator(".rv-yes").first().click();
  } },
  { route: "/inbox", state: "dismiss-armed", reach: async (page) => {
    await go(page, "/inbox");
    await page.locator(".rv-no").first().click();
  } },
  { route: "/inbox", state: "review-sheet", reach: async (page) => {
    await go(page, "/inbox");
    await page.locator(".rv-amend").first().click();
    await sheetUp(page);
  } },
  { route: "/inbox", state: "failed-open", reach: async (page) => {
    await go(page, "/inbox");
    await openRow(page, row(page, "[aria-labelledby=pki-failed-h]", "A message"));
  } },

  /* /household: the owner's system and a member's */
  { route: HH, state: "rest", reach: (page) => household(page) },
  { route: HH, state: "member-open", reach: async (page) => {
    await household(page);
    await openRow(page, row(page, ".hh-members", "Emma Lawson"));
  } },
  { route: HH, state: "member-remove-armed", reach: async (page) => {
    await household(page);
    const emma = row(page, ".hh-members", "Emma Lawson");
    await openRow(page, emma);
    await emma.getByRole("button", { name: "Remove Emma Lawson" }).click();
  } },
  { route: HH, state: "leave-armed", reach: async (page) => {
    await household(page);
    const gran = row(page, ".hh-members", "Gran");
    await openRow(page, gran);
    await gran.locator("[data-row-acts] button").last().click();
  } },
  { route: HH, state: "invitation-open", reach: async (page) => {
    await household(page);
    await openRow(page, row(page, ".hh-members", "daniel.lawson@example.com"));
  } },
  { route: HH, state: "knocking", reach: async (page) => {
    await page.route("**/api/join-requests*", (route) => route.fulfill({ json: { requests: [
      { id: "jr-1", householdId: "hh-lawson-1", userId: "u-ben", displayName: "Ben Lawson", createdAt: "2026-08-11T09:00:00Z" },
    ] } }));
    await page.route("**/api/households/hh-lawson-1/join-requests*", (route) => route.fulfill({ json: { requests: [
      { id: "jr-1", householdId: "hh-lawson-1", userId: "u-ben", displayName: "Ben Lawson", createdAt: "2026-08-11T09:00:00Z" },
    ] } }));
    await household(page);
    await page.locator(".hh-members", { hasText: "Ben Lawson" }).waitFor({ timeout: 5000 });
  } },
  { route: HH, state: "invite-sheet", reach: async (page) => {
    await household(page);
    await page.locator(".hh-pocket button", { hasText: "invite someone" }).click();
    await sheetUp(page);
  } },
  { route: HH, state: "add-account-sheet", reach: async (page) => {
    await household(page);
    await page.locator(".hh-pocket button", { hasText: "add an existing account" }).click();
    await sheetUp(page);
  } },
  { route: HH, state: "add-account-nobody", reach: async (page) => {
    await household(page);
    await page.locator(".hh-pocket button", { hasText: "add an existing account" }).click();
    await sheetUp(page);
    await sheet(page).locator(".hh-filter").fill("xyz");
  } },
  { route: HH, state: "handover-sheet", reach: async (page) => {
    await household(page);
    const emma = row(page, ".hh-members", "Emma Lawson");
    await openRow(page, emma);
    await emma.getByRole("button", { name: /Hand .* over to Emma/ }).click();
    await sheetUp(page);
  } },
  { route: HH, state: "handover-armed", reach: async (page) => {
    await household(page);
    const emma = row(page, ".hh-members", "Emma Lawson");
    await openRow(page, emma);
    await emma.getByRole("button", { name: /Hand .* over to Emma/ }).click();
    await sheetUp(page);
    await settle(page);
    await sheet(page).locator(".arm").click();
  } },
  { route: HH, state: "time-zone-sheet", reach: async (page) => {
    await household(page);
    await row(page, "[data-hh=system]", "time zone").locator("[data-row-face]").click();
    await sheetUp(page);
  } },
  { route: HH, state: "currency-sheet", reach: async (page) => {
    await household(page);
    await row(page, "[data-hh=system]", "currency").locator("[data-row-face]").click();
    await sheetUp(page);
  } },
  { route: HH, state: "save-bar", reach: async (page) => {
    await household(page);
    await page.locator(".hh-switch").first().click();
    await page.locator("[data-hh=savebar].up").waitFor();
  } },
  { route: HH, state: "save-bar-refusal", reach: async (page) => {
    await household(page);
    await page.locator("#hh-name").fill("");
    await page.locator("[data-hh=savebar].up").waitFor();
  } },
  { route: HH, state: "section-open", reach: async (page) => {
    await household(page);
    await openRow(page, row(page, ".hh-sections", "Vehicles"));
  } },
  { route: HH, state: "add-section-sheet", reach: async (page) => {
    await household(page);
    await page.locator(".hh-pocket button", { hasText: "add a section" }).click();
    await sheetUp(page);
  } },
  { route: HH, state: "edit-section-sheet", reach: async (page) => {
    await household(page);
    const vehicles = row(page, ".hh-sections", "Vehicles");
    await openRow(page, vehicles);
    await vehicles.locator("[data-row-acts] button").first().click();
    await sheetUp(page);
  } },
  { route: HH, state: "archive-export", reach: async (page) => {
    await household(page);
    await page.locator(".hh-pocket button", { hasText: "export this system" }).click();
    await page.locator("#hh-pass-out").waitFor();
    await page.locator("#hh-pass-out").fill("a fixture passphrase");
    await page.locator("#hh-pass-again").fill("a different one");
  } },
  { route: HH, state: "archive-bring-in", reach: async (page) => {
    await household(page);
    await page.locator("#hh-tab-in").click();
    await page.locator("#hh-panel-in").waitFor();
  } },
  { route: HH, state: "delete-sheet", reach: async (page) => {
    await household(page);
    await page.locator(".hh-pocket button", { hasText: "delete this system" }).click();
    await sheetUp(page);
  } },
  { route: HH, state: "delete-armed", reach: async (page) => {
    await household(page);
    await page.locator(".hh-pocket button", { hasText: "delete this system" }).click();
    await sheetUp(page);
    await settle(page);
    await page.locator("#hh-delname").fill("Lawson Home");
    await sheet(page).locator(".arm").click();
  } },
  { route: SEASIDE, state: "rest", reach: (page) => household(page, SEASIDE) },
  { route: SEASIDE, state: "leave-armed", reach: async (page) => {
    await household(page, SEASIDE);
    const me = row(page, ".hh-members", "Tom Lawson");
    await openRow(page, me);
    await me.locator("[data-row-acts] button").last().click();
  } },

  /* /settings: every card, its sheets and its swipes */
  { route: "/settings", state: "rest", reach: (page) => go(page, "/settings") },
  { route: "/settings", state: "hatch", reach: async (page) => { await go(page, "/settings"); await hatch(page); } },
  { route: "/settings", state: "password-open", reach: async (page) => {
    await go(page, "/settings");
    await openRow(page, row(page, ".st-pocket", "password"));
  } },
  { route: "/settings", state: "change-password-sheet", reach: async (page) => {
    await go(page, "/settings");
    const password = row(page, ".st-pocket", "password");
    await openRow(page, password);
    await password.locator("[data-row-acts] button", { hasText: "change" }).click();
    await sheetUp(page);
  } },
  { route: "/settings", state: "remove-password-sheet", reach: async (page) => {
    await go(page, "/settings");
    const password = row(page, ".st-pocket", "password");
    await openRow(page, password);
    await password.getByRole("button", { name: "Remove your password" }).click();
    await password.getByRole("button", { name: "Remove your password" }).click();
    await sheetUp(page);
  } },
  { route: "/settings", state: "provider-open", reach: async (page) => {
    await go(page, "/settings");
    await openRow(page, row(page, ".st-pocket", "id.lawson-home.example"));
  } },
  { route: "/settings", state: "unlink-sheet", reach: async (page) => {
    await go(page, "/settings");
    const provider = row(page, ".st-pocket", "id.lawson-home.example");
    await openRow(page, provider);
    await provider.locator("[data-row-acts] .arm").click();
    await provider.locator("[data-row-acts] .arm").click();
    await sheetUp(page);
  } },
  { route: "/settings", state: "sent-tab", reach: async (page) => {
    await go(page, "/settings");
    await page.locator("#st-tab-sent").click();
    await page.locator("#st-panel-sent:not([hidden])").waitFor();
  } },
  { route: "/settings", state: "session-open", reach: async (page) => {
    await go(page, "/settings");
    await openRow(page, row(page, ".st-pocket", "Safari"));
  } },
  { route: "/settings", state: "sign-out-everywhere-armed", reach: async (page) => {
    await go(page, "/settings");
    const everywhere = page.locator(".st-pocket button", { hasText: "sign out of every device" });
    await everywhere.scrollIntoViewIfNeeded();
    await everywhere.click();
  } },
  { route: "/settings", state: "packs-scrolled", reach: async (page) => {
    await go(page, "/settings");
    await page.locator(".st-pack").last().scrollIntoViewIfNeeded();
  } },
  { route: "/settings/mail", state: "rest", reach: (page) => go(page, "/settings/mail") },
  { route: "/settings/mail", state: "rotate-armed", reach: async (page) => {
    await go(page, "/settings/mail");
    await page.getByRole("button", { name: "Rotate your relay address" }).click();
  } },
  { route: "/settings/mail", state: "paused", reach: (page) => go(page, "/settings/mail?relay=paused") },
  { route: "/settings/mail", state: "never-received", reach: (page) => go(page, "/settings/mail?relay=never") },

  /* /administration: every card, its sheets and its swipes */
  { route: "/administration", state: "rest", reach: administration },
  { route: "/administration", state: "hatch", reach: async (page) => { await administration(page); await hatch(page); } },
  { route: "/administration", state: "person-open", reach: async (page) => {
    await administration(page);
    await openRow(page, row(page, "[data-ad=people]", "Emma Lawson"));
  } },
  { route: "/administration", state: "invite-sheet", reach: async (page) => {
    await administration(page);
    await adButton(page, "invite someone").click();
    await sheetUp(page);
  } },
  { route: "/administration", state: "setup-link-sheet", reach: async (page) => {
    await administration(page);
    const emma = row(page, "[data-ad=people]", "Emma Lawson");
    await openRow(page, emma);
    await emma.getByRole("button", { name: /setup link/ }).click();
    await sheetUp(page);
  } },
  { route: "/administration", state: "place-sheet", reach: async (page) => {
    await administration(page);
    const emma = row(page, "[data-ad=people]", "Emma Lawson");
    await openRow(page, emma);
    await emma.getByRole("button", { name: /^Place/ }).click();
    await sheetUp(page);
  } },
  { route: "/administration", state: "new-system-sheet", reach: async (page) => {
    await administration(page);
    await adButton(page, "new system").click();
    await sheetUp(page);
  } },
  { route: "/administration", state: "clock-open", reach: async (page) => {
    await administration(page);
    await openRow(page, row(page, "[data-ad=systems]", "Aunt May"));
  } },
  { route: "/administration", state: "delete-system-sheet", reach: async (page) => {
    await administration(page);
    const gone = row(page, "[data-ad=systems]", "Aunt May");
    await openRow(page, gone);
    await gone.locator("[data-row-acts] .arm").click();
    await gone.locator("[data-row-acts] .arm").click();
    await sheetUp(page);
  } },
  { route: "/administration", state: "contact-sheet", reach: async (page) => {
    await administration(page);
    await row(page, "[data-ad=contact]", "").locator("[data-row-face]").click();
    await sheetUp(page);
  } },
  { route: "/administration", state: "mailbox-configured", reach: async (page) => {
    await administration(page, { mailbox: true });
    await page.locator("[data-ad=mail]").scrollIntoViewIfNeeded();
  } },
  { route: "/administration", state: "remove-credential-armed", reach: async (page) => {
    await administration(page, { mailbox: true });
    await adButton(page, "remove credential").click();
  } },
  { route: "/administration", state: "rotate-addresses-sheet", reach: async (page) => {
    await administration(page, { mailbox: true });
    await row(page, "[data-ad=mail]", "every address").locator("[data-row-face]").click();
    await sheetUp(page);
  } },
  { route: "/administration", state: "rotate-password-sheet", reach: async (page) => {
    await administration(page, { mailbox: true });
    await adButton(page, "rotate password").click();
    await sheetUp(page);
  } },
  { route: "/administration", state: "mailbox-sheet", reach: async (page) => {
    await administration(page, { mailbox: true });
    await adButton(page, "change mailbox").click();
    await sheetUp(page);
  } },
  { route: "/administration", state: "service-sheet", reach: async (page) => {
    await administration(page);
    await row(page, "[data-ad=operations]", "orbit-app").locator("[data-row-face]").click();
    await sheetUp(page);
  } },
  { route: "/administration", state: "alert-sheet", reach: async (page) => {
    await administration(page);
    await page.locator(".ad-alert .p-pill").first().click();
    await sheetUp(page);
  } },
];

/* ══════════════════════════════════════════════════════════════════════════
   STEP 9 · THE DOOR FAMILY (#1120, #1127; proposal §2.13–§2.20)

   The door's screens are states rather than addresses, so each entry says
   how to reach its state, the way screens.spec.js does: the same faked
   health, availability and session answers the fidelity gate gives, and the
   auth endpoints answered where a card has to be refused or kept waiting.
   `/approve` and `/invite` read the database in their `load`, which this
   harness has none of, so they are reached by a client-side navigation whose
   `__data.json` is answered here -- the real built page, rendered from data
   stated in the test. Measured with reduced motion, so the door's delayed
   first-light entrances are measured where they settle rather than mid-fade.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {import("@playwright/test").Route} route
 * @param {number} status
 * @param {unknown} body
 */
const answer = (route, status, body) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/**
 * SvelteKit's `__data.json` payload is devalue: a flat array whose first
 * entry maps each key to the index of its value. Enough of it for plain
 * objects of strings, booleans and null.
 * @param {unknown} root
 */
function devalue(root) {
  /** @type {unknown[]} */
  const out = [];
  /** @param {unknown} value */
  const put = (value) => {
    const at = out.length;
    out.push(null);
    if (value && typeof value === "object") {
      /** @type {Record<string, number>} */
      const refs = {};
      for (const [key, inner] of Object.entries(value)) refs[key] = inner === null ? -1 : put(inner);
      out[at] = refs;
    } else out[at] = value;
    return at;
  };
  put(root);
  return out;
}

const DOOR_LAYOUT = { type: "data", data: [{ fixtures: 1, isAdmin: 2 }, true, false], uses: {} };
const HEALTHY = { configured: true, phase: "running", contactAddress: null };
const MIXED_DOOR = { ...HEALTHY, claimed: true, methods: { local: true, oidc: true, localAccounts: true } };
const LOCAL_DOOR = { ...HEALTHY, claimed: true, methods: { local: true, oidc: false, localAccounts: true } };
const UNCLAIMED_DOOR = { ...HEALTHY, claimed: false, methods: { local: true, oidc: true } };
const APPROVAL = {
  instance: "Lawson Home", device: "Firefox on a Mac", where: "near Leeds, United Kingdom",
  requestedAt: "25 Sep 2026, 21:14 UTC", expiresAt: "25 Sep 2026, 21:29 UTC",
};

/**
 * @param {Page} page
 * @param {{ availability?: unknown, signedOut?: boolean }} [options]
 */
async function doorAnswers(page, { availability = HEALTHY, signedOut = true } = {}) {
  await page.route("**/api/health", (route) => answer(route, 200, { status: "ready" }));
  if (availability === null) await page.route("**/api/auth/availability", (route) => route.fulfill({ status: 500, body: "" }));
  else await page.route("**/api/auth/availability", (route) => answer(route, 200, availability));
  if (signedOut) await page.route("**/api/auth/session", (route) => answer(route, 401, { error: "unauthenticated" }));
}

/**
 * Land on a database-backed page through the client router, its data stated.
 * @param {Page} page
 * @param {string} path
 * @param {unknown} node the page's own `__data.json` node
 */
async function throughRouter(page, path, node) {
  await doorAnswers(page);
  await page.route(`**${path}/__data.json*`, (route) => answer(route, 200, { type: "data", nodes: [DOOR_LAYOUT, node] }));
  await page.goto(`${APP}/login`, { waitUntil: "load" });
  await page.waitForFunction(() => document.body.classList.contains("lit"));
  await page.evaluate((href) => {
    const link = Object.assign(document.createElement("a"), { href, id: "door-measure-go", textContent: "go" });
    document.body.append(link);
    link.click();
    link.remove();
  }, path);
  await page.waitForURL(`**${path}`);
}

/** @param {Page} page */
async function signInCard(page) {
  await doorAnswers(page, { availability: LOCAL_DOOR });
  await page.goto(`${APP}/login`, { waitUntil: "load" });
  await page.waitForSelector("#idemail");
}

/** @param {Page} page */
async function submitSignIn(page) {
  await page.fill("#idemail", "tom@lawson.example");
  await page.fill("#idpassword", "a fixture password");
  await page.click("#idbtn");
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
}

/**
 * `slug` is the screenshot folder and file stem; `name` is the test title
 * the measurement check has always used.
 * @type {{ name: string, slug: string, state: string, reach: (page: Page) => Promise<void>, defect?: Record<string, string> }[]}
 */
export const DOOR_STATES = [
  { name: "/ (the door, signed out)", slug: "door", state: "rest", reach: async (page) => {
    await doorAnswers(page);
    await page.goto(`${APP}/`, { waitUntil: "load" });
    await page.waitForSelector("#gate");
  } },
  { name: "/login (the door with `local login`)", slug: "login", state: "mixed", reach: async (page) => {
    await doorAnswers(page, { availability: MIXED_DOOR });
    await page.goto(`${APP}/login`, { waitUntil: "load" });
    await page.waitForSelector("#localopen");
  } },
  { name: "/login (local sign-in card)", slug: "login", state: "local-card", reach: signInCard },
  { name: "/login (sign-in card, typing)", slug: "login", state: "local-card-typing", reach: async (page) => {
    await signInCard(page);
    await page.fill("#idemail", "tom@lawson.example");
    await page.focus("#idpassword");
  } },
  { name: "/login (sign-in refused)", slug: "login", state: "refused", reach: async (page) => {
    await signInCard(page);
    await page.route("**/api/auth/local/login", (route) => answer(route, 401, { error: { code: "credentials_invalid" } }));
    await submitSignIn(page);
    await page.waitForSelector(".err.shown");
  } },
  { name: "/login (too many attempts)", slug: "login", state: "too-many", reach: async (page) => {
    await signInCard(page);
    await page.route("**/api/auth/local/login", (route) => answer(route, 429, { error: { code: "too_many_attempts" } }));
    await submitSignIn(page);
    await page.waitForSelector(".err.shown");
  } },
  { name: "/login (waiting for the email, countdown)", slug: "login", state: "waiting-countdown", reach: async (page) => {
    await signInCard(page);
    const canResendAt = new Date(Date.now() + 60_000).toISOString();
    await page.route("**/api/auth/local/login", (route) => answer(route, 200, { pending: { canResendAt, limited: false } }));
    await page.route("**/api/auth/local/login/pending", (route) => answer(route, 200, { state: "pending" }));
    await submitSignIn(page);
    await page.waitForSelector(".card.waiting");
  } },
  { name: "/login (waiting, send it again)", slug: "login", state: "waiting-resend", reach: async (page) => {
    await signInCard(page);
    const canResendAt = new Date(Date.now() - 1000).toISOString();
    await page.route("**/api/auth/local/login", (route) => answer(route, 200, { pending: { canResendAt, limited: false } }));
    await page.route("**/api/auth/local/login/pending", (route) => answer(route, 200, { state: "pending" }));
    await submitSignIn(page);
    await page.waitForSelector("#resendapproval");
  } },
  { name: "/login (claim code)", slug: "login", state: "claim-code", reach: async (page) => {
    await doorAnswers(page, { availability: UNCLAIMED_DOOR });
    await page.goto(`${APP}/login`, { waitUntil: "load" });
    await page.waitForSelector("#claimcode");
  } },
  { name: "/login (first administrator)", slug: "login", state: "first-administrator", reach: async (page) => {
    await doorAnswers(page, { availability: UNCLAIMED_DOOR });
    await page.route("**/api/auth/bootstrap/claim", (route) =>
      answer(route, 200, { claimed: false, methods: { local: true, oidc: true } }));
    await page.goto(`${APP}/login#claim=ABCD-EFGH-2345`, { waitUntil: "load" });
    await page.waitForSelector("#idname");
  } },
  { name: "/login (sign-in not set up)", slug: "login", state: "unconfigured", reach: async (page) => {
    await doorAnswers(page, { availability: { configured: false, phase: "running", contactAddress: null } });
    await page.goto(`${APP}/login`, { waitUntil: "load" });
    await page.waitForFunction(() => document.body.dataset.state === "unconfigured");
  } },
  { name: "/login (waking up)", slug: "login", state: "starting", reach: async (page) => {
    await doorAnswers(page, { availability: { configured: true, phase: "starting", contactAddress: null } });
    await page.goto(`${APP}/login`, { waitUntil: "load" });
    await page.waitForFunction(() => document.body.dataset.state === "starting");
  } },
  { name: "/login (couldn't open)", slug: "login", state: "failed", reach: async (page) => {
    await doorAnswers(page, { availability: null });
    await page.goto(`${APP}/login`, { waitUntil: "load" });
    await page.waitForFunction(() => document.body.dataset.state === "failed");
  } },
  { name: "/setup/<token>", slug: "setup", state: "rest", reach: async (page) => {
    await doorAnswers(page);
    await page.goto(`${APP}/setup/pocket-measure-placeholder-token`, { waitUntil: "load" });
    await page.waitForSelector("#idagain");
  } },
  { name: "/setup/<token> (link spent)", slug: "setup", state: "spent", reach: async (page) => {
    await doorAnswers(page);
    await page.route("**/api/auth/local/setup", (route) => answer(route, 400, { error: { code: "setup_token_invalid" } }));
    await page.goto(`${APP}/setup/pocket-measure-placeholder-token`, { waitUntil: "load" });
    await page.fill("#idpassword", "a fixture password");
    await page.fill("#idagain", "a fixture password");
    await page.click("#idbtn");
    await page.waitForSelector(".note.after .quietline");
  } },
  { name: "/approve/<token>", slug: "approve", state: "open", reach: async (page) => {
    await throughRouter(page, "/approve/pocket-measure-placeholder-token", {
      type: "data", uses: {},
      data: devalue({ token: "pocket-measure-placeholder-token", request: { ...APPROVAL, state: "open" } }),
    });
    await page.waitForSelector("#approveyes");
  } },
  { name: "/approve/<token> (spent)", slug: "approve", state: "spent", reach: async (page) => {
    await throughRouter(page, "/approve/pocket-measure-placeholder-token", {
      type: "data", uses: {}, data: devalue({ token: "pocket-measure-placeholder-token", request: null }),
    });
    await page.waitForSelector(".card.approve");
  } },
  { name: "/invite/<token> (used)", slug: "invite", state: "used", reach: async (page) => {
    await throughRouter(page, "/invite/pocket-measure-placeholder-token", {
      type: "data", uses: {}, data: devalue({ state: "used", inviterName: "Tom Lawson" }),
    });
    await page.waitForSelector(".invite-card .gate");
  } },
  { name: "/invite/<token> (someone else)", slug: "invite", state: "mismatch", reach: async (page) => {
    await throughRouter(page, "/invite/pocket-measure-placeholder-token", {
      type: "data", uses: {}, data: devalue({ state: "mismatch", inviterName: "Tom Lawson" }),
    });
    await page.waitForSelector(".invite-card .acts");
  } },
  { name: "/logout", slug: "logout", state: "rest", reach: async (page) => {
    await doorAnswers(page);
    await page.goto(`${APP}/logout`, { waitUntil: "load" });
    await page.waitForFunction(() => document.body.classList.contains("farewell"));
  } },
  { name: "404 (off the chart)", slug: "404", state: "rest", reach: async (page) => {
    await page.goto(`${APP}/pocket-measure-no-such-page`, { waitUntil: "load" });
    await page.waitForSelector(".line-b a");
  } },
  { name: "500 (Orbit stumbled)", slug: "500", state: "rest", reach: async (page) => {
    await throughRouter(page, "/approve/pocket-measure-placeholder-token",
      { type: "error", error: { message: "Internal Error" }, status: 500 });
    await page.waitForSelector(".stumble .line-b .again");
  } },
  { name: "/maintenance", slug: "maintenance", state: "rest", reach: async (page) => {
    await page.goto(`${APP}/maintenance`, { waitUntil: "load" });
    await page.waitForSelector(".earlier summary");
  } },
  { name: "/maintenance (earlier updates open)", slug: "maintenance", state: "earlier-open", reach: async (page) => {
    await page.goto(`${APP}/maintenance`, { waitUntil: "load" });
    await page.click(".earlier summary");
  } },
];
