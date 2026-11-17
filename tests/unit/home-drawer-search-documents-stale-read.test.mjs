import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1605 b1 W-R7: rereadSearchDocuments resets `searchDocumentsFor` while the
 * first load is still reading. The reset makes the first load's stale() true
 * only until the second load sets the household again; from then on the first
 * (older) read counts as current and, when it finishes after the second, it
 * overwrites the papers the second read found. After an attach, a remove or a
 * restore the search then shows the papers as they were before the act.
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

beforeEach(() => {
  for (const fn of Object.values(ws)) if (typeof fn.mockReset === "function") fn.mockReset();
});

const household = { items: [{ id: "i1", title: "Boiler", status: "active", documentCount: 1 }] };
const view = () => /** @type {any} */ ({ household, primary: "h1" });

/** @param {string} name */
const paper = (name) => ({ id: name, name });
/** A promise a test settles by hand. @template T @returns {{ promise: Promise<T>, resolve: (value: T) => void }} */
function deferred() {
  /** @type {(value: any) => void} */
  let resolve = () => {};
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe("an older papers read never overwrites a newer one (#1605 W-R7)", () => {
  it("the first read finishing after the re-read leaves the re-read's papers in place", async () => {
    const first = deferred();
    const second = deferred();
    ws.readItemDocuments.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const acts = drawer.createDrawerActs({
      view, reread: vi.fn(), say: vi.fn(), focus: () => {}, open: () => "i1",
      itemOf: () => /** @type {any} */ ({}), amend: () => null, leave: vi.fn(), wakeFirst: false,
    });

    const initial = acts.loadSearchDocuments();
    await Promise.resolve();
    const again = acts.rereadSearchDocuments();
    await Promise.resolve();
    expect(ws.readItemDocuments).toHaveBeenCalledTimes(2);

    second.resolve([paper("after-the-act.pdf")]);
    await again;
    expect(acts.searchDocuments.map((/** @type {{ name: string }} */ doc) => doc.name)).toEqual(["after-the-act.pdf"]);

    first.resolve([paper("before-the-act.pdf")]);
    await initial;
    expect(acts.searchDocuments.map((/** @type {{ name: string }} */ doc) => doc.name)).toEqual(["after-the-act.pdf"]);
  });
});
