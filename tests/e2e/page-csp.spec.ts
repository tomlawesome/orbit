import { expect, test, type Page } from "@playwright/test";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { cleanupHousehold, sessionHeaders } from "./support/households";
import { seedHousehold, signIn } from "./support/signed-in";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * #1411 (owner answer 5a, 2026-10-14): every page carries a strict
 * Content-Security-Policy, and the product still works under it.
 *
 * The policy is SvelteKit's `kit.csp` in mode "auto": a nonce in a header for
 * the server-rendered pages, hashes in a <meta> tag for the prerendered ones
 * (/login, /logout, /auth/error). It allows only the page's own origin for
 * scripts (no 'unsafe-inline', no 'unsafe-eval'), keeps 'unsafe-inline' for
 * styles, and lets images take data: and blob:.
 *
 * Two halves:
 *   - THE WALK: a `securitypolicyviolation` listener is installed before the
 *     page's first script (addInitScript), and the reader walks `/`, `/home`,
 *     `/inbox`, `/create`, `/settings`, `/settings/mail`, `/administration`,
 *     `/about` and the first household's page signed in, then `/login` signed
 *     out. Not one violation is seen. A walk alone would pass on a site with
 *     no policy at all, so each page is also proven to ENFORCE one, by the
 *     control below.
 *   - THE CONTROL: a script element injected with inline text does not run,
 *     and it raises a violation. That is the proof that the listener works and
 *     that the policy is in force on the page it was run on: a header page and
 *     a <meta> page.
 *
 * The product's own inline code (the pre-paint theme script in app.html, kit's
 * bootstrap) is allowed by nonce or hash, never by 'unsafe-inline'; styles are
 * not part of what this proves, because style-src keeps 'unsafe-inline'.
 */

type Violation = {
  effectiveDirective: string;
  violatedDirective: string;
  blockedURI: string;
  sourceFile: string;
  lineNumber: number;
  sample: string;
};

type Watched = Window & { __cspViolations?: Violation[]; __orbitInlineRan?: boolean };

/** Listens from the first script of every document the page loads. */
async function watchViolations(page: Page) {
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    (window as Watched).__cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push({
        effectiveDirective: event.effectiveDirective,
        violatedDirective: event.violatedDirective,
        blockedURI: event.blockedURI,
        sourceFile: event.sourceFile,
        lineNumber: event.lineNumber,
        sample: event.sample,
      });
    });
  });
}

const violationsOn = (page: Page): Promise<Violation[]> =>
  page.evaluate(() => [...((window as Watched).__cspViolations ?? [])]);

/**
 * What says a page has mounted, beyond `load`. The app sets no one marker on
 * every page, so a page's own is used where it has one:
 *   - /home sets `body[data-home-ready]` as the last step of its mount;
 *   - /create sets `#card[data-ready]` (the wait gotoCreate uses);
 *   - /login is prerendered and has no main landmark: its door picks its face
 *     (gate, local card or claim card) only after onMount has read
 *     /api/auth/availability, so one of those being visible says it mounted.
 * Every other page is held to its main landmark being visible.
 */
const MAIN_LANDMARK = 'main:visible, [role="main"]:visible';
const READY_MARKER: Record<string, { selector: string; state: "attached" | "visible" }> = {
  "/home": { selector: 'body[data-home-ready="true"]', state: "attached" },
  "/create": { selector: "#card[data-ready]", state: "attached" },
  "/login": { selector: "#gate, #localopen, #idemail, #claimcode", state: "visible" },
};

/**
 * Lands on a page and waits for a real condition, not a sleep: the `load`
 * event, then the page's ready marker, then (where it has one) its main
 * landmark visible. The address is checked too, because a gated page that
 * redirects (no household sends every one to the arrival) would otherwise be
 * read as the page it is not. A wait that times out fails the walk, so a page
 * that never settles is never read as clean.
 */
async function visit(page: Page, path: string) {
  await page.goto(path, { waitUntil: "load" });
  if (path !== "/") expect(new URL(page.url()).pathname, `${path}: the page redirected away`).toBe(path);
  const marker = READY_MARKER[path];
  if (marker) {
    await page.locator(marker.selector).first().waitFor({ state: marker.state, timeout: 30_000 });
  }
  if (path !== "/login") {
    await expect(page.locator(MAIN_LANDMARK).first(), `${path}: no main landmark became visible`).toBeVisible({ timeout: 30_000 });
  }
}

/**
 * The control: an inline script, put in the page the way an injection would.
 * Under the policy it must not run, and it must raise a script-src violation.
 */
async function expectInlineScriptRefused(page: Page, where: string) {
  const before = (await violationsOn(page)).length;
  await page.evaluate(() => {
    const element = document.createElement("script");
    element.textContent = "window.__orbitInlineRan = true;";
    document.head.appendChild(element);
  });
  await expect
    .poll(async () => (await violationsOn(page)).length, { message: `${where}: the injected inline script raised no violation`, timeout: 5_000 })
    .toBeGreaterThan(before);
  const raised = (await violationsOn(page)).slice(before);
  expect(raised.some((violation) => violation.effectiveDirective.startsWith("script-src")), `${where}: ${JSON.stringify(raised)}`).toBe(true);
  expect(await page.evaluate(() => (window as Watched).__orbitInlineRan === true), `${where}: the injected inline script ran`).toBe(false);
}

const SIGNED_IN_PAGES = ["/", "/home", "/inbox", "/create", "/settings", "/settings/mail", "/administration", "/about"];

test("every page, signed in and signed out, runs without one CSP violation, and enforces a policy", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await watchViolations(page);
  await signIn(page, { returnTo: "/home" });
  const household = await seedHousehold(page, "CspWalk");

  try {
    /* The first household: the one this reader just made is the only one there is. */
    const walk = [...SIGNED_IN_PAGES, `/household/${household.id}`];
    for (const path of walk) {
      await visit(page, path);
      expect(await violationsOn(page), `a CSP violation on ${path}`).toEqual([]);
      await expectInlineScriptRefused(page, path);
    }

    const signedOut = await browser.newContext();
    try {
      const outPage = await signedOut.newPage();
      await watchViolations(outPage);
      await visit(outPage, "/login");
      await expect(outPage.locator('meta[http-equiv="content-security-policy" i]')).toHaveCount(1);
      expect(await violationsOn(outPage), "a CSP violation on /login, signed out").toEqual([]);
      await expectInlineScriptRefused(outPage, "/login");
    } finally {
      await signedOut.close();
    }
  } finally {
    await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
  }
});

test("control, a header page: an inline script injected into /about does not run and raises a violation", async ({ page }) => {
  test.setTimeout(120_000);
  await watchViolations(page);
  await signIn(page, { returnTo: "/about" });
  /* A household first: with none, every gated page (/about too) is answered 303
     to the arrival, and this control would run on the arrival, not /about. */
  const household = await seedHousehold(page, "CspAbout");
  try {
    await visit(page, "/about");
    expect(await violationsOn(page), "the page itself is clean before the injection").toEqual([]);
    await expectInlineScriptRefused(page, "/about");
  } finally {
    await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
  }
});

test("control, a <meta> page: an inline script injected into /login does not run and raises a violation", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await watchViolations(page);
    await visit(page, "/login");
    await expect(page.locator('meta[http-equiv="content-security-policy" i]')).toHaveCount(1);
    expect(await violationsOn(page), "the page itself is clean before the injection").toEqual([]);
    await expectInlineScriptRefused(page, "/login");
  } finally {
    await context.close();
  }
});
