import { expect, test } from "@playwright/test";

import { signedIn } from "./a11y-support.js";

/*
 * #495 + #660: the gravity well dial announces itself as a labelled group
 * instead of role="img" (which used to prune its whole subtree from the
 * accessibility tree), every focusable body inside it carries a name built
 * from the same data the hover callout already shows, and the decorative
 * chrome (rings, ticks, month labels, trails, comet, defs) stays aria-hidden.
 * Criterion 3's aria snapshot: the group, the household link, and one named
 * link per rendered body, plus a check that nothing focusable inside is left
 * unnamed. Moved from tests/e2e (ADR-0039, #1611): the bodies are the fixture
 * workspace's Harlow Home items, `/home rest`; the item the stack test seeded
 * for itself is the MOT.
 */

const MOT = { id: "i-mot", title: "Car MOT — Volvo V60" };
const SETTLE = 20_000;

test("names the household link and every rendered body, and hides the decorative chrome", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.endsWith("phone"), "the labelled-group dial is the desktop dialect; the pocket dial (.mdial) is out of scope for #495/#660");

  await signedIn("/home", "rest")(page);
  const dial = page.locator(".dial");
  await expect(dial).toBeVisible({ timeout: SETTLE });

  // Criterion 1: a labelled group, not a subtree-pruning image, keeping its existing label exactly.
  //
  // The name is asserted on its own rather than inside the snapshot below. An
  // aria snapshot is YAML, and this name contains ": ", which YAML reads as a
  // nested mapping; toHaveAccessibleName takes the string whole.
  await expect(dial).toHaveAttribute("role", "group");
  await expect(dial).toHaveAccessibleName(
    "Gravity well: items orbit by due date; distance from the household is time remaining, body size is typical cost per year; details in the manifest below",
  );
  // What the snapshot is for: proving the subtree survives. Under the old
  // role="img" the group's children were pruned from the accessibility tree
  // entirely, so this fails if that regresses.
  await expect(dial).toMatchAriaSnapshot(`
    - group:
      - link /^Open /
  `);

  // Criterion 3: the household link and one named link per rendered body.
  const sunLink = dial.locator(".sun-link");
  await expect(sunLink).toHaveAttribute("aria-label", /^Open .+/);

  const bodyLinks = dial.locator(".body-link");
  const bodyCount = await bodyLinks.count();
  expect(bodyCount).toBeGreaterThan(0);
  for (let i = 0; i < bodyCount; i++) {
    const label = await bodyLinks.nth(i).getAttribute("aria-label");
    expect(label, `body-link ${i} should carry an accessible name`).toBeTruthy();
  }

  // The MOT's body link is named from the same data the hover callout
  // composes: title, T-minus, then cost.
  const escapedTitle = MOT.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await expect(dial.locator(`[data-body="${MOT.id}"]`)).toHaveAttribute("aria-label", new RegExp(`^${escapedTitle}, T[−+]\\d+d · `));

  // Criterion 2: no focusable element inside the chart lacks an accessible
  // name (aria-label, else text content; nothing inside relies on
  // aria-labelledby or a <title> element).
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
});
