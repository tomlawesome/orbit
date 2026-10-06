// Screenshots of the round's pages: desk at 1440 (2×), phone at 390 (3×), and a reduced-motion desk shot.
// NODE_PATH=<a playwright install> node shots.cjs   (the round was shot with the app's own playwright 1.63)
const { chromium } = require(process.env.PW || 'playwright');
const path = require('path');
const pages = ['photosphere', 'chromosphere', 'furnace'];
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
      console.log('shot', `${name}-${tag}.png`);
      await ctx.close();
    }
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
