import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1584 W-R5, X-R1, X-R2, W-R13, X-R3: a drawer act that landed is never
 * read back as refused. Every act in home/drawer-acts.svelte.js sends its
 * command and then reads home again (`reread`). When only that read fails the
 * act is done: the item's line (`say`) and the wake say `done — ... reload
 * ...`, never "couldn't ... it" or the read's own error, the act's side
 * effects stand (the row leaves, the completion closes, the rows close, the
 * attach id is kept for a re-pick), and a paper removed or restored from the
 * reader is still offered back. A refused command keeps its own words and
 * reads nothing.
 *
 * Harness as v19-home-shared-acts.test.mjs: runes stood in as plain values
 * (here with `snapshot` too, which DrawerModes calls), workspace.js and the
 * wake stood in, createDrawerActs and attach-id.js real. Each failing test:
 * the command resolves and `reread` rejects once.
 */
const ws = vi.hoisted(() => ({
  applyCommand: vi.fn(), attachItemDocument: vi.fn(), askCommand: vi.fn(), checkCommand: vi.fn(), dueDateIn: vi.fn(),
  readItemDocuments: vi.fn(), readReminders: vi.fn(), removeDocument: vi.fn(), restoreDocument: vi.fn(),
  wordsOf: (/** @type {unknown} */ e, fallback = "failed") => (e instanceof Error ? e.message : fallback),
}));
const wakeSpy = vi.hoisted(() => ({ wake: vi.fn() }));
vi.hoisted(() => {
  const state = Object.assign((/** @type {unknown} */ v) => v, {
    raw: (/** @type {unknown} */ v) => v, snapshot: (/** @type {unknown} */ v) => v,
  });
  Object.assign(globalThis, { $state: state, $effect: () => {}, $derived: (/** @type {unknown} */ v) => v });
});
vi.mock("$lib/data/workspace.js", () => ws);
vi.mock("$lib/pocket/wake.js", () => wakeSpy);
const drawer = await import("../../web/src/routes/home/drawer-acts.svelte.js");
const { attachIdFor } = await import("../../web/src/routes/home/attach-id.js");

const DONE = /^done —.*reload/i;
const UNLOADED = "home would not load";
const failedRead = () => vi.fn().mockRejectedValueOnce(new Error(UNLOADED));
const goodRead = () => vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  for (const fn of Object.values(ws)) if (typeof fn.mockReset === "function") fn.mockReset();
  wakeSpy.wake.mockReset();
});

/** A filed item, as the drawer addresses it. */
const itemOf = (/** @type {string} */ id) => ({
  id, householdId: "h1", title: "Boiler", status: "active", dueDate: "2026-11-01", sectionId: "s1",
  kind: "task", version: 2, currency: "GBP",
});

/** @param {{ reread: any, wakeFirst?: boolean }} how */
function make({ reread, wakeFirst = false }) {
  const say = vi.fn();
  const leave = vi.fn();
  const acts = drawer.createDrawerActs({
    view: () => null, reread, say, focus: () => {}, open: () => "open",
    itemOf: (id) => itemOf(id), amend: () => null, leave, wakeFirst,
  });
  return { acts, say, leave, wake: wakeSpy.wake };
}
const sayLog = (/** @type {any} */ say) => say.mock.calls.map((/** @type {unknown[]} */ c) => c.slice(0, 2));

describe("a landed drawer act is not read back as refused (#1584 W-R5, X-R1, X-R2, W-R13)", () => {
  it("snooze, desk order: the item line clears then says done; the only wake is the done line; not busy", async () => {
    ws.applyCommand.mockResolvedValue({});
    const { acts, say, wake } = make({ reread: failedRead() });
    await acts.runRowAct("i1", "snooze", () => ({ type: "x" }), "Boiler snoozed until 5 Nov");

    expect(sayLog(say)).toEqual([["i1", null], ["i1", expect.stringMatching(DONE)]]);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0]).toMatch(DONE);
    expect(wake.mock.calls[0][0]).not.toMatch(/snoozed until/);
    expect(acts.busy).toBeNull();
  });

  it("retire that leaves, phone order: the row leaves once; the wake says retired, then done; the item line says done", async () => {
    ws.applyCommand.mockResolvedValue({});
    const { acts, say, leave, wake } = make({ reread: failedRead(), wakeFirst: true });
    await acts.runRowAct("i1", "retire", () => ({ type: "x" }), "Boiler retired", { leaves: true });

    expect(leave).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledWith("i1");
    expect(wake.mock.calls.map((c) => c[0])).toEqual(["Boiler retired", expect.stringMatching(DONE)]);
    expect(say).toHaveBeenLastCalledWith("i1", expect.stringMatching(DONE));
    expect(sayLog(say).some(([, words]) => /couldn't|home would not load/.test(String(words)))).toBe(false);
    expect(acts.busy).toBeNull();
  });

  it("attach: says done, not 'couldn't attach it'; the id is kept so a re-pick sends the same id, and is dropped after a good read", async () => {
    ws.attachItemDocument.mockResolvedValue({});
    const file = () => new File(["a"], "bill.pdf", { lastModified: 1_700_000_000_000 });
    const first = make({ reread: failedRead() });
    await first.acts.attach("item-attach", file());

    expect(first.say).toHaveBeenLastCalledWith("item-attach", expect.stringMatching(DONE));
    expect(sayLog(first.say).some(([, words]) => /couldn't attach/.test(String(words)))).toBe(false);
    const sent = ws.attachItemDocument.mock.calls[0][3];
    expect(attachIdFor("item-attach", file())).toBe(sent);

    const second = make({ reread: goodRead() });
    await second.acts.attach("item-attach", file());
    expect(ws.attachItemDocument.mock.calls[1][3]).toBe(sent);
    expect(attachIdFor("item-attach", file())).not.toBe(sent);
  });

  it("record with a next date: answers it; the completion closes; the item stays; the line and the wake say done", async () => {
    ws.applyCommand.mockResolvedValue({});
    ws.dueDateIn.mockReturnValue("2026-11-30");
    const { acts, say, leave, wake } = make({ reread: failedRead() });
    acts.modes.startComplete(/** @type {any} */ (itemOf("i1")), "2026-10-31");

    expect(await acts.record("i1")).toBe("2026-11-30");
    expect(acts.modes.completing).toBeNull();
    expect(acts.modes.completeProblem).toBeNull();
    expect(say).toHaveBeenLastCalledWith("i1", expect.stringMatching(DONE));
    expect(wake.mock.calls.some((c) => DONE.test(c[0]))).toBe(true);
    expect(leave).not.toHaveBeenCalled();
    expect(acts.busy).toBeNull();
    expect(acts.modes.recording).toBe(false);
  });

  it("record of a one-off: the item leaves once and the same done line is said", async () => {
    ws.applyCommand.mockResolvedValue({});
    ws.dueDateIn.mockReturnValue(null);
    const { acts, say, leave } = make({ reread: failedRead() });
    acts.modes.startComplete(/** @type {any} */ (itemOf("i1")), "2026-10-31");

    expect(await acts.record("i1")).toBeNull();
    expect(leave).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledWith("i1");
    expect(acts.modes.completeProblem).toBeNull();
    expect(say).toHaveBeenLastCalledWith("i1", expect.stringMatching(DONE));
  });

  it("the rows' save of a filed item: commit lands, the rows close, the item line says done, no done wake", async () => {
    ws.applyCommand.mockResolvedValue({});
    const { acts, say, wake } = make({ reread: failedRead() });
    acts.modes.startEdit(/** @type {any} */ (itemOf("i1")));
    /* the engine's dry run does not run here: stand its "it will do" in */
    acts.modes.edit.answered = true;
    acts.modes.edit.refusal = null;
    /** @type {any} */ (acts.modes.edit.draft).title = "Boiler service";

    expect(await acts.modes.edit.commit()).toBe(true);
    expect(acts.modes.edit.id).toBeNull();
    expect(acts.modes.edit.problem).toBeNull();
    expect(say).toHaveBeenLastCalledWith("i1", expect.stringMatching(DONE));
    expect(wake.mock.calls.some((c) => DONE.test(c[0]))).toBe(false);
  });
});

describe("guards: a refused command keeps its own words and reads nothing (pass today)", () => {
  it("runRowAct says the refusal; no leave, no wake, no read", async () => {
    ws.applyCommand.mockRejectedValue(new Error("no"));
    const reread = goodRead();
    const { acts, say, leave, wake } = make({ reread, wakeFirst: true });
    await acts.runRowAct("i1", "retire", () => ({ type: "x" }), "retired", { leaves: true });

    expect(sayLog(say)).toEqual([["i1", null], ["i1", "no"]]);
    expect(leave).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(reread).not.toHaveBeenCalled();
    expect(acts.busy).toBeNull();
  });

  it("record sets the problem and keeps the completion open", async () => {
    ws.applyCommand.mockRejectedValue(new Error("no"));
    const reread = goodRead();
    const { acts, leave } = make({ reread });
    acts.modes.startComplete(/** @type {any} */ (itemOf("i1")), "2026-10-31");

    expect(await acts.record("i1")).toBeNull();
    expect(acts.modes.completeProblem).toBe("no");
    expect(acts.modes.completing).not.toBeNull();
    expect(leave).not.toHaveBeenCalled();
    expect(reread).not.toHaveBeenCalled();
    expect(acts.modes.recording).toBe(false);
  });

  it("attach says the refusal and keeps the id for a retry (nothing forgotten)", async () => {
    ws.attachItemDocument.mockRejectedValue(new Error("no"));
    const file = () => new File(["a"], "refused.pdf", { lastModified: 1_700_000_000_000 });
    const reread = goodRead();
    const { acts, say } = make({ reread });
    await acts.attach("item-refused", file());

    expect(say).toHaveBeenLastCalledWith("item-refused", "no");
    expect(attachIdFor("item-refused", file())).toBe(ws.attachItemDocument.mock.calls[0][3]);
    expect(reread).not.toHaveBeenCalled();
  });
});

describe("a paper removed or restored from the reader is not read back as refused (#1584 X-R3)", () => {
  const paper = { id: "d1", name: "bill.pdf" };

  it("removePaper: resolves; the removed wake is raised with its undo; the drawer's item line says done; the card is away", async () => {
    ws.removeDocument.mockResolvedValue(undefined);
    const { acts, say, wake } = make({ reread: failedRead() });
    acts.preview = paper;
    await acts.removePaper(paper);

    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0]).toBe("bill.pdf removed");
    expect(typeof wake.mock.calls[0][1]?.undo).toBe("function");
    expect(say).toHaveBeenCalledWith("open", expect.stringMatching(DONE));
    expect(acts.preview).toBeNull();
  });

  it("the undo: a restore that lands with a failed read says done again, and is not 'couldn't restore'", async () => {
    ws.removeDocument.mockResolvedValue(undefined);
    ws.restoreDocument.mockResolvedValue(undefined);
    const reread = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error(UNLOADED));
    const { acts, say, wake } = make({ reread });
    await acts.removePaper(paper);
    expect(say).not.toHaveBeenCalled();
    wake.mock.calls[0][1].undo();

    await vi.waitFor(() => expect(say).toHaveBeenCalledWith("open", expect.stringMatching(DONE)));
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls.some((c) => c[1]?.failure)).toBe(false);
  });

  it("restorePaper: resolves; the drawer's item line says done", async () => {
    ws.restoreDocument.mockResolvedValue(undefined);
    const { acts, say } = make({ reread: failedRead() });
    acts.preview = paper;
    await acts.restorePaper(paper);

    expect(say).toHaveBeenCalledWith("open", expect.stringMatching(DONE));
    expect(acts.preview).toBeNull();
  });

  it("guard: a refused removal rejects with its error, with no wake and no read; a refused undo raises the failure wake", async () => {
    const boom = new Error("gone wrong");
    ws.removeDocument.mockRejectedValueOnce(boom);
    const reread = goodRead();
    const refused = make({ reread });
    await expect(refused.acts.removePaper(paper)).rejects.toBe(boom);
    expect(refused.wake).not.toHaveBeenCalled();
    expect(reread).not.toHaveBeenCalled();

    ws.removeDocument.mockResolvedValue(undefined);
    ws.restoreDocument.mockRejectedValue(new Error("no"));
    const { acts, wake } = make({ reread: goodRead() });
    await acts.removePaper(paper);
    wake.mock.calls[0][1].undo();
    await vi.waitFor(() => expect(wake).toHaveBeenCalledWith("couldn't restore bill.pdf — try again", { failure: true }));
  });

  it("happy path pins the order: the papers are read before the removed wake, and nothing is said", async () => {
    ws.removeDocument.mockResolvedValue(undefined);
    /** @type {string[]} */
    const order = [];
    const reread = vi.fn(async () => { order.push("reread"); });
    const { acts, say, wake } = make({ reread });
    wake.mockImplementation(() => { order.push("wake"); });
    await acts.removePaper(paper);

    expect(order).toEqual(["reread", "wake"]);
    expect(say).not.toHaveBeenCalled();
  });
});
