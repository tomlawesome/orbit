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
  { path: "/create" },
  { path: "/inbox" },
  { path: "/household/hh-lawson-1" },
  { path: "/household/hh-seaside-4551" },
  { path: "/settings" },
  { path: "/settings/mail" },
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

/* ══════════════════════════════════════════════════════════════════════════
   STEP 9 · THE DOOR FAMILY (#1120, #1127; proposal §2.13–§2.20)
   Kept as one block so the lanes adding other steps' routes above never
   touch it, and it never touches theirs.

   The door's screens are states rather than addresses, so each entry says
   how to reach its state, the way screens.spec.js does: the same faked
   health, availability and session answers the fidelity gate gives, and the
   auth endpoints answered where a card has to be refused or kept waiting.
   `/approve` and `/invite` read the database in their `load`, which this
   harness has none of, so they are reached by a client-side navigation whose
   `__data.json` is answered here -- the real built page, rendered from data
   stated in the test. Reduced motion, so the door's delayed first-light
   entrances are measured where they settle rather than mid-fade.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {import("@playwright/test").Route} route
 * @param {number} status
 * @param {unknown} body
 */
const answer = (route, status, body) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/**
 * SvelteKit's `__data.json` payload is devalue: a flat array whose first
 * entry maps each key to the index of its value. Enough of it for plain
 * objects of strings, booleans and null.
 * @param {unknown} root
 */
function devalue(root) {
  /** @type {unknown[]} */
  const out = [];
  /** @param {unknown} value */
  const put = (value) => {
    const at = out.length;
    out.push(null);
    if (value && typeof value === "object") {
      /** @type {Record<string, number>} */
      const refs = {};
      for (const [key, inner] of Object.entries(value)) refs[key] = inner === null ? -1 : put(inner);
      out[at] = refs;
    } else out[at] = value;
    return at;
  };
  put(root);
  return out;
}

const DOOR_LAYOUT = { type: "data", data: [{ fixtures: 1, isAdmin: 2 }, true, false], uses: {} };
const HEALTHY = { configured: true, phase: "running", contactAddress: null };
const MIXED_DOOR = { ...HEALTHY, claimed: true, methods: { local: true, oidc: true, localAccounts: true } };
const LOCAL_DOOR = { ...HEALTHY, claimed: true, methods: { local: true, oidc: false, localAccounts: true } };
const UNCLAIMED_DOOR = { ...HEALTHY, claimed: false, methods: { local: true, oidc: true } };
const APPROVAL = {
  instance: "Lawson Home", device: "Firefox on a Mac", where: "near Leeds, United Kingdom",
  requestedAt: "25 Sep 2026, 21:14 UTC", expiresAt: "25 Sep 2026, 21:29 UTC",
};

/**
 * @param {import("@playwright/test").Page} page
 * @param {{ availability?: unknown, signedOut?: boolean }} [options]
 */
async function doorAnswers(page, { availability = HEALTHY, signedOut = true } = {}) {
  await page.route("**/api/health", (route) => answer(route, 200, { status: "ready" }));
  if (availability === null) await page.route("**/api/auth/availability", (route) => route.fulfill({ status: 500, body: "" }));
  else await page.route("**/api/auth/availability", (route) => answer(route, 200, availability));
  if (signedOut) await page.route("**/api/auth/session", (route) => answer(route, 401, { error: "unauthenticated" }));
}

/**
 * Land on a database-backed page through the client router, its data stated.
 * @param {import("@playwright/test").Page} page
 * @param {string} path
 * @param {unknown} node the page's own `__data.json` node
 */
async function throughRouter(page, path, node) {
  await doorAnswers(page);
  await page.route(`**${path}/__data.json*`, (route) => answer(route, 200, { type: "data", nodes: [DOOR_LAYOUT, node] }));
  await page.goto(`${APP}/login`, { waitUntil: "load" });
  await page.waitForFunction(() => document.body.classList.contains("lit"));
  await page.evaluate((href) => {
    const link = Object.assign(document.createElement("a"), { href, id: "door-measure-go", textContent: "go" });
    document.body.append(link);
    link.click();
    link.remove();
  }, path);
  await page.waitForURL(`**${path}`);
}

/** @param {import("@playwright/test").Page} page */
async function signInCard(page) {
  await doorAnswers(page, { availability: LOCAL_DOOR });
  await page.goto(`${APP}/login`, { waitUntil: "load" });
  await page.waitForSelector("#idemail");
}

/** @param {import("@playwright/test").Page} page */
async function submitSignIn(page) {
  await page.fill("#idemail", "tom@lawson.example");
  await page.fill("#idpassword", "a fixture password");
  await page.click("#idbtn");
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
}

/** @type {{ name: string, reach: (page: import("@playwright/test").Page) => Promise<void> }[]} */
const DOOR_STATES = [
  { name: "/ (the door, signed out)", reach: async (page) => {
    await doorAnswers(page);
    await page.goto(`${APP}/`, { waitUntil: "load" });
    await page.waitForSelector("#gate");
  } },
  { name: "/login (the door with `local login`)", reach: async (page) => {
    await doorAnswers(page, { availability: MIXED_DOOR });
    await page.goto(`${APP}/login`, { waitUntil: "load" });
    await page.waitForSelector("#localopen");
  } },
  { name: "/login (local sign-in card)", reach: signInCard },
  { name: "/login (sign-in card, typing)", reach: async (page) => {
    await signInCard(page);
    await page.fill("#idemail", "tom@lawson.example");
    await page.focus("#idpassword");
  } },
  { name: "/login (sign-in refused)", reach: async (page) => {
    await signInCard(page);
    await page.route("**/api/auth/local/login", (route) => answer(route, 401, { error: { code: "credentials_invalid" } }));
    await submitSignIn(page);
    await page.waitForSelector(".err.shown");
  } },
  { name: "/login (too many attempts)", reach: async (page) => {
    await signInCard(page);
    await page.route("**/api/auth/local/login", (route) => answer(route, 429, { error: { code: "too_many_attempts" } }));
    await submitSignIn(page);
    await page.waitForSelector(".err.shown");
  } },
  { name: "/login (waiting for the email, countdown)", reach: async (page) => {
    await signInCard(page);
    const canResendAt = new Date(Date.now() + 60_000).toISOString();
    await page.route("**/api/auth/local/login", (route) => answer(route, 200, { pending: { canResendAt, limited: false } }));
    await page.route("**/api/auth/local/login/pending", (route) => answer(route, 200, { state: "pending" }));
    await submitSignIn(page);
    await page.waitForSelector(".card.waiting");
  } },
  { name: "/login (waiting, send it again)", reach: async (page) => {
    await signInCard(page);
    const canResendAt = new Date(Date.now() - 1000).toISOString();
    await page.route("**/api/auth/local/login", (route) => answer(route, 200, { pending: { canResendAt, limited: false } }));
    await page.route("**/api/auth/local/login/pending", (route) => answer(route, 200, { state: "pending" }));
    await submitSignIn(page);
    await page.waitForSelector("#resendapproval");
  } },
  { name: "/login (claim code)", reach: async (page) => {
    await doorAnswers(page, { availability: UNCLAIMED_DOOR });
    await page.goto(`${APP}/login`, { waitUntil: "load" });
    await page.waitForSelector("#claimcode");
  } },
  { name: "/login (first administrator)", reach: async (page) => {
    await doorAnswers(page, { availability: UNCLAIMED_DOOR });
    await page.route("**/api/auth/bootstrap/claim", (route) =>
      answer(route, 200, { claimed: false, methods: { local: true, oidc: true } }));
    await page.goto(`${APP}/login#claim=ABCD-EFGH-2345`, { waitUntil: "load" });
    await page.waitForSelector("#idname");
  } },
  { name: "/login (sign-in not set up)", reach: async (page) => {
    await doorAnswers(page, { availability: { configured: false, phase: "running", contactAddress: null } });
    await page.goto(`${APP}/login`, { waitUntil: "load" });
    await page.waitForFunction(() => document.body.dataset.state === "unconfigured");
  } },
  { name: "/login (waking up)", reach: async (page) => {
    await doorAnswers(page, { availability: { configured: true, phase: "starting", contactAddress: null } });
    await page.goto(`${APP}/login`, { waitUntil: "load" });
    await page.waitForFunction(() => document.body.dataset.state === "starting");
  } },
  { name: "/login (couldn't open)", reach: async (page) => {
    await doorAnswers(page, { availability: null });
    await page.goto(`${APP}/login`, { waitUntil: "load" });
    await page.waitForFunction(() => document.body.dataset.state === "failed");
  } },
  { name: "/setup/<token>", reach: async (page) => {
    await doorAnswers(page);
    await page.goto(`${APP}/setup/pocket-measure-placeholder-token`, { waitUntil: "load" });
    await page.waitForSelector("#idagain");
  } },
  { name: "/setup/<token> (link spent)", reach: async (page) => {
    await doorAnswers(page);
    await page.route("**/api/auth/local/setup", (route) => answer(route, 400, { error: { code: "setup_token_invalid" } }));
    await page.goto(`${APP}/setup/pocket-measure-placeholder-token`, { waitUntil: "load" });
    await page.fill("#idpassword", "a fixture password");
    await page.fill("#idagain", "a fixture password");
    await page.click("#idbtn");
    await page.waitForSelector(".note.after .quietline");
  } },
  { name: "/approve/<token>", reach: async (page) => {
    await throughRouter(page, "/approve/pocket-measure-placeholder-token", {
      type: "data", uses: {},
      data: devalue({ token: "pocket-measure-placeholder-token", request: { ...APPROVAL, state: "open" } }),
    });
    await page.waitForSelector("#approveyes");
  } },
  { name: "/approve/<token> (spent)", reach: async (page) => {
    await throughRouter(page, "/approve/pocket-measure-placeholder-token", {
      type: "data", uses: {}, data: devalue({ token: "pocket-measure-placeholder-token", request: null }),
    });
    await page.waitForSelector(".card.approve");
  } },
  { name: "/invite/<token> (used)", reach: async (page) => {
    await throughRouter(page, "/invite/pocket-measure-placeholder-token", {
      type: "data", uses: {}, data: devalue({ state: "used", inviterName: "Tom Lawson" }),
    });
    await page.waitForSelector(".invite-card .gate");
  } },
  { name: "/invite/<token> (someone else)", reach: async (page) => {
    await throughRouter(page, "/invite/pocket-measure-placeholder-token", {
      type: "data", uses: {}, data: devalue({ state: "mismatch", inviterName: "Tom Lawson" }),
    });
    await page.waitForSelector(".invite-card .acts");
  } },
  { name: "/logout", reach: async (page) => {
    await doorAnswers(page);
    await page.goto(`${APP}/logout`, { waitUntil: "load" });
    await page.waitForFunction(() => document.body.classList.contains("farewell"));
  } },
  { name: "404 (off the chart)", reach: async (page) => {
    await page.goto(`${APP}/pocket-measure-no-such-page`, { waitUntil: "load" });
    await page.waitForSelector(".line-b a");
  } },
  { name: "500 (another status)", reach: async (page) => {
    await throughRouter(page, "/approve/pocket-measure-placeholder-token",
      { type: "error", error: { message: "Internal Error" }, status: 500 });
    await page.waitForSelector(".stage .said");
  } },
  { name: "/maintenance (earlier updates open)", reach: async (page) => {
    await page.goto(`${APP}/maintenance`, { waitUntil: "load" });
    await page.click(".earlier summary");
  } },
];

for (const phone of PHONES) {
  test.describe(`pocket measurement at ${phone.name}: the door family`, () => {
    test.use({ viewport: phone.viewport, hasTouch: true, isMobile: true, reducedMotion: "reduce" });

    for (const state of DOOR_STATES) {
      test(`${state.name} meets the pocket floors`, async ({ page }) => {
        await state.reach(page);
        await page.evaluate(() => document.fonts.ready);
        /* reduced motion still crossfades the card in over .7s (ringcard.css) */
        await page.waitForTimeout(900);
        const problems = await page.evaluate(measure, "");
        expect(problems, problems.join("\n")).toEqual([]);
      });
    }
  });
}

/*
 * THE GRAPHIC CHECK (#1120). The floors above measure tappable elements and
 * text, so they passed a 404 whose black hole ran off both sides of the phone
 * (the owner, on a real phone: "the 404 graphic is too wide for mobile").
 * This holds the error page's main graphic -- the well, `.world > svg` -- to
 * the screen: the disc glow, the precessing disc and its rings, both 4s, and
 * every falling label at every moment of its orbit must sit inside the
 * viewport. The star fall behind it (`.infall`) is sky and bleeds by design.
 *
 * Runs in the page. Returns each part outside the viewport, as a string.
 */
function wellOverflow() {
  const svg = /** @type {SVGSVGElement} */ (document.querySelector(".world > svg"));
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  /** @type {Map<string, string>} the first place each part was caught outside */
  const out = new Map();
  /** @param {Element | null} el @param {string} what */
  const check = (el, what) => {
    if (!el) { out.set(what, `${what} is missing`); return; }
    const r = el.getBoundingClientRect();
    if (!out.has(what) && (r.left < 0 || r.top < 0 || r.right > vw || r.bottom > vh))
      out.set(what, `${what} at ${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)} of ${vw}x${vh}`);
  };
  check(svg.querySelector("circle.disc-glow"), "circle.disc-glow");
  check(svg.querySelector("g.disc-precess"), "g.disc-precess");
  /* The labels ride SMIL paths (13s, 17s, 21s): step the svg's clock through
     the longest cycle and measure each label wherever it has got to. */
  svg.pauseAnimations();
  for (let t = 0; t <= 21; t += 0.25) {
    svg.setCurrentTime(t);
    for (const text of svg.querySelectorAll("text")) check(text, `text "${text.textContent}"`);
  }
  return [...out.values()];
}

for (const phone of PHONES) {
  test.describe(`pocket measurement at ${phone.name}: the error page's graphic`, () => {
    test.use({ viewport: phone.viewport, hasTouch: true, isMobile: true });

    test(".world > svg (the gravity well) fits inside the screen", async ({ page }) => {
      await page.goto(`${APP}/pocket-measure-no-such-page`, { waitUntil: "load" });
      await page.waitForSelector(".world[data-rasterised=ready]");
      const problems = await page.evaluate(wellOverflow);
      expect(problems, problems.join("\n")).toEqual([]);
    });
  });
}
