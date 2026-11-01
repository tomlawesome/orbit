import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

  it("sends nothing without today's date, whether undefined or empty (the strip reads view?.today)", async () => {
    expect(await call()({ raw, primary: "h1", today: undefined })).toEqual({ done: false, problem: null });
    expect(await call()({ raw, primary: "h1", today: "" })).toEqual({ done: false, problem: null });
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
});

/*
 * #1582 (Medium) / #1584 fix review: the desk's `itemOf` is the plain
 * `commandItemOf(detail, id = detail?.id)` of home/command-item.js, so its id
 * check is a behaviour here and not a regex on the screen's source. It answers
 * `detail` only when that is the item asked for, a filed one (a household, not
 * a suggestion); any other id answers null.
 */
describe("#1582 commandItemOf: the item a drawer command addresses on the desk", () => {
  const detail = { id: "open", householdId: "h1", title: "Open one" };
  /** Loaded by absolute path inside each test, so the module being absent fails these tests alone. */
  const load = async () => (await import(/* @vite-ignore */ fileURLToPath(new URL("../../web/src/routes/home/command-item.js", import.meta.url)))).commandItemOf;

  it("answers the detail for its own id, given or left out", async () => {
    const commandItemOf = await load();
    expect(commandItemOf(detail, "open")).toBe(detail);
    expect(commandItemOf(detail)).toBe(detail);
  });

  it("answers null for another id, a suggestion, an item with no household, and no detail at all", async () => {
    const commandItemOf = await load();
    expect(commandItemOf(detail, "other")).toBeNull();
    expect(commandItemOf({ ...detail, suggestion: true }, "open")).toBeNull();
    expect(commandItemOf({ id: "open", title: "x" }, "open")).toBeNull();
    expect(commandItemOf(null, "open")).toBeNull();
    expect(commandItemOf(null)).toBeNull();
  });
});

describe("#1582 the desk's wiring: drawer acts on an id that is not the open item send nothing", () => {
  const detail = { id: "open", householdId: "h1", title: "Open one" };
  const make = async () => {
    const { commandItemOf } = await import(/* @vite-ignore */ fileURLToPath(new URL("../../web/src/routes/home/command-item.js", import.meta.url)));
    return drawer.createDrawerActs({
      view: () => null, reread: async () => {}, say: () => {}, focus: () => {}, open: () => "open",
      itemOf: (id) => commandItemOf(detail, id), amend: () => null,
    });
  };

  it("runRowAct for another id calls neither applyCommand nor build; for the open id it sends build(detail) once", async () => {
    ws.applyCommand.mockResolvedValue({});
    const acts = await make();
    const build = vi.fn((/** @type {any} */ item) => ({ type: "x", itemId: item.id }));
    await acts.runRowAct("other", "retire", build, "retired");
    expect(ws.applyCommand).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();

    await acts.runRowAct("open", "retire", build, "retired");
    expect(ws.applyCommand).toHaveBeenCalledTimes(1);
    expect(ws.applyCommand).toHaveBeenCalledWith({ type: "x", itemId: "open" });
  });

  it("attach for another id does not call attachItemDocument", async () => {
    ws.attachItemDocument.mockResolvedValue({});
    const acts = await make();
    await acts.attach("other", new File(["a"], "a.pdf"));
    expect(ws.attachItemDocument).not.toHaveBeenCalled();
  });
});

describe("#1582 the desk screen wires itemOf through commandItemOf (source check; the screen cannot be mounted)", () => {
  const page = () => readFileSync(new URL("../../web/src/routes/home/+page.svelte", import.meta.url), "utf8");
  it("imports commandItemOf from ./command-item.js and hands the id through verbatim", () => {
    const src = page();
    // booleans, so a failure does not print the whole screen
    expect(/import\s*\{[^}]*\bcommandItemOf\b[^}]*\}\s*from\s*["']\.\/command-item\.js["']/u.test(src), "imports commandItemOf from ./command-item.js").toBe(true);
    expect(src.includes("itemOf: (id) => commandItemOf(detail, id)"), "wires itemOf verbatim").toBe(true);
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
