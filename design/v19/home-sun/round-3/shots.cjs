// Screenshots of the round's pages: desk at 1440 (2×), phone at 390 (3×), a reduced-motion desk shot,
// and the hover state of one desk cell per pack (3×, element only).
// PW=/home/codex/projects/orbit/node_modules/.pnpm/playwright@1.63.0/node_modules/playwright node shots.cjs
const { chromium } = require(process.env.PW || 'playwright');
const path = require('path');
const pages = (process.env.PAGES || 'orbit,feather,weighted').split(',');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const name of pages) {
    const url = 'file://' + path.join(__dirname, name + '.html');
    for (const [tag, w, dpr, reduce] of [['desk', 1440, 2, false], ['phone', 390, 3, false], ['desk-still', 1440, 2, true]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: dpr, reducedMotion: reduce ? 'reduce' : 'no-preference' });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.error(name, tag, 'page error:', e.message));
      await page.goto(url);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1800);
      await page.screenshot({ path: path.join(__dirname, 'shots', `${name}-${tag}.png`), fullPage: true });
      const fits = await page.$$eval('a.sun-link', (as) => as.map((a) => `${a.id}: ${a.dataset.fit}`));
      console.log('shot', `${name}-${tag}.png`, tag === 'desk' ? '\n  ' + fits.join('\n  ') : '');
      if (tag === 'desk') {
        for (const pack of ['starchart', 'dawn', 'retrograde']) {
          const cell = page.locator(`#${pack}-desk-short`).locator('xpath=ancestor::div[contains(@class,"stage")]');
          await cell.hover({ position: { x: 160, y: 150 } });
          await page.waitForTimeout(500);
          await cell.screenshot({ path: path.join(__dirname, 'shots', `${name}-hover-${pack}.png`) });
          console.log('shot', `${name}-hover-${pack}.png`);
        }
      }
      await ctx.close();
    }
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
