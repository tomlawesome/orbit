// Captures round 5 (J, the notice) into shots/. Desk 1440x900, phone 390x844 at device scale 2.
// node capture.mjs   (Playwright is loaded from the orbit checkout's pnpm store; override with PW=<path>)
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || path.join(os.homedir(), 'projects/orbit/node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'));
const here = path.dirname(fileURLToPath(import.meta.url));
const url = (q) => 'file://' + path.join(here, 'j-whats-new.html') + '?' + q;

const scenes = [
  ['j-desk-member',    'scene=desk&who=member',   'desk',  false],
  ['j-desk-admin',     'scene=desk&who=admin',    'desk',  false],
  ['j-phone-member',   'scene=phone&who=member',  'phone', false],
  ['j-phone-admin',    'scene=phone&who=admin',   'phone', false],
  ['j-desk-dismissed', 'scene=desk&who=member',   'desk',  true],   // after Escape: the sky behind
];
const ctxOpts = {
  desk:  { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 },  deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const browser = await chromium.launch();
for (const [name, q, kind, esc] of scenes) {
  const ctx = await browser.newContext(ctxOpts[kind]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(name, 'page error:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error(name, 'console:', m.text()); });
  await page.goto(url(q));
  await page.waitForFunction(() => window.__ready === true);
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  if (esc) { await page.keyboard.press('Escape'); await page.waitForTimeout(400); }
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => {
    const c = document.getElementById('card').getBoundingClientRect();
    const s = document.querySelector('.scroll');
    const r = (id) => { const b = document.querySelector(id).getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; };
    return { gotit: r('#gotit'), link: r('#notes-link'), card: [Math.round(c.width), Math.round(c.height)], scrolls: s.scrollHeight > s.clientHeight, hOverflow: document.documentElement.scrollWidth > innerWidth };
  });
  await page.screenshot({ path: path.join(here, 'shots', name + '.png') });
  console.log('shot', name + '.png', 'focus=' + focused, JSON.stringify(m));
  await ctx.close();
}
await browser.close();
