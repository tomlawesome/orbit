import { expect, test, type Page } from "@playwright/test";

/**
 * #641: the household hit-area fix, proved by a real hit-test.
 *
 * #638 was diagnosed from one CI log and fixed from first principles; #640's
 * evidence was computed styles and geometry read in happy-dom, which has no
 * layout engine and so cannot hit-test at all. #670 then fixed the placement
 * side — the floor pass keeps drawn rings 80px apart, marks overflow undrawn
 * and routes short viewports to the pocket — but its evidence is geometry too.
 * Nothing has ever fired a click at a packed sky in a real browser.
 *
 * This spec does. It asks the browser itself, through elementFromPoint and a
 * real mouse click, which card owns a point over one card's ring while a
 * neighbour's 210x160 box covers that same point. The second test reverts the
 * `pointer-events` rule in the page and watches the neighbour take the click —
 * #638 reproduced deterministically rather than inferred (#641 criteria 1
 * and 2), which is the reproduction debt the owner ruled on 2026-08-26 cannot
 * go unpaid.
 *
 * The sky is built by stubbing `GET /api/workspace`, not by creating
 * households in the shared instance. #641 asks for an overlap constructed by
 * the test "not by chance or accumulated fixture data", and household
 * bearings are a pure function of household id (`constellationPosOf`), so a
 * fixed set of ids is the same sky on every run and on every machine.
 * Everything the test then measures — layout, CSS, hit-testing, the click — is
 * the real page. It also leaves no households behind to crowd other specs,
 * which is the accumulation #730 is about.
 */

const skyOf = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `hit-routing-${String(index + 1).padStart(2, "0")}`,
  name: `Hit Routing ${String(index + 1).padStart(2, "0")}`,
  requested: false,
}));

/* Twelve is the drawn cap (#670), so twelve fills the sky exactly; twenty
   overflows it and leaves undrawn households for the last test. */
const FULL_SKY = skyOf(12);
const OVERFULL_SKY = skyOf(20);

/* The desk viewports, smallest first. Below 601px tall the pocket dialect
   takes over and draws no constellations at all (#670), so the worst case for
   crowding is 901x601 rather than anything smaller. */
const DESK_VIEWPORTS = [
  { width: 901, height: 601 },
  { width: 1024, height: 700 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];

type Overlap = {
  point: { x: number; y: number };
  target: string;
  /* the covering card painted last, which is the one a box-level hit-test
     hands the click to */
  neighbour: string;
  coverers: number;
  hitCard: string | null;
};

async function signIn(page: Page, account: string) {
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: account }).click();
  await expect(page).toHaveURL(/\/home$/);
}

/* The viewer stays adrift — no household of their own — and sees exactly the
   set this test names. Only the household list is substituted; the page, its
   placement, its CSS and its handlers are the real ones. */
async function stubSky(page: Page, visibleHouseholds: ReturnType<typeof skyOf>) {
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.workspace = { ...body.workspace, households: [], activeHouseholdId: null, visibleHouseholds };
    await route.fulfill({ response, json: body });
  });
}

async function drawnNames(page: Page) {
  return page.locator(".minisys").evaluateAll((cards) =>
    cards.map((card) => (card.getAttribute("aria-label") ?? "").replace(/^Request to join /u, "")));
}

/* Read the sky as the browser has actually laid it out and find the pair the
   defect needs: a card whose ring centre falls inside a later-painted card's
   210x160 box. Later-painted matters — with the boxes clickable it is the last
   covering card that wins the hit-test, which is what #637's log recorded. */
async function findOverlap(page: Page): Promise<Overlap | null> {
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
async function packUntilOverlapping(page: Page) {
  const tried: string[] = [];
  for (const viewport of DESK_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto("/home");
    await expect(page.locator(".minisys").first()).toBeVisible();
    const overlap = await findOverlap(page);
    if (overlap) return { overlap, viewport, drawn: (await drawnNames(page)).length };
    tried.push(`${viewport.width}x${viewport.height} (${(await drawnNames(page)).length} drawn, no covering pair)`);
  }
  throw new Error(`no card's ring fell inside a later card's box at any desk viewport: ${tried.join("; ")}`);
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the labelled sky is the desk dialect; the pocket draws no constellations");
  await stubSky(page, FULL_SKY);
  await signIn(page, "Orbit Outsider");
  await expect(page.getByRole("heading", { name: "you’re adrift" })).toBeVisible();
});

test("a click over one household's ring opens that household, not the neighbour whose box covers it", async ({ page }) => {
  test.setTimeout(120_000);
  const { overlap, viewport, drawn } = await packUntilOverlapping(page);
  console.log(`packed sky: ${drawn} drawn at ${viewport.width}x${viewport.height}; ${overlap.coverers} card(s) cover "${overlap.target}"'s ring, last of them "${overlap.neighbour}"`);

  /* #670's separation guarantee, measured on the rendered page rather than on
     a placement fixture: no two drawn hit circles within 80px of each other,
     or a ring — the surface #640 deliberately kept clickable — could steal a
     click the way a box once did. */
  const converging = await page.evaluate(() => {
    const rings = [...document.querySelectorAll(".minisys")].map((card) => {
      const box = card.querySelector(".mshit")?.getBoundingClientRect();
      return box ? { name: (card.getAttribute("aria-label") ?? "").replace(/^Request to join /u, ""), x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
    }).filter((ring) => ring !== null);
    const tooClose: string[] = [];
    for (let i = 0; i < rings.length; i += 1) {
      for (let j = i + 1; j < rings.length; j += 1) {
        const gap = Math.hypot(rings[i].x - rings[j].x, rings[i].y - rings[j].y);
        if (gap < 80) tooClose.push(`${rings[i].name} and ${rings[j].name} are ${gap.toFixed(1)}px apart`);
      }
    }
    return tooClose;
  });
  expect(converging).toEqual([]);

  /* The hit-test itself, asked of the browser rather than inferred from CSS. */
  expect(overlap.hitCard).toBe(overlap.target);

  /* And the click that follows it lands in the same place. */
  await page.mouse.click(overlap.point.x, overlap.point.y);
  await expect(page.getByRole("heading", { name: `Request to join ${overlap.target} system?` })).toBeVisible();
  await expect(page.getByRole("heading", { name: `Request to join ${overlap.neighbour} system?` })).toHaveCount(0);
});

test("reverting the pointer-events rule gives the click to the neighbour, as #637 recorded", async ({ page }) => {
  test.setTimeout(120_000);
  const { overlap } = await packUntilOverlapping(page);
  expect(overlap.hitCard).toBe(overlap.target);

  /* #640's fix is one CSS rule. Put the page back the way #638 found it: the
     whole 210x160 box opts into hit-testing again. */
  await page.addStyleTag({ content: ".minisys{pointer-events:auto}" });
  const stolen = await page.evaluate((point) => {
    const at = document.elementFromPoint(point.x, point.y)?.closest(".minisys");
    return at ? (at.getAttribute("aria-label") ?? "").replace(/^Request to join /u, "") : null;
  }, overlap.point);

  /* A neighbouring .minisys intercepts — the element #637's run log named. */
  expect(stolen).toBe(overlap.neighbour);
  expect(stolen).not.toBe(overlap.target);

  await page.mouse.click(overlap.point.x, overlap.point.y);
  await expect(page.getByRole("heading", { name: `Request to join ${overlap.neighbour} system?` })).toBeVisible();
});

test("a household the packed sky cannot draw is still reachable by name", async ({ page }) => {
  test.setTimeout(120_000);
  await page.unroute("**/api/workspace");
  await stubSky(page, OVERFULL_SKY);
  await page.setViewportSize(DESK_VIEWPORTS[0]);
  await page.goto("/home");
  await expect(page.locator(".minisys").first()).toBeVisible();
  const drawn = await drawnNames(page);

  /* Over capacity the floor pass marks the overflow undrawn rather than
     placing it sub-floor (#670). That is ratified behaviour, not a defect —
     but the join list is fed visibleHouseholds, not the capped sky, so an
     undrawn household must still be askable by name. */
  const undrawn = OVERFULL_SKY.map((household) => household.name).filter((name) => !drawn.includes(name));
  expect(undrawn.length).toBeGreaterThan(0);

  await page.goto("/");
  const belong = page.getByRole("group", { name: "Where do you belong?" });
  await expect(belong).toBeVisible();
  for (const name of undrawn) {
    await expect(belong.getByRole("button", { name: `Request to join ${name}` })).toBeVisible();
  }
});
