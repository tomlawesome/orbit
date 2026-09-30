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
 *     screen; every callout points at something — its anchor (the box the
 *     film stamps on it) is a real, on-screen element and its stem lands on
 *     that box, the design's own `dy` allowed — and covers no bright text
 *     but its anchor's (text under the veil is dimmed by design; text in a
 *     hole, or with the veil down, is being read); every ring on the screen
 *     is drawn round a real element's own box — a ring that matches nothing
 *     under it is a spotlight in the wrong place, which is what the owner
 *     saw; and the film reaches its own end
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

  /* The veil's holes, read from its own mask: text inside one is bright. */
  const veil = document.getElementById("orbit-tour-veil");
  const veilUp = veil !== null && parseFloat(getComputedStyle(veil).opacity) > 0.05;
  /** @type {{ x: number, y: number, w: number, h: number }[]} */
  const holes = [];
  if (veilUp && veil) {
    const mask = veil.style.maskImage || veil.style.webkitMaskImage || "";
    const m = /url\("data:image\/svg\+xml,(.*)"\)/u.exec(mask);
    const svg = m ? decodeURIComponent(m[1]) : "";
    for (const r of svg.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)" rx=/gu)) {
      holes.push({ x: +r[1], y: +r[2], w: +r[3], h: +r[4] });
    }
    for (const c of svg.matchAll(/<circle cx="([\d.-]+)" cy="([\d.-]+)" r="([\d.]+)"/gu)) {
      holes.push({ x: +c[1] - +c[3], y: +c[2] - +c[3], w: 2 * +c[3], h: 2 * +c[3] });
    }
  }
  /** @param {DOMRect} r */
  const bright = (r) => !veilUp || holes.some((h) => r.left < h.x + h.w && r.right > h.x && r.top < h.y + h.h && r.bottom > h.y);

  /** Every readable text box on the page that is not the film's own. */
  /** @type {{ rect: DOMRect, node: Text }[]} */
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = /** @type {Text} */ (node);
    if (!text.data.trim()) continue;
    const parent = /** @type {HTMLElement | null} */ (text.parentElement);
    if (parent === null) continue;
    if (parent.closest("#orbit-tour-film, #orbit-tour-veil, #orbit-tour-transport, script, style")) continue;
    const cs = getComputedStyle(parent);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.05) continue;
    /* visually-hidden text (the kit's sr-only, the count beads' words) is
       a 1px box whose text still measures at its laid-out width */
    const pb = parent.getBoundingClientRect();
    if (pb.width < 2 || pb.height < 2) continue;
    const range = document.createRange();
    range.selectNodeContents(text);
    for (const rect of range.getClientRects()) {
      if (rect.width < 2 || rect.height < 2) continue;
      texts.push({ rect, node: text });
    }
  }

  for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".tourfilm-callout"))) {
    const box = el.getBoundingClientRect();
    if (el.style.opacity === "0") continue; /* leaving */
    const said = (el.textContent ?? "").slice(0, 28);
    if (box.left < -0.5 || box.top < -0.5 || box.right > window.innerWidth + 0.5 || box.bottom > window.innerHeight + 0.5) {
      faults.push(`callout past the screen (${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)})`);
    }
    if (chromeBox && chromeBox.height > 0 && intersects(box, chromeBox)) faults.push("callout under the top chrome");

    /* What it points at. */
    const anchor = el.dataset.tourfilmAnchor ?? "";
    const side = el.dataset.tourfilmSide ?? "";
    const dy = Math.abs(Number(el.dataset.tourfilmDy ?? 0));
    /** @type {DOMRect | null} */
    let target = null;
    if (anchor === "none") {
      faults.push(`callout pointing at nothing: "${said}"`);
    } else if (anchor !== "point" && anchor) {
      const [x, y, w, h] = anchor.split(",").map(Number);
      target = new DOMRect(x, y, w, h);
      if (w < 1 || h < 1) faults.push(`callout on a 0x0 anchor: "${said}"`);
      else if (target.right <= 0 || target.bottom <= 0 || target.left >= window.innerWidth || target.top >= window.innerHeight) {
        faults.push(`callout whose anchor is off the screen: "${said}"`);
      } else {
        /* The stem's tip: the 14px square sits 8px past the box's edge,
           rotated, so its tip is ~7px beyond the box on the named side. */
        const stem = el.querySelector("i");
        const sb = stem ? stem.getBoundingClientRect() : box;
        const tip = side === "top" ? [(sb.left + sb.right) / 2, sb.bottom]
          : side === "bottom" ? [(sb.left + sb.right) / 2, sb.top]
            : side === "left" ? [sb.right, (sb.top + sb.bottom) / 2]
              : [sb.left, (sb.top + sb.bottom) / 2];
        const slackX = 10 + (side === "left" || side === "right" ? dy : 0);
        const slackY = 10 + (side === "top" || side === "bottom" ? dy : 0);
        const onTarget = tip[0] >= target.left - slackX && tip[0] <= target.right + slackX
          && tip[1] >= target.top - slackY && tip[1] <= target.bottom + slackY;
        if (!onTarget) faults.push(`callout's stem misses its anchor: "${said}"`);
      }
    }

    /* Bright text it covers, other than its anchor's own — and other than
       the lit surface its anchor stands in: a hole that contains the anchor
       (the item card round its complete button, the hatch's panel round
       its settings row) is the film's own picture of "this control, here",
       and a line inside it has nowhere else to sit. */
    /** @param {DOMRect} r @param {{ x: number, y: number, w: number, h: number }} h */
    const within = (r, h) => r.left >= h.x - 1 && r.right <= h.x + h.w + 1 && r.top >= h.y - 1 && r.bottom <= h.y + h.h + 1;
    const surface = target ? holes.filter((h) => within(target, h) && (h.w > target.width + 2 || h.h > target.height + 2)) : [];
    for (const { rect, node } of texts) {
      if (!intersects(box, rect) || !bright(rect)) continue;
      if (target && within(rect, { x: target.left, y: target.top, w: target.width, h: target.height })) continue;
      if (surface.some((h) => within(rect, h))) continue;
      faults.push(`callout "${said}" covers the text "${node.data.trim().slice(0, 24)}"`);
      break;
    }
  }
  /* Every ring must be the outline of something real: the film's own
     account (`__lit`, vocabulary.js's litBoxes) gives each ring beside the
     box of the element it was drawn round as it measures NOW — the two must
     agree to a pixel, the element must still be in the document and shown,
     and no ring may be up that the film does not account for (one left
     behind by a screen change). The rings' own frame after a scroll is
     allowed for by the caller (two samples running). */
  const rings = [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#orbit-tour-film .tourfilm-ring"))]
    .filter((r) => r.style.opacity !== "0");
  /** @type {{ ring: {x:number,y:number,w:number,h:number}, target: {x:number,y:number,w:number,h:number}, connected: boolean, shown: boolean, sel: string }[]} */
  const lit = /** @type {any} */ (window).__lit?.() ?? [];
  if (rings.length > lit.length) faults.push(`${rings.length - lit.length} ring(s) the film does not account for`);
  for (const one of lit) {
    const where = `${one.sel} at ${Math.round(one.ring.x)},${Math.round(one.ring.y)} ${Math.round(one.ring.w)}x${Math.round(one.ring.h)}`;
    if (!one.connected) { faults.push(`a ring round an element no longer in the document: ${where}`); continue; }
    if (one.ring.w < 1 || one.ring.h < 1 || one.target.w < 1 || one.target.h < 1) { faults.push(`a ring round nothing (0x0): ${where}`); continue; }
    const off = one.ring.x + one.ring.w <= 0 || one.ring.y + one.ring.h <= 0 || one.ring.x >= window.innerWidth || one.ring.y >= window.innerHeight;
    if (off) continue; /* a control the page has scrolled away is not on the screen to mislead */
    if (!one.shown) faults.push(`a ring round something a reader cannot see: ${where}`);
    const drift = Math.max(Math.abs(one.ring.x - one.target.x), Math.abs(one.ring.y - one.target.y),
      Math.abs(one.ring.w - one.target.w), Math.abs(one.ring.h - one.target.h));
    /* 2px is the lift: the control rises 2px inside its ring (applyLift). */
    if (drift > 2.5) faults.push(`a ring ${Math.round(drift)}px off its element: ${where}`);
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
    /** The chrome is re-measured one frame after the page moves and a
     *  callout fades over 180ms, so a fault caught on one 250ms sample is a
     *  frame in transit; one seen on two samples running is on the screen
     *  long enough to be read. `pointing at nothing` is counted at once —
     *  it is never in transit. @type {Set<string>} */
    let lastFaults = new Set();
    let ended = false;
    const started = Date.now();
    while (!ended && Date.now() - started < 380_000) {
      const s = await page.evaluate(sample);
      if (s) {
        const now = new Set();
        for (const fault of s.faults) {
          const key = `${fault} · ${s.url} · ch${s.chapter}`;
          now.add(key);
          if (!fault.startsWith("callout pointing at nothing") && !lastFaults.has(key)) continue;
          faults[key] = (faults[key] ?? 0) + 1;
        }
        lastFaults = now;
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
