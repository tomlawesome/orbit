// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";
import { readHome } from "../../web/src/lib/data/workspace.js";
import { dismissWake } from "../../web/src/lib/pocket/wake.js";
import { INBOX_FIXTURE } from "../../web/src/lib/data/fixtures/inbox.js";
import { SESSION_FIXTURE, WORKSPACE_FIXTURE, WORKSPACE_FIXTURE_TODAY } from "../../web/src/lib/data/fixtures/workspace.js";

/*
 * #1145 (owner, 2026-09-27): "let the suggested items open as a drawer like
 * the manifest items". On the desk home a suggestion row opens into
 * SuggestionView.svelte: the relay's readings with how sure it was, when it
 * burns up, the paper it came in, the two decisions that used to sit on the
 * row at rest, `copy link` and `review & amend →`. #1319 (owner-decisions
 * §34): a suggestion is reviewed in its home drawer -- amended in the drawer's
 * own rows and accepted, and dismiss takes two presses.
 *
 * Moved from web/tests/fidelity/home-suggestion-drawer.spec.js (ADR-0039,
 * #1613). home/+page.svelte cannot be mounted here, so the drawer is mounted
 * through tests/unit/support/SuggestionDrawerHost.svelte: CorridorRow ->
 * SuggestionView -> EditRows with the page's own glue (tapReceipt,
 * amendReceipt) over the real createDrawerActs, createReceiptActs and data
 * layer, with a fetch that answers the fixture reads and records the writes --
 * the same thing the rig's page.route did. What stays on the rig is what needs
 * a browser: the address and Back, Escape and click-off, real focus, the
 * chooser card and the preview card standing beside the drawer.
 *
 * Runs already proven lower and so not repeated one for one (named in the
 * commit): receipt-acts-replayed, approve-with-operation, v19-home-shared-acts
 * and home-drawer-landed-then-reread prove the same acts at the act level.
 */

/* The real wake store, with the words it was handed also kept; Wake.svelte is
   mounted over it, so a test reads the two live regions a reader would hear. */
const wakes = vi.hoisted(() => /** @type {string[]} */ ([]));
vi.mock("$lib/pocket/wake.js", async (importActual) => {
  const actual = /** @type {typeof import("../../web/src/lib/pocket/wake.js")} */ (await importActual());
  return {
    ...actual,
    wake: (/** @type {string} */ words, /** @type {any} */ options) => { wakes.push(words); return actual.wake(words, options); },
  };
});

const HOST = `${import.meta.dirname}/support/SuggestionDrawerHost.svelte`;
const WAKE_HOST = "lib/pocket/Wake.svelte";
const page = createPageLoader("home-suggestion-drawer");

/** What the fake relay saw, and how it is told to behave. */
const seen = /** @type {{ approvals: any[], discards: string[], pair: any, sinkNextWorkspace: boolean, afterApprove: (() => void) | null }} */ ({
  approvals: [], discards: [], pair: null, sinkNextWorkspace: false, afterApprove: null,
});

const json = (/** @type {unknown} */ body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** The calls home makes: the three reads of readHome, and what a decision sends. */
async function relay(/** @type {string} */ href, /** @type {RequestInit | undefined} */ init) {
  const url = new URL(href, "http://localhost");
  const method = init?.method ?? "GET";
  if (url.pathname === "/api/workspace") {
    if (seen.sinkNextWorkspace) { seen.sinkNextWorkspace = false; throw new TypeError("Failed to fetch"); }
    return json({ workspace: WORKSPACE_FIXTURE, fixtureToday: WORKSPACE_FIXTURE_TODAY });
  }
  if (url.pathname === "/api/auth/session") return json(SESSION_FIXTURE);
  if (url.pathname === "/api/imap-inbox") return json(INBOX_FIXTURE);
  if (url.pathname.startsWith("/api/imap-inbox/r-")) {
    const id = url.pathname.split("/").pop() ?? "";
    if (method === "DELETE") { seen.discards.push(id); return json({ ok: true }); }
    if (method === "PUT") return json({ ok: true });
    return json({
      receipt: { id, draftVersion: 3, proposal: { title: "Home insurance renewal" } },
      sections: [{ id: "s-home" }, { id: "s-dates" }],
      attachments: [{ id: "a-1" }],
      ...(seen.pair ? { approval: seen.pair } : {}),
    });
  }
  if (url.pathname === "/api/reviewed-intake/approve") {
    seen.approvals.push(JSON.parse(String(init?.body)));
    if (seen.afterApprove) seen.afterApprove();
    return json({ outcome: "approved", itemId: "i-new" });
  }
  return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  wakes.length = 0;
  dismissWake();
  Object.assign(seen, { approvals: [], discards: [], pair: null, sinkNextWorkspace: false, afterApprove: null });
  vi.stubEnv("ORBIT_FIXTURES", "1");
  vi.stubGlobal("fetch", vi.fn(relay));
});
afterEach(() => {
  page.unmount();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(() => page.teardown());

/** The home view as readHome reads it, mounted into the host's corridor. */
async function openHome() {
  const first = await readHome();
  await page.mount(WAKE_HOST, {});
  const { target, flushSync } = await page.mount(HOST, { first });
  await settle();
  /** The wake's two live regions: what is announced politely, and what assertively. */
  const regions = () => ({
    status: document.querySelector('.p-wake-host [role="status"]')?.textContent ?? null,
    alert: document.querySelector('.p-wake-host [role="alert"]')?.textContent ?? null,
  });
  const row = () => /** @type {HTMLElement} */ (target.querySelector("a.item.suggest, div.item.suggest"));
  const drawer = () => /** @type {HTMLElement | null} */ (target.querySelector('[id="r-insurance-view"]'));
  /** A button in the drawer by its accessible name. @param {string} name */
  const button = (name) => [...(drawer()?.querySelectorAll("button") ?? [])].find(
    (one) => (one.getAttribute("aria-label") ?? one.textContent ?? "").trim() === name);
  /** Presses a button of the drawer and lets the page settle. @param {string} name */
  const press = async (name) => {
    const one = button(name);
    expect(one, `a button named "${name}" is in the drawer`).toBeDefined();
    one?.click();
    flushSync();
    await settle();
  };
  /** Types into a live row, as the keyboard does. @param {string} selector @param {string} text */
  const type = (selector, text) => {
    const field = /** @type {HTMLElement} */ (target.querySelector(selector));
    expect(field, `${selector} is editable`).not.toBeNull();
    field.textContent = text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
  };
  const open = async () => { row().click(); flushSync(); await settle(); };
  return { target, flushSync, row, drawer, button, press, type, open, regions };
}

describe("a suggestion row, at rest and opened (#1145)", () => {
  it("at rest it carries the hollow mark, the title and the found-in line, and no decisions", async () => {
    const { row, drawer } = await openHome();
    expect(row().textContent).toContain("Home insurance renewal");
    expect(row().querySelector(".planet.sug")).not.toBeNull();
    expect(row().querySelector(".body span")?.textContent).toBe("Found in 1 forwarded document · renews 03 Oct · ~£400.00");
    expect(row().querySelectorAll("button")).toHaveLength(0);
    expect(drawer()).toBeNull();
    expect(row().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens into the relay's readings with how sure it was, when it burns up, the paper and the decisions", async () => {
    const { target, row, drawer, button, open } = await openHome();
    await open();
    expect(row().getAttribute("aria-expanded")).toBe("true");
    const view = /** @type {HTMLElement} */ (drawer());
    expect(view, "the drawer is drawn").not.toBeNull();
    const kv = (/** @type {string} */ label) =>
      [...view.querySelectorAll(".kv")].find((one) => one.querySelector("span")?.textContent === label);
    expect(kv("provider")?.querySelector("b")?.textContent).toContain("Harbour Mutual");
    expect(kv("provider")?.querySelector("i.sure")?.textContent).toBe("sure");
    expect(kv("renews")?.querySelector("b")?.textContent).toContain("03 Oct 2026");
    expect(kv("cost")?.querySelector("b")?.textContent).toContain("~£400.00");
    expect(kv("cost")?.querySelector("i.sure")?.textContent).toBe("unsure");
    expect(kv("burns up")?.querySelector("b")?.textContent).toBe("in 43d · 25 September 2026");
    /* The paper it came in, attached only on acceptance. */
    expect(view.querySelector(".doc")?.textContent).toContain("policy-schedule.pdf");
    expect(view.querySelector(".doc small")?.textContent).toBe("attached on acceptance");
    for (const name of ["Add to orbit", "Dismiss", "copy link", "review & amend →"]) {
      expect(button(name), `"${name}" is offered`).toBeDefined();
    }
    /* Nothing about a suggestion links to the retired item screen, and nothing here promises anything (owner's 10b). */
    expect(view.querySelectorAll('a[href^="/item"]')).toHaveLength(0);
    expect(target.textContent).not.toContain("nothing is created");
  });
});

describe("the two decisions take two presses (#434)", () => {
  it("Add to orbit arms on the first press and approves on the second, from the drawer", async () => {
    const { open, press, button } = await openHome();
    await open();
    await press("Add to orbit");
    expect(button("tap again to approve")).toBeDefined();
    expect(seen.approvals).toHaveLength(0);
    await press("tap again to approve");
    expect(seen.approvals).toHaveLength(1);
    expect(seen.approvals[0]).toMatchObject({
      sectionId: "s-home", action: "create_separate", attachmentIds: ["a-1"],
      source: { kind: "mailbox_draft", receiptId: "r-insurance", draftVersion: 3 },
    });
  });

  it("Dismiss arms on the first press and discards on the second, from the drawer", async () => {
    const { open, press, button } = await openHome();
    await open();
    await press("Dismiss");
    expect(button("tap again to dismiss")).toBeDefined();
    expect(seen.discards).toHaveLength(0);
    await press("tap again to dismiss");
    expect(seen.discards).toEqual(["r-insurance"]);
  });
});

describe("review & amend edits the proposal in the rows (#1319)", () => {
  it("puts the rows into editing, and add to orbit approves the proposal as amended", async () => {
    const { target, drawer, button, open, press, type } = await openHome();
    await open();
    await press("review & amend →");
    /* The decisions give way to add and cancel; the readings to live rows. */
    expect(button("Add to orbit")).toBeUndefined();
    expect(button("add to orbit")).toBeDefined();
    expect(button("cancel")).toBeDefined();
    expect(target.querySelector('[id="r-insurance"] [data-ed="title"]')?.textContent).toBe("Home insurance renewal");
    expect(drawer()?.querySelector('[data-ed="provider"]')?.textContent).toBe("Harbour Mutual");
    expect(drawer()?.querySelector('[data-ed="cost"]')?.textContent).toBe("£400.00");

    type('[id="r-insurance"] [data-ed="title"]', "Home insurance, corrected");
    type('[id="r-insurance-view"] [data-ed="cost"]', "199.99");
    type('[id="r-insurance-view"] [data-ed="reference"]', "HM-7");
    await press("add to orbit");

    expect(seen.approvals).toHaveLength(1);
    expect(seen.approvals[0]).toMatchObject({
      action: "create_separate", attachmentIds: ["a-1"],
      source: { kind: "mailbox_draft", receiptId: "r-insurance", draftVersion: 3 },
      /* The rows send the cost as typed, for the engine to read (ADR-0034, #1325). */
      item: { title: "Home insurance, corrected", provider: "Harbour Mutual", reference: "HM-7", cost: "199.99",
        currency: "GBP", dueDate: "2026-10-03", scheduleKind: "renewal", recurrenceMonths: 12 },
    });
    /* Added: the drawer goes, and the wake says so. */
    expect(drawer()).toBeNull();
    expect(wakes).toEqual(["added to your orbit · Home insurance, corrected"]);
  });

  it("cancel, asked twice over a change, puts the readings back and sends nothing", async () => {
    const { drawer, button, open, press, type } = await openHome();
    await open();
    await press("review & amend →");
    type('[id="r-insurance-view"] [data-ed="cost"]', "1.00");
    /* The rows hold a change, so the first press only asks (84b21c82). */
    await press("cancel");
    expect(button("discard changes?"), "the first press asked").toBeDefined();
    await press("discard changes?");
    expect(button("Add to orbit"), "the decisions are back").toBeDefined();
    const cost = [...(drawer()?.querySelectorAll(".kv") ?? [])].find((one) => one.querySelector("span")?.textContent === "cost");
    expect(cost?.querySelector("b")?.textContent).toContain("~£400.00");
    expect(seen.approvals).toHaveLength(0);
  });
});

/*
 * #1584 web-wr9: a receipt with an earlier approval still pending. The review
 * read reports the pair (#1396), so the approval is that pair sent verbatim.
 * Matched on the fragment `earlier approval`, never on the whole sentence: the
 * words belong to the seam alone.
 */
const PAIR = {
  operationId: "7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a",
  request: {
    source: { kind: "mailbox_draft", receiptId: "r-insurance", draftVersion: 3 },
    householdId: "hh-harlow-1",
    sectionId: "s-home",
    action: "create_separate",
    item: { title: "Home insurance renewal", currency: "GBP" },
    attachmentIds: ["a-1"],
  },
};

describe("an amended add that lands in an unusual way (#1584 web-wr9)", () => {
  it("web-wr9-3: an amend over a pending pair is replayed, and the wake says so", async () => {
    seen.pair = PAIR;
    const { drawer, target, open, press, type, regions } = await openHome();
    await open();
    await press("review & amend →");
    type('[id="r-insurance"] [data-ed="title"]', "Home insurance, corrected");
    await press("add to orbit");
    expect(seen.approvals).toHaveLength(1);
    /* the pair verbatim, not the corrected title */
    expect(seen.approvals[0]).toEqual({ ...PAIR.request, operationId: PAIR.operationId });
    expect(seen.approvals[0].item.title).toBe("Home insurance renewal");
    expect(drawer()).toBeNull();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain("earlier approval");
    expect(wakes[0]).not.toContain("added to your orbit");
    /* said in the status region, not as a failure, and never as the plain add */
    expect(regions().status).toContain("earlier approval");
    expect(regions().status).not.toContain("added to your orbit");
    expect(regions().alert).toBe("");
    expect(target.textContent).not.toMatch(/not added/i);
  });

  it("web-wr9-2: a failed re-read after an amended add is done, not 'not added', and the row says so", async () => {
    /* answer the approval, then sink the one home read that follows it */
    seen.afterApprove = () => { seen.sinkNextWorkspace = true; };
    const { drawer, target, open, press, type, regions } = await openHome();
    await open();
    await press("review & amend →");
    type('[id="r-insurance"] [data-ed="title"]', "Home insurance, corrected");
    await press("add to orbit");
    expect(seen.approvals).toHaveLength(1);
    expect(drawer()).toBeNull();
    /* The done line is the wake, in place of "added to your orbit". */
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatch(/^done — .*reload/);
    /* in the status region; the alert region is empty: a plain wake, not a failure */
    expect(regions().status).toMatch(/^done — .*reload/);
    expect(regions().status).not.toContain("added to your orbit");
    expect(regions().alert).toBe("");
    expect(target.textContent).not.toMatch(/not added/i);
    /* The stale row kept its line for a reader who opens it before reloading. */
    await open();
    const problem = drawer()?.querySelector(".mail-problem");
    expect(problem, "the line is drawn under the row").not.toBeNull();
    expect(problem?.textContent).toMatch(/^done — .*reload/);
  });
});
