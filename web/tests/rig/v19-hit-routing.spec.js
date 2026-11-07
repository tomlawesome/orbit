import { expect, test } from "@playwright/test";

import { signedIn } from "./a11y-support.js";

/*
 * #641: the household hit-area fix, proved by a real hit-test.
 *
 * #638 was diagnosed from one CI log and fixed from first principles; #640's
 * evidence was computed styles and geometry read in happy-dom, which has no
 * layout engine and so cannot hit-test at all. #670 then fixed the placement
 * side -- the floor pass keeps drawn rings 80px apart, marks overflow undrawn
 * and routes short viewports to the pocket -- but its evidence is geometry too.
 * Nothing had ever fired a click at a packed sky in a real browser.
 *
 * This spec does. It asks the browser itself, through elementFromPoint and a
 * real mouse click, which card owns a point over one card's ring while a
 * neighbour's 210x160 box covers that same point. The second test reverts the
 * `pointer-events` rule in the page and watches the neighbour take the click:
 * #638 reproduced deterministically rather than inferred (#641 criteria 1 and
 * 2), the reproduction debt the owner ruled on 2026-08-26 cannot go unpaid.
 *
 * Moved from tests/e2e (ADR-0039, #1611). The sky is a fixture scene, not a
 * stubbed workspace read: `/home full-sky` (twelve systems, ids
 * hit-routing-01..12, the drawn cap of #670) and `overfull-sky` (twenty).
 * Household bearings are a pure function of household id
 * (`constellationPosOf`), so a fixed set of ids is the same sky on every run.
 * Everything measured -- layout, CSS, hit-testing, the click -- is the real page.
 */

const SETTLE = 20_000;

/* Twenty overflows the twelve the sky can draw (#670) and leaves undrawn
   households for the last test. */
const OVERFULL_SKY = Array.from({ length: 20 }, (_, index) => `Hit Routing ${String(index + 1).padStart(2, "0")}`);

/* The desk viewports, smallest first. Below 840 wide or 480 tall the pocket
   dialect takes over and draws no constellations at all (#670, #1382), so the
   worst case for crowding is 840x480 rather than anything smaller. */
const DESK_VIEWPORTS = [
  { width: 840, height: 480 },
  { width: 901, height: 601 },
  { width: 1024, height: 700 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];

/** @typedef {import("@playwright/test").Page} Page */

/** @param {Page} page */
async function drawnNames(page) {
  return page.locator(".minisys").evaluateAll((cards) =>
    cards.map((card) => (card.getAttribute("aria-label") ?? "").replace(/^Request to join /u, "")));
}

/* Read the sky as the browser has actually laid it out and find the pair the
   defect needs: a card whose ring centre falls inside a later-painted card's
   210x160 box. Later-painted matters -- with the boxes clickable it is the last
   covering card that wins the hit-test, which is what #637's log recorded. */
/** @param {Page} page */
async function findOverlap(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll(".minisys")].map((element, index) => {
      const box = element.getBoundingClientRect();
      const ring = element.querySelector(".mshit")?.getBoundingClientRect();
      return {
        index,
        name: (element.getAttribute("aria-label") ?? "").replace(/^Request to join /u, ""),
        requested: (element.textContent ?? "").includes("ASKED TO JOIN"),
        box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
        ring: ring ? { x: ring.left + ring.width / 2, y: ring.top + ring.height / 2 } : null,
      };
    });

    for (const target of cards) {
      if (target.requested || !target.ring) continue;
      const { x, y } = target.ring;
      const covering = cards.filter((card) => card.index > target.index
        && x >= card.box.left && x <= card.box.right && y >= card.box.top && y <= card.box.bottom);
      if (!covering.length) continue;
      const topmost = covering[covering.length - 1];
      const at = document.elementFromPoint(x, y)?.closest(".minisys");
      return {
        point: { x, y },
        target: target.name,
        neighbour: topmost.name,
        coverers: covering.length,
        hitCard: at ? (at.getAttribute("aria-label") ?? "").replace(/^Request to join /u, "") : null,
      };
    }
    return null;
  });
}

/* Pack the sky until a neighbour's box genuinely covers another card's ring,
   smallest desk viewport first. A failure names every geometry it tried, so it
   cannot be mistaken for the routing itself breaking. */
/** @param {Page} page */
async function packUntilOverlapping(page) {
  /** @type {string[]} */
  const tried = [];
  for (const viewport of DESK_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await signedIn("/home", "full-sky")(page);
    await expect(page.locator(".minisys").first()).toBeVisible({ timeout: SETTLE });
    const overlap = await findOverlap(page);
    if (overlap) return { overlap, viewport, drawn: (await drawnNames(page)).length };
    tried.push(`${viewport.width}x${viewport.height} (${(await drawnNames(page)).length} drawn, no covering pair)`);
  }
  throw new Error(`no card's ring fell inside a later card's box at any desk viewport: ${tried.join("; ")}`);
}

/* #1219: a `page.route` is not applied to a request the service worker
   handles; nothing here is about the worker, so it is kept out. */
test.use({ serviceWorkers: "block" });

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name.endsWith("phone"), "the labelled sky is the desk dialect; the pocket draws no constellations");
});

test("a click over one household's ring opens that household, not the neighbour whose box covers it", async ({ page }) => {
  const { overlap, viewport, drawn } = await packUntilOverlapping(page);
  console.log(`packed sky: ${drawn} drawn at ${viewport.width}x${viewport.height}; ${overlap.coverers} card(s) cover "${overlap.target}"'s ring, last of them "${overlap.neighbour}"`);

  /* #670's separation guarantee, measured on the rendered page rather than on
     a placement fixture: no two drawn hit circles within 80px of each other,
     or a ring -- the surface #640 deliberately kept clickable -- could steal a
     click the way a box once did.
     #1183: measured to within one layout unit. placement.js builds the floor
     to 80px plus a micron, and Chromium reports that position exactly, but
     Firefox snaps layout to 1/60px, so the same pair reads 79.996px there.
     Anything a whole unit or more under the floor still fails. */
  const converging = await page.evaluate(() => {
    const LAYOUT_UNIT = 1 / 60;
    const rings = [...document.querySelectorAll(".minisys")].map((card) => {
      const box = card.querySelector(".mshit")?.getBoundingClientRect();
      return box ? { name: (card.getAttribute("aria-label") ?? "").replace(/^Request to join /u, ""), x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
    }).filter((ring) => ring !== null);
    /** @type {string[]} */
    const tooClose = [];
    for (let i = 0; i < rings.length; i += 1) {
      for (let j = i + 1; j < rings.length; j += 1) {
        const gap = Math.hypot(rings[i].x - rings[j].x, rings[i].y - rings[j].y);
        if (gap < 80 - LAYOUT_UNIT) tooClose.push(`${rings[i].name} and ${rings[j].name} are ${gap.toFixed(3)}px apart`);
      }
    }
    return tooClose;
  });
  expect(converging).toEqual([]);

  /* The hit-test itself, asked of the browser rather than inferred from CSS. */
  expect(overlap.hitCard).toBe(overlap.target);

  /* And the click that follows it lands in the same place. */
  await page.mouse.click(overlap.point.x, overlap.point.y);
  await expect(page.getByRole("heading", { name: `Request to join ${overlap.target} system?` })).toBeVisible({ timeout: SETTLE });
  await expect(page.getByRole("heading", { name: `Request to join ${overlap.neighbour} system?` })).toHaveCount(0);
});

test("reverting the pointer-events rule gives the click to the neighbour, as #637 recorded", async ({ page }) => {
  const { overlap } = await packUntilOverlapping(page);
  expect(overlap.hitCard).toBe(overlap.target);

  /* #640's fix is one CSS rule. Put the page back the way #638 found it: the
     whole 210x160 box opts into hit-testing again. */
  await page.addStyleTag({ content: ".minisys{pointer-events:auto}" });
  const stolen = await page.evaluate((point) => {
    const at = document.elementFromPoint(point.x, point.y)?.closest(".minisys");
    return at ? (at.getAttribute("aria-label") ?? "").replace(/^Request to join /u, "") : null;
  }, overlap.point);

  /* A neighbouring .minisys intercepts -- the element #637's run log named. */
  expect(stolen).toBe(overlap.neighbour);
  expect(stolen).not.toBe(overlap.target);

  await page.mouse.click(overlap.point.x, overlap.point.y);
  await expect(page.getByRole("heading", { name: `Request to join ${overlap.neighbour} system?` })).toBeVisible({ timeout: SETTLE });
});

test("a household the packed sky cannot draw is still reachable by name", async ({ page }) => {
  await page.setViewportSize(DESK_VIEWPORTS[0]);
  await signedIn("/home", "overfull-sky")(page);
  await expect(page.locator(".minisys").first()).toBeVisible({ timeout: SETTLE });
  const drawn = await drawnNames(page);

  /* Over capacity the floor pass marks the overflow undrawn rather than
     placing it sub-floor (#670). That is ratified behaviour, not a defect --
     but the join list is fed visibleHouseholds, not the capped sky, so an
     undrawn household must still be askable by name. */
  const undrawn = OVERFULL_SKY.filter((name) => !drawn.includes(name));
  expect(undrawn.length).toBeGreaterThan(0);

  /* The join list is read where a newcomer meets it: the arrival with the same
     twenty (`/?arrival=overfull`), not the adrift reader's /home, which
     carries a session that skips the newcomer stage (#840). */
  await signedIn("/", "arrival-overfull")(page);
  const belong = page.getByRole("group", { name: "Where do you belong?" });
  await expect(belong).toBeVisible({ timeout: SETTLE });
  for (const name of undrawn) {
    await expect(belong.getByRole("button", { name: `Request to join ${name}` })).toBeVisible();
  }
});
