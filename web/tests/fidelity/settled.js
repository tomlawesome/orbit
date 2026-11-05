/**
 * "The sky has painted", said once (#1712). Grain.svelte and the Dawn/Dusk
 * `.world` hosts rasterise their filters once, asynchronously (#499, #501),
 * and mark themselves `data-rasterised="pending"` until the picture lands,
 * then `"ready"`. A capture or assertion taken before that photographs a blank
 * overlay, so every fidelity spec that needs the painted sky waits here, not
 * on a frame or two of requestAnimationFrame.
 *
 * Waits until at least one marked layer exists (so an empty page fails
 * clearly, rather than `every()` passing over nothing) and every one reads
 * "ready". A page that legitimately has no rasterised layer, such as the
 * hand-drawn mockups (their inline grain carries no attribute), passes
 * `{ optional: true }` to skip the existence guard and the wait.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{ optional?: boolean, timeout?: number }} [options]
 */
export async function settled(page, { optional = false, timeout } = {}) {
  const layers = ".grain[data-rasterised], .world[data-rasterised]";
  if (optional && (await page.locator(layers).count()) === 0) return;
  await page.waitForSelector(layers, { state: "attached", timeout });
  await page.waitForFunction(
    (selector) =>
      [...document.querySelectorAll(selector)].every(
        (el) => /** @type {HTMLElement} */ (el).dataset.rasterised === "ready",
      ),
    layers,
    { timeout },
  );
}
