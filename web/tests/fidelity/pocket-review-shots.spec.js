import { test } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOOR_STATES, PHONES, SIGNED_IN, settle } from "./pocket-states.js";

/*
 * THE REVIEW ROUND'S SCREENSHOT SET (#1120, review round step a).
 *
 * Not part of the gate: it guards nothing, it photographs. The design review
 * that follows cannot render a page, so this draws it every phone state the
 * measurement check walks (pocket-states.js) at both widths, in the default
 * theme (after dark), star-chart, and clouds for a light pack, and puts the
 * desk's baselines beside them. Viewport-sized shots of every state, plus
 * one full-page shot of each route at rest.
 *
 *   POCKET_SHOTS=1 pnpm --filter orbit-web exec playwright test \
 *     --project=fidelity tests/fidelity/pocket-review-shots.spec.js
 *
 * Writes <route>/<state>-<width>-<theme>.png and index.html under
 * POCKET_SHOTS_DIR (default /tmp/orbit-phone-vision/review).
 */
test.skip(!process.env.POCKET_SHOTS, "photographs for the review round only: set POCKET_SHOTS=1");

const OUT = process.env.POCKET_SHOTS_DIR ?? "/tmp/orbit-phone-vision/review";
const BASELINES = join(dirname(fileURLToPath(import.meta.url)), "baselines");
const THEMES = ["afterdark", "starchart", "clouds"];

/** A route's folder: `/household/hh-lawson-1` → `household-hh-lawson-1`. @param {string} route */
const slugOf = (route) => route.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-") || "door";

/**
 * Every state, signed in or at the door, in one list.
 * @type {{ slug: string, state: string, door: boolean, reach: (page: import("@playwright/test").Page) => Promise<void> }[]}
 */
const SHOTS = [
  ...SIGNED_IN.map((s) => ({ slug: slugOf(s.route), state: s.state, door: false, reach: s.reach })),
  ...DOOR_STATES.map((s) => ({ slug: s.slug, state: s.state, door: true, reach: s.reach })),
];

for (const theme of THEMES) {
  for (const phone of PHONES) {
    test.describe(`review shots · ${theme} · ${phone.name}`, () => {
      test.use({ viewport: phone.viewport, hasTouch: true, isMobile: true });

      for (const shot of SHOTS) {
        test(`${shot.slug} · ${shot.state}`, async ({ page }) => {
          /* The door is photographed where it settles, as it is measured. */
          if (shot.door) await page.emulateMedia({ reducedMotion: "reduce" });
          await page.addInitScript((id) => { try { localStorage.setItem("orbit-theme", id); } catch { /* none */ } }, theme);
          await shot.reach(page);
          await settle(page);
          if (shot.door) await page.waitForTimeout(900);
          const dir = join(OUT, shot.slug);
          mkdirSync(dir, { recursive: true });
          await page.screenshot({ path: join(dir, `${shot.state}-${phone.name}-${theme}.png`) });
          if (shot.state === "rest")
            await page.screenshot({ path: join(dir, `rest-full-${phone.name}-${theme}.png`), fullPage: true });
        });
      }
    });
  }
}

/* The desk's own baselines, which route each phone screen answers to. */
const DESK = /** @type {Record<string, string[]>} */ ({
  home: ["home.png", "mobile.png"], item: ["item.png"], "item-i-mot": ["item.png"], create: ["create.png"],
  inbox: ["inbox.png"], "household-hh-lawson-1": ["household.png"], "household-hh-seaside-4551": ["household.png"],
  settings: ["settings.png"], "settings-mail": ["relay.png"], administration: ["administration.png"],
  door: ["first-run.png", "first-run-error.png", "newcomer.png"],
  login: ["login.png", "door-mixed.png", "door-local.png", "door-identity.png", "door-claim.png"],
  setup: ["setup.png"], logout: ["logout.png"], 404: ["notfound.png"], maintenance: ["maintenance.png", "maintenance-mobile.png"],
});

test("the review index", async () => {
  mkdirSync(join(OUT, "desk"), { recursive: true });
  const desk = readdirSync(BASELINES).filter((f) => f.endsWith(".png")).sort();
  for (const file of desk) copyFileSync(join(BASELINES, file), join(OUT, "desk", file));

  const esc = (/** @type {string} */ s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const figure = (/** @type {string} */ src, /** @type {string} */ caption, wide = false) =>
    `<figure${wide ? ' class="wide"' : ""}><a href="${esc(src)}"><img loading="lazy" src="${esc(src)}" alt="${esc(caption)}"></a><figcaption>${esc(caption)}</figcaption></figure>`;

  const order = [...new Set(SHOTS.map((s) => s.slug))].filter((slug) => existsSync(join(OUT, slug)));
  const sections = order.map((slug) => {
    const files = new Set(readdirSync(join(OUT, slug)));
    const states = [...new Set(SHOTS.filter((s) => s.slug === slug).map((s) => s.state))];
    const rows = states.map((state) => {
      const shots = PHONES.flatMap((phone) => THEMES.map((theme) => [`${state}-${phone.name}-${theme}.png`, `${state} · ${phone.name} · ${theme}`]))
        .filter(([f]) => files.has(f))
        .map(([f, caption]) => figure(`${slug}/${f}`, caption));
      return `<h3>${esc(state)}</h3><div class="strip">${shots.join("")}</div>`;
    });
    const full = PHONES.flatMap((phone) => THEMES.map((theme) => [`rest-full-${phone.name}-${theme}.png`, `full page · ${phone.name} · ${theme}`]))
      .filter(([f]) => files.has(f)).map(([f, caption]) => figure(`${slug}/${f}`, caption));
    const deskShots = (DESK[slug] ?? []).map((f) => figure(`desk/${f}`, `desk · ${f}`, true));
    return `<section id="${esc(slug)}"><h2>${esc(slug)}</h2>`
      + (deskShots.length ? `<h3>the desk</h3><div class="strip">${deskShots.join("")}</div>` : "")
      + rows.join("")
      + (full.length ? `<h3>full page at rest</h3><div class="strip">${full.join("")}</div>` : "")
      + "</section>";
  });
  const toc = order.map((slug) => `<a href="#${esc(slug)}">${esc(slug)}</a>`).join(" · ");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Orbit phone review · screenshots</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:24px;background:#111;color:#ddd}
a{color:#8cf} h2{margin:48px 0 8px;border-bottom:1px solid #333;padding-bottom:4px} h3{margin:20px 0 6px;font-size:14px;color:#aaa}
.strip{display:flex;gap:12px;overflow-x:auto;align-items:flex-start;padding-bottom:8px}
figure{margin:0;flex:none} figure img{width:195px;border:1px solid #333;display:block} figure.wide img{width:480px}
figcaption{font:12px ui-monospace,monospace;color:#999;margin-top:4px;max-width:195px} figure.wide figcaption{max-width:480px}
</style></head><body>
<h1>Orbit phone review · every phone state at 390x844 and 360x780</h1>
<p>Captions read state · width · theme. Themes: afterdark (the default), starchart, clouds (a light pack). The desk's baselines lead each route, where it has one; all of them are at the end.</p>
<p>${toc} · <a href="#desk">desk baselines</a></p>
${sections.join("\n")}
<section id="desk"><h2>desk baselines</h2><div class="strip" style="flex-wrap:wrap">${desk.map((f) => figure(`desk/${f}`, f, true)).join("")}</div></section>
</body></html>`;
  writeFileSync(join(OUT, "index.html"), html);
});
