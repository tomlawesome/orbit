import { expect, test } from "@playwright/test";

import { APP, onPhone } from "./a11y-support.js";
import { openRow } from "../fidelity/pocket-states.js";

/*
 * THE HOUSEHOLD PAGE'S MEMBER ACTS, AS A PERSON SEES THEM (#1354 part 2), written
 * BEFORE the six acts (ownerLeave, act, handOver, decide, offer, nameOk) move out
 * of the desk (+page.svelte) and the pocket (pocket.svelte) into acts.js. The
 * spec pins what each shape does today, request and words, on both sizes, so the
 * move cannot change either unnoticed. It passes on the code as it is, and must
 * pass the same after.
 *
 * Desk and pocket are NOT the same in their words, and this spec says so rather
 * than hiding it: the desk writes into its own "said" lines, the pocket wakes a
 * toast. Where they differ the test branches on `onPhone` and names both.
 *
 * Harlow Home belongs to Ned (the fixture's signed-in person, its owner). The
 * server is the fixture app; the writes under test are answered here by
 * `page.route`, recorded in `sent`, and the household reads they trigger fall
 * through to the fixture server.
 */
test.use({ baseURL: APP });

const HH = "/household/hh-harlow-1";
const API = `${APP}/api/households/hh-harlow-1`;
const INVITED = "daniel.harlow@example.com";
const REFUSAL = "Only the owner can do that.";
const knock = { id: "jr-1", householdId: "hh-harlow-1", userId: "u-ben", displayName: "Ben Harlow", createdAt: "2026-08-11T09:00:00Z" };
/** @param {string} email @param {string | null} sentAt */
const invitationOf = (email, sentAt) => ({
  id: "inv-new", householdId: "hh-harlow-1", email, createdAt: "2026-08-13T12:00:00.000Z",
  sentAt, sendError: sentAt ? null : "bounced", expiresAt: "2026-09-18T12:00:00.000Z",
});

/**
 * Answers the household's writes and records them. `refuse` makes every write a
 * 403 with the server's own words; `hold` makes the hand-over wait until
 * `release()` is called, so a test can look at the page while it is in flight.
 * @param {import("@playwright/test").Page} page
 * @param {{ refuse?: boolean, unsent?: boolean, knocking?: boolean, hold?: boolean }} [options]
 */
async function stage(page, { refuse = false, unsent = false, knocking = false, hold = false } = {}) {
  /** @type {{ method: string, path: string, body: any }[]} */
  const sent = [];
  /** @type {(value?: unknown) => void} */
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  /** @param {import("@playwright/test").Route} route @param {any} json */
  const answer = async (route, json) => {
    const request = route.request();
    sent.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postDataJSON() });
    if (hold && request.method() === "PATCH") await gate;
    if (refuse) return route.fulfill({ status: 403, json: { error: { code: "forbidden", message: REFUSAL } } });
    return route.fulfill({ json });
  };
  /* Only the writes; the page's own reads go on to the fixture server. */
  await page.route(`${API}/invitations`, (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fallback();
    if (request.method() === "DELETE") return answer(route, { invitations: [] });
    const { email } = request.postDataJSON();
    return answer(route, { invitation: invitationOf(email, unsent ? null : "2026-08-13T12:00:00.000Z") });
  });
  await page.route(`${API}/members`, (route) =>
    route.request().method() === "GET" ? route.fallback() : answer(route, { ok: true }));
  await page.route(`${API}/lifecycle`, (route) => answer(route, { ok: true }));
  await page.route(`${APP}/api/join-requests/jr-1`, (route) => answer(route, { request: knock }));
  if (knocking) {
    const requests = { requests: [knock] };
    await page.route("**/api/join-requests*", (route) =>
      route.request().url().endsWith("/jr-1") ? route.fallback() : route.fulfill({ json: requests }));
    await page.route(`${API}/join-requests*`, (route) => route.fulfill({ json: requests }));
  }
  return { sent, release };
}

/** @param {import("@playwright/test").Page} page */
async function open(page) {
  await page.goto(`${APP}${HH}`, { waitUntil: "load" });
  /* The shape on screen is drawn after hydration; wait for its own members list. */
  await page.locator(".roster:visible, .hh-members:visible").first().waitFor();
}

/** What the page said, as a status line (the desk's "said" lines, the pocket's toast).
 * @param {import("@playwright/test").Page} page @param {string | RegExp} text */
const said = (page, text) => expect(page.getByRole("status").filter({ hasText: text }).first()).toBeAttached();
/** A problem, as an alert. @param {import("@playwright/test").Page} page @param {string | RegExp} text */
const problem = (page, text) => expect(page.getByRole("alert").filter({ hasText: text }).first()).toBeAttached();

/** Pocket only: a member's row, opened. @param {import("@playwright/test").Page} page @param {string} name */
async function memberRow(page, name) {
  const row = page.locator(".hh-members [data-row]", { hasText: name }).first();
  await openRow(page, row);
  return row;
}

/** The first tap arms, the second fires (both shapes' dangerous acts).
 * @param {import("@playwright/test").Locator} button */
async function twice(button) {
  /* The button's name changes when it arms, so hold the element, not the query. */
  const held = await button.elementHandle();
  if (!held) throw new Error("the button to tap twice is not on the page");
  await held.click();
  await held.click();
}

test.describe("inviting by email", () => {
  /** @param {import("@playwright/test").Page} page @param {boolean} phone @param {string} email */
  async function typeAndSend(page, phone, email) {
    if (phone) {
      await page.locator(".hh-pocket button", { hasText: "invite someone" }).click();
      await page.locator("#hh-invite").fill(email);
      await page.locator(".p-sheet-layer.open button", { hasText: /^send$/ }).click();
    } else {
      await page.getByLabel("email address to invite").fill(email);
      await page.getByRole("button", { name: "send invitation" }).click();
    }
  }

  test("a sent invitation says so with the address it went to, and asks for the household again", async ({ page }, testInfo) => {
    const { sent } = await stage(page);
    await open(page);
    await typeAndSend(page, onPhone(testInfo), "  ada@example.com ");
    await said(page, "invitation sent to ada@example.com");
    expect(sent).toEqual([{ method: "POST", path: "/api/households/hh-harlow-1/invitations", body: { email: "ada@example.com" } }]);
    if (!onPhone(testInfo)) await expect(page.getByLabel("email address to invite")).toHaveValue("");
    else await expect(page.locator(".p-sheet-layer.open")).toHaveCount(0);
  });

  test("a mail that could not go says the person is invited but must be resent (desk and phone use different dashes)", async ({ page }, testInfo) => {
    await stage(page, { unsent: true });
    await open(page);
    await typeAndSend(page, onPhone(testInfo), "ada@example.com");
    const tail = onPhone(testInfo) ? "· try resend" : "— try resend";
    const words = `ada@example.com is invited, but the mail could not be sent ${tail}`;
    /* The phone wakes it as a failure (an alert); the desk writes a status line. */
    await (onPhone(testInfo) ? problem(page, words) : said(page, words));
  });

  test("a refusal puts the server's words in the page and says nothing was sent", async ({ page }, testInfo) => {
    await stage(page, { refuse: true });
    await open(page);
    await typeAndSend(page, onPhone(testInfo), "ada@example.com");
    await problem(page, REFUSAL);
    await expect(page.getByRole("status").filter({ hasText: /invitation sent/ })).toHaveCount(0);
  });

  test("a blank address sends nothing: the button stays asleep", async ({ page }, testInfo) => {
    const { sent } = await stage(page);
    await open(page);
    if (onPhone(testInfo)) {
      await page.locator(".hh-pocket button", { hasText: "invite someone" }).click();
      await page.locator("#hh-invite").fill("   ");
      await expect(page.locator(".p-sheet-layer.open button", { hasText: /^send$/ })).toBeDisabled();
    } else {
      await page.getByLabel("email address to invite").fill("   ");
      await expect(page.getByRole("button", { name: "send invitation" })).toBeDisabled();
    }
    expect(sent).toEqual([]);
  });
});

test.describe("a held invitation", () => {
  /** @param {import("@playwright/test").Page} page @param {boolean} phone @param {string} act */
  async function pressOn(page, phone, act) {
    if (!phone) return page.locator(".inv", { hasText: INVITED }).getByRole("button", { name: act });
    const row = await memberRow(page, INVITED);
    return row.getByRole("button", { name: new RegExp(`^${act}`, "i") });
  }

  test("resend sends the same address again and says so", async ({ page }, testInfo) => {
    const { sent } = await stage(page);
    await open(page);
    const phone = onPhone(testInfo);
    await (await pressOn(page, phone, phone ? "Resend the invitation" : "resend")).click();
    await said(page, `invitation sent again to ${INVITED}`);
    expect(sent.map(({ method, body }) => [method, body])).toEqual([["POST", { email: INVITED }]]);
  });

  test("a refused resend says the server's words", async ({ page }, testInfo) => {
    await stage(page, { refuse: true });
    await open(page);
    const phone = onPhone(testInfo);
    await (await pressOn(page, phone, phone ? "Resend the invitation" : "resend")).click();
    await problem(page, REFUSAL);
  });

  test("withdraw takes two taps, then says the link no longer works (desk: 'has been withdrawn'; phone: 'is withdrawn')", async ({ page }, testInfo) => {
    const { sent } = await stage(page);
    await open(page);
    const phone = onPhone(testInfo);
    const button = await pressOn(page, phone, phone ? "Withdraw the invitation" : "withdraw");
    if (phone) await twice(button);
    else await twice(page.locator(".inv", { hasText: INVITED }).locator("button.ghost").last());
    await said(page, phone
      ? `the invitation to ${INVITED} is withdrawn · its link no longer works`
      : `the invitation to ${INVITED} has been withdrawn · its link no longer works`);
    expect(sent.map(({ method, body }) => [method, body])).toEqual([["DELETE", { invitationId: "inv-fixture-1" }]]);
  });
});

test.describe("a join request", () => {
  /** @param {import("@playwright/test").Page} page @param {boolean} phone @param {"approve" | "decline"} which */
  const decideButton = (page, phone, which) => phone
    ? page.getByRole("button", { name: `${which === "approve" ? "Approve" : "Decline"} Ben Harlow` })
    : page.locator(".joinreq").getByRole("button", { name: which, exact: true });

  test("approve sends the decision for the request and says the person is in", async ({ page }, testInfo) => {
    const { sent } = await stage(page, { knocking: true });
    await open(page);
    await decideButton(page, onPhone(testInfo), "approve").click();
    await said(page, onPhone(testInfo) ? "Ben Harlow is in Harlow Home" : "Ben Harlow is in");
    expect(sent).toEqual([{ method: "POST", path: "/api/join-requests/jr-1", body: { action: "approve" } }]);
  });

  test("decline sends the decision; the phone says the person was not let in, the desk says nothing", async ({ page }, testInfo) => {
    const { sent } = await stage(page, { knocking: true });
    await open(page);
    await decideButton(page, onPhone(testInfo), "decline").click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].body).toEqual({ action: "decline" });
    if (onPhone(testInfo)) await said(page, "Ben Harlow was not let in");
    else await expect(page.getByRole("status").filter({ hasText: /is in$/ })).toHaveCount(0);
  });

  test("a refusal says the server's words and nothing was let in", async ({ page }, testInfo) => {
    await stage(page, { knocking: true, refuse: true });
    await open(page);
    await decideButton(page, onPhone(testInfo), "approve").click();
    await problem(page, REFUSAL);
    await expect(page.getByRole("status").filter({ hasText: /Ben Harlow is in/ })).toHaveCount(0);
  });
});

test.describe("handing the system over", () => {
  /** Opens the hand-over to Emma and arms its last tap.
   * @param {import("@playwright/test").Page} page @param {boolean} phone */
  async function toTheLastTap(page, phone) {
    if (phone) {
      const row = await memberRow(page, "Emma Harlow");
      await row.getByRole("button", { name: "Hand Harlow Home over to Emma Harlow" }).click();
      return page.locator(".p-sheet-layer.open").getByRole("button", { name: /hand over to Emma Harlow/ });
    }
    await page.getByRole("button", { name: "hand over →" }).click();
    await page.locator(".handover.open label.pick", { hasText: "Emma Harlow" }).click();
    return page.locator(".handover.open").getByRole("button", { name: "hand over to Emma Harlow" });
  }

  test("two taps hand it to the chosen member and say they own it now", async ({ page }, testInfo) => {
    const { sent } = await stage(page);
    await open(page);
    await twice(await toTheLastTap(page, onPhone(testInfo)));
    const words = "Emma Harlow owns Harlow Home now · you’re a member";
    /* The desk's panel shuts on success, taking its status line out of sight, so the words are read off it in place. */
    if (onPhone(testInfo)) await said(page, words);
    else await expect(page.locator(".handover .said")).toHaveText(words);
    expect(sent).toEqual([{ method: "PATCH", path: "/api/households/hh-harlow-1/members", body: { userId: "u-emma" } }]);
  });

  test("the sheet closes at once on the phone but only once the server has said yes on the desk", async ({ page }, testInfo) => {
    const phone = onPhone(testInfo);
    const { sent, release } = await stage(page, { hold: true });
    await open(page);
    await twice(await toTheLastTap(page, phone));
    await expect.poll(() => sent.length).toBe(1);
    const panel = phone ? page.locator(".p-sheet-layer.open") : page.locator(".handover.open");
    if (phone) await expect(panel).toHaveCount(0);
    else await expect(panel).toHaveCount(1);
    release();
    await expect(panel).toHaveCount(0);
  });

  test("a refusal leaves nothing said as handed over, and says the server's words", async ({ page }, testInfo) => {
    await stage(page, { refuse: true });
    await open(page);
    await twice(await toTheLastTap(page, onPhone(testInfo)));
    await problem(page, REFUSAL);
    await expect(page.getByRole("status").filter({ hasText: /owns Harlow Home now/ })).toHaveCount(0);
    /* The desk keeps its panel open after a refusal; the phone's has already gone. */
    if (!onPhone(testInfo)) await expect(page.locator(".handover.open")).toHaveCount(1);
  });
});

test.describe("the owner cannot leave", () => {
  test("pressing leave sends nothing, says an owner can't, and lets go after a few seconds", async ({ page }, testInfo) => {
    const { sent } = await stage(page);
    await open(page);
    if (onPhone(testInfo)) {
      const row = await memberRow(page, "Ned Harlow");
      await row.getByRole("button", { name: "Leave Harlow Home" }).click();
      await said(page, "an owner can’t leave · hand the system over first");
      await expect(page.locator(".hh-moment.warn")).toBeVisible();
      await expect(page.locator(".hh-moment.warn")).toHaveCount(0, { timeout: 9_000 });
    } else {
      await page.getByRole("button", { name: "leave this system" }).click();
      await said(page, "an owner can’t be removed and can’t leave — hand the system over first");
      await expect(page.locator(".moment.warn")).toHaveCount(0, { timeout: 9_000 });
    }
    expect(sent).toEqual([]);
  });
});

test.describe("asking for deletion", () => {
  /** @param {import("@playwright/test").Page} page @param {boolean} phone */
  async function toTheName(page, phone) {
    if (phone) {
      await page.locator(".hh-pocket button", { hasText: "delete this system" }).click();
      return {
        input: page.locator("#hh-delname"),
        button: page.locator(".p-sheet-layer.open").getByRole("button", { name: /^delete$/ }),
      };
    }
    await page.getByRole("button", { name: "request deletion →" }).click();
    return { input: page.locator("#delname"), button: page.locator("button.dangerbtn").last() };
  }

  test("the button wakes only for the exact name, edge spaces allowed", async ({ page }, testInfo) => {
    await stage(page);
    await open(page);
    const { input, button } = await toTheName(page, onPhone(testInfo));
    await expect(button).toBeDisabled();
    for (const wrong of ["harlow home", "Harlow", "Harlow  Home", "Harlow Homes"]) {
      await input.fill(wrong);
      await expect(button, `"${wrong}"`).toBeDisabled();
    }
    await input.fill("  Harlow Home ");
    await expect(button).toBeEnabled();
    await input.fill("");
    await expect(button).toBeDisabled();
  });

  test("two taps send the typed name and say deletion is requested", async ({ page }, testInfo) => {
    const { sent } = await stage(page);
    await open(page);
    const { input, button } = await toTheName(page, onPhone(testInfo));
    await input.fill("Harlow Home");
    await twice(button);
    await said(page, onPhone(testInfo) ? /^Harlow Home is asked to be deleted · gone for good in / : /^requested · Harlow Home stops now, and is gone for good in /);
    expect(sent).toEqual([{ method: "POST", path: "/api/households/hh-harlow-1/lifecycle", body: { action: "delete", confirmation: "Harlow Home" } }]);
  });

  test("a refusal says 'not requested' with the server's words", async ({ page }, testInfo) => {
    await stage(page, { refuse: true });
    await open(page);
    const { input, button } = await toTheName(page, onPhone(testInfo));
    await input.fill("Harlow Home");
    await twice(button);
    await problem(page, `not requested — ${REFUSAL}`);
  });
});
