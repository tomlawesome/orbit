import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const here = dirname(fileURLToPath(import.meta.url));
const baselines = resolve(here, "baselines");
const artifacts = resolve(here, "../../test-results/fidelity");

/*
 * The two hosts the gate photographs. Overridable by environment, and
 * defaulted to the ports the config starts: more than one of these can be
 * running at a time on a shared machine — a screen being built, a gate being
 * re-run, an evidence capture — and a second run must be able to stand up its
 * own pair rather than silently reusing, or fighting over, somebody else's.
 * Unset, nothing about this file's behaviour changes.
 */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";
const MOCKUPS = process.env.FIDELITY_MOCKUPS ?? "http://127.0.0.1:5174";

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
    /*
     * Back to PORTING, and against a different sheet (#410, §15). The owner
     * ratified the login/logout flight verbatim on 2026-08-16 — "nothing short
     * of amazing... Ship these in that exact form" — and ruled in the same
     * breath that they are not first-run dressing: "they ship as THE login and
     * logout screens for every user, every time". So the sign-in is a fresh
     * port of first-run.html's own login layer and has to earn its baseline
     * against it.
     *
     * CORRECTED 2026-08-17. The line that used to end this note — that the
     * 2026-08-14 hero lockup was history from that ruling on — read the
     * ratification too widely. What the owner ratified verbatim was the
     * FLIGHT; the sheet's login CHROME was design/family/login.html's older
     * v18 drawing, reproduced by accident, and the owner struck it: "the
     * flight's login screen uses THE MOST RECENT APPROVED LOGIN (the 08-14
     * rulings: no ribbon, the current lockup)... there shouldnt be a footer."
     * The 08-14 hero is therefore current, in the sheet and in the app alike,
     * which is why this entry still ports against the sheet and still reads 0.
     */
    stage: "porting",
    mockup: "/design/v19/first-run.html",
    /*
     * The sheet's DEFAULT state is the first-run card standing on the login.
     * The state this screen ships is the one UNDER it, and toLogin() is the
     * sheet's own name for it — the demos toolbar's button calls exactly this.
     * Asking for it here rather than clicking keeps the selection in the gate,
     * where it is read alongside the budget.
     *
     * The same predicate settles the app, which has no such function and no
     * card: `lit` is first light, in both.
     */
    settle: () => {
      if (typeof window.toLogin === "function" && document.body.classList.contains("showform")) {
        window.toLogin();
      }
      return document.body.classList.contains("lit")
        && !document.body.classList.contains("showform");
    },
    /* The sheet's own scaffolding: the demos toolbar that replays the flight
       and switches packs, and the footer line describing the proposal. */
    mockupOnly: [".demos", ".sheet"],
  },
  {
    name: "logout",
    path: "/logout",
    /*
     * A RATIFIED REPLACEMENT, not a drift (§15, owner 2026-08-17): "the
     * descent is the default logout (re-confirmed)... the old /logout sunset
     * retires." What this entry used to watch was CON-17's sunset, owned since
     * 2026-08-14 against design/family/logout.html. That screen is gone from
     * the product, so watching it would be watching nothing.
     *
     * What /logout serves now is the surface the ratified descent lands on, so
     * this goes back to PORTING against the sheet that draws it — the same
     * sheet the login is ported from, which is the point: one drawing, two
     * ends of one session. It earns a fresh baseline against the design the
     * way every ported screen does.
     */
    stage: "porting",
    mockup: "/design/v19/first-run.html",
    /*
     * The sheet's DEFAULT state is the first-run card on the login; the state
     * this screen ships is the far end of the descent, and toDusk() is the
     * sheet's own name for it (as toLogin() is for the login's). Asking for it
     * rather than playing five seconds of flight keeps the selection in the
     * gate, where it is read alongside the budget.
     *
     * The same predicate settles the app, which has no such function: the
     * goodbye is two body classes in both, because the staging is
     * class-driven — which is also why the reduced-motion descent can drop
     * every frame of the journey and still arrive here.
     */
    settle: () => {
      if (typeof window.toDusk === "function" && !document.body.classList.contains("showdusk")) {
        window.toDusk();
      }
      return document.body.classList.contains("showdusk")
        && document.body.classList.contains("farewell");
    },
    /*
     * The one screen in the family that has only ONE reader. A signed-in
     * visitor to /logout is handed on to /home — the goodbye is the end of the
     * descent, earned by revocation, and showing "You are signed out." to a
     * live session would be a lie the interface tells before doing the work.
     * The fixture harness answers every session question with "yes, signed
     * in", which for this address is precisely the wrong reader, so the gate
     * says who is knocking.
     */
    signedOut: true,
    /* The sheet's own scaffolding: the demos toolbar that replays the flight
       and switches packs, and the footer line describing the proposal. */
    mockupOnly: [".demos", ".sheet"],
  },
  {
    /*
     * THE CREATE-SYSTEM CARD (#410, §15). The sheet's own DEFAULT state — the
     * card standing alone on the dawn, three fields, a button and air, with the
     * login screen taken off it entirely (fourth pass) — so this ports against
     * the sheet exactly as the login and the goodbye do, and reads 0.
     *
     * The arrival's stages are named through the fixture harness (see the front
     * door's +page.server.js): the fixture workspace has households, and this
     * surface belongs to a reader who has none, which is a state the workspace
     * fixture cannot be in. The fixture pins the two answers the card reads off
     * the browser — the time zone and the currency — to the sheet's own first
     * options, because a select shows what the machine running the gate
     * happens to be set to otherwise.
     */
    name: "first-run",
    path: "/?arrival=create",
    stage: "porting",
    mockup: "/design/v19/first-run.html",
    /*
     * One predicate, both sides. The sheet opens ON this state (its own
     * `toForm()` runs at load), and the app reaches it once the card is drawn:
     * first light, the card showing, and the card in the document.
     */
    settle: () => document.body.classList.contains("lit")
      && document.body.classList.contains("showform")
      && Boolean(document.querySelector(".card")),
    /* The sheet's own scaffolding: the demos toolbar that replays the flight
       and switches packs, and the footer line describing the proposal. */
    mockupOnly: [".demos", ".sheet"],
  },
  {
    /*
     * THE SEALED REJECTION, in one warm line (§15 third pass: "the rejection is
     * one line"). Its own entry because it is a ruling in its own right and
     * because it is genuinely at rest: the settle-back has finished, the field
     * wears the warm outline, and the line under it names the system that holds
     * the name and offers the road to it.
     */
    name: "first-run-error",
    path: "/?arrival=create&reject=Lawson%20Home",
    stage: "porting",
    mockup: "/design/v19/first-run.html",
    /*
     * The sheet reaches this state through its own demo (`showError()`, which
     * is what its ERROR STATE chip calls); the app reaches it through the
     * fixture's `reject` name. Both then settle the same way: rejected, and no
     * longer grounded — the climb has started, caught, and set back down.
     */
    settle: () => {
      if (typeof window.showError === "function" && !document.body.classList.contains("rejected")) {
        window.showError();
      }
      return document.body.classList.contains("lit")
        && document.body.classList.contains("rejected")
        && !document.body.classList.contains("grounded");
    },
    mockupOnly: [".demos", ".sheet"],
  },
  {
    /*
     * THE NEWCOMER'S QUESTION (§15 second pass, ruling 4), arrived at: the
     * labelled sky, the north star, and the centred "where do you belong?" with
     * its rows and its other road. The state a reader is left in at the end of
     * the climb, and the state a refresh of it serves directly — which is why
     * it can be photographed at all.
     *
     * BASELINE ONLY, deliberately, and this is the justification. The sheet
     * hand-places its five systems at literal coordinates; the app places every
     * constellation at its own identity-derived bearing (#428's law, one pure
     * function of (households, camera, viewport)), so no fixture can put the
     * app's sky where the sheet's is drawn without faking the ids that produce
     * it. And §11's labelled sky carries NO planets — "id and name are the
     * entire surface a non-member sees" — where the sheet's constellations
     * carry theirs. Both differences are ratified product, so a porting
     * comparison here would measure the ratification rather than drift. What
     * this entry guards is the app against itself from here on.
     */
    name: "newcomer",
    path: "/?arrival=newcomer",
    /* Settled once the sky is placed and the question has arrived in the space
       the count left. */
    settle: () => document.querySelectorAll(".minisys").length > 0
      && document.body.classList.contains("belong"),
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
    /*
     * THE ITEM BELT (#458, §15) — and with it, the item screen. What used to
     * stand here was an owned baseline for a view no mockup drew (#424): the
     * item's card on a bare stage, guarded against itself. The owner ruled on
     * 2026-08-16 that "this surface IS the item screen", so /item/<id> now
     * renders design/v19/item-belt.html and has to earn its baseline against
     * that sheet like every other ported screen. Back to PORTING.
     */
    name: "item",
    path: "/item/i-mot",
    stage: "porting",
    mockup: "/design/v19/item-belt.html",
    /*
     * REDUCED MOTION, deliberately, and only here.
     *
     * The belt's ambient bed drifts for ever — fifteen pixels a second, on a
     * requestAnimationFrame loop that Playwright's `animations: "disabled"`
     * does not touch, because that flag governs CSS and Web Animations and
     * not a canvas being painted by hand. Measured on the sheet: two captures
     * three seconds apart differ by 0.57%, six times the whole budget. There
     * is no moment to compare, so comparing at all means asking for the one
     * state in which the belt holds still — and that state is not a testing
     * hack, it is a ratified design state the sheet spells out in full: "the
     * band's drift holds still", the mark's breath never runs, the roll
     * becomes an instant swap. Both sides are captured in it, so what the
     * budget measures is the still both were drawn to hold.
     */
    reducedMotion: "reduce",
    /*
     * THE SHEET'S DECLARED FURNITURE, REMOVED BEFORE IT LOADS.
     *
     * The mockup's manifest is fourteen items: the six that are fixture-true
     * and eight the sheet marks `fill:1` and names, in its own header, as
     * furniture — "drawn in the same household's flavour... purely so the
     * band reads as a real manifest rather than a six-item sketch — they are
     * mockup furniture, not fixture, and the build takes the real manifest.
     * Nothing here depends on the eight existing."
     *
     * So they are cut out of the sheet's source on its way to the browser,
     * which is the same act as masking the demos rail by name — excluding a
     * known, declared difference so the budget measures real drift — except
     * that it is stricter: nothing is blanked, and everything that remains,
     * every rock and every grain of the seeded bed, has to match. It has to
     * happen at LOAD and not in `settle`, because the ambient stream is sown
     * once from its seed at first layout: splicing the furniture out
     * afterwards and rebuilding sows the bed from a stream that has already
     * run, which lands 0.51% away from the same manifest built cleanly. The
     * regex takes whole `fill:1` object literals and nothing else; if the
     * sheet ever stops carrying them it removes nothing and the comparison is
     * unchanged.
     */
    mockupTrim: (html) => html.replace(/[ \t]*\{ id:"[^"]+",[^{}]*fill:1,[^{}]*\},\r?\n/g, ""),
    /* Settled once the band has its seats and the apex has its card — every
       one of which arrives client-side, off the workspace seam. */
    settle: () =>
      document.querySelectorAll("#seats .seat").length > 0
      && Boolean(document.querySelector(".item-card h2")),
    /* The sheet's own scaffolding: the demos rail that centres each end of
       the belt and switches packs, and the footer describing the proposal. */
    mockupOnly: [".demos", "footer"],
  },
  {
    name: "administration",
    path: "/administration",
    stage: "porting",
    mockup: "/design/v19/administration.html",
    /* Settled once mission control has people and systems — client-side data. */
    settle: () => Boolean(document.querySelector(".person")) && Boolean(document.querySelector(".system svg")),
    mockupOnly: ["footer"],
  },
  {
    name: "settings",
    path: "/settings",
    stage: "porting",
    mockup: "/design/v19/settings.html",
    /* Settled once the helm has its pack cards — the data arrives client-side. */
    settle: () => document.querySelectorAll(".pack").length > 0 && Boolean(document.querySelector(".memb")),
    mockupOnly: ["footer"],
  },
  {
    name: "inbox",
    path: "/inbox",
    stage: "porting",
    mockup: "/design/v19/inbox.html",
    /* Settled once the queue has its review card — the data arrives client-side. */
    settle: () => Boolean(document.querySelector(".receipt .actions")),
    /* The mockup's empty-queue demo toolbar and self-description. */
    mockupOnly: [".demos", "footer"],
  },
  {
    name: "household",
    /* The workspace fixture's own primary household, so the screen is read in
       its OWNER state — the one the mockup draws by default. */
    path: "/household/hh-lawson-1",
    stage: "porting",
    mockup: "/design/v19/household-manage.html",
    /* Settled once the roster has arrived — every payload this screen needs is
       fetched client-side, and the sections editor lays out beside it. */
    settle: () => document.querySelectorAll(".memb").length > 0 && Boolean(document.querySelector(".sec .toggle")),
    /* The mockup's owner/non-owner state toolbar and its self-description. */
    mockupOnly: [".demos", "footer"],
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

async function capture(
  page, url, settle, mockupOnly = [], viewport = null, signedOut = false,
  { reducedMotion = null, trim = null } = {},
) {
  await page.route("https://fonts.googleapis.com/**", (route) =>
    route.fulfill({ contentType: "text/css", body: LOCAL_FONT_CSS }),
  );

  /*
   * A screen may ask to be judged at rest (the belt, #458): its band is a
   * canvas painted on requestAnimationFrame, which `animations: "disabled"`
   * cannot reach, so there is no moment to compare unless the design's own
   * reduced-motion state — in which the drift holds still — is the one asked
   * for. Applied to BOTH captures of that screen and to no other screen, so
   * the rest of the family is still judged in the motion the design has.
   */
  if (reducedMotion) await page.emulateMedia({ reducedMotion });

  /*
   * A mockup may carry data it names as furniture — rows drawn so a sheet
   * reads as a real screen, which the build is told not to reproduce. Cutting
   * them out of the source is the same act as masking a demos rail by name,
   * and stricter, because everything left has to match rather than being
   * blanked. Only ever applied to the mockup's own document.
   */
  if (trim) {
    await page.route(url, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: trim(await response.text()),
      });
    });
  }

  /*
   * WHO IS KNOCKING. The fixture harness answers every session question with
   * "signed in", because every other screen in this list is a screen only a
   * signed-in reader ever sees. The goodbye is the one that is the other way
   * round: it is what /logout serves a reader whose session is gone, and it
   * hands a live session on to /home rather than telling it that it is signed
   * out. Saying so here is not a mock of the design — it is the design's only
   * reader, stated, so the gate photographs the screen instead of the redirect.
   */
  if (signedOut) {
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"unauthenticated"}' }),
    );
  }

  /* Most of the family is drawn for a desk. The mobile dialect is drawn for a
     phone, and comparing it at 1600 wide would measure the wrong thing. */
  if (viewport) await page.setViewportSize(viewport);

  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(settle ?? (() => document.body.classList.contains("lit")));
  await page.evaluate(() => document.fonts.ready);

  /*
   * #499: the grain overlay is now rasterised once, off the main thread's
   * paint path, instead of living as a permanent SVG filter — but the
   * rasterisation is necessarily async (an <img> decode), so a capture taken
   * before it lands would photograph a blank overlay and never read the 0 px
   * this gate demands. Grain.svelte marks itself `data-rasterised="pending"`
   * at build and flips to `"ready"` in the same tick it paints the
   * background, so waiting for that is waiting for the exact frame the app
   * would show a real visitor. The mockups' own inline grain SVG carries no
   * such attribute — it never left the live-filter path this fixes — so the
   * selector matches nothing there and the wait resolves immediately.
   */
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".grain[data-rasterised]")].every(
      (el) => el.dataset.rasterised === "ready",
    ),
  );

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
        page, MOCKUPS + screen.mockup, screen.settle, screen.mockupOnly, screen.viewport,
        false, { reducedMotion: screen.reducedMotion, trim: screen.mockupTrim });
      const actual = await capture(
        page, APP + screen.path, screen.settle, [], screen.viewport, screen.signedOut,
        { reducedMotion: screen.reducedMotion });
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
      page, APP + screen.path, screen.settle, [], screen.viewport, screen.signedOut,
      { reducedMotion: screen.reducedMotion });
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
