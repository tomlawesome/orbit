import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { cleanupHousehold, sessionHeaders } from "./households";
import { ensureWorkerAdministrator, waitForAuthenticatedSession, workerAccount } from "./worker-identity";
import { settleArrival } from "./arrival";
import { answerPushWithoutAService } from "./webkit-push";
import { inDays } from "./household-dates";
import { SETTLE } from "./settle";

/**
 * #1178: the signed-in fixtures the v19-axe-sweep spec grew (#496), lifted
 * out for the two specs that restore what authenticated-accessibility.spec.ts
 * covered before the Next.js removal (8a315e18): v19-layout-and-themes and
 * v19-feedback-recovery, both since moved to the rig (web/tests/rig/). Same
 * shape and same reasons as the sweep's own copies, which are left where they are: each test signs in
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

/**
 * Signs `page` in through the provider's chooser and leaves it holding a
 * session: land first, then ask (#1233, #1221, #840).
 *
 * The session probe answers as soon as the cookie is set, while the browser is
 * still following the sign-in's own redirects (the callback, then /home or the
 * arrival, which may itself leave for /home). A spec's first `goto` after that
 * raced the redirect still in flight -- `net::ERR_ABORTED` on Chromium,
 * "interrupted by another navigation to /home" on WebKit (pipeline 2131), and
 * a 7 s stall before /inbox loaded on desktop-webkit (pipeline 2203, job
 * 32545); the axe sweep's own copy lacked the wait (pipelines 907/1275/1491).
 * So: settleArrival(page, 20_000, returnTo) first, then the session.
 *
 * `account` defaults to this worker's administrator (#1080), which is also the
 * only account the instance-administrator grant is held for: any other account
 * (a member, a newcomer, an outsider) is signed in and left as it is.
 *
 * Two options exist for the few specs whose subject is the landing itself:
 *   - `settle: false` returns straight after the chooser click, so the spec
 *     sees the arrival or the maintenance screen as it really comes;
 *   - `holdAdministrator: false` skips the grant (and the walk record it
 *     writes) for the worker administrator when the spec is about a reader
 *     who has not had either.
 */
export async function signIn(
  page: Page,
  options: { returnTo?: string; account?: string; settle?: boolean; holdAdministrator?: boolean } = {},
) {
  const returnTo = options.returnTo ?? "/home";
  const account = options.account ?? READER();
  const settle = options.settle ?? true;
  const holdAdministrator = options.holdAdministrator ?? account === workerAccount("administrator");

  await answerPushWithoutAService(page);
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("link", { name: account }).click();
  if (settle) await settleArrival(page, SETTLE, returnTo);
  /* #1080: waits for the session, then holds administrator access. */
  if (holdAdministrator) await ensureWorkerAdministrator(page);
  else if (settle) await waitForAuthenticatedSession(page);
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

export type Household = {
  id: string;
  name: string;
  sectionId: string;
  itemId?: string;
  itemTitle?: string;
  /** The item's due date, when it has one. */
  dueDate?: string;
};

export type SeedOptions = {
  withItem?: boolean;
  /** The seeded item's title; `<prefix> item` when not given. */
  itemTitle?: string;
  itemNotes?: string;
  /** Days from today, in the household's zone, the item falls due; 20 when not given, `null` for no date. */
  dueInDays?: number | null;
  /** The household's zone, and the zone `dueInDays` is counted in; Europe/London when not given. */
  timeZone?: string;
};

/**
 * What a seed sends, planned once so the request-side and the in-browser seed
 * cannot drift. A household name is at most 60 characters
 * (src/lib/workspace.ts); the space and the 8-character id take 9, so a prefix
 * over 51 is refused here rather than with a bare 422 (#1316).
 */
function planSeed(prefix: string, options: SeedOptions) {
  if (prefix.length > 51) throw new Error(`#1316: seed prefix "${prefix}" is over 51 characters; the household name would pass the 60-character limit`);
  const timeZone = options.timeZone ?? "Europe/London";
  const name = `${prefix} ${randomUUID().slice(0, 8)}`;
  const householdId = randomUUID();
  const sectionId = randomUUID();
  const household = {
    type: "household.create",
    household: {
      id: householdId,
      name,
      timezone: timeZone,
      currency: "GBP",
      memberCount: 1,
      canManage: true,
      onboardingComplete: true,
      sections: [{ id: sectionId, name: "Home", icon: "home", accent: "sage", visible: true }],
      items: [],
    },
  };
  if (!options.withItem) return { name, householdId, sectionId, household, item: null, itemId: undefined, itemTitle: undefined, dueDate: undefined };

  const itemId = randomUUID();
  const itemTitle = options.itemTitle ?? `${prefix} item`;
  const dueInDays = options.dueInDays === undefined ? 20 : options.dueInDays;
  const dueDate = dueInDays === null ? undefined : inDays(dueInDays, timeZone);
  const item = {
    type: "item.upsert",
    householdId,
    // The engine refuses an item that names no kind (422 item_kind_missing, #1316).
    kind: "service",
    item: {
      id: itemId,
      sectionId,
      title: itemTitle,
      currency: "GBP",
      ...(dueDate ? { dueDate, recurrenceMonths: 12 } : {}),
      ...(options.itemNotes ? { notes: options.itemNotes } : {}),
    },
    activity: { id: randomUUID(), itemId, occurredAt: new Date().toISOString() },
  };
  return { name, householdId, sectionId, household, item, itemId, itemTitle, dueDate };
}

/**
 * A household of the signed-in reader's own, through the same
 * `household.create` / `item.upsert` commands the sweep uses. The prefix
 * names the spec so a leak says where it came from.
 */
export async function seedHousehold(page: Page, prefix: string, options: SeedOptions = {}): Promise<Household> {
  const plan = planSeed(prefix, options);
  const headers = { ...(await sessionHeaders(page)), "content-type": "application/json" };

  const created = await page.request.post("/api/workspace/commands", { headers, data: plan.household });
  if (!created.ok()) throw new Error(`#1178: could not seed household "${plan.name}" (${created.status()}): ${await created.text()}`);

  if (plan.item) {
    const itemCreated = await page.request.post("/api/workspace/commands", { headers, data: plan.item });
    if (!itemCreated.ok()) throw new Error(`#1178: could not seed item for "${plan.name}" (${itemCreated.status()})`);
  }
  return { id: plan.householdId, name: plan.name, sectionId: plan.sectionId, itemId: plan.itemId, itemTitle: plan.itemTitle, dueDate: plan.dueDate };
}

/**
 * The same seed, sent by the page's own `fetch` with the page's session, for
 * specs whose subject includes the browser's side of those requests (cookies
 * and CSRF read from the page, no request context in between).
 */
export async function seedHouseholdInBrowser(page: Page, prefix: string, options: SeedOptions = {}): Promise<Household> {
  const plan = planSeed(prefix, options);
  await page.evaluate(async ({ commands }) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    for (const payload of commands) {
      const response = await fetch("/api/workspace/commands", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`command failed: ${response.status} ${await response.text()}`);
    }
  }, { commands: plan.item ? [plan.household, plan.item] : [plan.household] });
  return { id: plan.householdId, name: plan.name, sectionId: plan.sectionId, itemId: plan.itemId, itemTitle: plan.itemTitle, dueDate: plan.dueDate };
}

/** #730: every household a test makes is removed, even when the test fails. */
export async function cleanup(page: Page, household: { id: string; name: string }) {
  await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
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

/**
 * Where focus STAYS (T-Q2): what has focus, described, but read on `frames` painted frames in a row (a count, not a time).
 * "body" if focus was on the page at any of them, so a focus that only
 * passed through an element does not count; "moving" if it was on one
 * element and then another; otherwise the one element it held throughout.
 */
export async function focusHeld(page: Page, frames = 30): Promise<string> {
  return page.evaluate(async (count) => {
    const describe = () => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return "body";
      const name = el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 40);
      return `${el.tagName.toLowerCase()} "${name}"`;
    };
    const seen = new Set<string>();
    for (let frame = 0; frame < count; frame += 1) {
      seen.add(describe());
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    if (seen.has("body")) return "body";
    return seen.size === 1 ? [...seen][0] : "moving";
  }, frames);
}
