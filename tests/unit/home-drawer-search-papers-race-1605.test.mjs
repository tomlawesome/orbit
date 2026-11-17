import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1605 W-R7: on a household with many papers, attaching one while the first
 * search list is still loading left the new paper missing from search until
 * the next re-read. rereadSearchDocuments() starts a second read while the
 * first is out; the first, finishing last, still passed its `searchDocumentsFor
 * === household` check and overwrote the newer list with its stale one. A read
 * superseded by a later one must not land, whichever finishes last.
 *
 * Harness as home-drawer-landed-then-reread.test.mjs.
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

const household = { items: [{ id: "i1", title: "Boiler", status: "active", documentCount: 1 }] };
const make = () => drawer.createDrawerActs({
  view: () => /** @type {any} */ ({ household, primary: "h1" }),
  reread: vi.fn(), say: vi.fn(), focus: vi.fn(), open: () => "i1", itemOf: () => null, amend: () => null,
});
const names = (/** @type {any[]} */ docs) => docs.map((doc) => doc.name);

describe("a superseded search-papers read never lands", () => {
  beforeEach(() => { ws.readItemDocuments.mockReset(); });

  it("the first read finishing after the re-read does not overwrite the newer papers", async () => {
    /** @type {Array<(papers: object[]) => void>} */
    const answers = [];
    ws.readItemDocuments.mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
    const acts = make();
    const first = acts.loadSearchDocuments();
    const second = acts.rereadSearchDocuments();
    expect(answers).toHaveLength(2);
    answers[1]([{ id: "d1", name: "old.pdf" }, { id: "d2", name: "new.pdf" }]);
    await second;
    expect(names(acts.searchDocuments)).toEqual(["old.pdf", "new.pdf"]);
    answers[0]([{ id: "d1", name: "old.pdf" }]);
    await first;
    expect(names(acts.searchDocuments)).toEqual(["old.pdf", "new.pdf"]);
    expect(acts.papersReady).toBe(true);
  });

  it("the first read finishing before the re-read lands, then the newer one replaces it", async () => {
    /** @type {Array<(papers: object[]) => void>} */
    const answers = [];
    ws.readItemDocuments.mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
    const acts = make();
    const first = acts.loadSearchDocuments();
    const second = acts.rereadSearchDocuments();
    answers[0]([{ id: "d1", name: "old.pdf" }]);
    await first;
    answers[1]([{ id: "d1", name: "old.pdf" }, { id: "d2", name: "new.pdf" }]);
    await second;
    expect(names(acts.searchDocuments)).toEqual(["old.pdf", "new.pdf"]);
  });
});
