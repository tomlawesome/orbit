import { expect, test, type Page } from "@playwright/test";

/**
 * #455: the item view's writes, for real — a household and item seeded
 * through the same command API the product uses, then completed through the
 * v19 view, with the new orbit visible back on home.
 */
async function seedHouseholdWithItem(page: Page): Promise<{ itemId: string }> {
  return await page.evaluate(async () => {
    const sessionResponse = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
    const session = (await sessionResponse.json()) as { csrfToken: string };
    const command = async (payload: unknown) => {
      const response = await fetch("/api/workspace/commands", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`command failed: ${response.status} ${await response.text()}`);
    };
    const householdId = crypto.randomUUID();
    const sectionId = crypto.randomUUID();
    await command({
      type: "household.create",
      household: {
        id: householdId,
        name: "Actions Proving Ground",
        timezone: "Europe/London",
        currency: "GBP",
        memberCount: 1,
        canManage: true,
        onboardingComplete: true,
        sections: [{ id: sectionId, name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    });
    const itemId = crypto.randomUUID();
    const dueDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    await command({
      type: "item.upsert",
      householdId,
      item: {
        id: itemId,
        sectionId,
        title: "Boiler service proving",
        currency: "GBP",
        scheduleKind: "service",
        dueDate,
        recurrenceMonths: 12,
        status: "active",
      },
      activity: { id: crypto.randomUUID(), itemId, kind: "created", occurredAt: new Date().toISOString() },
    });
    return { itemId };
  });
}

test("completing an item from the v19 view moves its orbit", async ({ page }) => {
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: "Orbit Administrator" }).click();
  await expect(page).toHaveURL(/\/home$/);

  const { itemId } = await seedHouseholdWithItem(page);

  await page.goto(`/item/${itemId}`);
  await expect(page.getByRole("heading", { name: "Boiler service proving" })).toBeVisible();
  // Due in 20 days: needs attention.
  await expect(page.locator(".item-card")).toContainText("T−20d");

  await page.locator(".acts button", { hasText: /^complete$/ }).click();
  // The next orbit defaults to +recurrenceMonths and stays editable.
  await expect(page.locator("#a-next")).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await page.locator(".panel .btn-primary").click();

  // The view re-reads: a year of lead time now (allow the ±1 day of month arithmetic).
  await expect(page.locator(".item-card")).toContainText(/T−36[456]d/);

  // And home tells the same story. On a desk the row sits in the wide orbit;
  // in the pocket dialect only attention rows exist, so the truth there is
  // the item's absence from them.
  await page.goto("/home");
  if (test.info().project.name.startsWith("mobile")) {
    await expect(page.locator(".mdial svg")).toBeVisible();
    await expect(page.locator(".mitem", { hasText: "Boiler service proving" })).toHaveCount(0);
  } else {
    await expect(page.locator(`[id="${itemId}"]`)).toContainText(/T−36[456]d/);
  }
});

test("a stale version is refused and the view says so", async ({ page }) => {
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: "Orbit Administrator" }).click();
  await expect(page).toHaveURL(/\/home$/);

  const { itemId } = await seedHouseholdWithItem(page);
  await page.goto(`/item/${itemId}`);
  await expect(page.getByRole("heading", { name: "Boiler service proving" })).toBeVisible();

  // Someone else reschedules while our view is open (same command API,
  // fresh version) — our copy is now stale.
  await page.evaluate(async () => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const workspace = (await (await fetch("/api/workspace", { credentials: "same-origin" })).json()).workspace;
    const household = workspace.households.find((one: { name: string }) => one.name === "Actions Proving Ground");
    const item = household.items[0];
    const response = await fetch("/api/workspace/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({
        type: "item.reschedule",
        householdId: household.id,
        itemId: item.id,
        expectedVersion: item.version,
        dueDate: "2027-03-03",
        activity: { id: crypto.randomUUID(), itemId: item.id, kind: "rescheduled", occurredAt: new Date().toISOString(), nextDate: "2027-03-03" },
      }),
    });
    if (!response.ok) throw new Error(`rival reschedule failed: ${response.status}`);
  });

  await page.locator(".acts button", { hasText: /^reschedule$/ }).click();
  await page.locator("#a-due").fill("2026-12-01");
  await page.locator(".panel .btn-primary").click();

  // Refused in the server's own words, and the view re-reads the truth.
  await expect(page.locator(".problem")).toContainText("changed on another device");
  await expect(page.locator(".item-card")).toContainText("3 March 2027");
});
