import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const here = dirname(fileURLToPath(import.meta.url));
const baselines = resolve(here, "baselines");
const artifacts = resolve(here, "../../test-results/fidelity");

const APP = "http://127.0.0.1:4173";
const MOCKUPS = "http://127.0.0.1:5174";

/**
 * The visual gate, in two stages.
 *
 * `porting` — the screen has just been built and is compared against its
 * mockup. The budget is there to catch *drift of substance* — a missing
 * starfield, a reworded button, a restructured layout — not sub-perceptual
 * noise like a star mid-twinkle. This is the check that did not exist when the
 * v19 work was reverted (#408): the app was compared only against itself, so a
 * screen could be green while missing an entire sky.
 *
 * `owned` — the owner has seen the screen and iterated on it, so it has
 * deliberately moved away from the mockup, which becomes a historical record.
 * From then on the comparison is against the approved baseline: whatever the
 * owner last ratified. Every screen records *why* it moved.
 *
 * Baselines are written deliberately, never automatically:
 *
 *   UPDATE_BASELINE=1 pnpm fidelity
 *
 * Run that only once a change has been seen and approved.
 */
const PIXEL_THRESHOLD = 0.1;
const MAX_DIFF_RATIO = 0.001;

const SCREENS = [
  {
    name: "login",
    path: "/login",
    stage: "owned",
    /* Owner iterated the lockup, button and ribbon on 2026-08-14 (CON-19
       amended for the sign-in hero); design/family/login.html is now history. */
    mockup: "/design/family/login.html",
  },
  {
    name: "logout",
    path: "/logout",
    /* Owner iterated on 2026-08-14: the SIGNED OUT ribbon removed and the pill
       reworded to match the sign-in, so the mockup is now history. */
    stage: "owned",
    mockup: "/design/family/logout.html",
    /* The sunset runs once on load; `set` is its completion flag. */
    settle: () => document.body.classList.contains("set"),
  },
  {
    name: "notfound",
    /* Reached the way a user reaches it: by asking for something that isn't there. */
    path: "/this-page-does-not-exist",
    stage: "porting",
    mockup: "/design/family/404-gravity.html",
    /* No dawn here — it settles once the lensed arcs have been drawn. */
    settle: () => document.querySelectorAll("#lensarcs path").length > 0,
    /* The mockup explains its own concept to the reviewer; the product does not. */
    mockupOnly: [".foot"],
  },
  {
    name: "maintenance",
    path: "/maintenance",
    stage: "porting",
    mockup: "/design/family/maintenance.html",
    settle: () => document.querySelectorAll("#farstars circle").length > 0,
    /* The mockup annotates its own demo loop for the reviewer; the product does not. */
    mockupOnly: [".foot"],
  },
  {
    name: "mobile",
    /* Same path as home: the pocket is a dialect of it, not a second screen
       (#430). What selects between them is the viewport below, which is why
       the gate having per-screen frames is what makes one URL possible. */
    path: "/home",
    stage: "porting",
    mockup: "/design/family/mobile-home.html",
    /* The dialect's own frame: `.mpage` is drawn at max-width 400 and the sky
       behind it at a 400×850 viewBox, so that is the sheet of glass to
       compare, not a desk viewport with a narrow column down the middle. */
    viewport: { width: 400, height: 850 },
    settle: () => Boolean(document.querySelector(".mdial svg")),
  },
  {
    name: "admin",
    path: "/admin",
    stage: "porting",
    mockup: "/design/family/admin.html",
    settle: () => Boolean(document.querySelector(".pane .row")),
    /* The mockup names its own motif for the reviewer; the product does not. */
    mockupOnly: [".foot"],
  },
  {
    name: "relay",
    path: "/settings/mail",
    stage: "porting",
    mockup: "/design/family/settings-mail.html",
    settle: () => Boolean(document.querySelector(".relay-card")),
    /* The mockup names its own motif for the reviewer; the product does not. */
    mockupOnly: [".foot"],
  },
  {
    name: "create",
    path: "/create",
    stage: "porting",
    mockup: "/design/family/create.html",
    /* No dawn and no generated artwork — the starfield is drawn in the markup,
       so the screen is settled as soon as the card has laid out. */
    settle: () => Boolean(document.getElementById("card")),
    /* The mockup states its own thesis to the reviewer; the product does not. */
    mockupOnly: [".foot"],
  },
  {
    /* No mockup draws the item view (#424): it is composed from ratified
       vocabulary and guarded by its owned baseline alone. Discovered missing
       from this list during #455 — a shipped screen the gate never watched. */
    name: "item",
    path: "/item/i-mot",
    stage: "owned",
    settle: () => Boolean(document.querySelector(".item-card .acts button")),
  },
  {
    name: "home",
    path: "/home",
    stage: "porting",
    mockup: "/design/v19/home.html",
    /* Home settles once the galaxy has been placed, rather than on a dawn. */
    settle: () => document.querySelectorAll(".minisys").length > 0,
    /*
     * Mockup-only scaffolding, deliberately absent from the product: a DEMOS
     * toolbar for replaying POL states on demand, and a footer describing the
     * proposal and its issue number. Masked by name rather than by coordinates,
     * and masked in *both* images, so the budget measures real drift instead of
     * being quietly consumed by a known, intended difference.
     */
    mockupOnly: [".demos", "footer"],
  },
];

/**
 * Point the mockup's Google Fonts request at the same self-hosted files the
 * app uses, so the comparison is about design rather than font delivery.
 */
const LOCAL_FONT_CSS = [500, 600]
  .map(
    (weight) =>
      `@font-face{font-family:'Space Grotesk';font-style:normal;` +
      `font-weight:${weight};font-display:block;` +
      `src:url(${MOCKUPS}/fonts/space-grotesk-latin-${weight}-normal.woff2) format('woff2')}`,
  )
  .concat([
    /*
     * Inter and JetBrains Mono, declared under the plain names the mockups ask
     * for. The app bundles them as variable faces (#418); the mockups never
     * fetched them at all and fell back to whatever the host had, which on a
     * bare Linux box is not a face anyone chose. Serving both sides the same
     * files is what keeps this a comparison of design.
     */
    `@font-face{font-family:'Inter';font-style:normal;font-weight:100 900;` +
      `font-display:block;src:url(${MOCKUPS}/inter/inter-latin-wght-normal.woff2) format('woff2')}`,
    `@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:100 800;` +
      `font-display:block;src:url(${MOCKUPS}/mono/jetbrains-mono-latin-wght-normal.woff2) format('woff2')}`,
  ])
  .join("\n");

/** Blanks the given rectangles in an image, in place. */
function maskRegions(png, rects) {
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(png.width, Math.ceil(r.x + r.width));
    const y1 = Math.min(png.height, Math.ceil(r.y + r.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (png.width * y + x) << 2;
        png.data[i] = png.data[i + 1] = png.data[i + 2] = 0;
        png.data[i + 3] = 255;
      }
    }
  }
}

async function capture(page, url, settle, mockupOnly = [], viewport = null) {
  await page.route("https://fonts.googleapis.com/**", (route) =>
    route.fulfill({ contentType: "text/css", body: LOCAL_FONT_CSS }),
  );

  /* Most of the family is drawn for a desk. The mobile dialect is drawn for a
     phone, and comparing it at 1600 wide would measure the wrong thing. */
  if (viewport) await page.setViewportSize(viewport);

  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(settle ?? (() => document.body.classList.contains("lit")));
  await page.evaluate(() => document.fonts.ready);

  /* Where the mockup carries scaffolding the product does not, find it by
     selector so the excluded area tracks the design rather than a magic box. */
  const rects = await page.evaluate((selectors) =>
    selectors.flatMap((sel) =>
      [...document.querySelectorAll(sel)].map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    ), mockupOnly);

  /*
   * Playwright's animation freezing covers CSS only. The atmosphere screens
   * also use SVG SMIL — the 404's infalling debris, the eclipse's corona — and
   * those keep running, so each capture would catch them at a different moment
   * and the gate would flake. Rewind every SVG timeline to zero and hold it.
   */
  await page.evaluate(() => {
    for (const svg of document.querySelectorAll("svg")) {
      if (typeof svg.pauseAnimations === "function") {
        svg.setCurrentTime(0);
        svg.pauseAnimations();
      }
    }
  });

  /*
   * animations: "disabled" fast-forwards transitions to their end state and
   * rewinds infinite CSS animations to their first frame. The sky never stops
   * moving, so without this the gate would compare two different moments.
   */
  const png = PNG.sync.read(await page.screenshot({ animations: "disabled" }));
  /* Masked on both sides — the app has no such element, so the same
     coordinates are blanked there too and the region cannot hide drift. */
  maskRegions(png, rects);
  return { png, rects };
}

function compare(expected, actual, name, label) {
  expect(
    { width: actual.width, height: actual.height },
    `${label}: sizes must match`,
  ).toEqual({ width: expected.width, height: expected.height });

  const diff = new PNG({ width: expected.width, height: expected.height });
  const differing = pixelmatch(
    expected.data,
    actual.data,
    diff.data,
    expected.width,
    expected.height,
    { threshold: PIXEL_THRESHOLD },
  );
  const total = expected.width * expected.height;
  const ratio = differing / total;

  /*
   * Written pass or fail. A gate whose output you only see when it breaks is a
   * gate nobody checks is working.
   */
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(`${artifacts}/${name}-${label}-actual.png`, PNG.sync.write(actual));
  writeFileSync(`${artifacts}/${name}-${label}-expected.png`, PNG.sync.write(expected));
  writeFileSync(`${artifacts}/${name}-${label}-diff.png`, PNG.sync.write(diff));

  console.log(
    `${name} [${label}]: ${differing} of ${total} pixels differ ` +
      `(${(ratio * 100).toFixed(4)}%), budget ${(MAX_DIFF_RATIO * 100).toFixed(4)}%`,
  );
  return { ratio, differing };
}

for (const screen of SCREENS) {
  if (screen.stage === "porting") {
    test(`${screen.name} matches its mockup (porting)`, async ({ page }) => {
      const mockup = await capture(
        page, MOCKUPS + screen.mockup, screen.settle, screen.mockupOnly, screen.viewport);
      const actual = await capture(
        page, APP + screen.path, screen.settle, [], screen.viewport);
      maskRegions(actual.png, mockup.rects);
      const { ratio, differing } = compare(mockup.png, actual.png, screen.name, "mockup");
      expect(
        ratio,
        `${differing} pixels differ from the mockup (${(ratio * 100).toFixed(4)}%). ` +
          `A screen being ported must match its design before it earns a baseline. ` +
          `Artifacts in test-results/fidelity/.`,
      ).toBeLessThanOrEqual(MAX_DIFF_RATIO);
    });
  }

  test(`${screen.name} matches its approved appearance`, async ({ page }) => {
    const { png: actual } = await capture(
      page, APP + screen.path, screen.settle, [], screen.viewport);
    const baselinePath = `${baselines}/${screen.name}.png`;

    if (process.env.UPDATE_BASELINE === "1" || !existsSync(baselinePath)) {
      mkdirSync(baselines, { recursive: true });
      writeFileSync(baselinePath, PNG.sync.write(actual));
      console.log(`${screen.name}: baseline written to ${baselinePath}`);
      return;
    }

    const { ratio, differing } = compare(
      PNG.sync.read(readFileSync(baselinePath)), actual, screen.name, "baseline",
    );
    expect(
      ratio,
      `${differing} pixels differ (${(ratio * 100).toFixed(4)}%). ` +
        `If this change is intended and approved, re-run with UPDATE_BASELINE=1.`,
    ).toBeLessThanOrEqual(MAX_DIFF_RATIO);
  });
}
