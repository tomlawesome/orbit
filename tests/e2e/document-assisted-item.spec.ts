import { expect, test, type Locator, type Page } from "@playwright/test";
import { syntheticPdf } from "../support/synthetic-documents";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in securely" }).click();
  await page.getByRole("link", { name: "Orbit Administrator" }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3000\/$/);
}

async function readWorkspace(page: Page) {
  const response = await page.request.get("/api/workspace");
  return (await response.json()) as { workspace: { activeHouseholdId: string | null; households: Array<{ id: string; items: Array<Record<string, unknown>> }> } };
}

async function ensureHousehold(page: Page) {
  const current = await readWorkspace(page);
  if (current.workspace.activeHouseholdId) return current.workspace.activeHouseholdId;
  await page.getByRole("heading", { name: "Where would you like to begin?" }).waitFor();
  await page.getByRole("button", { name: "Create a new household" }).click();
  const dialog = page.getByRole("dialog", { name: "Set up your space" });
  await dialog.getByLabel("Household name").fill(`Document intake ${Date.now()}`);
  await dialog.getByRole("button", { name: "Create household" }).click();
  let created: string | null = null;
  await expect.poll(async () => {
    created = (await readWorkspace(page)).workspace.activeHouseholdId;
    return created;
  }, { timeout: 15_000 }).toBeTruthy();
  if (!created) throw new Error("Household creation did not produce an active household");
  return created;
}

async function openAddItem(page: Page, isMobile: boolean) {
  if (isMobile) {
    const add = page.locator("button.mobile-add");
    await expect(add).toBeVisible();
    await add.focus();
    await page.keyboard.press("Enter");
    return;
  }
  await page.getByRole("button", { name: "Add item", exact: true }).first().click();
}

async function submitAddItem(page: Page, editor: Locator, isMobile: boolean) {
  const submit = editor.getByRole("button", { name: "Add item", exact: true });
  if (isMobile) {
    await submit.focus();
    await page.keyboard.press("Enter");
    return;
  }
  await submit.click();
}

test.describe("document-assisted item intake", () => {
  test.describe.configure({ mode: "serial", retries: 0 });

  test("supports manual and reviewed document-assisted submission on desktop and mobile", async ({ page, isMobile }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");

    await signIn(page);
    await ensureHousehold(page);
    const suffix = Date.now();
    const inspectionRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/item-document-inspection")) inspectionRequests.push(request.url());
    });

    await openAddItem(page, isMobile);
    let editor = page.getByRole("dialog", { name: "Add an item" });
    const manualTitle = `Manual intake ${suffix}`;
    await editor.getByLabel("What do you want to keep track of?").fill(manualTitle);
    await editor.getByRole("button", { name: "No schedule" }).click();
    await submitAddItem(page, editor, isMobile);
    await expect(page.locator(".action-toast")).toContainText(`${manualTitle} added`);
    expect(inspectionRequests).toHaveLength(0);

    await openAddItem(page, isMobile);
    editor = page.getByRole("dialog", { name: "Add an item" });
    const assistedTitle = `Reviewed intake ${suffix}`;
    await editor.getByLabel("What do you want to keep track of?").fill(assistedTitle);
    const mockedSuggestions = [
      { field: "title", value: "Suggested title", source: "filename", confidence: "high" },
      { field: "provider", value: "Suggested Provider", source: "document_text", confidence: "medium" },
      { field: "reference", value: "SUGGESTED-123", source: "document_text", confidence: "medium" },
      { field: "dueDate", value: "2030-12-20", source: "document_text", confidence: "medium" },
    ] as const;
    await page.route("**/api/households/*/item-document-inspection", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ extracted: true, suggestions: mockedSuggestions }),
      });
    });
    const inspectionResponse = page.waitForResponse((response) => response.url().includes("/item-document-inspection") && response.request().method() === "POST");
    await editor.getByLabel("Document", { exact: true }).setInputFiles({
      name: "synthetic-policy.pdf",
      mimeType: "application/pdf",
      buffer: syntheticPdf("Provider: Hostile-but-inert Cover\nPolicy number: REVIEW-12345\n2030-12-20"),
    });
    const inspectionPayload = await (await inspectionResponse).json() as { suggestions: typeof mockedSuggestions };
    expect(inspectionPayload.suggestions).toEqual(mockedSuggestions);
    await expect(editor.getByLabel("What do you want to keep track of?")).toHaveValue(assistedTitle);
    await expect(editor.getByLabel("Provider")).toHaveValue("Suggested Provider");
    await expect(editor.getByLabel("Reference")).toHaveValue("SUGGESTED-123");
    await expect(editor.getByLabel("Renewal date")).toHaveValue("2030-12-20");
    await editor.getByLabel("Type").fill("Insurance");
    await editor.getByLabel("Provider").fill("Reviewed Cover");
    await editor.getByLabel("Reference").fill("");
    await editor.getByLabel("Cost (GBP)").fill("125.50");
    await editor.getByRole("button", { name: "Renews" }).click();
    await editor.getByLabel("Renewal date").fill("2031-01-10");
    await editor.getByLabel("Repeats").selectOption("12");
    await page.unroute("**/api/households/*/item-document-inspection");

    const beforeSubmit = await readWorkspace(page);
    const beforeItems = beforeSubmit.workspace.households.flatMap((household) => household.items);
    expect(beforeItems.some((item) => item.title === assistedTitle)).toBe(false);

    await submitAddItem(page, editor, isMobile);
    await expect(page.locator(".action-toast")).toContainText(`${assistedTitle} added`, { timeout: 15_000 });
    await expect.poll(async () => {
      const workspace = await readWorkspace(page);
      return workspace.workspace.households.some((household) => household.items.some((item) => item.title === assistedTitle));
    }, { timeout: 15_000 }).toBe(true);

    const finalWorkspace = await readWorkspace(page);
    const finalItem = finalWorkspace.workspace.households.flatMap((household) => household.items).find((item) => item.title === assistedTitle);
    expect(finalItem).toMatchObject({
      title: assistedTitle,
      subtype: "Insurance",
      provider: "Reviewed Cover",
      costMinor: 12550,
      dueDate: "2031-01-10",
      scheduleKind: "renewal",
      recurrenceMonths: 12,
    });
    expect(finalItem?.reference).toBeUndefined();
    const itemCard = page.locator("article.item-card").filter({ hasText: assistedTitle });
    await itemCard.getByRole("button", { name: `Open ${assistedTitle}`, exact: true }).click();
    const detail = page.getByRole("dialog", { name: assistedTitle });
    await expect(detail.getByRole("heading", { name: "Files" })).toBeVisible();
    await expect(detail).toContainText("synthetic-policy.pdf");
    expect(inspectionRequests).toHaveLength(1);
  });

  test("does not upload when reviewed approval fails", async ({ page, isMobile }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");

    await signIn(page);
    await ensureHousehold(page);
    await openAddItem(page, isMobile);
    const editor = page.getByRole("dialog", { name: "Add an item" });
    await editor.getByLabel("What do you want to keep track of?").fill(`Command failure ${Date.now()}`);
    await editor.getByRole("button", { name: "No schedule" }).click();
    await editor.getByLabel("Document", { exact: true }).setInputFiles({
      name: "command-failure.pdf",
      mimeType: "application/pdf",
      buffer: syntheticPdf("synthetic command failure"),
    });
    await expect(editor.getByRole("status")).toContainText(/Document inspected|Suggestions are unavailable/, { timeout: 15_000 });

    const uploadRequests: string[] = [];
    let approvalRequests = 0;
    await page.route("**/api/reviewed-intake/approve", async (route) => {
      approvalRequests += 1;
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "reviewed_intake_conflict", message: "This item changed on another device; refresh and try again" } }) });
    });
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/documents")) uploadRequests.push(request.url());
    });

    await submitAddItem(page, editor, isMobile);
    await expect(editor).toBeVisible();
    await expect(editor.getByRole("status")).toContainText("changed on another device");
    expect(approvalRequests).toBe(1);
    expect(uploadRequests).toHaveLength(0);
    await page.unroute("**/api/reviewed-intake/approve");
  });

  test("keeps the editor and original file available for bounded attachment retry", async ({ page, isMobile }) => {
    test.skip(process.env.ORBIT_ACCEPTANCE_OIDC !== "true", "Requires the disposable OIDC acceptance profile.");

    await signIn(page);
    await ensureHousehold(page);
    await openAddItem(page, isMobile);
    const editor = page.getByRole("dialog", { name: "Add an item" });
    const title = `Attachment failure ${Date.now()}`;
    await editor.getByLabel("What do you want to keep track of?").fill(title);
    await editor.getByRole("button", { name: "No schedule" }).click();
    await editor.getByLabel("Document", { exact: true }).setInputFiles({
      name: "attachment-failure.pdf",
      mimeType: "application/pdf",
      buffer: syntheticPdf("synthetic attachment failure"),
    });
    await expect(editor.getByRole("status")).toContainText(/Document inspected|Suggestions are unavailable/, { timeout: 15_000 });
    let attempts = 0;
    await page.route("**/api/households/*/items/*/documents", async (route) => {
      if (route.request().method() === "POST") {
        attempts += 1;
        if (attempts === 1) {
          await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "document_scanner_unreachable", message: "Document upload is not possible because the malware scanner cannot be reached. Uploads stay blocked until the scanner is running." } }) });
        } else {
          await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ document: { id: "22222222-2222-4222-8222-222222222222" } }) });
        }
        return;
      }
      await route.continue();
    });

    await submitAddItem(page, editor, isMobile);
    await expect(editor).toBeVisible();
    await expect(editor.getByRole("status")).toContainText("temporarily unavailable");
    const workspace = await readWorkspace(page);
    expect(workspace.workspace.households.flatMap((household) => household.items).some((item) => item.title === title)).toBe(true);
    await submitAddItem(page, editor, isMobile);
    await expect(page.locator(".action-toast")).toContainText(`${title} added`, { timeout: 15_000 });
    expect(attempts).toBe(2);
    await page.unroute("**/api/households/*/items/*/documents");
  });
});
