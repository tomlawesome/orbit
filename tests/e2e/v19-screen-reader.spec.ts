import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { householdRegister, sessionHeaders } from "./support/households";

/**
 * #496: a screen-reader walkthrough of the core journeys.
 *
 * A real screen reader needs a human in the loop, so this is the automated
 * proxy: for every core-journey screen, signed in, it reads back what the
 * browser's own accessibility engine would announce (Playwright's
 * `getByRole`/`toHaveAccessibleName` are backed by the same accessible-name
 * computation a screen reader uses, not by `title` text) and writes the raw
 * ARIA tree to `test-results/aria/<route>.txt` so a human can read the same
 * thing back in plain text.
 *
 * Criterion 3 (decorative art) does NOT re-prove the home dial: that is
 * tests/e2e/v19-chart-accessibility.spec.ts's job, in detail neither this
 * file nor a second pass over the same markup should repeat. This file only
 * asserts the OTHER decorative backdrops each screen carries (the `.sky` /
 * `.backdrop` / `.satellites` starfields), plus whatever the dial spec does
 * not cover.
 *
 * Data is seeded once for the whole file (`test.beforeAll`, mirroring
 * v19-tour.spec.ts's own setup/teardown split) because every read-only
 * journey below shares one household and one item; only the final journey
 * (signing out) is destructive, so it runs last and cleanup runs afterwards
 * on a fresh session, exactly as v19-tour.spec.ts's `afterAll` does.
 */

const READER = "Orbit Administrator";
const NAME_PREFIX = "screen-reader-";

const ROLES_NEEDING_NAMES = [
  "button", "link", "textbox", "combobox", "checkbox", "switch", "tab", "menuitem",
] as const;

/** Text that must never appear in a live status/notice region (#411). */
const UNBOUNDED_TEXT_PATTERNS: [RegExp, string][] = [
  [/\b\d+\.\d+\.\d+\b/, "a version number"],
  [/\/(home|app|var|usr|srv|etc)\//, "a filesystem path"],
  [/\bat [\w./]+:\d+:\d+\b/, "a stack-trace frame"],
  [/\bError:\s/, "a raw error prefix"],
];

async function signIn(page: Page, returnTo = "/home") {
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("link", { name: READER }).click();
  // The click starts a redirect chain through the identity provider and back
  // through /api/auth/callback, which is what actually sets the session
  // cookie -- proceeding before it lands (as every other spec's idiom does)
  // races page.request calls against a cookie that is not there yet.
  const escaped = returnTo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page.waitForURL(new RegExp(`${escaped}$`), { timeout: 30_000 });
}

/**
 * Every role the criterion cares about, across the whole page, must be
 * named. Soft assertions: one unnamed control should not hide the rest, so
 * a single run of this walkthrough surfaces every gap on the screen rather
 * than only the first.
 */
async function assertEveryControlIsNamed(page: Page, screen: string) {
  for (const role of ROLES_NEEDING_NAMES) {
    const locator = page.getByRole(role);
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const control = locator.nth(index);
      await expect.soft(control, `${screen}: ${role} #${index} has no accessible name`).toHaveAccessibleName(/\S/);
    }
  }
}

/** Criterion 2: one main, one h1, and no skipped heading level. */
async function assertLandmarksAndHeadings(page: Page, screen: string) {
  const main = page.locator('main, [role="main"]');
  await expect.soft(main, `${screen}: expected exactly one main landmark`).toHaveCount(1);

  const h1 = page.locator("h1");
  await expect.soft(h1, `${screen}: expected exactly one h1`).toHaveCount(1);

  const levels = await page.locator("h1, h2, h3, h4, h5, h6").evaluateAll((elements) =>
    elements.map((element) => Number(element.tagName.slice(1))),
  );
  let previous = 0;
  for (const level of levels) {
    if (previous > 0 && level > previous + 1) {
      expect.soft(level, `${screen}: heading level skipped, from h${previous} to h${level} (order: ${levels.join(",")})`)
        .toBeLessThanOrEqual(previous + 1);
    }
    previous = level;
  }
}

/** Criterion 4: a live region carries role=status/aria-live, and its text is bounded. */
async function assertLiveRegionIsSafe(region: Locator, screen: string, label: string) {
  const role = await region.getAttribute("role");
  const live = await region.getAttribute("aria-live");
  expect.soft(role === "status" || role === "alert" || live !== null, `${screen}: ${label} has neither role=status/alert nor aria-live`).toBe(true);

  const text = (await region.innerText()).trim();
  for (const [pattern, description] of UNBOUNDED_TEXT_PATTERNS) {
    expect.soft(pattern.test(text), `${screen}: ${label} text "${text}" looks like it leaked ${description}`).toBe(false);
  }
}

async function writeSnapshot(page: Page, testInfo: TestInfo, route: string) {
  const snapshot = await page.locator("body").ariaSnapshot();
  // One file per route per project (desktop and mobile both walk every
  // screen, and /home in particular has two dialects worth reading
  // separately), at test-results/aria/<route>--<project>.txt.
  // testInfo.outputPath() itself refuses to leave its own per-test
  // subdirectory, so the flat, human-browsable "aria" folder the task asks
  // for is built from testInfo.project.outputDir -- the same test-results
  // root outputPath is rooted at -- rather than through outputPath itself.
  const path = join(testInfo.project.outputDir, "aria", `${route}--${testInfo.project.name}.txt`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, snapshot, "utf8");
}

/**
 * One screen, fully worked: snapshot written, every named-control criterion
 * checked, landmarks and headings checked. Screen-specific extras (criteria
 * 3/4/5) are layered on by the caller after this returns.
 */
async function walkScreen(page: Page, testInfo: TestInfo, route: string) {
  await writeSnapshot(page, testInfo, route);
  await assertEveryControlIsNamed(page, route);
  await assertLandmarksAndHeadings(page, route);
}

const households = householdRegister();
let householdId: string;
let householdName: string;
let itemId: string;

/*
 * Deliberately NOT serial mode: this is a walkthrough of every core-journey
 * screen, so one screen failing its promise must not hide whatever the rest
 * have to say. Serial mode's own failure behaviour (skip everything after
 * the first failing test) is right for v19-tour.spec.ts's journeys, which
 * build on each other's state, but wrong here -- each of these is an
 * independent screen with the one exception (sign-out, which must run
 * last) handled by file order under this suite's single worker.
 */
test.describe("#496 screen-reader walkthrough of the core journeys", () => {
  // Soft assertions mean a screen with several real gaps (e.g. /create's
  // four unnamed form controls) keeps checking rather than stopping at the
  // first one -- each failing check still pays its own retry-until-timeout
  // cost, and on a screen with many gaps that sum passes the default 30s
  // budget before every control has been read. 90s gives the walkthrough
  // room to finish naming every gap it finds, not to tolerate flakiness.
  test.beforeEach(() => {
    test.setTimeout(90_000);
  });

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await signIn(page);
      householdId = randomUUID();
      itemId = randomUUID();
      const sectionId = randomUUID();
      householdName = `${NAME_PREFIX}${randomUUID()}`;
      const headers = await sessionHeaders(page);
      const createHousehold = await page.request.post("/api/workspace/commands", {
        headers,
        data: {
          type: "household.create",
          household: {
            id: householdId,
            name: householdName,
            timezone: "Europe/London",
            currency: "GBP",
            memberCount: 1,
            canManage: true,
            onboardingComplete: true,
            sections: [{ id: sectionId, name: "Home", icon: "home", accent: "sage", visible: true }],
            items: [],
          },
        },
      });
      if (!createHousehold.ok()) throw new Error(`household.create failed: ${createHousehold.status()}`);
      households.track({ id: householdId, name: householdName });

      const upsertItem = await page.request.post("/api/workspace/commands", {
        headers,
        data: {
          type: "item.upsert",
          householdId,
          item: {
            id: itemId,
            sectionId,
            title: `${NAME_PREFIX}item ${randomUUID().slice(0, 8)}`,
            currency: "GBP",
            costMinor: 4500,
            scheduleKind: "renewal",
            dueDate: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10),
            recurrenceMonths: 12,
            status: "active",
            version: 1,
            updatedAt: new Date().toISOString(),
          },
        },
      });
      if (!upsertItem.ok()) throw new Error(`item.upsert failed: ${upsertItem.status()}`);
    } finally {
      await context.close();
    }
  });

  /* #730: the sky this file made is removed once every journey has run,
     including the one that signs the session out from under itself. A fresh
     session does the sweep, exactly as v19-tour.spec.ts's own afterAll does. */
  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await signIn(page);
      await households.sweep(page);
    } finally {
      await context.close();
    }
  });

  test("arrive/sign-in: the front door, signed out", async ({ page }, testInfo) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await walkScreen(page, testInfo, "arrive-sign-in");
    // Decorative: the dawn's own starfield and world layers.
    await expect(page.locator(".signin-stage")).toHaveAttribute("aria-hidden", "true");
  });

  test("/home", async ({ page }, testInfo) => {
    await signIn(page);
    await page.reload();
    await expect(page.locator(".dialwrap, .mdial").filter({ visible: true })).toHaveCount(1);
    await walkScreen(page, testInfo, "home");

    // Criterion 3: the dial itself is v19-chart-accessibility.spec.ts's job;
    // this only checks the status drawer is present to check as a live region.
    const drawer = page.locator("#statusdrawer");
    await expect(drawer).toBeAttached();
    await assertLiveRegionIsSafe(drawer, "home", "#statusdrawer (system status)");
  });

  test("/item/[id]", async ({ page }, testInfo) => {
    await signIn(page);
    await page.goto(`/item/${itemId}`);
    await walkScreen(page, testInfo, "item-id");
  });

  test("/household/[id]", async ({ page }, testInfo) => {
    await signIn(page);
    await page.goto(`/household/${householdId}`);
    await walkScreen(page, testInfo, "household-id");
  });

  test("/create", async ({ page }, testInfo) => {
    await signIn(page);
    await page.goto("/create");
    await walkScreen(page, testInfo, "create");
    await expect(page.locator(".backdrop")).toHaveAttribute("aria-hidden", "true");
  });

  test("/settings", async ({ page }, testInfo) => {
    await signIn(page);
    await page.goto("/settings");
    await walkScreen(page, testInfo, "settings");
    await expect(page.locator(".sky").first()).toHaveAttribute("aria-hidden", "true");
  });

  test("/settings/mail", async ({ page }, testInfo) => {
    await signIn(page);
    await page.goto("/settings/mail");
    await walkScreen(page, testInfo, "settings-mail");
    await expect(page.locator(".satellites")).toHaveAttribute("aria-hidden", "true");
  });

  test("/inbox", async ({ page }, testInfo) => {
    await signIn(page, "/inbox");
    await walkScreen(page, testInfo, "inbox");
    await expect(page.locator(".sky").first()).toHaveAttribute("aria-hidden", "true");
  });

  test("/due-next", async ({ page }, testInfo) => {
    await signIn(page);
    await page.goto("/due-next");
    await walkScreen(page, testInfo, "due-next");
    await expect(page.locator(".sky").first()).toHaveAttribute("aria-hidden", "true");
  });

  test("/documents", async ({ page }, testInfo) => {
    await signIn(page);
    await page.goto("/documents");
    await walkScreen(page, testInfo, "documents");
    await expect(page.locator(".sky").first()).toHaveAttribute("aria-hidden", "true");
  });

  test("/admin", async ({ page }, testInfo) => {
    await signIn(page);
    await page.goto("/admin");
    await walkScreen(page, testInfo, "admin");
    // The observatory's own starfield backdrop, unlike every sibling screen's.
    await expect(page.locator(".sky").first()).toHaveAttribute("aria-hidden", "true");
  });

  test("/administration", async ({ page }, testInfo) => {
    await signIn(page);
    await page.goto("/administration");
    await walkScreen(page, testInfo, "administration");
    await expect(page.locator(".station-backdrop")).toHaveAttribute("aria-hidden", "true");
  });

  /**
   * First-run tour overlay (see tests/e2e/v19-tour.spec.ts for the full
   * mechanics). Cleared and re-triggered here the same way that file does,
   * on our own household so no other spec's sky is disturbed, and skipped
   * again immediately afterwards so the record is left exactly as every
   * other spec expects to find it: taken.
   */
  test("first-run tour overlay", async ({ page }, testInfo) => {
    await signIn(page);
    const forgotten = await page.evaluate(async () => {
      const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
      const response = await fetch("/api/settings/tour", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify({ tourSeenAt: null }),
      });
      return response.ok;
    });
    expect(forgotten).toBe(true);

    await page.goto("/home");
    const card = page.locator(".tourcard");
    await expect(card).toBeVisible({ timeout: 30_000 });

    await expect(card).toHaveAttribute("role", "dialog");
    await expect(card).toHaveAccessibleName(/\S/);
    await expect(card, "the tour card takes focus so keys land on it without the reader hunting for it").toBeFocused();

    await expect(page.getByRole("button", { name: "Skip" })).toHaveAccessibleName(/\S/);
    await expect(page.getByRole("button", { name: "Back" })).toHaveAccessibleName(/\S/);
    await expect(page.getByRole("button", { name: "Next" })).toHaveAccessibleName(/\S/);

    await writeSnapshot(page, testInfo, "tour-overlay");

    // Ends the walk so the record is left taken, as every other spec expects.
    await page.locator("#tour-skip").click();
    await expect(card).toHaveCount(0);
  });

  /**
   * Sign-out, last: this is the one destructive journey, so it runs after
   * every other screen has been walked. It uses Chrome.svelte's own two-tap
   * control (arm, then confirm) reached from a sub-screen, which is the real
   * product path: the confirm tap revokes the session for real before
   * handing the reader to /logout.
   */
  test("sign-out screen", async ({ page }, testInfo) => {
    await signIn(page);
    await page.goto("/settings");
    await page.locator("button.orb").click();
    const signOutButton = page.locator(".account .signout");
    await signOutButton.click();
    await signOutButton.click();
    await expect(page).toHaveURL(/\/logout$/, { timeout: 30_000 });
    await expect(page.getByRole("link", { name: "Sign back in" })).toBeVisible();

    await walkScreen(page, testInfo, "sign-out");
    await expect(page.locator(".signin-stage")).toHaveAttribute("aria-hidden", "true");
  });
});
