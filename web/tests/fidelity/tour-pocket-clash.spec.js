import { expect, test } from "@playwright/test";

import { installFilmEnded } from "./film-ended.js";

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

/** Runs in the page: samples with `sample` on every animation frame until
 *  stopped, into window.__clashes. @param {() => string[] | null} sample */
function installClashRecorder(sample) {
  /** @type {{ counts: Record<string, number>, sawPill: boolean, stopped: boolean }} */
  const recorded = { counts: {}, sawPill: false, stopped: false };
  /** @type {any} */ (window).__clashes = recorded;
  const frame = () => {
    if (recorded.stopped) return;
    const clashes = sample();
    if (clashes) {
      recorded.sawPill = true;
      for (const clash of clashes) recorded.counts[clash] = (recorded.counts[clash] ?? 0) + 1;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

for (const width of WIDTHS) {
  test(`the pocket transport never clashes at ${width.name}`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize(width.viewport);
    await installFilmEnded(page);
    await page.route("**/api/settings/tour", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"tour":{"tourSeenAt":null}}' }));
    await page.goto(`${APP}/home`, { waitUntil: "load" });
    await page.waitForFunction(() => Array.isArray(/** @type {any} */ (window).__chapters));

    /* The sampler runs in the page, on every one of its own frames, from here
       to the end of the film: a clash on any frame is counted, however briefly
       it lasts, and how fast the runner can ask the page is not part of it
       (this used to be a 250 ms poll from the runner, which could step over a
       clash that lived less than that). W3-Q6 (#1151): sampleClashes() returns
       null both while the film has not started yet AND when the pill never
       renders at all, so the recorder keeps whether a real sample (the pill
       actually present and sized) was ever seen. */
    await page.evaluate(`(${installClashRecorder})(${sampleClashes})`);

    /* The end state: the film has read to its last chapter. 280 s covers the
       2:55 film with room to spare. */
    await page.waitForFunction(() => {
      const w = /** @type {any} */ (window);
      return w.__readingEnded(w.__reading?.());
    }, null, { timeout: 280_000, polling: 1_000 });
    const { sawPill, counts } = await page.evaluate(() => {
      const recorded = /** @type {any} */ (window).__clashes;
      recorded.stopped = true;
      return { sawPill: recorded.sawPill, counts: recorded.counts };
    });

    expect(sawPill, `the pocket transport pill never appeared at ${width.name}`).toBe(true);

    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    /* the owner's acceptance evidence, printed for the PR */
    console.log(`tour-pocket-clash ${width.name}:`, total === 0 ? "zero clashes" : counts);
    expect(counts, `clash counts at ${width.name}`).toEqual({});
  });
}
