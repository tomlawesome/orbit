import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

/**
 * #495 + #660: the gravity well dial announces itself as a labelled group
 * instead of role="img" (which used to prune its whole subtree from the
 * accessibility tree), every focusable body inside it carries a name built
 * from the same data the hover callout already shows, and the decorative
 * chrome (rings, ticks, month labels, trails, comet, defs) stays
 * aria-hidden. This spec is criterion 3's aria snapshot: the group, the
 * household link, and one named link per rendered body -- plus a check that
 * nothing focusable inside is left unnamed.
 */

async function signIn(page: Page) {
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: "Orbit Administrator" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function sessionHeaders(page: Page) {
  const response = await page.request.get("/api/auth/session");
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  return { Origin: new URL(page.url()).origin, "X-CSRF-Token": csrfToken };
}

async function cleanupHousehold(page: Page, headers: Record<string, string>, householdId: string, name: string) {
  const url = `/api/households/${householdId}/lifecycle`;
  const schedule = await page.request.post(url, { headers, data: { action: "delete", confirmation: name } });
  if (schedule.status() === 404) return;
  if (!schedule.ok() && schedule.status() !== 409) {
    throw new Error(`Could not schedule dial-accessibility fixture cleanup (${schedule.status()})`);
  }
  const remove = await page.request.post(url, { headers, data: { action: "hard_delete", confirmation: name } });
  if (remove.status() !== 404 && !remove.ok()) {
    throw new Error(`Could not remove dial-accessibility fixture (${remove.status()})`);
  }
}

test("names the household link and every rendered body, and hides the decorative chrome", async ({ page, isMobile }) => {
  test.skip(isMobile, "the labelled-group dial is the desktop dialect; the pocket dial (.mdial) is out of scope for #495/#660");

  await signIn(page);
  const headers = await sessionHeaders(page);
  const suffix = randomUUID().slice(0, 8);
  const householdId = randomUUID();
  const sectionId = randomUUID();
  const itemId = randomUUID();
  const householdName = `Dial Accessibility ${suffix}`;
  const itemTitle = `Dial proving item ${suffix}`;
  const dueDate = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);

  try {
    const create = await page.request.post("/api/workspace/commands", {
      headers,
      data: {
        type: "household.create",
        household: {
          id: householdId,
          name: householdName,
          timezone: "Europe/London",
          currency: "GBP",
          memberCount: 1,
          canManage: true,
          onboardingComplete: true,
          sections: [{ id: sectionId, name: "Accessibility", icon: "home", accent: "sage", visible: true }],
          items: [],
        },
      },
    });
    expect(create.ok()).toBeTruthy();

    const upsert = await page.request.post("/api/workspace/commands", {
      headers,
      data: {
        type: "item.upsert",
        householdId,
        item: {
          id: itemId,
          sectionId,
          title: itemTitle,
          currency: "GBP",
          costMinor: 12550,
          scheduleKind: "renewal",
          dueDate,
          recurrenceMonths: 12,
          status: "active",
          version: 1,
          updatedAt: new Date().toISOString(),
        },
      },
    });
    expect(upsert.ok()).toBeTruthy();

    await page.goto("/home");
    const dial = page.locator(".dial");
    await expect(dial).toBeVisible();

    // Criterion 1: a labelled group, not a subtree-pruning image, keeping
    // its existing label exactly.
    //
    // The name is asserted on its own rather than inside the snapshot
    // below. An aria snapshot is YAML, and this name contains ": " (as
    // written at web/src/routes/home/+page.svelte:886), which YAML reads as
    // a nested mapping and rejects with "Nested mappings are not allowed in
    // compact mappings" -- quoting does not help, and nor does a regex,
    // because the entry still ends in the colon that opens the child list.
    // toHaveAccessibleName takes the string whole, and asserts the name the
    // user is actually read rather than the attribute carrying it.
    await expect(dial).toHaveAttribute("role", "group");
    await expect(dial).toHaveAccessibleName(
      "Gravity well: items orbit by due date; distance from the household is time remaining, body size is typical cost; details in the manifest below",
    );
    // What the snapshot is for: proving the subtree survives. Under the old
    // role="img" the group's children were pruned from the accessibility
    // tree entirely, so this fails if that regresses.
    await expect(dial).toMatchAriaSnapshot(`
      - group:
        - link /^Open /
    `);

    // Criterion 3: the household link and one named link per rendered body.
    // Checked generically (not by exact count) because the account this
    // suite shares accumulates households and items across other specs.
    const sunLink = dial.locator(".sun-link");
    await expect(sunLink).toHaveAttribute("aria-label", /^Open .+/);

    const bodyLinks = dial.locator(".body-link");
    const bodyCount = await bodyLinks.count();
    expect(bodyCount).toBeGreaterThan(0);
    for (let i = 0; i < bodyCount; i++) {
      const label = await bodyLinks.nth(i).getAttribute("aria-label");
      expect(label, `body-link ${i} should carry an accessible name`).toBeTruthy();
    }

    // This fixture's own body link is named from the same data the hover
    // callout composes: title, T-minus, then cost.
    const escapedTitle = itemTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ownLink = dial.locator(`[data-body="${itemId}"]`);
    await expect(ownLink).toHaveAttribute("aria-label", new RegExp(`^${escapedTitle}, T[−+]\\d+d · `));

    // Criterion 2: no focusable element inside the chart lacks an
    // accessible name. Approximated the same way the accessibility tree
    // computes a name here (aria-label, else text content) -- nothing
    // inside the dial relies on aria-labelledby or a <title> element.
    const unnamed = await dial.locator("a, button, [tabindex]").evaluateAll((elements) =>
      elements
        .filter((element) => {
          if (element.getAttribute("tabindex") === "-1") return false;
          const label = element.getAttribute("aria-label");
          const text = element.textContent?.trim();
          return !(label && label.length > 0) && !(text && text.length > 0);
        })
        .map((element) => element.outerHTML));
    expect(unnamed).toEqual([]);

    // The decorative chrome is pruned from the tree, not merely styled away.
    await expect(dial.locator("g.chrome")).toHaveAttribute("aria-hidden", "true");
  } finally {
    await cleanupHousehold(page, headers, householdId, householdName);
  }
});
