// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureApi } from "../support/fixture-api.mjs";
import { createPageLoader, runtime } from "../support/svelte-page.mjs";
import { subscribeWake } from "$lib/pocket/wake.js";

/*
 * HOME'S DRAWERS ON A PHONE (#1120, review round §2.1), mounted in happy-dom
 * over the fixtures instance's own home (#1613, ADR-0039): what a manifest
 * row's foot asks when `complete` is tapped (#1319 stage 2), what a search
 * result or an address opens, and how a suggestion's row is reviewed in place
 * (its two decisions, `review & amend →` putting its lines into editing,
 * cancel asked twice over a change). Where the dial's planets, the sheets'
 * inert and focus, scroll and the outlines are drawn stays on the rig
 * (pocket-home-drawers.spec.js).
 *
 * The mount stands the pocket dialect (the media query matches) with the
 * desk's behaviour (home.behaviour.js: canvas, dial, pointer) and the page's
 * flight, sun and chrome stood in for: none of them draws a row or a drawer.
 */

vi.mock("$lib/tour/watch.js", () => ({ watchTour: () => () => {} }));
vi.mock("../../web/src/routes/home/home.behaviour.js", () => ({
  mountHome: () => () => {}, mountAccount: () => () => {}, mountEmptySky: () => () => {},
}));

const PAGE = "routes/home/+page.svelte";
/** The pair a receipt with an earlier approval still pending reports (#1396, #1584 web-wr9). */
const PAIR = {
  operationId: "7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a",
  request: {
    source: { kind: "mailbox_draft", receiptId: "r-insurance", draftVersion: 3 },
    householdId: "hh-harlow-1",
    sectionId: "s-home",
    action: "create_separate",
    item: { kind: "renewal", title: "Home insurance renewal", currency: "GBP" },
    attachmentIds: ["a-1"],
  },
};

describe("home's drawers on a phone, mounted", () => {
  const loader = createPageLoader("pocket-home-drawers", {
    stub: (file) => /\/lib\/(Chrome|pocket\/Sky|pocket\/NorthStar|flight\/Leave|flight\/Dawn|sun\/Sun|NorthStarMark)\.svelte$/.test(file),
  });
  beforeAll(() => loader.setup(PAGE));
  afterAll(() => loader.teardown());
  /** @type {(() => void) | null} */
  let stopWatching = null;
  afterEach(() => { loader.unmount(); stopWatching?.(); stopWatching = null; vi.unstubAllGlobals(); });

  /**
   * The writes an approval makes are answered here and read back; the fixture
   * API answers reads only.
   * @param {{ url?: string, overrides?: Parameters<typeof fixtureApi>[0] }} [options]
   */
  async function mountHome({ url = "http://localhost/home", overrides = {} } = {}) {
    /** @type {{ approvals: any[] }} */
    const seen = { approvals: [] };
    const api = fixtureApi({
      "GET /api/imap-inbox/*": ({ path }) => ({
        receipt: { id: path.split("/").pop(), draftVersion: 3, proposal: { title: "Home insurance renewal" } },
        sections: [{ id: "s-home" }, { id: "s-dates" }],
        attachments: [{ id: "a-1" }],
      }),
      "PUT /api/imap-inbox/*": () => ({ ok: true }),
      "POST /api/reviewed-intake/approve": ({ body }) => { seen.approvals.push(body); return { outcome: "approved", itemId: "i-new" }; },
      ...overrides,
    });
    vi.stubGlobal("fetch", api.fetch);
    /* the phone: everything but the desk's width query matches */
    vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
      matches: !query.includes("901"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    /** @type {string[]} */
    const wakes = [];
    /* subscribing replays the wake standing now (a previous test's, held 4 s): not this one's */
    let replay = true;
    stopWatching = subscribeWake((entry) => { if (replay) { replay = false; return; } if (entry) wakes.push(entry.message); });
    await loader.mount(PAGE, { data: { view: null, fixtures: true } }, { url });
    const { flushSync } = await runtime();
    /** Lets promises and timers at zero run, then draws what they changed. */
    const settle = async () => { await new Promise((done) => setTimeout(done, 0)); flushSync(); };
    await vi.waitFor(() => expect(document.querySelector(".pocket .pk-below [data-row]")).not.toBeNull());
    await settle();
    return { api, seen, wakes, settle };
  }

  const $ = (/** @type {string} */ selector, /** @type {ParentNode} */ scope = document) =>
    /** @type {HTMLElement} */ (scope.querySelector(selector));
  const $$ = (/** @type {string} */ selector, /** @type {ParentNode} */ scope = document) =>
    /** @type {HTMLElement[]} */ ([...scope.querySelectorAll(selector)]);
  const text = (/** @type {Element} */ el) => (el.textContent ?? "").replace(/\s+/gu, " ").trim();
  /** A row of the manifest or the signals, by text. */
  const row = (/** @type {"below" | "signals"} */ list, /** @type {string} */ words) =>
    $$(`.pocket .pk-${list} [data-row]`).find((el) => el.textContent?.includes(words)) ?? null;
  const control = (/** @type {string | RegExp} */ name, /** @type {ParentNode} */ scope = document) =>
    $$("button, a", scope).find((el) => {
      const words = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
      return typeof name === "string" ? words === name : name.test(words);
    }) ?? null;
  const group = (/** @type {string} */ name, /** @type {ParentNode} */ scope = document) =>
    $$('[role="group"]', scope).find((el) => el.getAttribute("aria-label") === name) ?? null;
  const reachable = (/** @type {Element | null} */ el) => Boolean(el) && !el?.closest("[hidden]");
  const click = (/** @type {HTMLElement | null} */ el) => { if (!el) throw new Error("no such control"); el.click(); };
  const isOpen = (/** @type {Element | null} */ el) => Boolean(el?.hasAttribute("data-open"));
  const open = async (/** @type {HTMLElement | null} */ one, /** @type {() => Promise<void>} */ settle) => {
    click($("[data-row-face]", /** @type {HTMLElement} */ (one)));
    await settle();
  };
  /** Types into a row's editable line, as the reader does. */
  const type = (/** @type {HTMLElement} */ el, /** @type {string} */ words) => {
    el.textContent = words;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const sheetsOpen = () => $$(".p-sheet-layer.open");

  /* #1319 stage 2 (owner, 2026-10-08): complete asks for the date, the cost
     and the notes in the rows before it records; cancel sends nothing. */
  it("complete asks in the rows, in place", async () => {
    const { api, settle } = await mountHome();
    const gutter = /** @type {HTMLElement} */ (row("below", "Gutter clearing"));
    await open(gutter, settle);
    click(control("Complete Gutter clearing", gutter));
    await settle();
    expect(loader.navigation.goto).not.toHaveBeenCalled();
    const completing = /** @type {HTMLElement} */ (group("Completing Gutter clearing", gutter));
    expect(completing).not.toBeNull();
    expect($$("button", completing).map(text)).toEqual(["record", "cancel"]);
    expect(control(/^completed on: /, gutter)).not.toBeNull();
    click(control("cancel", completing));
    await settle();
    expect(reachable(group("Actions for Gutter clearing", gutter))).toBe(true);
    /* cancel sends nothing (the form's dry run asks the engine and writes nothing) */
    expect(api.calls.filter((call) => call.method !== "GET" && !call.body?.dryRun)).toEqual([]);
  });

  it("a search result opens the row, and closes the search", async () => {
    const { settle } = await mountHome();
    click($(".msearch"));
    await settle();
    const field = /** @type {HTMLInputElement} */ ($(".pk-field"));
    field.value = "MOT";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const hit = $$(".pk-results [data-row-face]").find((el) => el.textContent?.includes("Car MOT"));
    click(hit ?? null);
    await settle();
    expect(isOpen(row("below", "Car MOT"))).toBe(true);
    expect(document.activeElement).toBe($("[data-row-face]", /** @type {HTMLElement} */ (row("below", "Car MOT"))));
    expect(sheetsOpen()).toHaveLength(0);
  });

  it("a search result with no row draws one and opens it", async () => {
    const { settle } = await mountHome();
    expect(row("below", "Chimney sweep")).toBeNull();
    click($(".msearch"));
    await settle();
    const field = /** @type {HTMLInputElement} */ ($(".pk-field"));
    field.value = "Chimney";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    click($$(".pk-results [data-row-face]").find((el) => el.textContent?.includes("Chimney sweep")) ?? null);
    await settle();
    expect(isOpen(row("below", "Chimney sweep"))).toBe(true);
    expect(sheetsOpen()).toHaveLength(0);
    expect(loader.navigation.goto).not.toHaveBeenCalled();
  });

  it("the address of an item the manifest does not list draws its row and opens it", async () => {
    /* Chimney sweep is 61 days out, so the manifest draws no row for it (#1282):
       the address must not be left opening nothing. Since #1319 it is drawn
       as one more row, on home, rather than sent to the belt. */
    /** @type {Element[]} */
    const scrolled = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = /** @type {any} */ (function () { scrolled.push(/** @type {any} */ (this)); });
    try {
      const { settle } = await mountHome({ url: "http://localhost/home?item=i-chimney" });
      await vi.waitFor(() => expect(row("below", "Chimney sweep")).not.toBeNull());
      await settle();
      const chimney = /** @type {HTMLElement} */ (row("below", "Chimney sweep"));
      expect(isOpen(chimney)).toBe(true);
      /* ...and put on screen: the phone scrolls the row it opened (pocket.svelte openRow). */
      await vi.waitFor(() => expect(scrolled, "the opened row is scrolled on screen").toContain(chimney));
      expect(reachable(group("Actions for Chimney sweep", chimney))).toBe(true);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("a suggestion's address opens its row in the signals", async () => {
    const { settle } = await mountHome({ url: "http://localhost/home?item=r-insurance" });
    await vi.waitFor(() => expect(isOpen(row("signals", "Home insurance"))).toBe(true));
    await settle();
    expect(loader.navigation.goto).not.toHaveBeenCalled();
  });

  /** Opens the relay's catch. */
  async function openCatch(/** @type {Awaited<ReturnType<typeof mountHome>>} */ mounted) {
    const catch_ = /** @type {HTMLElement} */ (row("signals", "Home insurance"));
    await open(catch_, mounted.settle);
    return catch_;
  }

  it("Add to orbit arms on the first tap and approves as proposed on the second, from the row", async () => {
    const mounted = await mountHome();
    const catch_ = await openCatch(mounted);
    click(control("Add Home insurance renewal to your orbit", catch_));
    await mounted.settle();
    expect(control("tap again to add Home insurance renewal to your orbit", catch_)).not.toBeNull();
    expect(mounted.seen.approvals).toHaveLength(0);
    click(control("tap again to add Home insurance renewal to your orbit", catch_));
    await vi.waitFor(() => expect(mounted.seen.approvals).toHaveLength(1));
    expect(mounted.seen.approvals[0]).toMatchObject({
      sectionId: "s-home", action: "create_separate", attachmentIds: ["a-1"],
      source: { kind: "mailbox_draft", receiptId: "r-insurance", draftVersion: 3 },
    });
    expect(loader.navigation.goto).not.toHaveBeenCalled();
  });

  it("review & amend puts the row's lines into editing, and add to orbit approves them amended", async () => {
    const mounted = await mountHome();
    const { settle, seen, wakes } = mounted;
    const catch_ = await openCatch(mounted);
    click(control("review & amend →", catch_));
    await settle();
    /* No sheet rises: the lines are live in the row, the title in its head. */
    expect($$('[role="dialog"]').some((el) => el.textContent?.includes("Review & amend"))).toBe(false);
    const title = $('[data-ed="title"]', catch_);
    expect(text(title)).toBe("Home insurance renewal");
    /* and focus follows them: the title is where the reader's next key lands (focusInRow) */
    expect(document.activeElement).toBe(title);
    expect(text($('[data-ed="provider"]', catch_))).toBe("Harbour Mutual");
    /* The two decisions give way to add and cancel; review & amend goes. */
    expect(control("Add Home insurance renewal to your orbit", catch_)).toBeNull();
    expect(control("review & amend →", catch_)).toBeNull();
    const amending = /** @type {HTMLElement} */ (group("Amending Home insurance renewal", catch_));
    expect($$("button", amending).map(text)).toEqual(["add to orbit", "cancel"]);
    type(title, "Home insurance, corrected");
    type($('[data-ed="provider"]', catch_), "Harbour Mutual plc");
    await settle();
    click(control("add to orbit", amending));
    await vi.waitFor(() => expect(seen.approvals).toHaveLength(1));
    expect(seen.approvals[0]).toMatchObject({
      action: "create_separate", attachmentIds: ["a-1"],
      source: { kind: "mailbox_draft", receiptId: "r-insurance", draftVersion: 3 },
      /* the cost as the rows hold it, for the engine to read (ADR-0034, #1325) */
      item: { title: "Home insurance, corrected", provider: "Harbour Mutual plc", cost: "£400.00", currency: "GBP",
        dueDate: "2026-10-03", scheduleKind: "renewal", kind: "renewal", recurrenceMonths: 12 },
    });
    await vi.waitFor(() => expect(wakes).toContain("added to your orbit · Home insurance, corrected"));
    expect(loader.navigation.goto).not.toHaveBeenCalled();
  });

  it("cancel, asked twice over a change, puts the readings back and sends nothing", async () => {
    const mounted = await mountHome();
    const { settle, seen } = mounted;
    const catch_ = await openCatch(mounted);
    click(control("review & amend →", catch_));
    await settle();
    type($('[data-ed="provider"]', catch_), "Someone else");
    await settle();
    /* The rows hold a change, so the first tap only asks (84b21c82). */
    const amending = /** @type {HTMLElement} */ (group("Amending Home insurance renewal", catch_));
    click(control("cancel", amending));
    await settle();
    click(control("discard changes?", amending));
    await settle();
    expect(catch_.querySelector('[data-ed="provider"]')).toBeNull();
    expect(text($$(".p-kv", catch_).find((el) => el.textContent?.includes("provider")) ?? catch_)).toContain("Harbour Mutual");
    expect(control("review & amend →", catch_)).not.toBeNull();
    /* focus returns to the button that started the amend, not to the body */
    expect(document.activeElement).toBe(control("review & amend →", catch_));
    expect(seen.approvals).toHaveLength(0);
  });

  it("#1584 web-wr9-3: an amend over a pending pair is replayed, and the wake says so, from the row", async () => {
    const mounted = await mountHome({
      overrides: {
        "GET /api/imap-inbox/*": ({ path }) => ({
          receipt: { id: path.split("/").pop(), draftVersion: 3, proposal: { title: "Home insurance renewal" } },
          sections: [{ id: "s-home" }, { id: "s-dates" }],
          attachments: [{ id: "a-1" }],
          approval: PAIR,
        }),
      },
    });
    const { settle, seen, wakes } = mounted;
    const catch_ = await openCatch(mounted);
    click(control("review & amend →", catch_));
    await settle();
    type($('[data-ed="title"]', catch_), "Home insurance, corrected");
    await settle();
    click(control("add to orbit", /** @type {HTMLElement} */ (group("Amending Home insurance renewal", catch_))));
    await vi.waitFor(() => expect(seen.approvals).toHaveLength(1));
    /* the pair verbatim, not the corrected title */
    expect(seen.approvals[0]).toEqual({ ...PAIR.request, operationId: PAIR.operationId });
    expect(seen.approvals[0].item.title).toBe("Home insurance renewal");
    await vi.waitFor(() => expect(wakes.some((words) => words.includes("earlier approval"))).toBe(true));
    expect(wakes.some((words) => words.includes("added to your orbit"))).toBe(false);
    expect(document.body.textContent).not.toMatch(/not added/i);
  });
});
