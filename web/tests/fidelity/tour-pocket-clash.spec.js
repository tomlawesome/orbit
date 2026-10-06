import { expect, test } from "@playwright/test";

const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * THE CLASH SAMPLER (#1083, owner's acceptance on round 8 question 1a).
 *
 * Round 8 asked whether any transport placement could be made clash-free by
 * sampling `g-pocket.html` every 250ms and recording every intersection of
 * the pill's rect with a sheet, the save bar, a callout or the top chrome's
 * own controls (the mockup measurement, `/tmp/pocket-clash/REPORT.md`, not
 * committed). The owner's acceptance for the BUILD is the same measurement,
 * made durable and run against the real product: zero clashes at 390x844 and
 * 360x780, normal motion (the timings the clash is about — the fade, the
 * sheet's rise and fold, the 350ms return — vanish under reduced motion, so
 * only normal motion can catch a race in them).
 *
 * Opt-in and skipped by default (`TOUR_CLASH`): sampling a full 2:55 film
 * every 250ms at two widths is slow, and nothing else in the fidelity gate
 * takes that long. Run it explicitly when the transport's own docking,
 * fading or callout placement changes:
 *
 *   TOUR_CLASH=1 npx playwright test tour-pocket-clash --project=fidelity
 *
 * and paste the printed counts into the PR, the same evidence round 8's own
 * measurement gave the owner.
 */
test.skip(!process.env.TOUR_CLASH, "opt-in: TOUR_CLASH=1 to run the pocket transport's clash sampler");

const WIDTHS = [
  { name: "390x844", viewport: { width: 390, height: 844 } },
  { name: "360x780", viewport: { width: 360, height: 780 } },
];

/** Every rect the pill must never sit inside, and every callout/callout or
 *  callout/edge condition to watch for, sampled from inside the page.
 *  Returns null while the film has not started yet. */
function sampleClashes() {
  const pill = document.getElementById("orbit-tour-transport");
  if (!pill) return null;
  const pillBox = pill.getBoundingClientRect();
  if (pillBox.width === 0 && pillBox.height === 0) return null;

  /** @param {DOMRect} a @param {DOMRect} b */
  const intersects = (a, b) =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  /** @type {string[]} */
  const clashes = [];

  const others = [
    { label: "a raised sheet's panel", els: [...document.querySelectorAll(".p-sheet-layer.open .p-sheet-panel")] },
    { label: "the save bar", els: [...document.querySelectorAll(".pk-bar")] },
    { label: "a callout", els: [...document.querySelectorAll(".tourfilm-callout")] },
    { label: "the top chrome's own controls", els: [...document.querySelectorAll(".p-chrome a, .p-chrome button")] },
  ];
  for (const group of others) {
    for (const el of group.els) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (intersects(pillBox, box)) clashes.push(`pill × ${group.label}`);
    }
  }

  const callouts = [...document.querySelectorAll(".tourfilm-callout")].map((el) => el.getBoundingClientRect());
  for (let i = 0; i < callouts.length; i++) {
    for (let j = i + 1; j < callouts.length; j++) {
      if (intersects(callouts[i], callouts[j])) clashes.push("callout × callout");
    }
  }
  for (const box of callouts) {
    if (box.left < 0 || box.top < 0 || box.right > window.innerWidth || box.bottom > window.innerHeight) {
      clashes.push("callout past the viewport");
    }
  }

  return clashes;
}

for (const width of WIDTHS) {
  test(`the pocket transport never clashes at ${width.name}`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(width.viewport);
    await page.route("**/api/settings/tour", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"tour":{"tourSeenAt":null}}' }));
    await page.goto(`${APP}/home`, { waitUntil: "load" });
    await page.waitForFunction(() => Array.isArray(/** @type {any} */ (window).__chapters));

    /** @type {Record<string, number>} */
    const counts = {};
    // W3-Q6 (#1151): sampleClashes() returns null both while the film has
    // not started yet AND when the pill never renders at all -- the old
    // loop treated both the same (nothing to count), so a regression that
    // kept the pill from ever appearing sampled nothing but null for the
    // whole run and still reported "zero clashes". Track whether a real
    // sample (the pill actually present and sized) was ever seen.
    let sawPill = false;
    let ended = false;
    const start = Date.now();
    while (!ended && Date.now() - start < 220_000) {
      const clashes = await page.evaluate(sampleClashes);
      if (clashes) {
        sawPill = true;
        for (const clash of clashes) counts[clash] = (counts[clash] ?? 0) + 1;
      }
      ended = await page.evaluate(() => {
        const reading = /** @type {any} */ (window).__reading?.();
        return Boolean(reading && reading.total > 0 && reading.cursor >= reading.total);
      });
      await page.waitForTimeout(250);
    }

    expect(sawPill, `the pocket transport pill never appeared at ${width.name}`).toBe(true);

    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    /* the owner's acceptance evidence, printed for the PR */
    console.log(`tour-pocket-clash ${width.name}:`, total === 0 ? "zero clashes" : counts);
    expect(counts, `clash counts at ${width.name}`).toEqual({});
  });
}
