import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * #1405: the screen a member sees when Orbit holds no usable encryption key.
 * One route, /maintenance, with `kind: "key"` (the fixture harness draws it
 * with ?kind=key, and ?kind=key&contact=1 for the variant that names the
 * instance's public contact address). Same sky and type as the operator's
 * window screen; the words are the design's (design-1405 section 6), and the
 * rules about what it must NOT say are as much the point as what it does:
 * no "back by" time and no timeline (nothing says when the key will return),
 * no counts, no mechanics, no setting names.
 *
 * Run on the desk and on the phone (AGENTS.md: every screen on both layouts).
 * The apostrophe is compared as a straight one; the screen may use the
 * typographic one, as the rest of Orbit's copy does. The heading is compared
 * without case: innerText applies the screen's text-transform, and the words,
 * not their capitals, are what the design fixes.
 */

const LAYOUTS = [
  { label: "desk", width: 1280, height: 800 },
  { label: "pocket", width: 400, height: 850 },
];

/** @param {string} text */
const straight = (text) => text.replace(/[‘’]/gu, "'").replace(/\s+/gu, " ").trim();

const HEADING = "locked — back once the key is restored";
const FIRST = "Orbit's encryption key isn't available, so it can't open anyone's records or sign anyone in right now.";
const SECOND = "Nothing is lost. Everything is intact and waiting. An administrator needs to fix this on the server Orbit runs on — it can't be done from here, and signing in won't help until it's done.";
/** @param {string} address */
const ADDRESS_LINE = (address) => `If you're not sure who that is, write to ${address}.`;

for (const layout of LAYOUTS) {
  test.describe(`the key screen on the ${layout.label}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: layout.width, height: layout.height });
    });

    test("says what the design says, word for word, without an address", async ({ page }) => {
      const response = await page.goto(`${APP}/maintenance?kind=key`, { waitUntil: "load" });
      expect(response?.ok() || response?.status() === 503).toBe(true);

      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      expect(straight(await page.getByRole("heading", { level: 1 }).innerText()).toLowerCase()).toBe(HEADING);
      const text = straight(await page.locator("main, body").first().innerText());
      expect(text).toContain(FIRST);
      expect(text).toContain(SECOND);
      expect(text).not.toContain("not sure who that is");
      expect(text).not.toMatch(/@/u);
    });

    test("names the public contact address when there is one", async ({ page }) => {
      await page.goto(`${APP}/maintenance?kind=key&contact=1`, { waitUntil: "load" });

      const text = straight(await page.locator("main, body").first().innerText());
      expect(text).toContain(FIRST);
      expect(text).toContain(SECOND);
      const address = text.match(/write to (\S+@\S+?)\.(?:\s|$)/u)?.[1];
      expect(address, "the contact line names no address").toBeTruthy();
      expect(text).toContain(ADDRESS_LINE(address ?? ""));
    });

    test("promises no return time, no timeline and no earlier updates", async ({ page }) => {
      await page.goto(`${APP}/maintenance?kind=key&contact=1`, { waitUntil: "load" });

      const text = straight(await page.locator("body").innerText()).toLowerCase();
      for (const forbidden of ["back by", "expected", "earlier updates", "scheduled", "started", "update"]) {
        expect(text, `the key screen must not say "${forbidden}"`).not.toContain(forbidden);
      }
      await expect(page.locator(".earlier")).toHaveCount(0);
      await expect(page.locator("time")).toHaveCount(0);
    });

    test("names no setting, key id or command", async ({ page }) => {
      await page.goto(`${APP}/maintenance?kind=key`, { waitUntil: "load" });

      const text = await page.locator("body").innerText();
      expect(text).not.toMatch(/DOCUMENT_KEK|OPERATOR_ALERT_ADDRESS|docker|\.env/iu);
      expect(text).not.toMatch(/\b[0-9a-f]{24}\b/u);
    });

    /*
     * Owner decision on #1405 (9a): with no alert address set, the container log
     * is the alert, and the maintenance screen itself tells the administrator to
     * look there. Design section 6 leaves the line out; the owner's answer
     * wins, so it is asserted here, loosely (it has to say "log" and be about
     * the server), until the copy is ratified.
     */
    test("tells an administrator where to look: the server's log (owner decision 9a)", async ({ page }) => {
      await page.goto(`${APP}/maintenance?kind=key`, { waitUntil: "load" });

      const text = straight(await page.locator("body").innerText()).toLowerCase();
      expect(text).toMatch(/\blogs?\b/u);
    });

    test("does not spill sideways", async ({ page }) => {
      await page.goto(`${APP}/maintenance?kind=key&contact=1`, { waitUntil: "load" });

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, "the key screen scrolls sideways").toBeLessThanOrEqual(0);
    });
  });
}
