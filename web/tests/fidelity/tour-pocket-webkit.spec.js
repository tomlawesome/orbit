import { expect, test } from "@playwright/test";

const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * THE POCKET FILM IN WEBKIT (#1174).
 *
 * The first-run film's pocket cut (#1083) shipped with every check green and
 * broke on the owner's iPhone. Every check ran in Chromium, and none played
 * the film through: the fidelity frames hold at three marks, pocket-measure
 * at three states, the e2e spec jumps to one chapter. What was wrong was
 * mostly in the playing — rings left where a control WAS before the page
 * scrolled, the film stopping itself at chapter 8, a lane named against a
 * page not yet drawn — and one part was Safari's alone (an unprefixed
 * `backdrop-filter`, so the pill and every callout were see-through).
 *
 * So this spec plays the whole film, in WebKit, at two phone widths, and
 * looks at every held mark. It runs as the `pocket-webkit` project
 * (web/playwright.config.js): `pnpm --filter orbit-web fidelity:webkit`,
 * which CI's `fidelity` job runs after the Chromium projects, in Playwright's
 * own image, where WebKit is installed. On a host without WebKit's system
 * libraries run it inside that image:
 *
 *   docker run --rm --network=host -v "$PWD:$PWD:ro" -w "$PWD/web" \
 *     -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e FIDELITY_APP=http://127.0.0.1:4173 \
 *     mcr.microsoft.com/playwright:v1.63.0-noble \
 *     node node_modules/@playwright/test/cli.js test --project=pocket-webkit
 *
 * against an app already serving the fixture build (`reuseExistingServer`).
 * Read-only mount, deliberately: a package manager run inside the image
 * rewrites the host's node_modules (environment skill, 2026-08-24).
 *
 * Two passes, both under reduced motion so the whole thing fits a CI job
 * (the played film is 2:09 reduced against 3:44; the timings only normal
 * motion can catch are the clash sampler's, tour-pocket-clash.spec.js). Each
 * pass measured ~2.7 minutes on a quiet host and ~4 under load, so the
 * budget is 7: a stalled film here should fail on what it did, not on the
 * clock.
 *
 *  1. 390x844, played end to end from the film's own start with nothing
 *     jumped, sampled every 250ms: the pill never sits on a sheet, the save
 *     bar, a callout or the top chrome's controls (the chrome under a raised
 *     sheet's scrim is inert and the pill docks over it by the owner's 1a,
 *     so that one is not counted while a sheet is up); no callout leaves the
 *     screen; every ring on the screen is drawn round a real element's own
 *     box — a ring that matches nothing under it is a spotlight in the wrong
 *     place, which is what the owner saw; and the film reaches its own end
 *     with all twelve chapters seen in order and no error in the console — a
 *     film that stops itself (`Tour film stopped:`) is the failure chapter 8
 *     had.
 *
 *  2. 360x780, every mark held in turn (the review hooks the fidelity
 *     frames use): each is reached, and the same rules hold at each.
 */

/** Every mark the pocket cut fires, chapter by chapter (chapters/*.js;
 *  `add-yearly` is desk-only, #1083 §6). */
const MARKS = [
  ["arrive", ["arrive-chart", "arrive-suns", "arrive-gran"]],
  ["add", ["add-star", "add-drawer", "add-typing", "add-add"]],
  ["lands", ["lands-body", "lands-ring"]],
  ["manifest", ["manifest-scrolled", "manifest-today", "manifest-row"]],
  ["time", ["time-warmed", "time-toast"]],
  ["relay", ["relay-addr", "relay-never"]],
  ["inbox", ["inbox-orb", "inbox-lane-review", "inbox-lane-reading", "inbox-lane-filed", "inbox-lanes", "inbox-add", "inbox-sayso"]],
  ["belt", ["belt-arrive", "belt-cert", "belt-svc", "belt-doc", "belt-read", "belt-later", "belt-sooner"]],
  ["done", ["done-complete", "done-swung", "done-round"]],
  ["others", ["others-gran", "others-ask"]],
  ["sky", ["sky-orb", "sky-settings", "sky-swatches", "sky-dawn", "sky-back"]],
  ["yours", ["yours-year", "yours-year-line", "yours-close"]],
];

/** What the pill, the callouts and the last ring are doing right now, read
 *  from inside the page. Null until the film has put its pill up. */
function sample() {
  const pill = document.getElementById("orbit-tour-transport");
  if (!pill) return null;
  const pillBox = pill.getBoundingClientRect();
  if (pillBox.width === 0 && pillBox.height === 0) return null;
  /** @param {DOMRect} a @param {DOMRect} b */
  const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  /** @type {string[]} */
  const faults = [];
  /* The chrome is not counted while a sheet is up (inert under the scrim)
     nor while the pill is still docked `.top` — it leaves the dock 350ms
     after the sheet's fold, the owner's own fix 1 on round 8. */
  const sheetUp = Boolean(document.querySelector(".p-sheet-layer.open")) || pill.classList.contains("top");
  const others = [
    { label: "a raised sheet's panel", els: [...document.querySelectorAll(".p-sheet-layer.open .p-sheet-panel")] },
    { label: "the save bar", els: [...document.querySelectorAll(".pk-bar")] },
    { label: "a callout", els: [...document.querySelectorAll(".tourfilm-callout")].filter((el) => /** @type {HTMLElement} */ (el).style.opacity !== "0") },
    { label: "the top chrome's own controls",
      els: sheetUp ? [] : [...document.querySelectorAll(".p-chrome:not(.hidden) a, .p-chrome:not(.hidden) button")] },
  ];
  for (const group of others) {
    for (const el of group.els) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (intersects(pillBox, box)) faults.push(`pill on ${group.label}`);
    }
  }
  const chrome = document.querySelector(".p-chrome:not(.hidden)");
  const chromeBox = chrome ? chrome.getBoundingClientRect() : null;
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".tourfilm-callout"))) {
    const box = el.getBoundingClientRect();
    if (el.style.opacity === "0") continue; /* leaving */
    if (box.left < -0.5 || box.top < -0.5 || box.right > window.innerWidth + 0.5 || box.bottom > window.innerHeight + 0.5) {
      faults.push(`callout past the screen (${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)})`);
    }
    if (chromeBox && chromeBox.height > 0 && intersects(box, chromeBox)) faults.push("callout under the top chrome");
  }
  /* Every ring on the screen must be the outline of something real: an
     element under the ring's own centre whose box the ring matches, to the
     ring's own padding (the film pads a paper's ring 8px). A ring round a
     0x0 box is a control the page has replaced since it was measured. */
  const rings = [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#orbit-tour-film .tourfilm-ring"))]
    .filter((r) => r.style.opacity !== "0");
  for (const ring of rings) {
    const box = ring.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) { faults.push("a ring round nothing (0x0)"); continue; }
    if (box.right <= 0 || box.bottom <= 0 || box.left >= window.innerWidth || box.top >= window.innerHeight) continue;
    const cx = Math.min(window.innerWidth - 1, Math.max(0, (box.left + box.right) / 2));
    const cy = Math.min(window.innerHeight - 1, Math.max(0, (box.top + box.bottom) / 2));
    const under = document.elementsFromPoint(cx, cy).filter((el) => !el.closest("#orbit-tour-film, #orbit-tour-veil, #orbit-tour-transport"));
    let matched = false;
    for (const el of under) {
      for (let node = /** @type {Element | null} */ (el); node && node !== document.body && !matched; node = node.parentElement) {
        const b = node.getBoundingClientRect();
        const dx = Math.abs(b.left - box.left), dy = Math.abs(b.top - box.top);
        const dw = Math.abs(b.width - box.width), dh = Math.abs(b.height - box.height);
        if (dx <= 9 && dy <= 9 && dw <= 18 && dh <= 18) matched = true;
      }
      if (matched) break;
    }
    if (!matched) faults.push(`a ring round nothing at ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`);
  }
  const reading = /** @type {any} */ (window).__reading?.();
  return {
    faults,
    chapter: reading?.chapter ?? -1,
    ended: Boolean(reading && reading.total > 0 && reading.cursor >= reading.total),
    pill: pill.className,
    url: location.pathname,
  };
}

/** @param {import("@playwright/test").Page} page */
async function openFilm(page) {
  /** @type {string[]} */
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/settings/tour", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"tour":{"tourSeenAt":null}}' }));
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray(/** @type {any} */ (window).__chapters), null, { timeout: 30_000 });
  return errors;
}

test.describe("the pocket film in WebKit (#1174)", () => {
  test.use({ reducedMotion: "reduce" });

  test("plays end to end at 390x844 with the pill, the callouts and the chapters where they belong", async ({ page }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = await openFilm(page);

    /** @type {Record<string, number>} */
    const faults = {};
    /** @type {number[]} */
    const chapters = [];
    /** A ring is re-measured one frame after the page moves, so a ring
     *  caught between the scroll and that frame is not a fault; one seen on
     *  two samples running (250ms apart) is. @type {Set<string>} */
    let lastRingFaults = new Set();
    let ended = false;
    const started = Date.now();
    while (!ended && Date.now() - started < 380_000) {
      const s = await page.evaluate(sample);
      if (s) {
        const ringFaults = new Set();
        for (const fault of s.faults) {
          const key = `${fault} · ${s.url} · ch${s.chapter}`;
          if (fault.startsWith("a ring round nothing")) {
            ringFaults.add(key);
            if (!lastRingFaults.has(key)) continue;
          }
          faults[key] = (faults[key] ?? 0) + 1;
        }
        lastRingFaults = ringFaults;
        if (chapters.at(-1) !== s.chapter) chapters.push(s.chapter);
        ended = s.ended;
      }
      await page.waitForTimeout(250);
    }

    expect(errors, "no error in the console — a film that stopped itself says so there").toEqual([]);
    expect(ended, "the film reaches its own end").toBe(true);
    expect(chapters, "all twelve chapters, in order, none skipped").toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(faults, "the pill and the callouts stay where the design puts them").toEqual({});
  });

  test("reaches every mark at 360x780, each drawn on the screen", async ({ page }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width: 360, height: 780 });
    const errors = await openFilm(page);
    /** @type {string[]} */
    const wrong = [];

    for (const [chapter, marks] of MARKS) {
      const index = MARKS.findIndex(([id]) => id === chapter);
      for (const mark of marks) {
        await page.evaluate((m) => {
          const hooks = /** @type {any} */ (window);
          hooks.__held = null;
          hooks.__hold = m;
        }, mark);
        if (mark === marks[0]) await page.evaluate((k) => /** @type {any} */ (window).__jump(k), index);
        else await page.evaluate(() => /** @type {any} */ (window).__play());
        try {
          await page.waitForFunction((m) => /** @type {any} */ (window).__held === m, mark, { timeout: 45_000 });
        } catch {
          wrong.push(`${mark}: never reached`);
          continue;
        }
        /* the callout's own slide-in, and a frame for the sync loop */
        await page.waitForTimeout(350);
        const s = await page.evaluate(sample);
        if (!s) { wrong.push(`${mark}: no transport`); continue; }
        for (const fault of s.faults) wrong.push(`${mark}: ${fault}`);
      }
    }

    expect(errors, "no error in the console").toEqual([]);
    expect(wrong, "every mark reached and drawn on the screen").toEqual([]);
  });
});
