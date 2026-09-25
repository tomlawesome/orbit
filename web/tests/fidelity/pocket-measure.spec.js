import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * THE PHONE MEASUREMENT CHECK (#1120, proposal §1.6, §1.7, §3).
 *
 * Loads each route on a phone, touch on, at the two widths the proposal
 * draws for (390x844 and 360x780), and fails if anything visible breaks the
 * pocket's three hard floors:
 *   · a tappable element smaller than 44x44px
 *   · text smaller than 12px
 *   · a tappable element outside the viewport's width (content in a strip
 *     that scrolls sideways is reachable by scrolling, so it is exempt)
 *
 * Each step of the phone layouts adds the routes it lands. A route whose
 * screen has not had its phone layout yet is listed with the step that
 * fixes it and is an EXPECTED failure (test.fail), not a skip: it still
 * runs, and the day it passes Playwright says so, which is the cue to drop
 * the mark. The kit's own chrome (top bar, orb, hatch) is held to the
 * floors strictly on every route, expected failure or not.
 */

/*
 * `chromePending`: the kit's chrome is held to the floors strictly, except
 * where the screen itself pushes it out. The household page overflows the
 * phone's width today, which widens the layout viewport and carries the
 * fixed chrome with it (the orb lands past the right edge); that is the
 * screen's defect and its step fixes it.
 */
/** @type {{ path: string, pending?: string, chromePending?: string }[]} */
const ROUTES = [
  { path: "/kit" },
  { path: "/home" },
  { path: "/item/i-mot" },
  { path: "/create", pending: "step 4 (create / edit)" },
  { path: "/inbox", pending: "step 5 (inbox)" },
  { path: "/household/hh-lawson-1", pending: "step 6 (household)",
    chromePending: "step 6 (household): the page overflows sideways and carries the chrome off-screen" },
  { path: "/settings", pending: "step 7 (settings)" },
  { path: "/settings/mail", pending: "step 7 (settings › mail)" },
  { path: "/administration", pending: "step 8 (administration)" },
];

const PHONES = [
  { name: "390", viewport: { width: 390, height: 844 } },
  { name: "360", viewport: { width: 360, height: 780 } },
];

/**
 * Runs in the page. Returns every violation under `scope` (a selector; the
 * whole document when empty), as short readable strings.
 * @param {string} scope
 */
function measure(scope) {
  const MIN_HIT = 44;
  const MIN_TEXT = 12;
  const TAPPABLE = "a[href],button,input:not([type=hidden]),select,textarea,summary,"
    + "[role=button],[role=link],[role=tab],[role=switch],[tabindex]:not([tabindex='-1'])";
  const roots = scope ? [...document.querySelectorAll(scope)] : [document.body];
  const vw = document.documentElement.clientWidth;
  const out = new Set();

  /** @param {Element} el */
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    /* A 1px box is the visually-hidden pattern (.sr-only): read by a screen
       reader, never seen or tapped. */
    if (r.width <= 1 || r.height <= 1) return false;
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  };
  /** @param {Element} el */
  const inSideScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if ((o === "auto" || o === "scroll") && p.scrollWidth > p.clientWidth) return true;
    }
    return false;
  };
  /** @param {Element} el */
  const label = (el) => {
    const text = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList[0] ? `.${el.classList[0]}` : ""} "${text}"`;
  };

  for (const root of roots) {
    const candidates = [root, ...root.querySelectorAll(TAPPABLE)].filter((el) => el.matches(TAPPABLE));
    for (const el of candidates) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < MIN_HIT - 0.5 || r.height < MIN_HIT - 0.5)
        out.add(`tap target ${Math.round(r.width)}x${Math.round(r.height)}: ${label(el)}`);
      if ((r.left < -0.5 || r.right > vw + 0.5) && !inSideScroller(el))
        out.add(`outside the viewport (${Math.round(r.left)}..${Math.round(r.right)} of ${vw}): ${label(el)}`);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue?.trim()) continue;
      const el = node.parentElement;
      if (!el || !shown(el)) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < MIN_TEXT - 0.01) out.add(`text ${size}px: ${label(el)}`);
    }
  }
  return [...out];
}

/** The kit's own chrome on a screen that has not had its phone layout yet. */
const KIT_CHROME = ".p-chrome";

for (const phone of PHONES) {
  test.describe(`pocket measurement at ${phone.name}`, () => {
    test.use({ viewport: phone.viewport, hasTouch: true, isMobile: true });

    for (const route of ROUTES) {
      test(`${route.path} meets the pocket floors`, async ({ page }) => {
        /* Expected to fail until its step lands; see the header. */
        test.fail(Boolean(route.pending), `phone layout lands in ${route.pending}`);
        await page.goto(`${APP}${route.path}`, { waitUntil: "load" });
        await page.waitForLoadState("networkidle");
        await page.evaluate(() => document.fonts.ready);
        const problems = await page.evaluate(measure, "");
        expect(problems, problems.join("\n")).toEqual([]);
      });

      if (route.pending) {
        test(`${route.path}: the kit's chrome meets the pocket floors`, async ({ page }) => {
          test.fail(Boolean(route.chromePending), `${route.chromePending}`);
          await page.goto(`${APP}${route.path}`, { waitUntil: "load" });
          await page.waitForLoadState("networkidle");
          await page.evaluate(() => document.fonts.ready);
          await expect(page.locator(KIT_CHROME)).toBeVisible();
          const problems = await page.evaluate(measure, KIT_CHROME);
          expect(problems, problems.join("\n")).toEqual([]);
        });
      }
    }
  });
}
