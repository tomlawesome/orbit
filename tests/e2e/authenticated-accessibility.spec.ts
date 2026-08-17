import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

type AccessibilityFixture = {
  householdId: string;
  sectionId: string;
  itemId: string;
  householdName: string;
  itemTitle: string;
};

type ThemePreference = {
  mode: "system" | "light" | "dark";
  colourway: "after-dark" | "verdant" | "coast";
  textSize: "standard" | "comfortable" | "large" | "extra-large";
  urgencyPalette: "themed";
  emailNotifications: true;
  pushNotifications: true;
};

const axeTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const syntheticReceiptId = "11111111-1111-4111-8111-111111111111";
const syntheticAttachmentId = "22222222-2222-4222-8222-222222222222";
const syntheticDocumentId = "33333333-3333-4333-8333-333333333333";
const syntheticDraftId = "44444444-4444-4444-8444-444444444444";
const syntheticPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function newFixture(): AccessibilityFixture {
  const suffix = randomUUID().slice(0, 8);
  return {
    householdId: randomUUID(),
    sectionId: randomUUID(),
    itemId: randomUUID(),
    householdName: `Accessibility ${suffix}`,
    itemTitle: `Accessible item ${suffix}`,
  };
}

async function signIn(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("link", { name: "Sign in securely" }).click();
  await page.getByRole("link", { name: "Orbit Administrator" }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3000\/workspace$/);
}

async function sessionHeaders(page: Page) {
  const sessionResponse = await page.request.get("/api/auth/session");
  expect(sessionResponse.ok()).toBeTruthy();
  const { csrfToken } = await sessionResponse.json() as { csrfToken: string };
  return {
    Origin: new URL(page.url()).origin,
    "X-CSRF-Token": csrfToken,
  };
}

async function createFixture(page: Page, fixture: AccessibilityFixture) {
  const headers = await sessionHeaders(page);
  const householdResponse = await page.request.post("/api/workspace/commands", {
    headers,
    data: {
      type: "household.create",
      household: {
        id: fixture.householdId,
        name: fixture.householdName,
        timezone: "Europe/London",
        currency: "GBP",
        memberCount: 1,
        canManage: true,
        onboardingComplete: true,
        sections: [{
          id: fixture.sectionId,
          name: "Accessibility",
          icon: "home",
          accent: "sage",
          visible: true,
        }],
        items: [],
        activities: [],
        readNotificationIds: [],
        dismissedNotificationIds: [],
      },
    },
  });
  expect(householdResponse.ok()).toBeTruthy();

  const activateResponse = await page.request.post("/api/workspace/commands", {
    headers,
    data: { type: "household.activate", householdId: fixture.householdId },
  });
  expect(activateResponse.ok()).toBeTruthy();

  const itemResponse = await page.request.post("/api/workspace/commands", {
    headers,
    data: {
      type: "item.upsert",
      householdId: fixture.householdId,
      item: {
        id: fixture.itemId,
        sectionId: fixture.sectionId,
        title: fixture.itemTitle,
        currency: "GBP",
        status: "active",
        version: 1,
        updatedAt: new Date().toISOString(),
      },
    },
  });
  expect(itemResponse.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("heading", { name: fixture.itemTitle, exact: true })).toBeVisible();
}

async function cleanupFixture(page: Page, fixture: AccessibilityFixture) {
  const headers = await sessionHeaders(page);
  const url = `/api/households/${fixture.householdId}/lifecycle`;
  const schedule = await page.request.post(url, {
    headers,
    data: { action: "delete", confirmation: fixture.householdName },
  });
  if (schedule.status() === 404) return;
  if (!schedule.ok() && schedule.status() !== 409) {
    throw new Error(`Could not schedule accessibility fixture cleanup (${schedule.status()})`);
  }
  const remove = await page.request.post(url, {
    headers,
    data: { action: "hard_delete", confirmation: fixture.householdName },
  });
  if (remove.status() !== 404 && !remove.ok()) {
    throw new Error(`Could not remove accessibility fixture (${remove.status()})`);
  }
}

async function withFixture(
  page: Page,
  run: (fixture: AccessibilityFixture) => Promise<void>,
) {
  const fixture = newFixture();
  await signIn(page);
  await createFixture(page, fixture);
  try {
    await run(fixture);
  } finally {
    await cleanupFixture(page, fixture);
  }
}

async function expectNoAxeViolations(page: Page, include: string) {
  const results = await new AxeBuilder({ page }).include(include).withTags(axeTags).analyze();
  expect(results.violations, `Expected no WCAG A/AA violations in ${include}`).toEqual([]);
}

async function openSettings(page: Page) {
  const desktopTrigger = page.locator("button.topbar-profile:visible");
  if (await desktopTrigger.count()) {
    await desktopTrigger.click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "Personalise", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/settings$/);
  const settingsPage = page.locator(".settings-page");
  await expect(settingsPage).toBeVisible();
  return settingsPage;
}

async function openItemEditor(page: Page) {
  await page.locator("button.add-button:visible, button.mobile-add:visible").first().click();
  const dialog = page.getByRole("dialog", { name: "Add an item" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("What do you want to keep track of?")).toBeFocused();
  return dialog;
}

async function openItemDetail(page: Page, fixture: AccessibilityFixture) {
  const row = page.locator("article.item-card").filter({
    has: page.getByRole("heading", { name: fixture.itemTitle, exact: true }),
  });
  await row.locator("button.more-button").click();
  const dialog = page.getByRole("dialog", { name: fixture.itemTitle });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: fixture.itemTitle, exact: true })).toBeFocused();
  return { dialog, trigger: row.locator("button.more-button") };
}

async function openNotifications(page: Page) {
  const trigger = page.locator("header.topbar")
    .getByRole("button", { name: /^Notifications(?:,|$)/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Notifications" });
  await expect(dialog).toBeVisible();
  return { dialog, trigger };
}

async function stubMailboxReview(page: Page, fixture: AccessibilityFixture) {
  const receipt = {
    id: syntheticReceiptId,
    status: "pending_review",
    householdId: fixture.householdId,
    draftVersion: 1,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    receivedAt: new Date().toISOString(),
    attachmentCount: 1,
    classification: "ready",
    canApprove: true,
    canDiscard: true,
    message: "Synthetic review is ready.",
    proposal: {
      title: "Synthetic suggested title",
      provider: "Synthetic provider",
      reference: "SYNTHETIC-123",
      currency: "GBP",
    },
    fieldEvidence: { title: { source: "parser", confidence: "medium" } },
  };
  await page.route("**/api/imap-inbox", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        receipts: [receipt],
        households: [{ id: fixture.householdId, name: fixture.householdName, currency: "GBP" }],
      }),
    });
  });
  await page.route("**/api/imap-inbox/*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        receipt,
        sections: [{ id: fixture.sectionId, name: "Accessibility" }],
        candidates: [{
          itemId: fixture.itemId,
          title: fixture.itemTitle,
          reason: "matching provider",
        }],
        attachments: [{
          id: syntheticAttachmentId,
          ordinal: 1,
          mediaType: "application/pdf",
          sizeBytes: 128,
        }],
      }),
    });
  });
}

async function stubDocumentReview(page: Page, fixture: AccessibilityFixture) {
  await page.route(
    `**/api/households/${fixture.householdId}/items/${fixture.itemId}/documents`,
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          documents: [{
            id: syntheticDocumentId,
            itemId: fixture.itemId,
            displayName: "synthetic-accessibility.pdf",
            mediaType: "application/pdf",
            sizeBytes: 128,
            lifecycle: "available",
            scanStatus: "clean",
            availableAt: new Date().toISOString(),
            deleteAfter: null,
            ready: true,
            failureCode: null,
          }],
        }),
      });
    },
  );
  await page.route("**/api/documents/*/draft", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        draft: {
          id: syntheticDraftId,
          proposal: {
            title: "Synthetic reviewed title",
            provider: "Synthetic provider",
            reference: "SYNTHETIC-456",
          },
          evidence: { excerpt: "Synthetic bounded review evidence." },
          duplicates: [],
        },
      }),
    });
  });
}

/**
 * Mirrors src/lib/preferences.ts `legacyToThemePack` (#325): the DOM no
 * longer exposes the pre-#325 (mode, colourway, urgencyPalette) triple
 * directly — `data-theme` carries the resolved v19 pack id, and mode/
 * urgency-palette have no DOM representation at all, because the four
 * theme packs each already bake in a fixed light/dark scheme and a flat,
 * non-switchable status-colour set. Duplicated here (rather than imported)
 * because Playwright's test bundle does not resolve the app's `@/*` path
 * alias; kept in lockstep with the production mapping's documented table.
 */
function resolveThemePack(colourway: string, mode: string): "starchart" | "afterdark" | "atlas" | "dawn" {
  const dark = mode === "dark";
  switch (colourway) {
    case "after-dark":
      return "afterdark";
    case "coast":
      return dark ? "afterdark" : "dawn";
    case "verdant":
      return dark ? "starchart" : "atlas";
    case "ember":
      return dark ? "starchart" : "atlas";
    case "berry":
      return dark ? "afterdark" : "dawn";
    default:
      return "starchart";
  }
}

async function setThemePreference(page: Page, preference: ThemePreference) {
  await page.evaluate((value) => {
    localStorage.setItem("orbit:theme:v1", JSON.stringify(value));
    window.dispatchEvent(new CustomEvent("orbit:preference-change", { detail: "orbit:theme:v1" }));
  }, preference);
  await expect(page.locator(".app-frame"))
    .toHaveAttribute("data-text-size", preference.textSize);
  await expect(page.locator(".app-frame"))
    .toHaveAttribute("data-theme", resolveThemePack(preference.colourway, preference.mode));
}

async function expectAdminTheme(page: Page, preference: ThemePreference) {
  const admin = page.locator(".admin-page");
  await expect(admin).toHaveAttribute("data-text-size", preference.textSize);
  await expect(admin).toHaveAttribute("data-theme", resolveThemePack(preference.colourway, preference.mode));
}

async function expectNoHorizontalOverflow(page: Page, context: string) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    dimensions.scrollWidth,
    `${context} should not create document-level horizontal overflow`,
  ).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectInsideViewport(page: Page, selector: string, context: string) {
  const locator = page.locator(selector);
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box, `${context} should have a visible bounding box`).not.toBeNull();
  expect(viewport, `${context} should have a configured viewport`).not.toBeNull();
  if (!box || !viewport) return;
  expect(box.x, `${context} should not begin outside the viewport`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${context} should not end outside the viewport`)
    .toBeLessThanOrEqual(viewport.width);
}

async function expectCoreSurfacesFit(
  page: Page,
  fixture: AccessibilityFixture,
  context: string,
) {
  const settings = await openSettings(page);
  await expectNoHorizontalOverflow(page, `${context}/settings`);
  await expectInsideViewport(page, ".settings-page", `${context} settings page`);
  await page.keyboard.press("Escape");
  // See navigateHomeWithFocus (#410, §15): openSettings() above reached
  // settings from this engine's own workspace, so that is where it returns.
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(settings).not.toBeVisible();
  if ((page.viewportSize()?.width ?? 0) <= 820) {
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
    await expect(page.locator(".sidebar")).toHaveCSS("visibility", "hidden");
  } else {
    await expect(page.getByRole("button", { name: "Open account menu" })).toBeFocused();
  }

  const editor = await openItemEditor(page);
  await expectNoHorizontalOverflow(page, `${context}/item-editor`);
  await expectInsideViewport(page, ".item-editor", `${context} item editor`);
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();

  const detail = await openItemDetail(page, fixture);
  await expectNoHorizontalOverflow(page, `${context}/item-detail`);
  await expectInsideViewport(page, ".item-detail", `${context} item detail`);
  await page.keyboard.press("Escape");
  await expect(detail.dialog).toBeHidden();

  const notifications = await openNotifications(page);
  await expectNoHorizontalOverflow(page, `${context}/notifications`);
  await expectInsideViewport(page, ".notification-center", `${context} notification centre`);
  await expect(notifications.dialog.getByRole("heading", { name: "Notifications" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(notifications.dialog).toBeHidden();
}

test.describe("authenticated accessibility and responsive acceptance", () => {
  test("provides an accessible desktop account menu with explicit sign-out", async ({ page, isMobile }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    test.skip(isMobile, "The account control is desktop-only; mobile navigation remains unchanged.");

    const fixture = newFixture();
    let cleanupRequired = false;
    try {
      await signIn(page);
      cleanupRequired = true;
      await createFixture(page, fixture);
      const trigger = page.getByRole("button", { name: "Open account menu" });
      const menu = page.getByRole("menu", { name: "Account menu" });
      await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(menu).toHaveCount(0);

      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem")).toHaveCount(3);
      await expect(menu.getByRole("menuitem", { name: "Settings", exact: true })).toBeFocused();
      await expectNoAxeViolations(page, ".account-menu-popup");

      await page.keyboard.press("ArrowDown");
      await expect(menu.getByRole("menuitem", { name: "Administration", exact: true })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(menu.getByRole("menuitem", { name: "Sign out", exact: true })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(menu.getByRole("menuitem", { name: "Settings", exact: true })).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(menu.getByRole("menuitem", { name: "Sign out", exact: true })).toBeFocused();
      await page.keyboard.press("Home");
      await expect(menu.getByRole("menuitem", { name: "Settings", exact: true })).toBeFocused();
      await page.keyboard.press("End");
      await expect(menu.getByRole("menuitem", { name: "Sign out", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();

      await trigger.click();
      await page.locator("header.topbar .search").click();
      await expect(menu).toBeHidden();
      await expect(page.getByRole("heading", { name: "Sign in to Orbit." })).toHaveCount(0);

      await trigger.click();
      await expect(menu.getByRole("menuitem", { name: "Settings", exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(menu).toBeHidden();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("button", { name: "Add item", exact: true })).toBeFocused();

      await trigger.click();
      await menu.getByRole("menuitem", { name: "Administration", exact: true }).click();
      await expect(page).toHaveURL(/\/admin$/);
      await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();

      await page.goto("/workspace");
      await expect(trigger).toBeVisible();
      await trigger.click();
      await expect(menu.getByRole("menuitem", { name: "Settings", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("heading", { name: "Sign in to Orbit." })).toHaveCount(0);
      await trigger.click();
      await expect(menu.getByRole("menuitem", { name: "Settings", exact: true })).toBeFocused();
      await cleanupFixture(page, fixture);
      cleanupRequired = false;
      await menu.getByRole("menuitem", { name: "Sign out", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Sign in to Orbit." })).toBeVisible();
    } finally {
      if (cleanupRequired) {
        await cleanupFixture(page, fixture);
      }
    }
  });

  test("has no automated WCAG A or AA violations across core authenticated surfaces", async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    await withFixture(page, async (fixture) => {
      await expectNoAxeViolations(page, ".app-frame");

      const editor = await openItemEditor(page);
      await expectNoAxeViolations(page, ".item-editor");
      await editor.getByRole("button", { name: "Close item editor" }).click();

      await stubDocumentReview(page, fixture);
      const detail = await openItemDetail(page, fixture);
      await expectNoAxeViolations(page, ".item-detail");
      await detail.dialog.getByRole("button", { name: "Review as draft" }).click();
      await expect(page.getByRole("region", { name: "Review extracted draft" })).toBeVisible();
      await expectNoAxeViolations(page, ".detail-action-panel");
      await detail.dialog.getByRole("button", { name: "Close item details" }).click();

      const notifications = await openNotifications(page);
      await expectNoAxeViolations(page, ".notification-center");
      await notifications.dialog.getByRole("button", { name: "Close notifications" }).click();

      await stubMailboxReview(page, fixture);
      const settings = await openSettings(page);
      await expectNoAxeViolations(page, ".settings-page");
      await expect(settings.getByRole("tablist")).toHaveCount(0);
      await expect(settings.getByRole("tab")).toHaveCount(0);
      for (const sectionName of ["Appearance", "Your data", "Inbox", "Household", "Sections", "Members"]) {
        await expect(settings.getByRole("region", { name: sectionName, exact: true })).toBeVisible();
      }
      await expect(settings.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
      await settings.getByRole("link", { name: "Inbox", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Incoming documents" })).toBeVisible();
      await expectNoAxeViolations(page, ".settings-page");
      await page.getByRole("button", { name: "Review", exact: true }).click();
      await expect(page.getByRole("region", { name: "Check every value before saving" })).toBeVisible();
      await expectNoAxeViolations(page, ".imap-review");
      await page.goto("/admin");
      await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
      await expectNoAxeViolations(page, ".admin-page");
    });
  });

  test("applies persisted appearance to a fresh direct administration load and wraps its heading", async ({ page, browser, isMobile }) => {
    test.setTimeout(90_000);
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    test.skip(isMobile, "One browser context runs the narrow administration layout matrix.");
    await withFixture(page, async () => {
      const sessionResponse = await page.request.get("/api/auth/session");
      expect(sessionResponse.ok()).toBeTruthy();
      const sessionPayload = await sessionResponse.json() as {
        user: {
          themeMode: ThemePreference["mode"];
          themeId: ThemePreference["colourway"];
          textSize: ThemePreference["textSize"];
          urgencyPalette: ThemePreference["urgencyPalette"];
        };
      };
      const sessionPreference = {
        mode: sessionPayload.user.themeMode,
        colourway: sessionPayload.user.themeId,
        textSize: sessionPayload.user.textSize,
        urgencyPalette: sessionPayload.user.urgencyPalette,
      };
      const authenticatedState = await page.context().storageState();
      const directContext = await browser.newContext({
        storageState: { cookies: authenticatedState.cookies, origins: [] },
      });
      const directPage = await directContext.newPage();
      try {
        await directPage.goto(new URL("/admin", page.url()).toString());
        await expectAdminTheme(directPage, {
          ...sessionPreference,
          emailNotifications: true,
          pushNotifications: true,
        });
      } finally {
        await directContext.close();
      }

      const textSizes: ThemePreference["textSize"][] = [
        "standard",
        "comfortable",
        "large",
        "extra-large",
      ];
      for (const textSize of textSizes) {
        await page.setViewportSize({ width: 320, height: 900 });
        const preference: ThemePreference = {
          mode: "dark",
          colourway: "coast",
          textSize,
          urgencyPalette: "themed",
          emailNotifications: true,
          pushNotifications: true,
        };
        await page.goto("/workspace");
        await setThemePreference(page, preference);
        await page.goto("/admin");
        await expectAdminTheme(page, preference);
        const heading = page.getByRole("heading", { name: "Manage this Orbit instance", exact: true });
        await expect(heading).toBeVisible();
        const metrics = await heading.evaluate((element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return {
            fontSize: Number.parseFloat(style.fontSize),
            lineHeight: Number.parseFloat(style.lineHeight),
            letterSpacing: Number.parseFloat(style.letterSpacing),
            height: rect.height,
            width: rect.width,
            scrollWidth: element.scrollWidth,
          };
        });
        expect(metrics.lineHeight).toBeGreaterThan(metrics.fontSize);
        expect(metrics.letterSpacing).toBeGreaterThan(-2.8);
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width);
        expect(metrics.height).toBeGreaterThan(metrics.lineHeight);
      }
    });
  });

  test("contains keyboard focus and returns it to each core invoking control", async ({ page, isMobile }) => {
    test.setTimeout(60_000);
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    test.skip(isMobile, "Desktop provides the representative physical-keyboard focus journey.");
    await withFixture(page, async (fixture) => {
      const settingsTrigger = page.getByRole("button", { name: "Open account menu" });
      await settingsTrigger.focus();
      await settingsTrigger.click();
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
      await expect(page).toHaveURL(/\/settings$/);
      const settingsHeading = page.getByRole("heading", { name: "Settings" });
      await expect(settingsHeading).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      const returnButton = page.getByRole("button", { name: /Return to Orbit/ });
      expect(await returnButton.evaluate((element) => element.contains(document.activeElement) || element === document.activeElement)).toBe(true);
      await page.keyboard.press("Escape");
      // "/" is v19's own front door now (#410, §15): this engine's settings
      // returns to whichever of its own screens sent it here — /workspace,
      // reached moments ago through the account menu below — not to "/".
      await expect(page).toHaveURL(/\/workspace$/);
      await expect(settingsTrigger).toBeFocused();

      await settingsTrigger.click();
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(settingsHeading).toBeFocused();
      const inboxLink = page.getByRole("link", { name: "Inbox", exact: true });
      await inboxLink.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/settings#settings-inbox$/);
      await expect(page.getByRole("heading", { name: "Inbox", exact: true, level: 2 })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(/\/workspace$/);
      await expect(settingsTrigger).toBeFocused();

      const addTrigger = page.locator("button.add-button:visible");
      await addTrigger.focus();
      await addTrigger.click();
      const editor = page.getByRole("dialog", { name: "Add an item" });
      await expect(editor.getByLabel("What do you want to keep track of?")).toBeFocused();
      await editor.getByRole("button", { name: "Close item editor" }).focus();
      await page.keyboard.press("Shift+Tab");
      expect(await editor.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(addTrigger).toBeFocused();

      const detail = await openItemDetail(page, fixture);
      await expect(detail.dialog.getByRole("heading", { name: fixture.itemTitle })).toBeFocused();
      const cameraInput = detail.dialog.locator('input[capture="environment"]');
      await expect(cameraInput).toHaveAttribute("accept", "image/jpeg,image/png");
      await cameraInput.focus();
      await cameraInput.setInputFiles({
        name: "hostile-camera.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      });
      await expect(detail.dialog.getByRole("alert")).toHaveText("Choose a JPEG or PNG photo from your camera.");
      await expect(page.getByRole("dialog", { name: "Review captured photo" })).toBeHidden();
      await cameraInput.setInputFiles({
        name: "synthetic-camera.png",
        mimeType: "image/png",
        buffer: syntheticPng,
      });
      const captureReview = page.getByRole("dialog", { name: "Review captured photo" });
      await expect(captureReview.getByRole("button", { name: "Rotate" })).toBeFocused();
      await expect(captureReview.getByRole("img", { name: "Captured document preview" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Close captured photo review" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(captureReview).toBeHidden();
      await expect(cameraInput).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(detail.trigger).toBeFocused();

      const notifications = await openNotifications(page);
      await expect(notifications.dialog.getByRole("heading", { name: "Notifications" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(notifications.trigger).toBeFocused();
      await expect(notifications.trigger).toHaveCSS("outline-style", "solid");
      await expect(notifications.trigger).toHaveCSS("outline-width", "3px");
    });
  });

  test("opens the Inbox section and focuses its heading from a deep link", async ({ page }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    await withFixture(page, async () => {
      await page.goto("/settings?open=inbox");
      await expect(page).toHaveURL(/\/settings\?open=inbox$/);
      await expect(page.getByRole("heading", { name: "Inbox", exact: true, level: 2 })).toBeFocused();
    });
  });

  test("fits core surfaces across viewports, text sizes and representative themes", async ({ page, isMobile }) => {
    test.setTimeout(120_000);
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    test.skip(isMobile, "One browser context runs the explicit desktop, tablet and phone matrix.");
    await withFixture(page, async (fixture) => {
      const viewports = [
        { name: "desktop", width: 1440, height: 900 },
        { name: "tablet", width: 820, height: 1180 },
        { name: "phone", width: 412, height: 915 },
      ];
      const textSizes: ThemePreference["textSize"][] = [
        "standard",
        "comfortable",
        "large",
        "extra-large",
      ];
      for (const viewport of viewports) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        for (const textSize of textSizes) {
          await setThemePreference(page, {
            mode: "light",
            colourway: "after-dark",
            textSize,
            urgencyPalette: "themed",
            emailNotifications: true,
            pushNotifications: true,
          });
          await expectNoHorizontalOverflow(page, `${viewport.name}/${textSize}`);
          await expectCoreSurfacesFit(page, fixture, `${viewport.name}/${textSize}`);
        }
        for (const preference of [
          { mode: "dark", colourway: "after-dark" },
          { mode: "light", colourway: "verdant" },
          { mode: "system", colourway: "coast" },
        ] as const) {
          await setThemePreference(page, {
            ...preference,
            textSize: "extra-large",
            urgencyPalette: "themed",
            emailNotifications: true,
            pushNotifications: true,
          });
          await expectNoHorizontalOverflow(
            page,
            `${viewport.name}/${preference.mode}/${preference.colourway}`,
          );
          if (viewport.name === "desktop") {
            // --canvas was the pre-#325 page-background token; the v19 theme
            // packs (src/app/theme-tokens.css) expose it as --bg instead.
            const workspaceThemeTokens = await page.locator(".app-frame").evaluate((element) => {
              const style = window.getComputedStyle(element);
              return ["--bg", "--ink", "--text-bump"].map((name) => style.getPropertyValue(name).trim());
            });
            expect(workspaceThemeTokens.every((value) => value.length > 0)).toBe(true);
            const settings = await openSettings(page);
            const settingsThemeTokens = await settings.evaluate((element) => {
              const style = window.getComputedStyle(element);
              return ["--bg", "--ink", "--text-bump"].map((name) => style.getPropertyValue(name).trim());
            });
            expect(settingsThemeTokens).toEqual(workspaceThemeTokens);
            await page.keyboard.press("Escape");
            await expect(page).toHaveURL(/\/workspace$/);
          }
        }
      }
    });
  });
});
