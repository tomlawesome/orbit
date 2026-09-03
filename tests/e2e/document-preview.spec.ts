import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { syntheticPdf as createSyntheticPdf } from "../support/synthetic-documents";

const administrator = "Orbit Administrator";
const syntheticPdf = createSyntheticPdf("issue 476 document preview journey");

async function signIn(page: Page, identity: string) {
  await page.goto("/workspace");
  await page.getByRole("link", { name: "Sign in securely" }).click();
  await page.getByRole("link", { name: identity }).click();
  await expect(page).toHaveURL("/workspace");
}

interface DisposableWorkspace {
  householdId: string;
  sectionId: string;
  itemId: string;
  householdName: string;
  itemTitle: string;
}

function newDisposableWorkspace(): DisposableWorkspace {
  const suffix = randomUUID().slice(0, 8);
  return {
    householdId: randomUUID(),
    sectionId: randomUUID(),
    itemId: randomUUID(),
    householdName: `Issue 476 preview ${suffix}`,
    itemTitle: `Disposable preview item ${suffix}`,
  };
}

async function createDisposableWorkspace(page: Page, workspace: DisposableWorkspace) {
  const sessionResponse = await page.request.get("/api/auth/session");
  expect(sessionResponse.ok()).toBeTruthy();
  const session = await sessionResponse.json() as { csrfToken: string };
  const headers = {
    Origin: new URL(page.url()).origin,
    "X-CSRF-Token": session.csrfToken,
  };

  const householdResponse = await page.request.post("/api/workspace/commands", {
    headers,
    data: {
      type: "household.create",
      household: {
        id: workspace.householdId,
        name: workspace.householdName,
        timezone: "Europe/London",
        currency: "GBP",
        memberCount: 1,
        canManage: true,
        onboardingComplete: true,
        sections: [{ id: workspace.sectionId, name: "Documents", icon: "home", accent: "sage", visible: true }],
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
    data: { type: "household.activate", householdId: workspace.householdId },
  });
  expect(activateResponse.ok()).toBeTruthy();

  const itemResponse = await page.request.post("/api/workspace/commands", {
    headers,
    data: {
      type: "item.upsert",
      householdId: workspace.householdId,
      item: {
        id: workspace.itemId,
        sectionId: workspace.sectionId,
        title: workspace.itemTitle,
        currency: "GBP",
        status: "active",
        version: 1,
        updatedAt: new Date().toISOString(),
      },
    },
  });
  expect(itemResponse.ok()).toBeTruthy();
}

async function cleanupDisposableWorkspace(page: Page, workspace: DisposableWorkspace) {
  const sessionResponse = await page.request.get("/api/auth/session");
  if (!sessionResponse.ok()) throw new Error(`Could not read the authenticated session for cleanup (${sessionResponse.status()})`);
  const session = await sessionResponse.json() as { csrfToken: string };
  const url = `/api/households/${workspace.householdId}/lifecycle`;
  const headers = {
    Origin: new URL(page.url()).origin,
    "X-CSRF-Token": session.csrfToken,
  };
  const deletionResponse = await page.request.post(url, {
    headers,
    data: { action: "delete", confirmation: workspace.householdName },
  });
  if (deletionResponse.status() === 404) return;
  if (!deletionResponse.ok() && deletionResponse.status() !== 409) {
    throw new Error(`Could not schedule disposable household cleanup (${deletionResponse.status()})`);
  }

  const hardDeleteResponse = await page.request.post(url, {
    headers,
    data: { action: "hard_delete", confirmation: workspace.householdName },
  });
  if (hardDeleteResponse.status() === 404) return;
  if (!hardDeleteResponse.ok()) {
    throw new Error(`Could not permanently remove disposable household (${hardDeleteResponse.status()})`);
  }
}

test.describe("authenticated document preview", () => {
  test.describe.configure({ retries: 0 });

  test("renders a bounded page-one image for an uploaded document (#476)", async ({ page, isMobile }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");
    test.skip(isMobile, "The stateful authenticated journey uses one isolated desktop identity.");

    await signIn(page, administrator);
    const workspace = newDisposableWorkspace();
    let journeyFailed = false;
    try {
      await createDisposableWorkspace(page, workspace);
      await page.goto("/workspace");
      const itemCard = page.locator(".item-card").filter({ hasText: workspace.itemTitle });
      await expect(itemCard.locator(".item-main")).toBeVisible();
      await itemCard.locator(".item-main").click();

      const documentName = "preview-journey-document.pdf";
      const fileInput = page.locator('input[type="file"]').first();
      const uploadResponsePromise = page.waitForResponse((response) =>
        response.url().includes(`/api/households/${workspace.householdId}/items/${workspace.itemId}/documents`)
        && response.request().method() === "POST",
      );
      await fileInput.setInputFiles({ name: documentName, mimeType: "application/pdf", buffer: syntheticPdf });
      const uploadResponse = await uploadResponsePromise;
      expect(uploadResponse.status()).toBe(201);
      const uploadBody = await uploadResponse.json() as { document: { id: string } };
      const documentId = uploadBody.document.id;
      expect(documentId).toBeTruthy();

      const documentRow = page.getByRole("listitem").filter({ hasText: documentName });
      await expect(documentRow).toBeVisible();

      // The authenticated page context carries the same session cookie the
      // browser used to upload, so this is the same authorization boundary
      // the download endpoint enforces (#476).
      const previewResponse = await page.request.get(`/api/documents/${documentId}/preview`);
      expect(previewResponse.status()).toBe(200);
      const previewHeaders = previewResponse.headers();
      expect(["image/png", "image/jpeg"]).toContain(previewHeaders["content-type"]);
      expect(previewHeaders["cache-control"]).toContain("no-store");
      const previewBody = await previewResponse.body();
      // A trivial or empty body would mean a decode failure disguised as a
      // 200, so the size bound proves an actual rendered page came back.
      expect(previewBody.length).toBeGreaterThan(500);
    } catch (error) {
      journeyFailed = true;
      throw error;
    } finally {
      try {
        await cleanupDisposableWorkspace(page, workspace);
      } catch (cleanupError) {
        if (!journeyFailed) throw cleanupError;
      }
    }
  });

  test("words an unknown document id as not found, never as a picture (#476)", async ({ page }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");

    await signIn(page, administrator);
    const unknownDocumentId = randomUUID();
    const missingResponse = await page.request.get(`/api/documents/${unknownDocumentId}/preview`);
    expect(missingResponse.status()).toBe(404);
    expect(missingResponse.headers()["cache-control"]).toContain("no-store");
    expect(await missingResponse.json()).toEqual({
      error: { code: "document_not_found", message: "That document is not available" },
    });
  });
});
