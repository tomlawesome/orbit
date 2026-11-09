import { expect, test } from "@playwright/test";

import { readAsAdministrator } from "../fidelity/pocket-states.js";
import { APP, onPhone, settle } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Page} Page */
/** @typedef {import("@playwright/test").Locator} Locator */

/*
 * #1509, direction N (design/v19/relay-settings/round-2/n-relay-tab.html, the
 * seven scenes): a member's mail relay lives in Settings, as the third tab,
 * `your relay`, of the card that used to be Reminders and is now Mail. Desk
 * and phone, in one spec, because the words and the rows are the same and
 * only the layout differs.
 *
 * The fixture app has one relay answer (a checked sender, one address), so
 * each scene says what `GET /api/settings/mail-relay` answers, as the real
 * server words it (src/server/mail-in/relay-settings.ts): no mailbox is an
 * address of null and `not listening`; an administrator's pause is
 * `not listening` with `adminPaused`; no checked sending address is the
 * `no checked sending address` word. The writes the scenes press (add an
 * address, send the check) are answered in the same closure, and nothing
 * else changes. The administrator is the fixture app's reader flipped in the
 * document, as pocket-states.js does it.
 *
 * Words are the design's, exactly. Where the design draws an apostrophe it is
 * the curly one, and the test takes either.
 */
test.use({ baseURL: APP, serviceWorkers: "block" });

const ADDRESS = "orbit+k7q2@harlow.example";
const MIRA = "mira.harlow@mailbox.example";
const WORK = "mira.h@work.example";
const POST = "m.harlow@post.example";

const sendingRow = (/** @type {Record<string, unknown>} */ more = {}) => ({
  id: "row-seeded", address: MIRA, source: "account", verified: true, verificationPending: false, expiresAt: null, daysLeft: null, ...more,
});
const extraRow = (/** @type {string} */ address, /** @type {Record<string, unknown>} */ more = {}) => ({
  id: `row-${address.split("@")[0]}`, address, source: "manual", verified: false, verificationPending: false, expiresAt: null, daysLeft: 11, ...more,
});

/** What the server answers in each of the design's scenes. */
const SCENES = {
  "working": {
    address: ADDRESS, listening: "connected · listening", lastReceivedLabel: "2 hours ago", ingest: "enabled",
    sender: sendingRow(), senders: [sendingRow(), extraRow(WORK)],
  },
  "new-member": {
    address: ADDRESS, listening: "no checked sending address", ingest: "enabled",
    sender: sendingRow({ verified: false }), senders: [sendingRow({ verified: false })],
  },
  "no-mailbox": { address: null, listening: "not listening", ingest: "enabled", sender: null, senders: [] },
  "paused": {
    address: ADDRESS, listening: "connected · listening", lastReceivedLabel: "2 hours ago", ingest: "paused",
    sender: sendingRow(), senders: [sendingRow(), extraRow(WORK)],
  },
  "admin-paused": {
    address: ADDRESS, listening: "not listening", lastReceivedLabel: "2 hours ago", ingest: "paused", adminPaused: true,
    sender: sendingRow(), senders: [sendingRow(), extraRow(WORK)],
  },
};

const NO_MAILBOX_MEMBER = /your administrator hasn['’]t set up the household mailbox yet · your address appears here when they do, with nothing to do on your side/u;
const NO_MAILBOX_ADMIN = /the household mailbox isn['’]t set up yet · set it up under Administration → Mail/u;
const READY = "your address is ready · check the address you send from, then forward a document to try it";
const ARMED = "your old address keeps collecting for 14 days, so mail already on its way still arrives";
const ADMIN_PAUSED = "collection is paused by the administrator · mail sent now waits and is read when it resumes";
const CHECK_SENT = `check email sent to ${POST} · open the link while signed in, within 24 hours`;
const CLOSING_NOTE = /Orbit matches a forward to you by the address it came from/u;

/**
 * Stands the relay up as `scene` says and opens Settings on `at`.
 * @param {Page} page
 * @param {keyof typeof SCENES} scene
 * @param {{ at?: string, admin?: boolean }} [options]
 * @returns {Promise<{ sent: { href: string, body: unknown }[], relay: Record<string, any> }>}
 */
async function openSettings(page, scene, { at = "/settings#mail", admin = false } = {}) {
  const served = { sent: /** @type {{ href: string, body: unknown }[]} */ ([]), relay: structuredClone(/** @type {Record<string, any>} */ (SCENES[scene])) };
  await page.route("**/api/settings/mail-relay**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData() ? JSON.parse(/** @type {string} */ (request.postData())) : null;
    if (request.method() === "GET" && url.pathname === "/api/settings/mail-relay") return route.fulfill({ json: { relay: served.relay } });
    served.sent.push({ href: `${request.method()} ${url.pathname}`, body });
    if (url.pathname.endsWith("/senders")) {
      served.relay.senders = [...served.relay.senders, extraRow(body.address, { daysLeft: 14 })];
      return route.fulfill({ status: 201, json: { senders: served.relay.senders } });
    }
    if (url.pathname.endsWith("/verification")) {
      return route.fulfill({ status: 202, json: { address: POST, expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString() } });
    }
    return route.fulfill({ json: { relay: served.relay } });
  });
  if (admin) await readAsAdministrator(page, at.split("#")[0].split("?")[0]);
  await page.goto(`${APP}${at}`, { waitUntil: "load" });
  await settle(page);
  return served;
}

/** The Mail card of whichever layout is showing. @param {import("@playwright/test").TestInfo} testInfo @param {Page} page */
const mailCard = (page, testInfo) => page.locator(onPhone(testInfo) ? "#p-mail" : "#mail");
/** @param {Locator} card @param {string} label */
const label = (card, label) => card.getByText(label, { exact: true });
/** @param {Locator} card @param {string | RegExp} name */
const button = (card, name) => card.getByRole("button", { name });

/** Everything the working relay shows, present. @param {Locator} card */
async function expectWorking(card) {
  await expect(card.getByText(ADDRESS).first()).toBeVisible();
  for (const row of ["status", "last received", "ingest", "waiting for review"]) await expect(label(card, row).first(), row).toBeVisible();
  await expect(button(card, "rotate address")).toBeVisible();
  await expect(button(card, "pause ingest")).toBeVisible();
  await expect(card.getByText("Sending addresses", { exact: true })).toBeVisible();
  await expect(label(card, "sending from")).toBeVisible();
  await expect(label(card, "sender check")).toBeVisible();
  await expect(card.getByText(WORK)).toBeVisible();
  await expect(button(card, "send check")).toBeVisible();
  await expect(button(card, "remove")).toBeVisible();
  await expect(card.getByPlaceholder("another address you send from")).toBeVisible();
}

test.describe("the Mail card and its three tabs", () => {
  test("Settings has a Mail card with three tabs, and no Reminders card, on both layouts", async ({ page }, testInfo) => {
    await openSettings(page, "working", { at: "/settings" });
    const card = mailCard(page, testInfo);
    await expect(card.getByRole("heading", { name: "Mail", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Reminders", level: 2 })).toHaveCount(0);
    const tabs = card.getByRole("tab");
    await expect(tabs).toHaveCount(3);
    await expect(card.getByRole("tab", { name: "reminders", exact: true })).toBeVisible();
    await expect(card.getByRole("tab", { name: /^sent (to you )?lately$/u })).toBeVisible();
    await expect(card.getByRole("tab", { name: "your relay", exact: true })).toBeVisible();
  });

  test("#mail opens with the `your relay` tab selected, and its panel is the one showing", async ({ page }, testInfo) => {
    await openSettings(page, "working", { at: "/settings#mail" });
    const card = mailCard(page, testInfo);
    await expect(card.getByRole("tab", { name: "your relay", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(card.getByRole("tab", { name: "reminders", exact: true })).toHaveAttribute("aria-selected", "false");
    await expectWorking(card);
    await expect(label(card, "email reminders")).toBeHidden();
  });

  test("?sender= opens the same tab, with no hash", async ({ page }, testInfo) => {
    await openSettings(page, "working", { at: "/settings?sender=verified" });
    const card = mailCard(page, testInfo);
    await expect(card.getByRole("tab", { name: "your relay", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(card.getByText("address checked · your relay is listening")).toBeVisible();
  });

  test("the other two tabs still show what they showed", async ({ page }, testInfo) => {
    await openSettings(page, "working", { at: "/settings#mail" });
    const card = mailCard(page, testInfo);
    await card.getByRole("tab", { name: "reminders", exact: true }).click();
    await expect(label(card, "email reminders").or(card.getByText("email reminders", { exact: true })).first()).toBeVisible();
    await expect(label(card, "rotate address")).toHaveCount(0);
    await card.getByRole("tab", { name: /^sent (to you )?lately$/u }).click();
    await expect(card.getByRole("tab", { name: /^sent (to you )?lately$/u })).toHaveAttribute("aria-selected", "true");
    await card.getByRole("tab", { name: "your relay", exact: true }).click();
    await expectWorking(card);
  });
});

test.describe("the layout", () => {
  test("Mail spans the grid and Your systems spans below it: one stack of full-width cards", async ({ page }, testInfo) => {
    test.skip(onPhone(testInfo), "the desk's grid; the phone is one column anyway, checked below");
    await openSettings(page, "working");
    const mail = page.locator("#mail");
    await expect(mail).toHaveClass(/\bcard\b/u);
    await expect(mail).toHaveClass(/\bwide\b/u);
    const systems = page.locator(".card", { has: page.getByRole("heading", { name: "Your systems" }) });
    await expect(systems).toHaveClass(/\bwide\b/u);
    const [m, s] = await Promise.all([mail.boundingBox(), systems.boundingBox()]);
    expect(m && s && Math.abs(m.width - s.width) < 1, "Mail and Your systems are the same width").toBe(true);
    expect(/** @type {any} */ (s).y, "Your systems is below Mail").toBeGreaterThan(/** @type {any} */ (m).y + /** @type {any} */ (m).height - 1);
  });

  test("the relay panel is two halves on the desk, `Your relay` left and `Sending addresses` right, and one column on the phone", async ({ page }, testInfo) => {
    await openSettings(page, "working");
    const card = mailCard(page, testInfo);
    const relay = /** @type {any} */ (await card.getByText(ADDRESS).first().boundingBox());
    const sending = /** @type {any} */ (await card.getByText("Sending addresses", { exact: true }).boundingBox());
    if (onPhone(testInfo)) {
      expect(sending.y, "Sending addresses comes after the relay's rows").toBeGreaterThan(relay.y + relay.height);
      expect(Math.abs(sending.x - relay.x), "one column: the same left edge, within the card's padding").toBeLessThan(24);
    } else {
      expect(sending.x, "Sending addresses is on the right").toBeGreaterThan(relay.x + relay.width - 1);
      const heading = /** @type {any} */ (await card.getByText("Your relay", { exact: true }).first().boundingBox());
      expect(heading.x, "Your relay is on the left").toBeLessThan(sending.x);
    }
  });
});

test.describe("only what applies", () => {
  test("working: everything", async ({ page }, testInfo) => {
    await openSettings(page, "working");
    const card = mailCard(page, testInfo);
    await expectWorking(card);
    await expect(card.getByText("connected · listening")).toBeVisible();
    await expect(card.getByText("2 hours ago")).toBeVisible();
    await expect(card.getByText(READY)).toHaveCount(0);
  });

  test("a new member: the address, `no checked sending address`, the waiting count, the guide line and Sending addresses; no rotate, pause, last received or ingest", async ({ page }, testInfo) => {
    await openSettings(page, "new-member");
    const card = mailCard(page, testInfo);
    await expect(card.getByText(ADDRESS).first()).toBeVisible();
    await expect(card.getByText("no checked sending address").first()).toBeVisible();
    await expect(label(card, "waiting for review").first()).toBeVisible();
    await expect(card.getByText(READY)).toBeVisible();
    await expect(card.getByText("Sending addresses", { exact: true })).toBeVisible();
    await expect(card.getByPlaceholder("another address you send from")).toBeVisible();
    await expect(button(card, "send the check email")).toBeVisible();
    for (const gone of ["last received", "ingest"]) await expect(label(card, gone), gone).toHaveCount(0);
    await expect(button(card, "rotate address")).toHaveCount(0);
    await expect(button(card, /^pause/u)).toHaveCount(0);
  });

  test("no household mailbox, a member: `no address yet`, `not listening`, the explanation, and nothing else", async ({ page }, testInfo) => {
    await openSettings(page, "no-mailbox");
    const card = mailCard(page, testInfo);
    await expect(card.getByText("no address yet").first()).toBeVisible();
    await expect(card.getByText("not listening").first()).toBeVisible();
    await expect(card.getByText(NO_MAILBOX_MEMBER)).toBeVisible();
    await expect(card.getByRole("link", { name: /set it up under Administration/u })).toHaveCount(0);
    await expectNothingElse(card);
  });

  test("no household mailbox, an administrator: the same slot, and a link to the Administration Mail card", async ({ page }, testInfo) => {
    await openSettings(page, "no-mailbox", { admin: true });
    const card = mailCard(page, testInfo);
    await expect(card.getByText("no address yet").first()).toBeVisible();
    await expect(card.getByText("not listening").first()).toBeVisible();
    await expect(card.getByText(NO_MAILBOX_ADMIN)).toBeVisible();
    await expect(card.getByText(NO_MAILBOX_MEMBER)).toHaveCount(0);
    const link = card.getByRole("link", { name: "set it up under Administration → Mail" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", /\/administration(\?[^#]*)?#\S*mail/iu);
    await expectNothingElse(card);
  });

  test("paused by the member: the status is warm, and the button offers to resume", async ({ page }, testInfo) => {
    await openSettings(page, "paused");
    const card = mailCard(page, testInfo);
    await expect(card.getByText(ADDRESS).first()).toBeVisible();
    await expect(button(card, /^resume/u)).toBeVisible();
    await expect(button(card, "pause ingest")).toHaveCount(0);
    const status = onPhone(testInfo)
      ? card.locator(".p-row", { has: card.locator(".title", { hasText: /^status$/u }) }).locator(".p-body")
      : card.locator(".kv", { has: card.locator("span", { hasText: /^status$/u }) }).locator("b");
    await expect(status).toHaveClass(onPhone(testInfo) ? /\bsoon\b/u : /\bwarm\b/u);
  });

  test("paused by the administrator: the status says so", async ({ page }, testInfo) => {
    await openSettings(page, "admin-paused");
    const card = mailCard(page, testInfo);
    await expect(card.getByText(ADDRESS).first()).toBeVisible();
    await expect(card.getByText(ADMIN_PAUSED)).toBeVisible();
  });

  test("the closing note is gone, desk and phone: the page the old note lived on lands in Settings without it", async ({ page }, testInfo) => {
    await page.route("**/api/settings/mail-relay", (route) => route.fulfill({ json: { relay: SCENES.working } }));
    await page.goto(`${APP}/settings/mail`, { waitUntil: "load" });
    await expect(page).toHaveURL(/\/settings#mail$/u);
    await expect(mailCard(page, testInfo).getByText(ADDRESS).first()).toBeVisible();
    await expect(page.getByText(CLOSING_NOTE)).toHaveCount(0);
  });

  /** No rotate, pause, ingest or sending rows. @param {Locator} card */
  async function expectNothingElse(card) {
    await expect(button(card, "rotate address")).toHaveCount(0);
    await expect(button(card, /^pause/u)).toHaveCount(0);
    await expect(button(card, /^resume/u)).toHaveCount(0);
    for (const gone of ["last received", "ingest", "sending from", "sender check"]) await expect(label(card, gone), gone).toHaveCount(0);
    await expect(card.getByText("Sending addresses", { exact: true })).toHaveCount(0);
    await expect(card.getByPlaceholder("another address you send from")).toHaveCount(0);
  }
});

test.describe("what the relay does in Settings", () => {
  test("rotate is warm, arms on the first press, and says what happens to the old address", async ({ page }, testInfo) => {
    await openSettings(page, "working");
    const card = mailCard(page, testInfo);
    const rotate = button(card, "rotate address");
    if (!onPhone(testInfo)) {
      /* The desk follows the phone: `.pri.warm`, the accent of every other
         primary button turned warm (design: one extra class, nothing restyled). */
      await expect(rotate).toHaveClass(/\bpri\b/u);
      await expect(rotate).toHaveClass(/\bwarm\b/u);
      const differs = await rotate.evaluate((el) => {
        const plain = /** @type {HTMLElement} */ (el.cloneNode(true));
        plain.classList.remove("warm");
        el.after(plain);
        const [a, b] = [getComputedStyle(el), getComputedStyle(plain)];
        const same = a.color === b.color && a.backgroundColor === b.backgroundColor && a.borderColor === b.borderColor;
        plain.remove();
        return !same;
      });
      expect(differs, "the warm class changes the button's colours").toBe(true);
    } else {
      await expect(rotate).toHaveClass(/\bact-warm\b/u);
    }
    await rotate.click();
    await expect(card.getByText(ARMED)).toBeVisible();
    await expect(onPhone(testInfo) ? card.getByRole("button", { name: /tap again to rotate/u }) : button(card, "tap again to rotate")).toBeVisible();
  });

  test("adding an address and sending its check puts the answer under the box", async ({ page }, testInfo) => {
    const served = await openSettings(page, "working");
    const card = mailCard(page, testInfo);
    await card.getByPlaceholder("another address you send from").fill(POST);
    await button(card, "add").click();
    await expect.poll(() => served.sent.map((one) => one.href)).toContain("POST /api/settings/mail-relay/senders");
    await expect(card.getByText(POST)).toBeVisible();
    await button(card, "send check").nth(1).click();
    await expect.poll(() => served.sent.map((one) => one.href)).toContain("POST /api/settings/mail-relay/verification");
    await expect(card.getByText(CHECK_SENT)).toBeVisible();
  });
});

test.describe("the phone's controls keep the 44px tap floor", () => {
  /**
   * Every control in the panel, in each state that draws different ones: the
   * measurement the pocket-measure project makes (width and height both 44px,
   * a control shown at all), on this card only, so it runs in seconds.
   * @param {Page} page @param {string} scope
   */
  const small = (page, scope) => page.evaluate((root) => {
    const TAPPABLE = "a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=switch],[tabindex]:not([tabindex='-1'])";
    const out = [];
    for (const el of document.querySelector(root)?.querySelectorAll(TAPPABLE) ?? []) {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1 || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      if (r.width < 43.5 || r.height < 43.5) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  }, scope);

  for (const scene of /** @type {const} */ (["working", "new-member", "no-mailbox", "paused"])) {
    test(`${scene}: no control in the Mail card is under 44px`, async ({ page }, testInfo) => {
      test.skip(!onPhone(testInfo), "the phone's floor");
      await openSettings(page, scene);
      await expect(page.locator("#p-mail")).toBeVisible();
      await settle(page);
      expect(await small(page, "#p-mail")).toEqual([]);
    });
  }

  test("rotate armed, and the add box with an address typed: still 44px", async ({ page }, testInfo) => {
    test.skip(!onPhone(testInfo), "the phone's floor");
    await openSettings(page, "working");
    const card = page.locator("#p-mail");
    await button(card, "rotate address").click();
    await card.getByPlaceholder("another address you send from").fill(POST);
    await settle(page);
    expect(await small(page, "#p-mail")).toEqual([]);
  });
});

test.describe("the old page, and every link to it", () => {
  test("/settings/mail redirects to /settings#mail and lands on the `your relay` tab", async ({ page }, testInfo) => {
    await page.route("**/api/settings/mail-relay", (route) => route.fulfill({ json: { relay: SCENES.working } }));
    await page.goto(`${APP}/settings/mail`, { waitUntil: "load" });
    await expect(page).toHaveURL(/\/settings#mail$/u);
    await expect(mailCard(page, testInfo).getByRole("tab", { name: "your relay", exact: true })).toHaveAttribute("aria-selected", "true");
  });

  test("/settings/mail?sender=verified keeps ?sender= through the redirect, so the landing announces itself", async ({ page }, testInfo) => {
    await page.route("**/api/settings/mail-relay", (route) => route.fulfill({ json: { relay: SCENES.working } }));
    await page.goto(`${APP}/settings/mail?sender=verified`, { waitUntil: "load" });
    const landed = new URL(page.url());
    expect(landed.pathname).toBe("/settings");
    /* The card's own landing cleans ?sender= from the bar once it has said
       its piece, so the redirect is read on the way, by the announcement. */
    await expect(mailCard(page, testInfo).getByText("address checked · your relay is listening")).toBeVisible();
    await expect(mailCard(page, testInfo).getByRole("tab", { name: "your relay", exact: true })).toHaveAttribute("aria-selected", "true");
  });

  test("/settings/mail?sender=unverified lands on the refusal, in an alert", async ({ page }, testInfo) => {
    await page.route("**/api/settings/mail-relay", (route) => route.fulfill({ json: { relay: SCENES["new-member"] } }));
    await page.goto(`${APP}/settings/mail?sender=unverified`, { waitUntil: "load" });
    await expect(mailCard(page, testInfo).getByRole("alert")).toContainText("that link didn't work");
  });

  test("the inbox's links to the relay, desk and phone, go to /settings#mail", async ({ page }, testInfo) => {
    await page.route("**/api/imap-inbox", (route) => route.fulfill({ json: { receipts: [], filed: [] } }));
    await page.goto(`${APP}/inbox`, { waitUntil: "load" });
    const link = page.getByRole("link", { name: onPhone(testInfo) ? "open the relay →" : "your relay →" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/settings#mail");
    await expect(page.locator('a[href="/settings/mail"]')).toHaveCount(0);
  });

  test("Settings no longer carries the small relay card that only linked to the page", async ({ page }) => {
    await openSettings(page, "working", { at: "/settings" });
    await expect(page.getByRole("link", { name: "open the relay →" })).toHaveCount(0);
    await expect(page.locator('a[href="/settings/mail"]')).toHaveCount(0);
    await expect(page.getByText("rotate · pause · details")).toHaveCount(0);
  });
});
