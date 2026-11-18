import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1605 W-R7: a papers re-read that a newer one supersedes must not swallow
 * the failure of `mustRead`, which the caller (pocket.svelte's rereadPapers)
 * relies on to say done-but-unread. The superseded read stops before it reaches
 * the items it had not yet read (readSearchDocuments' `stale()`), so its own
 * `failed` set lacks the item. Either the superseded call rejects, or it hands
 * the failure to the newer read: this test accepts both, and fails only when
 * the failure is lost (every call resolves although the item's papers cannot
 * be read). Harness as home-drawer-landed-then-reread.test.mjs.
 */
const ws = vi.hoisted(() => ({
  applyCommand: vi.fn(), attachItemDocument: vi.fn(), askCommand: vi.fn(), checkCommand: vi.fn(), dueDateIn: vi.fn(),
  readItemDocuments: vi.fn(), readReminders: vi.fn(), removeDocument: vi.fn(), restoreDocument: vi.fn(),
  wordsOf: (/** @type {unknown} */ e, fallback = "failed") => (e instanceof Error ? e.message : fallback),
}));
vi.hoisted(() => {
  const state = Object.assign((/** @type {unknown} */ v) => v, {
    raw: (/** @type {unknown} */ v) => v, snapshot: (/** @type {unknown} */ v) => v,
  });
  Object.assign(globalThis, { $state: state, $effect: () => {}, $derived: (/** @type {unknown} */ v) => v });
});
vi.mock("$lib/data/workspace.js", () => ws);
vi.mock("$lib/pocket/wake.js", () => ({ wake: vi.fn() }));
const drawer = await import("../../web/src/routes/home/drawer-acts.svelte.js");
const { SEARCH_DOC_CONCURRENCY } = await import("../../web/src/routes/home/pocket-search.js");

beforeEach(() => { for (const fn of Object.values(ws)) if (typeof fn.mockReset === "function") fn.mockReset(); });

describe("a superseded papers re-read still reports the failure of mustRead (#1605 W-R7)", () => {
  it("the first read is superseded before it reaches the last item; that item's papers cannot be read; the failure is not lost", async () => {
    const items = Array.from({ length: SEARCH_DOC_CONCURRENCY + 2 }, (_, i) => ({ id: `i${i}`, title: `Item ${i}`, status: "active", documentCount: 1 }));
    const mustRead = items[items.length - 1].id;
    const household = { items };
    const view = () => /** @type {any} */ ({ household, primary: "h1" });
    /** The first reads held on a gate, so the second read starts while they are out. */
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => { release = () => resolve(undefined); });
    let held = 0;
    ws.readItemDocuments.mockImplementation(async (/** @type {string} */ _h, /** @type {string} */ id) => {
      if (id === mustRead) throw new Error("papers would not load");
      if (held < SEARCH_DOC_CONCURRENCY) { held += 1; await gate; }
      return [];
    });
    const acts = drawer.createDrawerActs({
      view, reread: async () => {}, say: () => {}, focus: () => {}, open: () => "open",
      itemOf: (id) => /** @type {any} */ ({ id }), amend: () => null,
    });

    const first = acts.rereadSearchDocuments(null, mustRead).then(() => "resolved", () => "rejected");
    await new Promise((r) => setTimeout(r, 0));
    const second = acts.rereadSearchDocuments(null, null).then(() => "resolved", () => "rejected");
    release();
    const outcomes = await Promise.all([first, second]);

    expect(outcomes, "the failure to read mustRead's papers reached a caller").toContain("rejected");
  });
});

/*
 * Round two: the act that asked for mustRead rejects when a newer re-read
 * superseded its read and that item's papers cannot be read. Each act reports
 * once; two acts with the same mustRead may each reject. (A plain load under a
 * new household object superseding it is not W-R7's race; batch-a's read
 * token does not cover it, and it is reported separately.)
 */
describe("whatever supersedes a papers re-read, the act that asked for mustRead still hears of its failure (#1605 W-R7)", () => {
  const make = (/** @type {() => any} */ view) => drawer.createDrawerActs({
    view, reread: async () => {}, say: () => {}, focus: () => {}, open: () => "open",
    itemOf: (id) => /** @type {any} */ ({ id }), amend: () => null,
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("a newer re-read whose `also` no longer lists mustRead (the item was retired) supersedes it", async () => {
    const items = [
      { id: "gone", title: "Gone", status: "retired", documentCount: 1 },
      ...Array.from({ length: 3 }, (_, i) => ({ id: `i${i}`, title: `Item ${i}`, status: "active", documentCount: 1 })),
    ];
    const household = { items };
    const acts = make(() => ({ household, primary: "h1" }));
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => { release = () => resolve(undefined); });
    let held = 0;
    ws.readItemDocuments.mockImplementation(async (/** @type {string} */ _h, /** @type {string} */ id) => {
      if (held < 4) { held += 1; await gate; }
      if (id === "gone") throw new Error("papers would not load");
      return [];
    });

    const asked = acts.rereadSearchDocuments("gone", "gone").then(() => "resolved", () => "rejected");
    await tick();
    const newer = acts.rereadSearchDocuments(null, null).then(() => "resolved", () => "rejected");
    release();
    await newer;

    expect(await asked, "the act that asked for the retired item's papers").toBe("rejected");
  });
});

