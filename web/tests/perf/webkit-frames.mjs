#!/usr/bin/env node
/**
 * #764 step 3 — a small, reusable WebKit frame-interval sampler.
 *
 * There is no committed WebKit profiling harness in this repo (the one used
 * for #498/#499 was ad-hoc and is gone). This is the measurable replacement:
 * point it at a running page and it prints how long the paint loop is
 * actually taking, on the one engine (Safari/WebKit) that the underlying bug
 * report is about — Chromium does not reproduce the same SVG-filter software
 * rasterisation cost, so a Chromium-only measurement cannot speak to it.
 *
 * Not a Playwright test/spec (no test runner, no assertions): a plain script
 * so it can be pointed at any URL — the 404 before a change, after it, with
 * animations forced off as a floor, or an unrelated screen for comparison —
 * without needing a fixture or a baseline.
 *
 * Uses @playwright/test's `webkit` export rather than the bare "playwright"
 * package: the latter is not a declared dependency here (only
 * "@playwright/test" is), and adding it would mean touching package.json,
 * which this script deliberately does not. @playwright/test re-exports the
 * exact same WebKit BrowserType from the same playwright-core install, so
 * this is not a different browser build, just a different import path.
 *
 * Usage:
 *   node tests/perf/webkit-frames.mjs <url> [--no-animation] [--duration=5000] [--ready=<selector>]
 *
 * `--no-animation` injects `* { animation: none !important; transition: none
 * !important }` after load, as the floor a page's paint loop can reach with
 * every CSS animation stopped (SVG SMIL and any live filter still paints,
 * but nothing is moving under it) — the counterpart it needs, run (b) vs (c)
 * in #764's own request, is not "does animation cost something" (it always
 * does) but "is the live *filtered* animation the dominant cost", which only
 * a WebKit sample of both states can show.
 *
 * `--ready=<selector>` waits for a CSS selector to match before sampling
 * starts, for screens whose own async rasterisation would otherwise still be
 * running (a synchronous decode/canvas-draw pass) inside the sample window
 * and read as steady-state animation cost when it is really one-time setup.
 * The login screen is the case this exists for: Dawn.svelte builds seven
 * separate rasters via Promise.all and marks itself the same way Grain.svelte
 * and this screen's own +error.svelte do, `data-rasterised="pending"` then
 * `"ready"` on its `.world` host — so `--ready='.world[data-rasterised="ready"]'`
 * is the selector that makes a login sample actually steady-state.
 *
 * Point it at a real running server — this script does not start one. See
 * playwright.config.js / tests/fidelity/screens.spec.js for how the adapter-
 * node build is stood up (`pnpm build && node build/index.js`, with
 * ORBIT_FIXTURES=1 so the fixture /api routes answer); the same recipe run
 * by hand against a free port is enough here.
 */
import { webkit } from "@playwright/test";

function parseArgs(argv) {
  const url = argv[0];
  let noAnimation = false;
  let duration = 5000;
  let ready = null;
  for (const arg of argv.slice(1)) {
    if (arg === "--no-animation") noAnimation = true;
    else if (arg.startsWith("--duration=")) duration = Number(arg.slice("--duration=".length));
    else if (arg.startsWith("--ready=")) ready = arg.slice("--ready=".length);
  }
  return { url, noAnimation, duration, ready };
}

const { url, noAnimation, duration, ready } = parseArgs(process.argv.slice(2));
if (!url) {
  console.error(
    "usage: node tests/perf/webkit-frames.mjs <url> [--no-animation] [--duration=5000] [--ready=<selector>]",
  );
  process.exit(1);
}

const browser = await webkit.launch({ headless: true });
try {
  /* 1600x1000 matches the design's own viewBox (family.css screens, this
     project's fidelity gate) so every sampled page is measured at the same
     size, whether or not that is its "natural" viewport — comparability
     across screens matters more than any one screen's own layout here. */
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  await page.goto(url, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  if (ready) await page.waitForSelector(ready, { state: "attached" });

  if (noAnimation) {
    await page.addStyleTag({ content: "* { animation: none !important; transition: none !important; }" });
    /* Let the forced style actually take effect — one rAF turn is enough
       for the browser to have applied it before sampling starts. */
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
  }

  const stats = await page.evaluate(
    (durationMs) =>
      new Promise((resolve) => {
        const intervals = [];
        let last;
        let start;
        function tick(now) {
          if (start === undefined) {
            start = now;
            last = now;
            requestAnimationFrame(tick);
            return;
          }
          intervals.push(now - last);
          last = now;
          if (now - start < durationMs) requestAnimationFrame(tick);
          else resolve(intervals);
        }
        requestAnimationFrame(tick);
      }),
    duration,
  );

  const sorted = [...stats].sort((a, b) => a - b);
  const mean = stats.reduce((a, b) => a + b, 0) / stats.length;
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const max = sorted[sorted.length - 1];

  console.log(
    JSON.stringify(
      {
        url,
        noAnimation,
        ready,
        durationMs: duration,
        frameCount: stats.length,
        meanMs: Number(mean.toFixed(3)),
        p95Ms: Number(p95.toFixed(3)),
        maxMs: Number(max.toFixed(3)),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
