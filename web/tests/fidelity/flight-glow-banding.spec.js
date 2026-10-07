import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * The door's and the dusk's glows are faint: the dusk's glow peaks at 14/255
 * opacity. Drawn into 8 bits and saved as lossy WebP (orbit-site's
 * tools/glows.cjs), each picture held a dozen or so opacity steps across the
 * sky, and on the sign-out each step showed as a stripe (owner, 2026-10-07).
 * scripts/flight-glows.mjs draws them from a high-precision merge, dithers
 * them and saves them lossless, so neighbouring pixels of one stripe now
 * differ.
 *
 * Measured as the share of 16-pixel horizontal runs, among those the glow
 * reaches, whose opacity is identical all along: a stripe is flat for its
 * whole width, a dithered gradient seldom is. Each ceiling sits between the
 * banded pictures' share and the dithered ones' (old → new, 2026-10-08). The
 * door's rays, its sun and the dusk's thin rim are not listed: their 8-bit
 * pictures were never flat.
 */
const CEILINGS = {
  "door/glow-zod.webp": 0.1, // 0.20 → 0.02
  "dusk/glow-glow.webp": 0.4, // 0.66 → 0.17
  "dusk/glow-belt.webp": 0.8, // 0.95 → 0.62: its source saturates past 4× (quarter steps)
  "dusk/glow-afterglow.webp": 0.25, // 0.35 → 0.13
};

for (const [picture, ceiling] of Object.entries(CEILINGS)) {
  test(`${picture} is dithered, not striped`, async ({ page }) => {
    await page.goto(APP + "/flight/" + picture);
    const flat = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
      context.drawImage(img, 0, 0);
      const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
      let runs = 0, flatRuns = 0;
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x + 16 <= width; x += 16) {
          let lo = 255, hi = 0;
          for (let i = 0; i < 16; i++) {
            const a = data[(y * width + x + i) * 4 + 3];
            lo = Math.min(lo, a);
            hi = Math.max(hi, a);
          }
          if (hi === 0) continue;
          runs++;
          if (lo === hi) flatRuns++;
        }
      }
      return flatRuns / runs;
    }, APP + "/flight/" + picture);
    expect(flat, `${picture}: share of flat 16-pixel runs`).toBeLessThan(ceiling);
  });
}
