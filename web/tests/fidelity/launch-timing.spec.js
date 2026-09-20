import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

/*
 * #873 step 1: measure the launch hand-off before anything about it changes.
 *
 * "The launch" is the create card's hand-off into the flight (Arrival.svelte,
 * `submit()`): on success the login ring shrinks from the card's 500px to the
 * login ring's own 302.4px in place while the login chrome (hidden while the
 * card showed) fades back in, both riding CSS transitions started together.
 * `body.reclaimed` starts them; `location.assign("/home")` fires 620ms later
 * (arrival.js's `markLaunch`, read back by /home's `consumeLaunch()`), and
 * /home then plays the live, un-pinned ascent (`Flight.ascend()`,
 * timeline.js's ASCENT_BASE) over its own data.
 *
 * Nothing today measures whether that hand-off actually holds 60fps. The
 * fidelity gate (screens.spec.js) freezes every CSS animation before its one
 * screenshot, by design (see its own header comment) — it can prove the
 * hand-off's start and end states are pixel-correct, never that the motion
 * between them was smooth. This spec is the other half: it drives the real,
 * live hand-off and the ascent's opening beats, and records the actual
 * requestAnimationFrame interval between every frame the browser painted.
 *
 * It makes no smoothness verdict and changes no timing, easing or transform —
 * see docs/launch-animation-timings.md for the numbers and what they
 * implicate. This file only has to keep collecting them the same way, run
 * after run.
 *
 * Where it runs changed on #1048: this is the `launch-timing` Playwright
 * project, not the `fidelity` one, so the per-merge-request visual gate no
 * longer collects it. It runs once per promotion, from the `launch_timing`
 * job in .gitlab-ci.yml, because "the same way, run after run" is exactly
 * what a shared machine could not give it.
 */

const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * Where each pack's numbers are left for something other than a human to read
 * (#1048). The console line below is still what docs/launch-animation-timings
 * .md is written from; this is the same summary as JSON, one file per pack,
 * so the `launch_timing` CI job can carry a promotion's numbers forward and
 * set the next promotion's beside them. One file per pack rather than one
 * shared file because these tests run in sequence in one worker and a shared
 * file would need locking to stay honest about that.
 */
const REPORT_DIR =
  process.env.ORBIT_LAUNCH_TIMING_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test-results", "launch-timing");

/*
 * Every pack in play (src/lib/theme.js's THEME_PACKS), because switching one
 * is cheap: screens.spec.js's `capture()` already does it by writing
 * `orbit-theme` into localStorage before the app's first paint, so this does
 * the same rather than inventing a second mechanism.
 *
 * "Both dial dialects" from the issue does NOT apply to this screen: the
 * desk/pocket split (CON-10) is a viewport media query scoped to home's own
 * dial, and grepping flight.css, ringcard.css and arrival.css for `@media`
 * turns up only `prefers-reduced-motion` — nothing viewport-conditional. The
 * create card and the ring it hands off into render one way regardless of
 * viewport, so there is no second dialect of this hand-off to measure. Said
 * plainly in docs/launch-animation-timings.md rather than left implicit.
 */
const THEME_PACKS = ["starchart", "afterdark", "clouds", "dawn", "retrograde"];

/*
 * Runs inside the page, installed before its first script so it never misses
 * an early frame. Samples performance.now() — an ABSOLUTE clock, not
 * relative to page load — on every animation frame for up to 4s of that
 * page's own wall time (bounding memory and run length rather than trusting
 * a specific beat to end on time — the whole point is not assuming that).
 * Absolute, because the create page sits idle for a few real seconds while
 * the test navigates, waits for it to settle and fills the field before ever
 * clicking Create: only frames from the click onward are the 620ms hand-off,
 * so `window.__submitAt` (set the instant before the click, below) is what
 * the analysis actually windows on, not "since this page loaded".
 *
 * `location.assign("/home")` tears the create document down mid-sequence, so
 * its samples are flushed onto sessionStorage on `pagehide` — same-origin
 * sessionStorage survives that navigation — tagged with which phase
 * collected them and the click time, if any. /home's own phase is flushed on
 * demand once the test has waited out the ascent's opening beats.
 */
function installFrameLog() {
  const KEY = "orbit-launch-frame-log";
  const phase = location.pathname === "/home" ? "home" : "create";
  /** @type {number[]} */
  const samples = [];
  let flushed = false;
  const stopAt = performance.now() + 4000;
  function tick(/** @type {number} */ t) {
    samples.push(t);
    if (t < stopAt) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  function flush() {
    if (flushed) return;
    flushed = true;
    const prior = JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
    prior.push({ phase, samples, submitAt: /** @type {any} */ (window).__submitAt ?? null });
    sessionStorage.setItem(KEY, JSON.stringify(prior));
  }
  addEventListener("pagehide", flush);
  /** @type {any} */ (window).__flushLaunchFrameLog = flush;
}

/** @param {number[]} samples absolute performance.now() rAF timestamps */
function intervalsOf(samples) {
  /** @type {number[]} */
  const out = [];
  for (let i = 1; i < samples.length; i++) out.push(samples[i] - samples[i - 1]);
  return out;
}

/** @param {number[]} values */
function summarise(values) {
  if (values.length === 0) return { count: 0, max: 0, mean: 0, over32: 0, over50: 0 };
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    count: values.length,
    max: Math.round(Math.max(...values) * 100) / 100,
    mean: Math.round((sum / values.length) * 100) / 100,
    /* >32ms: this frame missed more than one 60fps vsync (16.7ms) — a visibly
       dropped frame. >50ms: missed three or more — the kind the owner
       reported as a stutter, not just unevenness. */
    over32: values.filter((v) => v > 32).length,
    over50: values.filter((v) => v > 50).length,
  };
}

for (const pack of THEME_PACKS) {
  test(`launch hand-off frame timings — ${pack} pack`, async ({ page }) => {
    test.setTimeout(20_000);

    await page.addInitScript(installFrameLog);
    /* Same mechanism screens.spec.js's capture() uses: the app reads
       `orbit-theme` before its first paint, so the pack is in force for the
       whole hand-off rather than swapped in after layout. */
    await page.addInitScript((/** @type {string} */ chosen) => {
      try {
        localStorage.setItem("orbit-theme", chosen);
      } catch {
        /* storage refused: the default pack stands, same fallback capture() takes */
      }
    }, pack);

    await page.goto(`${APP}/?arrival=create`, { waitUntil: "load" });
    /* Same settle condition screens.spec.js's "first-run" entry uses: first
       light, the card showing, the card actually in the document. */
    await page.waitForFunction(
      () =>
        document.body.classList.contains("lit") &&
        document.body.classList.contains("showform") &&
        Boolean(document.querySelector(".card")),
    );

    await page.fill("#hhname", "Measured Household");
    await expect(page.locator("#gobtn")).toBeEnabled();
    /* The hand-off's own t=0: everything from here to `body.reclaimed`'s
       620ms is the window the issue is about. */
    await page.evaluate(() => {
      /** @type {any} */ (window).__submitAt = performance.now();
    });
    await page.click("#gobtn");

    /* The reclaim (620ms) plays, then Arrival.svelte's submit() navigates. */
    await page.waitForURL(/\/home(?:$|[/?#])/, { timeout: 5000 });
    await page.waitForLoadState("load");
    /* Lets the ascent's opening beats run live: warp (200ms), the mark's ride
       to centre (260-1340ms) and the release (430ms) all fall inside this
       window, unpinned — Flight.ascend() runs on its own real clock here,
       not the PINNED path screens.spec.js's baselines use. */
    await page.waitForTimeout(1800);

    const report = await page.evaluate(() => {
      /** @type {any} */ (window).__flushLaunchFrameLog?.();
      return JSON.parse(sessionStorage.getItem("orbit-launch-frame-log") ?? "[]");
    });

    const createPhase = report.find((/** @type {any} */ r) => r.phase === "create");
    const homePhase = report.find((/** @type {any} */ r) => r.phase === "home");
    expect(createPhase?.samples?.length ?? 0, "expected frames captured on the create page (the 620ms reclaim)").toBeGreaterThan(0);
    expect(homePhase?.samples?.length ?? 0, "expected frames captured on /home (the ascent's opening beats)").toBeGreaterThan(0);
    expect(createPhase?.submitAt, "expected the click timestamp to have been recorded").not.toBeNull();

    /* Only frames from the click onward are the hand-off; everything before
       is the test setup sitting idle on the settled card. */
    const handoffSamples = createPhase.samples.filter((/** @type {number} */ t) => t >= createPhase.submitAt);
    const createIntervals = intervalsOf([createPhase.submitAt, ...handoffSamples]);
    const homeIntervals = intervalsOf(homePhase.samples);

    const measured = {
      pack,
      create: { ...summarise(createIntervals), raw: createIntervals.map((n) => Math.round(n * 100) / 100) },
      home: { ...summarise(homeIntervals), raw: homeIntervals.map((n) => Math.round(n * 100) / 100) },
    };

    /* The report a human reads: docs/launch-animation-timings.md is built
       from this, pack by pack, run by hand and copied in — not asserted on,
       because a smoothness verdict is the next step's call, not this one's. */
    console.log(`LAUNCH_TIMING ${JSON.stringify(measured)}`);

    /* And the same numbers for the promotion gate to keep (#1048). Still no
       verdict here: the comparison is the job's, and it needs the previous
       release candidate's file to make one. */
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(join(REPORT_DIR, `${pack}.json`), `${JSON.stringify(measured, null, 2)}\n`, "utf8");
  });
}
