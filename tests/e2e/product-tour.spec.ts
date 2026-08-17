import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

type ProductTourFixture = {
  householdId: string;
  householdName: string;
  itemId: string;
  itemTitle: string;
  documentName: string;
};

const fixedNow = "2026-08-08T10:00:00.000Z";
const outputDirectory = join(process.cwd(), "docs/assets/product-tour");
const generatedPdf = readFileSync(resolve(process.cwd(), "tests/support/fixtures/chromium-synthetic.pdf"));

function newFixture(): ProductTourFixture {
  return {
    householdId: randomUUID(),
    householdName: "Willow House",
    itemId: randomUUID(),
    itemTitle: "Boiler service",
    documentName: "boiler-service.pdf",
  };
}

async function signIn(page: Page) {
  await page.clock.install({ time: new Date(fixedNow) });
  await page.goto("/workspace");
  await page.getByRole("link", { name: "Sign in securely" }).click();
  await page.getByRole("link", { name: "Orbit Administrator" }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3000\/workspace$/);
}

async function sessionHeaders(page: Page) {
  const response = await page.request.get("/api/auth/session");
  expect(response.ok()).toBeTruthy();
  const payload = await response.json() as { csrfToken?: unknown };
  if (typeof payload.csrfToken !== "string" || payload.csrfToken.length === 0) {
    throw new Error("The synthetic browser session did not provide a CSRF token");
  }
  return {
    Origin: new URL(page.url()).origin,
    "X-CSRF-Token": payload.csrfToken,
  };
}

async function createFixture(page: Page, fixture: ProductTourFixture) {
  const headers = await sessionHeaders(page);
  const sectionIds = {
    home: randomUUID(),
    vehicle: randomUUID(),
    service: randomUUID(),
  } as const;
  const sections = [
    { id: sectionIds.home, name: "Home", icon: "home", accent: "sage", visible: true },
    { id: sectionIds.vehicle, name: "Vehicles", icon: "vehicle", accent: "blue", visible: true },
    { id: sectionIds.service, name: "Services", icon: "service", accent: "plum", visible: true },
  ] as const;
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
        sections,
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

  const items = [
    {
      id: fixture.itemId,
      sectionId: sectionIds.home,
      title: fixture.itemTitle,
      subtype: "Annual service",
      provider: "Warm & Co.",
      reference: "HOME-2026",
      costMinor: 10900,
      currency: "GBP",
      dueDate: "2026-08-15",
      scheduleKind: "service",
      recurrenceMonths: 12,
      reminderDays: [14, 3],
      notes: "Annual check for the main home system.",
      status: "active",
      version: 1,
      updatedAt: fixedNow,
    },
    {
      id: randomUUID(),
      sectionId: sectionIds.vehicle,
      title: "Car insurance",
      subtype: "Annual renewal",
      provider: "Harbour Mutual",
      reference: "VEHICLE-2026",
      costMinor: 58200,
      currency: "GBP",
      dueDate: "2026-09-01",
      scheduleKind: "renewal",
      recurrenceMonths: 12,
      reminderDays: [30, 7],
      status: "active",
      version: 1,
      updatedAt: fixedNow,
    },
    {
      id: randomUUID(),
      sectionId: sectionIds.service,
      title: "Broadband contract",
      subtype: "Contract",
      provider: "HyperNet",
      reference: "HOME-CONNECT",
      costMinor: 4200,
      currency: "GBP",
      dueDate: "2026-10-01",
      scheduleKind: "renewal",
      recurrenceMonths: 18,
      reminderDays: [30, 7],
      status: "active",
      version: 1,
      updatedAt: fixedNow,
    },
  ];

  for (const item of items) {
    const response = await page.request.post("/api/workspace/commands", {
      headers,
      data: { type: "item.upsert", householdId: fixture.householdId, item },
    });
    if (!response.ok()) {
      const payload = await response.json().catch(() => ({})) as { error?: { code?: unknown } };
      const code = typeof payload.error?.code === "string" ? payload.error.code : "unknown";
      throw new Error(`Synthetic item fixture was rejected (${response.status()}, ${code})`);
    }
  }

  await page.reload();
  await expect(page.getByRole("heading", { name: fixture.itemTitle, exact: true }).first()).toBeVisible();
}

async function attachSyntheticDocument(page: Page, fixture: ProductTourFixture) {
  await page.getByRole("button", { name: `Open ${fixture.itemTitle}`, exact: true }).first().click();
  await page.locator('input[type="file"]').first().setInputFiles({
    name: fixture.documentName,
    mimeType: "application/pdf",
    buffer: generatedPdf,
  });
  const documentRow = page.getByRole("listitem").filter({ hasText: fixture.documentName });
  await expect(documentRow).toBeVisible();
  await expect(documentRow).toContainText("application/pdf");
}

async function installSyntheticMailbox(page: Page, fixture: ProductTourFixture) {
  await page.route("**/api/imap-inbox", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        receipts: [{
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          status: "pending_review",
          householdId: fixture.householdId,
          draftVersion: 1,
          expiresAt: "2026-08-09T10:00:00.000Z",
          receivedAt: fixedNow,
          attachmentCount: 1,
          classification: "ready",
          canApprove: true,
          canDiscard: true,
          message: "Synthetic mailbox item ready for review.",
          proposal: { title: fixture.itemTitle, provider: "Warm & Co.", reference: "HOME-2026", currency: "GBP" },
          fieldEvidence: {},
        }],
        households: [{ id: fixture.householdId, name: fixture.householdName, currency: "GBP" }],
      }),
    });
  });
}

async function removeFixture(page: Page, fixture: ProductTourFixture) {
  const headers = await sessionHeaders(page);
  const response = await page.request.post(`/api/households/${fixture.householdId}/lifecycle`, {
    headers,
    data: { action: "delete", confirmation: fixture.householdName },
  });
  if (response.status() === 404) return;
  if (!response.ok() && response.status() !== 409) {
    throw new Error(`Could not schedule product-tour fixture cleanup (${response.status()})`);
  }
  const hardDelete = await page.request.post(`/api/households/${fixture.householdId}/lifecycle`, {
    headers,
    data: { action: "hard_delete", confirmation: fixture.householdName },
  });
  if (hardDelete.status() !== 404 && !hardDelete.ok()) {
    throw new Error(`Could not remove product-tour fixture (${hardDelete.status()})`);
  }
}

/** Keep only PNG image chunks; screenshots must not retain textual or EXIF metadata. */
function stripPngMetadata(path: string) {
  const source = readFileSync(path);
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  if (!source.subarray(0, signature.length).equals(signature)) throw new Error("Product-tour capture was not a PNG");

  const chunks: Buffer[] = [signature];
  let offset = signature.length;
  while (offset < source.length) {
    if (offset + 12 > source.length) throw new Error("Product-tour PNG has a truncated chunk");
    const length = source.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > source.length) throw new Error("Product-tour PNG has an invalid chunk length");
    const type = source.subarray(offset + 4, offset + 8).toString("ascii");
    if (["IHDR", "PLTE", "IDAT", "IEND"].includes(type)) chunks.push(source.subarray(offset, end));
    offset = end;
  }
  if (offset !== source.length) throw new Error("Product-tour PNG has trailing data");
  writeFileSync(path, Buffer.concat(chunks));
}

test.describe("product tour screenshot capture", () => {
  test.skip(process.env.ORBIT_CAPTURE_PRODUCT_TOUR !== "true", "Opt-in capture; ordinary browser suites do not write documentation assets.");

  test("captures synthetic desktop application surfaces", async ({ page, isMobile }) => {
    test.skip(isMobile, "Documentation captures use the desktop layout only.");
    const fixture = newFixture();
    mkdirSync(outputDirectory, { recursive: true });

    await signIn(page);
    try {
      await createFixture(page, fixture);
      await page.screenshot({ path: join(outputDirectory, "overview.png"), animations: "disabled" });

      await attachSyntheticDocument(page, fixture);
      await expect(page.getByRole("dialog", { name: fixture.itemTitle })).toBeVisible();
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({ path: join(outputDirectory, "item-detail.png"), animations: "disabled" });

      await page.setViewportSize({ width: 1280, height: 720 });
      await installSyntheticMailbox(page, fixture);
      await page.goto("/settings");
      await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
      await page.screenshot({ path: join(outputDirectory, "settings.png"), animations: "disabled" });

      await page.getByRole("link", { name: "Inbox", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Incoming documents", exact: true })).toBeVisible();
      await expect(page.getByText("Synthetic mailbox item ready for review.", { exact: true })).toBeVisible();
      await page.screenshot({ path: join(outputDirectory, "inbox.png"), animations: "disabled" });

      for (const file of ["overview.png", "item-detail.png", "settings.png", "inbox.png"]) {
        stripPngMetadata(join(outputDirectory, file));
      }
    } finally {
      await removeFixture(page, fixture);
    }
  });
});
