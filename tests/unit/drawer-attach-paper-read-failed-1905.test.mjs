import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1905: on the phone (Home pocket) an attach whose paper read failed never
 * reports done, whatever other read lands meanwhile. The attach's own re-read
 * (rereadSearchDocuments with mustRead = the item) reports "could not refresh"
 * only when its own read ran and failed. When a plain loadSearchDocuments with
 * a new household object supersedes it, the attach's read stops early and the
 * failure is never seen, so the attach reads as a plain success.
 *
 * What the code must do (either way is accepted): the attach still ends in the
 * "could not refresh" outcome, or the later load's paper read covers the item
 * and its failure is reported the same way (the item's row and the wake say
 * DONE_UNREAD). The tests drive the real acts with the phone's reread wiring
 * (pocket.svelte: view re-read, then rereadSearchDocuments(lit, item)); the
 * workspace calls and the wake are stood in, as v19-home-drawer-attach-id.
 */
const ws = vi.hoisted(() => ({
  applyCommand: vi.fn(), attachItemDocument: vi.fn(), askCommand: vi.fn(), checkCommand: vi.fn(), dueDateIn: vi.fn(),
  readItemDocuments: vi.fn(), readReminders: vi.fn(), removeDocument: vi.fn(), restoreDocument: vi.fn(),
  wordsOf: (/** @type {unknown} */ e, fallback = "failed") => (e instanceof Error ? e.message : fallback),
}));
const wakes = vi.hoisted(() => ({ wake: vi.fn() }));
vi.hoisted(() => {
  const state = Object.assign((/** @type {unknown} */ v) => v, {
    raw: (/** @type {unknown} */ v) => v, snapshot: (/** @type {unknown} */ v) => v,
  });
  Object.assign(globalThis, { $state: state, $effect: () => {}, $derived: (/** @type {unknown} */ v) => v });
});
vi.mock("$lib/data/workspace.js", () => ws);
vi.mock("$lib/pocket/wake.js", () => wakes);
const drawer = await import("../../web/src/routes/home/drawer-acts.svelte.js");
const { SEARCH_DOC_CONCURRENCY } = await import("../../web/src/routes/home/pocket-search.js");
const { DONE_UNREAD } = await import("../../web/src/lib/data/landed.js");

beforeEach(() => {
  for (const fn of Object.values(ws)) if (typeof fn.mockReset === "function") fn.mockReset();
  wakes.wake.mockReset();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * A phone household of SEARCH_DOC_CONCURRENCY + 1 items carrying papers: the
 * attach target is the 7th, so its paper read waits behind the first six.
 * The first six reads are held on a gate; the target's read fails or succeeds.
 * @param {{ targetReads: "fails" | "succeeds" }} how
 */
function phone({ targetReads }) {
  const items = Array.from({ length: SEARCH_DOC_CONCURRENCY + 1 }, (_, i) => ({
    id: `i${i}`, title: `Item ${i}`, status: "active", documentCount: 1, householdId: "h1",
  }));
  const target = items[items.length - 1];
  const world = { household: /** @type {any} */ ({ items }) };
  /** @type {Array<[string, string]>} */
  const said = [];
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });
  let held = 0;
  ws.attachItemDocument.mockResolvedValue({});
  ws.readItemDocuments.mockImplementation(async (/** @type {string} */ _h, /** @type {string} */ id) => {
    if (held < SEARCH_DOC_CONCURRENCY) { held += 1; await gate; }
    if (id === target.id) {
      if (targetReads === "fails") throw new Error("papers would not load");
      return [{ id: "d-roof", name: "roof-quote.pdf" }];
    }
    return [];
  });
  /** @type {any} */
  let acts = null;
  acts = drawer.createDrawerActs({
    view: () => /** @type {any} */ ({ household: world.household, primary: "h1" }),
    // pocket.svelte's reread: the view first (a new household object), then the papers
    reread: async ({ view: home = true, papers = false }, item) => {
      if (home) world.household = { items };
      if (papers) await acts.rereadSearchDocuments(target.id, item);
    },
    say: (/** @type {string} */ id, /** @type {string | null} */ words) => { if (words) said.push([id, words]); },
    focus: () => {}, open: () => target.id, itemOf: () => /** @type {any} */ (target),
    amend: () => null, wakeFirst: true,
  });
  const file = new File(["abc"], "roof-quote.pdf", { type: "application/pdf", lastModified: 1_700_000_000_000 });
  return {
    acts, target, said, release, file,
    /** another read lands: a plain load under a new household object, as after another act's home read */
    plainLoad: () => { world.household = { items }; return acts.loadSearchDocuments(target.id); },
    /** whether the failure to refresh was said for the target, on its row or in the wake */
    unreadSaid: () => said.some(([id, words]) => id === target.id && words === DONE_UNREAD)
      || wakes.wake.mock.calls.some(([words]) => words === DONE_UNREAD),
  };
}

describe("an attach whose paper read failed never says done (#1905)", () => {
  it("(a) the item is 7th, its read fails, and a plain load with a new household lands before it runs: still could-not-refresh", async () => {
    const p = phone({ targetReads: "fails" });
    const attached = p.acts.attach(p.target.id, p.file);
    await tick(); await tick();
    const plain = p.plainLoad(); // supersedes the attach's re-read while its target read waits
    await tick();
    p.release();
    await plain;
    await attached;
    await tick();

    expect(p.unreadSaid(), `"${DONE_UNREAD}" was said for the item, on its row or in the wake`).toBe(true);
  });

  it("(b) the same race with a read that succeeds: the paper shows and no could-not-refresh is said", async () => {
    const p = phone({ targetReads: "succeeds" });
    const attached = p.acts.attach(p.target.id, p.file);
    await tick(); await tick();
    const plain = p.plainLoad();
    await tick();
    p.release();
    await plain;
    await attached;
    await tick();

    expect(p.unreadSaid(), "no could-not-refresh when the paper read fine").toBe(false);
    expect(p.acts.searchDocuments.map((/** @type {any} */ d) => d.id), "the new paper is in the search's papers").toContain("d-roof");
    expect(wakes.wake.mock.calls.map(([words]) => words).join("|")).toMatch(/roof-quote\.pdf attached/u);
  });

  it("(c) control, no other load: the failed read says could-not-refresh", async () => {
    const p = phone({ targetReads: "fails" });
    const attached = p.acts.attach(p.target.id, p.file);
    await tick(); await tick();
    p.release();
    await attached;
    await tick();

    expect(p.unreadSaid(), `"${DONE_UNREAD}" was said for the item`).toBe(true);
  });
});
