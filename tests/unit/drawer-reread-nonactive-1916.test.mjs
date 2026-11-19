import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1916: a re-read (rereadSearchDocuments(also, mustRead)) for a retired item
 * is overtaken by a plain load whose `also` differs (here none: the phone's
 * openSearch / a row opening, or the desk's explore focus, under a new
 * household object). A load reads only active items and its own `also`, so
 * neither read reads the retired item. What the code must do: when `mustRead`
 * was read by no read the re-read waited on, it reads it or rejects; it never
 * resolves as read. Reachable: a retired item's drawer is open (lit = it), a
 * paper act on it re-reads with also = lit (pocket.svelte:321), and another
 * home refresh plus a row opening / the search sheet starts a load meanwhile.
 * Drives the real acts with the workspace calls stood in.
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

beforeEach(() => {
  for (const fn of Object.values(ws)) if (typeof fn.mockReset === "function") fn.mockReset();
  wakes.wake.mockReset();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

/** SEARCH_DOC_CONCURRENCY active items carrying papers, then one retired item
 *  last, so its read waits behind the first reads, held on a gate. */
function phone() {
  const active = Array.from({ length: SEARCH_DOC_CONCURRENCY }, (_, i) => ({
    id: `a${i}`, title: `Active ${i}`, status: "active", documentCount: 1, householdId: "h1",
  }));
  const retired = { id: "r1", title: "Retired", status: "retired", documentCount: 1, householdId: "h1" };
  const items = [...active, retired];
  const world = { household: /** @type {any} */ ({ items }) };
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });
  let held = 0;
  /** @type {string[]} */
  const readIds = [];
  ws.readItemDocuments.mockImplementation(async (/** @type {string} */ _h, /** @type {string} */ id) => {
    if (held < SEARCH_DOC_CONCURRENCY) { held += 1; await gate; }
    readIds.push(id);
    return id === retired.id ? [{ id: "d-old", name: "old-quote.pdf", itemId: id }] : [];
  });
  const acts = drawer.createDrawerActs({
    view: () => /** @type {any} */ ({ household: world.household, primary: "h1" }),
    reread: async () => {}, say: () => {}, focus: () => {}, open: () => retired.id,
    itemOf: () => /** @type {any} */ (retired), amend: () => null, wakeFirst: true,
  });
  return {
    acts, retired, readIds, release,
    /** another read lands: a plain load, no `also`, under a new household object */
    plainLoad: () => { world.household = { items }; return acts.loadSearchDocuments(); },
  };
}

describe("a re-read for a retired item never resolves as read when nobody read it (#1916)", () => {
  it("overtaken by a plain load with no `also`: reads the retired item or rejects", async () => {
    const p = phone();
    /** @type {{ ok: true } | { ok: false, error: unknown }} */
    let outcome = { ok: true };
    const reread = p.acts.rereadSearchDocuments(p.retired.id, p.retired.id).catch((error) => { outcome = { ok: false, error }; });
    await tick(); await tick();
    const plain = p.plainLoad(); // supersedes the re-read; reads active items only
    await tick();
    p.release();
    await plain;
    await reread;
    await tick();

    const read = p.readIds.includes(p.retired.id);
    expect(outcome.ok === false || read, "the re-read resolved as read although the retired item's papers were never read and it did not reject").toBe(true);
  });

  it("control, not overtaken: the retired item's papers are read and the re-read resolves", async () => {
    const p = phone();
    const reread = p.acts.rereadSearchDocuments(p.retired.id, p.retired.id);
    await tick(); await tick();
    p.release();
    await reread;

    expect(p.readIds).toContain(p.retired.id);
    expect(p.acts.searchDocuments.map((/** @type {any} */ d) => d.id)).toContain("d-old");
  });
});
