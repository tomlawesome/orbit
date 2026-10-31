import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1582: the receipt acts (approve, dismiss, partial) and `complete` exist
 * once, and the desk's drawer acts on the id it is given. Receipt acts:
 * createReceiptActs().decide (inbox/acts.js). Complete: the new
 * `completeToday({ raw, primary, today })` in home/drawer-acts.svelte.js,
 * answering { done, problem }; it never throws and sends nothing without
 * `raw` and `primary`. The screens cannot be mounted here, so only that they
 * call the shared acts is read from source.
 */
const ws = vi.hoisted(() => ({
  applyCommand: vi.fn(), attachItemDocument: vi.fn(), approveWithOperation: vi.fn(), dismissReceipt: vi.fn(),
  askCommand: vi.fn(), checkCommand: vi.fn(), dueDateIn: vi.fn(), readItemDocuments: vi.fn(), readReminders: vi.fn(), removeDocument: vi.fn(), restoreDocument: vi.fn(),
  wordsOf: (/** @type {unknown} */ e, fallback = "failed") => (e instanceof Error ? e.message : fallback),
}));
// no svelte compiler runs on .svelte.js here: a plain value stands in for the rune
vi.hoisted(() => {
  const state = Object.assign((/** @type {unknown} */ v) => v, { raw: (/** @type {unknown} */ v) => v });
  Object.assign(globalThis, { $state: state, $effect: () => {}, $derived: (/** @type {unknown} */ v) => v });
});
vi.mock("$lib/data/workspace.js", () => ws);
vi.mock("$lib/pocket/wake.js", () => ({ wake: vi.fn() }));
const { createReceiptActs } = await import("../../web/src/routes/inbox/acts.js");
const drawer = await import("../../web/src/routes/home/drawer-acts.svelte.js");

beforeEach(() => { for (const fn of Object.values(ws)) if (typeof fn.mockReset === "function") fn.mockReset(); });

describe("#1582 the one receipt act", () => {
  const suggestion = { receiptId: "r1" };
  const make = () => {
    const calls = /** @type {string[]} */ ([]);
    const acts = createReceiptActs({
      view: () => /** @type {any} */ ({ suggestions: [suggestion], primary: "h1" }),
      operationIds: new Map(),
      reload: async () => { calls.push("reload"); },
      say: (_id, words) => { calls.push(`say:${words}`); },
      busy: (id, act) => { calls.push(`busy:${id}:${act}`); },
      landed: (_r, act) => { calls.push(`landed:${act}`); },
    });
    return { acts, calls };
  };

  it("approve: sends the receipt's suggestion on its operation ids, then lands and reloads, busy cleared last", async () => {
    ws.approveWithOperation.mockResolvedValue({});
    const { acts, calls } = make();
    expect(await acts.decide({ id: "r1" }, "approve")).toBe(true);
    expect(ws.approveWithOperation.mock.calls[0][0]).toBe(suggestion);
    expect(ws.approveWithOperation.mock.calls[0][2]).toBe("h1");
    expect(calls).toEqual(["say:null", "busy:r1:approve", "landed:approve", "reload", "busy:null:null"]);
  });

  it("a partial approval says its words, does not land or reload, and stays in review", async () => {
    ws.approveWithOperation.mockResolvedValue({ partial: true, message: "documents pending" });
    const { acts, calls } = make();
    expect(await acts.decide({ id: "r1" }, "approve")).toBe(false);
    expect(calls).toEqual(["say:null", "busy:r1:approve", "say:documents pending", "busy:null:null"]);
  });

  it("dismiss discards the receipt by id, then lands and reloads; a refusal is said, not landed", async () => {
    ws.dismissReceipt.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("offline"));
    const ok = make();
    expect(await ok.acts.decide({ id: "r1" }, "dismiss")).toBe(true);
    expect(ws.dismissReceipt).toHaveBeenCalledWith("r1");
    expect(ok.calls).toContain("reload");
    const bad = make();
    expect(await bad.acts.decide({ id: "r1" }, "dismiss")).toBe(false);
    expect(bad.calls).toEqual(["say:null", "busy:r1:dismiss", "say:offline", "busy:null:null"]);
  });
});

describe("#1582 the one complete act", () => {
  const raw = { id: "i1", title: "Boiler", version: 3 };
  const call = () => /** @type {Function} */ (/** @type {any} */ (drawer).completeToday);

  it("sends item.complete for the raw item in the primary household, dated today", async () => {
    ws.applyCommand.mockResolvedValue({});
    expect(await call()({ raw, primary: "h1", today: "2026-10-31" })).toEqual({ done: true, problem: null });
    const [command] = ws.applyCommand.mock.calls[0];
    expect(command).toMatchObject({ type: "item.complete", itemId: "i1", householdId: "h1", completedDate: "2026-10-31" });
  });

  it("sends nothing without the raw item or the household", async () => {
    expect(await call()({ raw: undefined, primary: "h1", today: "2026-10-31" })).toEqual({ done: false, problem: null });
    expect((await call()({ raw, primary: null, today: "2026-10-31" })).done).toBe(false);
    expect(ws.applyCommand).not.toHaveBeenCalled();
  });

  it("answers a refusal as a problem, in the engine's words", async () => {
    ws.applyCommand.mockRejectedValue(new Error("version conflict"));
    expect(await call()({ raw, primary: "h1", today: "2026-10-31" })).toEqual({ done: false, problem: "version conflict" });
  });
});

describe("#1582 the drawer acts on the id it is given, not the open item", () => {
  const items = {
    open: { id: "open", householdId: "h1", title: "Open one" },
    other: { id: "other", householdId: "h2", title: "Other one" },
  };
  const make = () => drawer.createDrawerActs({
    view: () => null, reread: async () => {}, say: () => {}, focus: () => {}, open: () => "open",
    itemOf: (id) => /** @type {any} */ (items)[id], amend: () => null,
  });

  it("runRowAct builds its command from the item of the id", async () => {
    ws.applyCommand.mockResolvedValue({});
    await make().runRowAct("other", "retire", (item) => ({ type: "x", itemId: item.id }), "retired");
    expect(ws.applyCommand).toHaveBeenCalledWith({ type: "x", itemId: "other" });
  });

  it("attach sends to the household and id it is given", async () => {
    ws.attachItemDocument.mockResolvedValue({});
    const file = new File(["a"], "a.pdf");
    await make().attach("other", file);
    expect(ws.attachItemDocument.mock.calls[0].slice(0, 3)).toEqual(["h2", "other", file]);
  });

  it("the desk hands createDrawerActs an itemOf that uses its id", () => {
    const src = readFileSync(new URL("../../web/src/routes/home/+page.svelte", import.meta.url), "utf8");
    expect(src).toMatch(/itemOf:\s*\(?\s*(\w+)\s*\)?\s*=>[^\n]*\b\1\b/u);
  });
});

describe("#1582 the screens call the shared acts and keep no copy (source check; the screens cannot be mounted)", () => {
  const src = (/** @type {string} */ p) => readFileSync(new URL(`../../web/src/routes/home/${p}`, import.meta.url), "utf8");
  it("the desk's tapReceipt and strip, and the pocket's complete", () => {
    expect(src("+page.svelte")).toMatch(/createReceiptActs\(/u);
    expect(src("+page.svelte")).not.toMatch(/dismissReceipt\(/u);
    for (const p of ["+page.svelte", "pocket.svelte"]) {
      expect(src(p), p).toMatch(/completeToday\(/u);
      expect(src(p), p).not.toMatch(/completeCommand\(/u);
    }
  });
});
