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
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in securely" }).click();
  await page.getByRole("link", { name: "Orbit Administrator" }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3000\/$/);
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
  } else {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "Personalise", exact: true }).click();
  }
  const dialog = page.getByRole("dialog", { name: "Personalise Orbit" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openItemEditor(page: Page) {
  await page.locator("button.add-button:visible, button.mobile-add:visible").first().click();
  const dialog = page.getByRole("dialog", { name: "Add an item" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openItemDetail(page: Page, fixture: AccessibilityFixture) {
  const row = page.locator("article.item-card").filter({
    has: page.getByRole("heading", { name: fixture.itemTitle, exact: true }),
  });
  await row.locator("button.more-button").click();
  const dialog = page.getByRole("dialog", { name: fixture.itemTitle });
  await expect(dialog).toBeVisible();
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

async function setThemePreference(page: Page, preference: ThemePreference) {
  await page.evaluate((value) => {
    localStorage.setItem("orbit:theme:v1", JSON.stringify(value));
    window.dispatchEvent(new CustomEvent("orbit:preference-change", { detail: "orbit:theme:v1" }));
  }, preference);
  await expect(page.locator(".app-frame"))
    .toHaveAttribute("data-text-size", preference.textSize);
  await expect(page.locator(".app-frame"))
    .toHaveAttribute("data-mode", preference.mode);
  await expect(page.locator(".app-frame"))
    .toHaveAttribute("data-theme", preference.colourway);
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
  await expectInsideViewport(page, ".settings-drawer", `${context} settings drawer`);
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  if ((page.viewportSize()?.width ?? 0) <= 820) {
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
    await expect(page.locator(".sidebar")).toHaveCSS("visibility", "hidden");
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
  await page.keyboard.press("Escape");
  await expect(notifications.dialog).toBeHidden();
}

test.describe("authenticated accessibility and responsive acceptance", () => {
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
      await expectNoAxeViolations(page, ".settings-drawer");
      await settings.getByRole("tab", { name: "Inbox" }).click();
      await expect(page.getByRole("heading", { name: "Incoming documents" })).toBeVisible();
      await expectNoAxeViolations(page, ".settings-drawer");
      await page.getByRole("button", { name: "Review", exact: true }).click();
      await expect(page.getByRole("region", { name: "Check every value before saving" })).toBeVisible();
      await expectNoAxeViolations(page, ".imap-review");
      await settings.getByRole("tab", { name: "Admin" }).click();
      await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
      await expectNoAxeViolations(page, ".settings-drawer");
    });
  });

  test("contains keyboard focus and returns it to each core invoking control", async ({ page, isMobile }) => {
    test.setTimeout(60_000);
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    test.skip(isMobile, "Desktop provides the representative physical-keyboard focus journey.");
    await withFixture(page, async (fixture) => {
      const settingsTrigger = page.getByRole("button", { name: "Open personalisation settings" });
      await settingsTrigger.focus();
      await settingsTrigger.click();
      const settings = page.getByRole("dialog", { name: "Personalise Orbit" });
      await expect(settings.getByRole("heading", { name: "Personalise Orbit" })).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      expect(await settings.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Escape");
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
        }
      }
    });
  });
});
