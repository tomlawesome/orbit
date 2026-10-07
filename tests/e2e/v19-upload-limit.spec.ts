import { expect, test, type Page } from "@playwright/test";
import { householdRegister, sessionHeaders } from "./support/households";
import { signInAsWorkerAdministrator } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { syntheticPdf } from "../support/synthetic-documents";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * #1285: the upload size limit an administrator sets in Administration,
 * against the real image. Three things only a real stack shows:
 *
 *  - a document over 512 KB reaches Orbit at all. adapter-node's own body
 *    limit (BODY_SIZE_LIMIT, 512 KB unless the image sets it) refused every
 *    such upload with a 500 before this change;
 *  - an administrator lowering the limit on the screen refuses the next
 *    over-limit upload with a 413, with no restart, and "use the default"
 *    puts it back;
 *  - a large body to a route that is not an upload is a 413 too, so raising
 *    the server-wide limit did not open every route to it.
 *
 * Desk only: the limit is one server setting, and the phone's sheet calls the
 * same route.
 */

const MIB = 1_048_576;
const households = householdRegister();

/** A real PDF of about 1.5 MB: one long line of page text, so the structure check reads it as any other. */
const LARGE_PDF = syntheticPdf("Orbit upload size limit proof. ".repeat(Math.ceil((1.5 * MIB) / 31)));

async function seedHousehold(page: Page, name: string): Promise<{ id: string; name: string }> {
  return await page.evaluate(async (householdName) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const householdId = crypto.randomUUID();
    const response = await fetch("/api/workspace/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({
        type: "household.create",
        household: {
          id: householdId, name: householdName, timezone: "Europe/London", currency: "GBP",
          memberCount: 1, canManage: true, onboardingComplete: true,
          sections: [{ id: crypto.randomUUID(), name: "Home", icon: "home", accent: "sage", visible: true }],
          items: [],
        },
      }),
    });
    if (!response.ok) throw new Error(`household.create failed: ${response.status}`);
    return { id: householdId, name: householdName };
  }, name);
}

/** The create form's inspection upload, as the form itself sends it. */
async function inspect(page: Page, householdId: string) {
  const headers = { ...(await sessionHeaders(page)), "x-orbit-filename": encodeURIComponent("large.pdf"), "content-type": "application/pdf" };
  const response = await page.request.post(`/api/households/${householdId}/item-document-inspection`, { headers, data: LARGE_PDF });
  const body = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
  return { status: response.status(), code: body.error?.code ?? null };
}

/** Back to the configured default through the route, whatever a failed run left. */
async function restoreDefault(page: Page) {
  const current = await page.request.get("/api/admin/upload-limit");
  if (!current.ok()) return;
  const { uploadLimit } = (await current.json()) as { uploadLimit: { overrideBytes: number | null; version: number } };
  if (uploadLimit.overrideBytes === null) return;
  await page.request.post("/api/admin/upload-limit", {
    headers: await sessionHeaders(page),
    data: { action: "default", expectedVersion: uploadLimit.version },
  });
}

test("an administrator lowers the upload limit, an over-limit upload is refused, and the default comes back", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one server setting; the desk proves it");
  test.setTimeout(120_000);
  expect(LARGE_PDF.length).toBeGreaterThan(1.4 * MIB);
  expect(LARGE_PDF.length).toBeLessThan(2 * MIB);

  await signInAsWorkerAdministrator(page, "/administration");
  const household = households.track(await seedHousehold(page, `Upload limit ${Date.now()}`));

  try {
    await restoreDefault(page);
    await page.goto("/administration");
    const card = page.locator("#upload-limit-card");
    await expect(card).toContainText("Upload size limit");
    await expect(card).toContainText("the configured default");
    await expect(card.getByRole("link", { name: "see the install guide" })).toHaveAttribute("href", /docs\/installing\.md#what-you-need$/);
    const defaultText = (await card.locator(".kv b").first().textContent())?.trim() ?? "";
    expect(defaultText).toMatch(/^\d+ MB$/);

    /* Over 512 KB, under the default: reaches Orbit and is read like any other. */
    expect(await inspect(page, household.id)).toEqual({ status: 200, code: null });

    /* The administrator lowers it on the screen, to 1 MB. */
    await card.getByRole("button", { name: "change…" }).click();
    await card.getByLabel("limit in MB").fill("1");
    await card.getByRole("button", { name: "save" }).click();
    await expect(card.locator(".kv b").first()).toHaveText("1 MB");
    await expect(card).toContainText("an administrator");

    /* The very next upload is held to it: a 413, never a 500. */
    expect(await inspect(page, household.id)).toEqual({ status: 413, code: "document_too_large" });

    /* "use the default" puts it back, and the same document goes through again. */
    await card.getByRole("button", { name: "change…" }).click();
    await card.getByRole("button", { name: /^use the default/ }).click();
    await expect(card).toContainText("the configured default");
    await expect(card.locator(".kv b").first()).toHaveText(defaultText);
    expect(await inspect(page, household.id)).toEqual({ status: 200, code: null });

    /* A large body to a route that is not an upload is refused before it is read. */
    const contact = await page.request.post("/api/admin/contact", {
      headers: { ...(await sessionHeaders(page)), "content-type": "application/json" },
      data: JSON.stringify({ action: "set", expectedVersion: 1, address: "x".repeat(2 * MIB) }),
    });
    expect(contact.status()).toBe(413);
    expect(((await contact.json()) as { error: { code: string } }).error.code).toBe("request_too_large");
    /* Refused unread, on a connection Orbit closed: the next request still
       gets an answer rather than a hung-up socket. */
    expect((await page.request.get("/api/admin/upload-limit")).status()).toBe(200);
  } finally {
    await restoreDefault(page);
    await households.sweep(page);
  }
});
