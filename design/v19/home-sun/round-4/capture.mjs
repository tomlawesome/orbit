// Captures every scene of round 4 into shots/. Desk at 1600x1000, phone at 390x844.
// PW=<orbit checkout>/node_modules/playwright node capture.mjs   (PW unset: plain 'playwright'; chromium.launch() needs no options)
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const url = (f, q = '') => 'file://' + path.join(here, f) + (q ? '?' + q : '');

const scenes = [
  ['g-desk-defaults',    'g-log-tuner.html',           '',                          'desk'],
  ['g-desk-tau14-all',   'g-log-tuner.html',           'tau=14&labels=all',         'desk'],
  ['g-desk-linear',      'g-log-tuner.html',           'mode=linear',               'desk'],
  ['g-phone',            'g-log-tuner.html',           'scene=phone',               'phone'],
  ['h-desk',             'h-importance-weights.html',  '',                          'desk'],
  ['h-phone',            'h-importance-weights.html',  'scene=phone',               'phone'],
  ['i-desk',             'i-importance-hues.html',     '',                          'desk'],
  ['i-phone',            'i-importance-hues.html',     'scene=phone',               'phone'],
];
// Optional extra scenes, written as <name>.png: the warning-date view and reduced motion.
const extras = [
  ['g-desk-warning-all', 'g-log-tuner.html',           'driver=warn&labels=all',    'desk', false],
  ['h-desk-reduced',     'h-importance-weights.html',  '',                          'desk', true],
];

const size = { desk: { width: 1600, height: 1000 }, phone: { width: 390, height: 844 } };
const browser = await chromium.launch();
let n = 0;
for (const [name, file, q, kind, reduce = false] of [...scenes, ...(process.env.EXTRAS === '0' ? [] : extras)]) {
  const ctx = await browser.newContext({ viewport: size[kind], reducedMotion: reduce ? 'reduce' : 'no-preference' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(name, 'page error:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error(name, 'console:', m.text()); });
  await page.goto(url(file, q));
  await page.waitForFunction(() => window.__ready === true);
  // Freeze the importance pulse at 0.9 s into its 2 s cycle so the shot shows the ring mid-expansion.
  await page.evaluate(() => document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 900; }));
  await page.waitForTimeout(150);
  const crowded = await page.evaluate(() => [...document.querySelectorAll('[data-crowded]')].map((e) => e.dataset.crowded).filter(Boolean).join(','));
  await page.screenshot({ path: path.join(here, 'shots', name + '.png') });
  console.log('shot', name + '.png', crowded ? 'CROWDED: ' + crowded : '');
  n++;
  await ctx.close();
}
await browser.close();
console.log(n, 'shots');
