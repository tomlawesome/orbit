import AxeBuilder from "@axe-core/playwright";
import { expect as baseExpect, test } from "@playwright/test";

import { APP, openRow } from "../fidelity/pocket-states.js";
import { onPhone, RIG_EXPECT_MS, RIG_TEST_MS, signedIn, withDecorationHidden } from "./a11y-support.js";
import { guardedRoute } from "./workspace-writes.js";

const expect = baseExpect.configure({ timeout: RIG_EXPECT_MS });
test.describe.configure({ timeout: RIG_TEST_MS });

/** @typedef {import("@playwright/test").Page} Page */
/** @typedef {import("@playwright/test").Locator} Locator */

/*
 * #1633: giving and removing administrator access from the People card, on
 * the desk and on the phone. Written from the design note on the issue
 * ("What the browser test must prove", points 1-5) before the control exists.
 *
 * The roster is this test's own answer to GET /api/admin/users, so it can
 * hold an administrator, a primary administrator and users at once; the PUT
 * is the test's own too, and a successful one changes what the next read
 * answers, as the engine would. The fixture app keeps actorHasPassword true,
 * so the band asks for "your current password" on both dialects.
 *
 * The server's side (the three guards, and the step-up the PUT now asks
 * for) is lower: tests/integration/primary-administrator.test.ts,
 * tests/integration/admin-set-administrator-1633.test.ts.
 */

const PASSWORD = "the-administrators-own";
const PRIMARY_WORDS = "The primary administrator's account cannot be demoted or disabled.";
const LAST_WORDS = "Orbit must retain at least one administrator";

/** Ned is the viewer (the fixture session's u-fixture). */
const roster = () => [
  { id: "u-fixture", displayName: "Ned Harlow", email: "ned@harlow.example", isInstanceAdmin: true, isPrimaryAdministrator: false, disabledAt: null },
  { id: "u-rob", displayName: "Rob Harlow", email: "rob@harlow.example", isInstanceAdmin: true, isPrimaryAdministrator: true, disabledAt: null },
  { id: "u-emma", displayName: "Emma Harlow", email: "emma@harlow.example", isInstanceAdmin: false, isPrimaryAdministrator: false, disabledAt: null },
  { id: "u-sue", displayName: "Sue Harlow", email: "sue@harlow.example", isInstanceAdmin: true, isPrimaryAdministrator: false, disabledAt: null },
  { id: "u-gran", displayName: "Gran", email: "gran@harlow.example", isInstanceAdmin: false, isPrimaryAdministrator: false, disabledAt: null },
  /* #1633 review: a disabled account cannot be given access, so it is not offered. */
  { id: "u-rose", displayName: "Rose Harlow", email: "rose@harlow.example", isInstanceAdmin: false, isPrimaryAdministrator: false, disabledAt: "2026-08-01T09:00:00.000Z" },
];

/**
 * Answers the roster read and the administrator PUT. `refusals` is a queue of
 * refusals the next PUTs answer with, in order; when it is empty a PUT lands
 * and the next read shows it. `sent` is every PUT body, in order.
 * @param {Page} page
 * @param {{ status: number, code: string, message: string }[]} [refusals]
 */
async function ownRoster(page, refusals = []) {
  const users = roster();
  /** @type {any[]} */
  const sent = [];
  const answer = () => ({ users, totalUsers: users.length, truncated: false });
  await page.route(`${APP}/api/admin/users`, guardedRoute(async (route) => {
    const method = route.request().method();
    if (method === "GET") return route.fulfill({ json: answer(), headers: { "cache-control": "no-store" } });
    if (method !== "PUT") return route.fallback();
    const body = route.request().postDataJSON();
    sent.push(body);
    const refusal = refusals.shift();
    if (refusal) return route.fulfill({ status: refusal.status, json: { error: { code: refusal.code, message: refusal.message } } });
    const person = users.find((one) => one.id === body.userId);
    if (person) person.isInstanceAdmin = body.administrator;
    return route.fulfill({ json: answer() });
  }));
  return { sent };
}

/** @param {Page} page */
async function reach(page) {
  await signedIn("/administration", "any-dialect")(page);
}

/* ── the desk ─────────────────────────────────────────────────────────── */

/** @param {Page} page @param {string} name */
const deskRow = (page, name) => page.locator(".person").filter({ hasText: name });
/** @param {Page} page @param {string} name */
const deskGive = (page, name) => page.getByRole("button", { name: `give ${name} administrator access` });
/** @param {Page} page @param {string} name */
const deskRemove = (page, name) => page.getByRole("button", { name: new RegExp(`^remove ${name}[’']s administrator access$`) });
/** The open band, whichever way it points. @param {Page} page */
const deskBand = (page) => page.locator("form.localuser.resend").filter({ hasText: "administrator access" });

/* ── the phone ────────────────────────────────────────────────────────── */

/** @param {Page} page @param {string} name */
const phoneRow = (page, name) => page.locator(".ad-pocket [data-ad=people] .p-row").filter({ hasText: name });
/** @param {Page} page @param {string} name */
const phoneGive = (page, name) => page.getByRole("button", { name: `Give ${name} administrator access` });
/** @param {Page} page @param {string} name */
const phoneRemove = (page, name) => page.getByRole("button", { name: new RegExp(`^Remove ${name}[’']s administrator access$`) });
/** @param {Page} page */
const phoneSheet = (page) => page.getByRole("dialog").filter({ hasText: "administrator access" });

/** Opens a phone row unless it is already open. @param {Page} page @param {string} name */
async function openPhoneRow(page, name) {
  const row = phoneRow(page, name).first();
  await expect(row).toBeVisible();
  if (await row.locator("[data-row-panel]:not([hidden])").count() === 0) await openRow(page, row);
  return row;
}

/** The phone row's drawn trail (its role). @param {Page} page @param {string} name */
const phoneTrail = (page, name) => phoneRow(page, name).first().locator(".trail").first();

/* ── 1. who is offered what ───────────────────────────────────────────── */

test("a user's row offers to give admin access, an administrator's to remove it, and the viewer's and the primary's neither", async ({ page }, testInfo) => {
  await ownRoster(page);
  await reach(page);

  if (onPhone(testInfo)) {
    await expect(phoneTrail(page, "Rob Harlow")).toHaveText("primary admin");
    await expect(phoneTrail(page, "Sue Harlow")).toHaveText("admin");
    await expect(phoneTrail(page, "Emma Harlow")).toHaveText("user");

    await openPhoneRow(page, "Emma Harlow");
    await expect(phoneGive(page, "Emma Harlow")).toHaveText("make admin");

    await openPhoneRow(page, "Sue Harlow");
    await expect(phoneRemove(page, "Sue Harlow")).toHaveText("remove admin");

    await openPhoneRow(page, "Rob Harlow");
    await expect(phoneRow(page, "Rob Harlow").first().getByRole("button", { name: /Rob Harlow.*administrator access/ })).toHaveCount(0);

    await openPhoneRow(page, "Ned Harlow");
    await expect(phoneRow(page, "Ned Harlow").first().getByRole("button", { name: /administrator access/ })).toHaveCount(0);
    return;
  }

  await expect(deskRow(page, "Rob Harlow").locator(".role")).toHaveText("primary admin");
  await expect(deskRow(page, "Sue Harlow").locator(".role")).toHaveText("admin");
  await expect(deskRow(page, "Emma Harlow").locator(".role")).toHaveText("user");

  await expect(deskGive(page, "Emma Harlow")).toHaveText("give admin access…");
  await expect(deskGive(page, "Gran")).toHaveText("give admin access…");
  await expect(deskRemove(page, "Sue Harlow")).toHaveText("remove admin access…");

  /* The pill is a status, never the control (#1624). */
  await expect(deskRow(page, "Emma Harlow").locator(".role")).not.toHaveAttribute("role", "button");
  await expect(deskRow(page, "Rob Harlow").getByRole("button", { name: /administrator access/ })).toHaveCount(0);
  await expect(deskRow(page, "Ned Harlow").getByRole("button", { name: /administrator access/ })).toHaveCount(0);
});

/* ── 2. give ──────────────────────────────────────────────────────────── */

test("gives a user administrator access behind the password, says so, and the row turns round", async ({ page }, testInfo) => {
  const { sent } = await ownRoster(page);
  await reach(page);
  const note = "Gives Emma Harlow administrator access: they will see every household and every person on this instance, and can change who else is an administrator.";

  if (onPhone(testInfo)) {
    await openPhoneRow(page, "Emma Harlow");
    await expect(phoneGive(page, "Emma Harlow")).toBeVisible();
    await phoneGive(page, "Emma Harlow").click();
    const sheet = phoneSheet(page);
    await expect(sheet).toContainText(note);
    expect(sent, "opening the sheet sends nothing").toEqual([]);
    await sheet.getByLabel("your current password").fill(PASSWORD);
    await sheet.getByRole("button", { name: "give it" }).click();
    await expect.poll(() => sent).toEqual([{ userId: "u-emma", administrator: true, currentPassword: PASSWORD }]);
    await expect(page.locator(".p-wake")).toContainText("Emma Harlow is now an administrator");
    await expect(phoneSheet(page)).toHaveCount(0);
    await expect(phoneTrail(page, "Emma Harlow")).toHaveText("admin");
    await openPhoneRow(page, "Emma Harlow");
    await expect(phoneRemove(page, "Emma Harlow")).toHaveText("remove admin");
    return;
  }

  const give = deskGive(page, "Emma Harlow");
  await expect(give).toHaveAttribute("aria-expanded", "false");
  await give.click();
  await expect(give).toHaveAttribute("aria-expanded", "true");
  const band = deskBand(page);
  await expect(band.locator(".mailboxnote")).toHaveText(note);
  expect(sent, "opening the band sends nothing").toEqual([]);
  await band.getByLabel("your current password").fill(PASSWORD);
  await band.getByRole("button", { name: "give it" }).click();

  await expect.poll(() => sent).toEqual([{ userId: "u-emma", administrator: true, currentPassword: PASSWORD }]);
  const said = page.locator(".adminproblem.ok").filter({ hasText: "Emma Harlow is now an administrator" });
  await expect(said).toHaveText("Emma Harlow is now an administrator");
  await expect(said).toHaveAttribute("role", "status");
  await expect(deskBand(page)).toHaveCount(0);
  await expect(deskRow(page, "Emma Harlow").locator(".role")).toHaveText("admin");
  await expect(deskRemove(page, "Emma Harlow")).toHaveText("remove admin access…");
});

/* ── 3. remove ────────────────────────────────────────────────────────── */

test("removes an administrator's access behind the password, says so, and the pill goes back to user", async ({ page }, testInfo) => {
  const { sent } = await ownRoster(page);
  await reach(page);
  const note = /^Removes Sue Harlow[’']s administrator access\. They keep their account and their households\.$/;

  if (onPhone(testInfo)) {
    await openPhoneRow(page, "Sue Harlow");
    await expect(phoneRemove(page, "Sue Harlow")).toBeVisible();
    await phoneRemove(page, "Sue Harlow").click();
    const sheet = phoneSheet(page);
    await expect(sheet.getByText(note)).toBeVisible();
    await sheet.getByLabel("your current password").fill(PASSWORD);
    await sheet.getByRole("button", { name: "remove it" }).click();
    await expect.poll(() => sent).toEqual([{ userId: "u-sue", administrator: false, currentPassword: PASSWORD }]);
    await expect(page.locator(".p-wake")).toContainText("Sue Harlow is no longer an administrator");
    await expect(phoneSheet(page)).toHaveCount(0);
    await expect(phoneTrail(page, "Sue Harlow")).toHaveText("user");
    await openPhoneRow(page, "Sue Harlow");
    await expect(phoneGive(page, "Sue Harlow")).toHaveText("make admin");
    return;
  }

  await expect(deskRemove(page, "Sue Harlow")).toBeVisible();

  await deskRemove(page, "Sue Harlow").click();
  const band = deskBand(page);
  await expect(band.locator(".mailboxnote")).toHaveText(note);
  await band.getByLabel("your current password").fill(PASSWORD);
  await band.getByRole("button", { name: "remove it" }).click();

  await expect.poll(() => sent).toEqual([{ userId: "u-sue", administrator: false, currentPassword: PASSWORD }]);
  const said = page.locator(".adminproblem.ok").filter({ hasText: "Sue Harlow is no longer an administrator" });
  await expect(said).toHaveText("Sue Harlow is no longer an administrator");
  await expect(said).toHaveAttribute("role", "status");
  await expect(deskBand(page)).toHaveCount(0);
  await expect(deskRow(page, "Sue Harlow").locator(".role")).toHaveText("user");
  await expect(deskGive(page, "Sue Harlow")).toHaveText("give admin access…");
});

/* ── 4. refusals ──────────────────────────────────────────────────────── */

test("a refusal shows the server's own sentence, keeps the band open and leaves the pill alone", async ({ page }, testInfo) => {
  /* A stale list: Sue was made primary, then the last administrator, after
     the screen read the roster, so the control was offered. */
  const { sent } = await ownRoster(page, [
    { status: 409, code: "primary_administrator_protected", message: PRIMARY_WORDS },
    { status: 409, code: "last_administrator", message: LAST_WORDS },
  ]);
  await reach(page);

  if (onPhone(testInfo)) {
    await openPhoneRow(page, "Sue Harlow");
    await expect(phoneRemove(page, "Sue Harlow")).toBeVisible();
    await phoneRemove(page, "Sue Harlow").click();
    const sheet = phoneSheet(page);
    await sheet.getByLabel("your current password").fill(PASSWORD);
    await sheet.getByRole("button", { name: "remove it" }).click();
    await expect(page.locator(".p-wake.failure")).toContainText(PRIMARY_WORDS);
    await expect(phoneSheet(page)).toBeVisible();

    await phoneSheet(page).getByLabel("your current password").fill(PASSWORD);
    await phoneSheet(page).getByRole("button", { name: "remove it" }).click();
    await expect(page.locator(".p-wake.failure")).toContainText(LAST_WORDS);
    await expect(phoneSheet(page)).toBeVisible();
    expect(sent).toHaveLength(2);
    await page.keyboard.press("Escape");
    await expect(phoneTrail(page, "Sue Harlow")).toHaveText("admin");
    return;
  }

  await expect(deskRemove(page, "Sue Harlow")).toBeVisible();

  await deskRemove(page, "Sue Harlow").click();
  const band = deskBand(page);
  await band.getByLabel("your current password").fill(PASSWORD);
  await band.getByRole("button", { name: "remove it" }).click();

  const refused = (/** @type {string} */ words) => page.locator(".adminproblem:not(.ok)").filter({ hasText: words });
  await expect(refused(PRIMARY_WORDS)).toHaveText(PRIMARY_WORDS);
  await expect(refused(PRIMARY_WORDS)).toHaveAttribute("role", "status");
  await expect(deskBand(page)).toBeVisible();
  await expect(deskRow(page, "Sue Harlow").locator(".role")).toHaveText("admin");

  /* Another go from the same band. */
  await deskBand(page).getByLabel("your current password").fill(PASSWORD);
  await deskBand(page).getByRole("button", { name: "remove it" }).click();
  await expect(refused(LAST_WORDS)).toHaveText(LAST_WORDS);
  await expect(deskBand(page)).toBeVisible();
  await expect(deskRow(page, "Sue Harlow").locator(".role")).toHaveText("admin");
  expect(sent).toHaveLength(2);
});

/* ── 5. keyboard and axe ──────────────────────────────────────────────── */

test("the control is reached by Tab, opens by Enter with focus inside, closes by Escape back on itself, and the open band passes axe", async ({ page }, testInfo) => {
  await ownRoster(page);
  await reach(page);

  /** @param {Locator} control */
  const focused = (control) => control.evaluate((el) => el === document.activeElement);

  if (onPhone(testInfo)) {
    await openPhoneRow(page, "Emma Harlow");
    /* The act sits right after the address act in the row's unfold. */
    await page.getByRole("button", { name: "Change the address of Emma Harlow" }).focus();
    await page.keyboard.press("Tab");
    const give = phoneGive(page, "Emma Harlow");
    await expect.poll(() => focused(give), { message: "Tab from the address act reaches the admin act" }).toBe(true);
    await page.keyboard.press("Enter");
    const sheet = phoneSheet(page);
    await expect(sheet).toBeVisible();
    await expect.poll(() => sheet.evaluate((el) => el.closest("[role=dialog]")?.contains(document.activeElement) ?? false)).toBe(true);

    const results = await withDecorationHidden(page, () => new AxeBuilder({ page })
      .include("[role=dialog]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze());
    expect(results.violations.map((v) => ({ rule: v.id, targets: v.nodes.map((n) => n.target.join(" ")) }))).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(phoneSheet(page)).toHaveCount(0);
    await expect.poll(() => focused(give), { message: "Escape gives focus back to the act" }).toBe(true);
    return;
  }

  /* The control comes straight after "change address…" in the row. */
  await page.getByRole("button", { name: "change the address of Emma Harlow" }).focus();
  await page.keyboard.press("Tab");
  const give = deskGive(page, "Emma Harlow");
  await expect.poll(() => focused(give), { message: "Tab from change address… reaches give admin access…" }).toBe(true);
  await page.keyboard.press("Enter");
  const band = deskBand(page);
  await expect(band).toBeVisible();
  await expect(give).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => band.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  const results = await withDecorationHidden(page, () => new AxeBuilder({ page })
    .include("form.localuser.resend").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze());
  expect(results.violations.map((v) => ({ rule: v.id, targets: v.nodes.map((n) => n.target.join(" ")) }))).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(deskBand(page)).toHaveCount(0);
  await expect(give).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => focused(give), { message: "Escape gives focus back to give admin access…" }).toBe(true);
});

/* ── review gaps (#1633) ──────────────────────────────────────────────── */

const WRONG_PASSWORD_WORDS = /^that isn[’']t your current password — nothing was changed$/;
const RECENT_AUTH = { status: 403, code: "recent_authentication_required", message: "Confirm it is you before making this change" };

test("a disabled user's row offers no way to give administrator access", async ({ page }, testInfo) => {
  await ownRoster(page);
  await reach(page);

  if (onPhone(testInfo)) {
    const rose = await openPhoneRow(page, "Rose Harlow");
    /* The row opened: its other acts are there, the admin act is not. */
    await expect(page.getByRole("button", { name: "Enable Rose Harlow" })).toBeVisible();
    await expect(rose.getByRole("button", { name: /administrator access/ })).toHaveCount(0);
    await expect(rose.getByRole("button", { name: "make admin" })).toHaveCount(0);
    return;
  }

  await expect(deskRow(page, "Rose Harlow")).toBeVisible();
  await expect(deskRow(page, "Rose Harlow").getByRole("button", { name: /administrator access/ })).toHaveCount(0);
  await expect(deskRow(page, "Rose Harlow").getByText("give admin access…")).toHaveCount(0);
});

test("a wrong password says nothing was changed, not that nothing was created", async ({ page }, testInfo) => {
  const { sent } = await ownRoster(page, [RECENT_AUTH]);
  await reach(page);

  if (onPhone(testInfo)) {
    await openPhoneRow(page, "Emma Harlow");
    await expect(phoneGive(page, "Emma Harlow")).toBeVisible();
    await phoneGive(page, "Emma Harlow").click();
    await phoneSheet(page).getByLabel("your current password").fill("not-the-password");
    await phoneSheet(page).getByRole("button", { name: "give it" }).click();
    await expect.poll(() => sent).toHaveLength(1);
    await expect(page.locator(".p-wake.failure .msg")).toHaveText(WRONG_PASSWORD_WORDS);
    return;
  }

  await expect(deskGive(page, "Emma Harlow")).toBeVisible();
  await deskGive(page, "Emma Harlow").click();
  await deskBand(page).getByLabel("your current password").fill("not-the-password");
  await deskBand(page).getByRole("button", { name: "give it" }).click();
  await expect.poll(() => sent).toHaveLength(1);
  await expect(page.locator(".adminproblem:not(.ok)").filter({ hasText: "current password" })).toHaveText(WRONG_PASSWORD_WORDS);
});

test("on the desk, cancel and Escape each clear the refusal line the band left under the card", async ({ page }, testInfo) => {
  test.skip(onPhone(testInfo), "the refusal line under the card is the desk's; the phone's is a wake that goes by itself");
  await ownRoster(page, [
    { status: 409, code: "last_administrator", message: LAST_WORDS },
    { status: 409, code: "last_administrator", message: LAST_WORDS },
  ]);
  await reach(page);
  const refused = page.locator(".adminproblem:not(.ok)").filter({ hasText: LAST_WORDS });

  /** Opens Sue's band and is refused once. */
  const refuseOnce = async () => {
    await expect(deskRemove(page, "Sue Harlow")).toBeVisible();
    await deskRemove(page, "Sue Harlow").click();
    await deskBand(page).getByLabel("your current password").fill(PASSWORD);
    await deskBand(page).getByRole("button", { name: "remove it" }).click();
    await expect(refused).toHaveText(LAST_WORDS);
  };

  await refuseOnce();
  await deskBand(page).getByRole("button", { name: "cancel" }).click();
  await expect(deskBand(page)).toHaveCount(0);
  await expect(refused, "cancel clears the refusal line").toHaveCount(0);

  await refuseOnce();
  await deskBand(page).getByLabel("your current password").press("Escape");
  await expect(deskBand(page)).toHaveCount(0);
  await expect(refused, "Escape clears the refusal line").toHaveCount(0);
});

/**
 * Marks every role="status" region that is in the page, empty, right now, so
 * a later line can be checked to have arrived in a region that was already
 * there (a region inserted with its text is not reliably announced).
 * @param {Page} page
 */
const markEmptyStatusRegions = (page) => page.evaluate(() => {
  for (const el of document.querySelectorAll('[role="status"]')) {
    if ((el.textContent ?? "").trim() === "") el.setAttribute("data-rig-was-empty", "");
  }
});

test("on the desk, the outcome and refusal lines arrive in a status region that was in the page, empty, before the act", async ({ page }, testInfo) => {
  test.skip(onPhone(testInfo), "the phone says both in the wake, whose live regions stand in the page from the start (Wake.svelte)");
  await ownRoster(page, [{ status: 409, code: "last_administrator", message: LAST_WORDS }]);
  await reach(page);

  /* A refusal first: Sue's removal. */
  await expect(deskRemove(page, "Sue Harlow")).toBeVisible();
  await markEmptyStatusRegions(page);
  await deskRemove(page, "Sue Harlow").click();
  await deskBand(page).getByLabel("your current password").fill(PASSWORD);
  await deskBand(page).getByRole("button", { name: "remove it" }).click();
  const refusal = page.locator('[role="status"]').filter({ hasText: LAST_WORDS });
  await expect(refusal).toHaveCount(1);
  await expect(refusal, "the refusal arrives in a region that was there before").toHaveAttribute("data-rig-was-empty", "");
  await deskBand(page).getByRole("button", { name: "cancel" }).click();

  /* Then an outcome: Emma is given access. */
  await page.reload();
  await expect(deskGive(page, "Emma Harlow")).toBeVisible();
  await markEmptyStatusRegions(page);
  await deskGive(page, "Emma Harlow").click();
  await deskBand(page).getByLabel("your current password").fill(PASSWORD);
  await deskBand(page).getByRole("button", { name: "give it" }).click();
  const outcome = page.locator('[role="status"]').filter({ hasText: "Emma Harlow is now an administrator" });
  await expect(outcome).toHaveCount(1);
  await expect(outcome, "the outcome arrives in a region that was there before").toHaveAttribute("data-rig-was-empty", "");
});
