/*
 * What the three mail specs in this folder share (#1610): v19-mail-review,
 * v19-mail-review-unread and v19-feedback-recovery. Not a spec.
 *
 * Each starts from the fixture inbox (src/lib/data/fixtures/inbox.js): the
 * approvable "Home insurance renewal" receipt and the failed ones. This file
 * only answers a test's own decisions, and shows them back on the next read:
 * the fixture server persists nothing, so an inbox that is read again after an
 * approval would otherwise still list the mail. Same idea as `rememberWrites`
 * in a11y-support.js, for the inbox's own routes.
 *
 * Every route handler runs inside `guardedRoute` (workspace-writes.js): a read
 * or an answer still in flight when the page closes ends the route, not the
 * test.
 */

import { guardedRoute } from "./workspace-writes.js";

/** @typedef {import("@playwright/test").Page} Page */

/** The fixture's approvable receipt, and its one named attachment. */
export const SUGGESTION = {
  id: "r-insurance",
  title: "Home insurance renewal",
  provider: "Harbour Mutual",
  attachmentId: "a-insurance-1",
  attachmentName: "policy-schedule.pdf",
};

/** The fixture's failed message that carries no document, and the words it says. */
export const FAILED_MESSAGE = { id: "r-no-document", words: "It carried no document Orbit can read" };

/** Orbit's own shape of an unexpected failure (src/lib/app-error.ts
 *  `appErrorResponse`): a mocked shape the backend cannot produce proves
 *  nothing about how the screen handles one it can (SQ2-Q1, #1151). */
export const INTERNAL_ERROR = { error: { code: "internal_error", message: "Orbit could not complete the request" } };

/** The fixture household's sections, as a review read lists the ones a mail can be filed into. */
const SECTIONS = [
  { id: "s-home", name: "Home" },
  { id: "s-vehicles", name: "Vehicles" },
  { id: "s-devices", name: "Devices" },
  { id: "s-services", name: "Services" },
];

/** The section an approval files into when the reader picks none: the first the review lists. */
export const FIRST_SECTION_ID = SECTIONS[0].id;

/**
 * Answers this test's mail decisions and remembers them.
 *
 * - `POST /api/reviewed-intake/approve`: `answer(n, body)` says how the n-th
 *   approval is answered (1-based); the default lands it as `approved`. A
 *   landed approval takes its receipt out of every later inbox read.
 * - `PUT /api/imap-inbox/<id>` (a receipt is assigned to a household before it
 *   is approved, and the fixture receipts name none): answered `{ ok: true }`,
 *   remembered in `assigned`, and every later inbox read names that household.
 * - `DELETE /api/imap-inbox/<id>`: answered `{ ok: true }`, and takes the
 *   receipt out of every later inbox read.
 * - `GET /api/imap-inbox`: the fixture's own answer, less what landed.
 * - `GET /api/imap-inbox/<id>?householdId=`: the review an approval reads
 *   first (the receipt as the inbox lists it, the household's sections, the
 *   staged attachments, no pending approval), which the fixture server has no
 *   route for.
 *
 * @param {Page} page
 * @param {{ answer?: (n: number, body: Record<string, any>) => { status?: number, json: unknown } | null }} [options]
 * @returns {Promise<{ approvals: Record<string, any>[], removals: string[], landed: Set<string>, assigned: Map<string, string> }>}
 */
export async function rememberMailDecisions(page, { answer } = {}) {
  /** @type {Record<string, any>[]} */
  const approvals = [];
  /** @type {string[]} */
  const removals = [];
  /** @type {Set<string>} */
  const landed = new Set();
  /** @type {Map<string, string>} receipt id -> the household it was assigned to */
  const assigned = new Map();

  /* The inbox as this page sees it: the fixture's own answer, less what landed,
     with the households it was assigned to. The list route and the review
     route both read it here, so a review of a receipt that landed finds none
     (the real server answers 404) and is never answered from the fixture's
     unfiltered list. A read the page's end cuts off is the end of the test
     (guardedRoute), not a failure of it. */
  /** @param {import("@playwright/test").Route} route */
  const inboxAsPageSees = async (route) => {
    const response = await route.fetch({ url: new URL("/api/imap-inbox", route.request().url()).href });
    const body = await response.json();
    body.receipts = body.receipts
      .filter((/** @type {{ id: string }} */ one) => !landed.has(one.id))
      .map((/** @type {{ id: string }} */ one) => ({ ...one, ...(assigned.has(one.id) ? { householdId: assigned.get(one.id) } : {}) }));
    return { response, body };
  };
  await page.route("**/api/imap-inbox", guardedRoute(async (route) => {
    const { response, body } = await inboxAsPageSees(route);
    return route.fulfill({ response, json: body });
  }));
  /** @param {import("@playwright/test").Route} route @param {string} id @param {string | null} householdId */
  const answerReview = async (route, id, householdId) => {
    const { body } = await inboxAsPageSees(route);
    const receipt = body.receipts.find((/** @type {{ id: string }} */ one) => one.id === id);
    if (!receipt) return route.fulfill({ status: 404, json: { error: { code: "inbox_receipt_not_found", message: "That incoming document is not available" } } });
    const { attachments = [], ...rest } = receipt;
    return route.fulfill({
      json: {
        receipt: { ...rest, householdId },
        sections: SECTIONS,
        candidates: [],
        attachments: attachments.map((/** @type {Record<string, unknown>} */ one) => ({ ...one, status: "stored" })),
      },
    });
  };
  await page.route("**/api/imap-inbox/**", guardedRoute(async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (/\/attachments\//.test(url.pathname)) return route.fallback();
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    if (method === "GET") return answerReview(route, id, url.searchParams.get("householdId"));
    if (method !== "DELETE" && method !== "PUT") return route.fallback();
    if (method === "PUT") {
      assigned.set(id, route.request().postDataJSON().householdId);
      return route.fulfill({ json: { ok: true } });
    }
    removals.push(id);
    landed.add(id);
    return route.fulfill({ json: { ok: true } });
  }));
  await page.route("**/api/reviewed-intake/approve", guardedRoute(async (route) => {
    const body = route.request().postDataJSON();
    approvals.push(body);
    const scripted = answer?.(approvals.length, body);
    if (scripted) return route.fulfill({ status: scripted.status ?? 200, json: scripted.json });
    landed.add(body.source?.receiptId);
    return route.fulfill({ json: { outcome: "approved", itemId: "i-mailed-renewal" } });
  }));
  return { approvals, removals, landed, assigned };
}
