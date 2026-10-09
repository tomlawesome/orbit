import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { cleanupHousehold, sessionHeaders } from "./households";
import { homeIsLive } from "./keyboard";
import { ensureWorkerAdministrator, workerAccount } from "./worker-identity";
import { settleArrival } from "./arrival";
import { answerPushWithoutAService } from "./webkit-push";

/**
 * #1178: the signed-in fixtures v19-axe-sweep.spec.ts grew (#496), lifted
 * out for the two specs that restore what authenticated-accessibility.spec.ts
 * covered before the Next.js removal (8a315e18): v19-layout-and-themes.spec.ts
 * and v19-feedback-recovery.spec.ts. Same shape and same reasons as the
 * sweep's own copies, which are left where they are: each test signs in
 * fresh, seeds what it needs, and removes it in `finally`.
 */

/* #1080: this worker's own administrator, resolved lazily (worker env only). */
export const READER = () => workerAccount("administrator");
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * The station backdrop's layers are pure decoration and already
 * `aria-hidden`; WCAG 1.4.3 exempts decorative text, so axe skips them here
 * exactly as the sweep does (its comment on DECORATIVE_BACKDROP says why).
 */
export const DECORATIVE_BACKDROP = '.layer[aria-hidden="true"]';

export async function signIn(page: Page, returnTo: string) {
  await answerPushWithoutAService(page);
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("link", { name: READER() }).click();
  /* #1233 (#1221, #840): the session probe below answers as soon as the
     cookie is set, while the browser is still following the sign-in's own
     redirects (the callback, then /home or the arrival, which may itself
     leave for /home). A spec's first `goto` after that raced the redirect
     still in flight -- `net::ERR_ABORTED` on Chromium, "interrupted by
     another navigation to /home" on WebKit (pipeline 2131), and a 7 s stall
     before /inbox loaded on desktop-webkit (pipeline 2203, job 32545). So:
     land first, then ask. */
  await settleArrival(page, 20_000, returnTo);
  /* #1080: waits for the session, then holds administrator access. */
  await ensureWorkerAdministrator(page);
}

/** WCAG A/AA violations on the page as it stands, decoration excluded. */
export async function axeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).exclude(DECORATIVE_BACKDROP).analyze();
  /* Only what a person needs to act on: the rule, and where it fired. */
  return results.violations.map((violation) => ({
    rule: violation.id,
    targets: violation.nodes.map((node) => node.target.join(" ")),
  }));
}

export type Household = { id: string; name: string; sectionId: string; itemId?: string; itemTitle?: string };

/**
 * A household of the signed-in reader's own, through the same
 * `household.create` / `item.upsert` commands the sweep uses. The prefix
 * names the spec so a leak says where it came from.
 */
export async function seedHousehold(page: Page, prefix: string, options: { withItem?: boolean } = {}): Promise<Household> {
  const name = `${prefix}-${randomUUID()}`;
  const householdId = randomUUID();
  const sectionId = randomUUID();
  const headers = { ...(await sessionHeaders(page)), "content-type": "application/json" };

  const created = await page.request.post("/api/workspace/commands", {
    headers,
    data: {
      type: "household.create",
      household: {
        id: householdId,
        name,
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
  if (!created.ok()) throw new Error(`#1178: could not seed household "${name}" (${created.status()})`);

  if (!options.withItem) return { id: householdId, name, sectionId };

  const itemId = randomUUID();
  const itemTitle = `${prefix} item`;
  const dueDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  const itemCreated = await page.request.post("/api/workspace/commands", {
    headers,
    data: {
      type: "item.upsert",
      householdId,
      kind: "service",
      item: {
        id: itemId,
        sectionId,
        title: itemTitle,
        currency: "GBP",
        dueDate,
        recurrenceMonths: 12,
      },
      activity: { id: randomUUID(), itemId, occurredAt: new Date().toISOString() },
    },
  });
  if (!itemCreated.ok()) throw new Error(`#1178: could not seed item for "${name}" (${itemCreated.status()})`);
  return { id: householdId, name, sectionId, itemId, itemTitle };
}

/** #730: every household a test makes is removed, even when the test fails. */
export async function cleanup(page: Page, household: { id: string; name: string }) {
  await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
}

/**
 * Lands on `/home` settled: the tour dismissed if it showed, one dial drawn,
 * and home's behaviour bound (#1064). The sweep's `settleHome`, verbatim in
 * what it waits for.
 */
export async function settleHome(page: Page) {
  await expect(page).toHaveURL(/\/home$/, { timeout: 30_000 });
  await page
    .waitForResponse(
      (response) => response.url().includes("/api/settings/tour") && response.request().method() === "GET",
      { timeout: 30_000 },
    )
    .catch(() => {});
  if (await page.locator("#orbit-tour-transport").count()) {
    await page.keyboard.press("Escape");
    await expect(page.locator("#orbit-tour-veil")).toBeHidden();
  }
  await expect(page.locator(".dialwrap, .mdial").filter({ visible: true })).toHaveCount(1);
  await homeIsLive(page);
}

/**
 * Where a visible message matching `pattern` would be announced from: the
 * nearest live region holding it (`role="alert"`, `role="status"`, an
 * `aria-live` other than "off", or an `<output>`), or "none" when the
 * message is drawn but a screen reader is never told. Returns "absent" when
 * no visible element carries the message at all, so a caller can tell "not
 * shown" from "shown but silent".
 */
export async function liveRegionFor(page: Page, pattern: RegExp): Promise<string> {
  return page.evaluate(({ source, flags }) => {
    const re = new RegExp(source, flags);
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      /* sr-only regions are 1px and still announced; only display/visibility
         decide whether this element is in the accessibility tree. */
      return (rect.width > 0 || rect.height > 0) && style.visibility !== "hidden" && style.display !== "none";
    };
    /* Deepest element whose own text matches: the paragraph, not <body>. */
    const holders = Array.from(document.querySelectorAll("body *")).filter(
      (el) => re.test(el.textContent ?? "") && !Array.from(el.children).some((child) => re.test(child.textContent ?? "")),
    );
    const shown = holders.filter(visible);
    if (!shown.length) return "absent";
    for (const el of shown) {
      const region = el.closest('[role="alert"], [role="status"], [aria-live]:not([aria-live="off"]), output');
      if (region) return region.getAttribute("role") ?? `aria-live=${region.getAttribute("aria-live") ?? "polite"}`;
    }
    return "none";
  }, { source: pattern.source, flags: pattern.flags });
}

/** What has focus, described, or "body" when focus has been dropped. */
export async function focusedElement(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return "body";
    const name = el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 40);
    return `${el.tagName.toLowerCase()} "${name}"`;
  });
}
