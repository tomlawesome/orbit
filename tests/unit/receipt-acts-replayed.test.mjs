import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * W-R9 (design-mailin fix 5, test 14): when the seam answers an approval
 * with `{ replayed: true, message }` -- the engine approved the pair it had
 * stored, not the member's amendment -- the receipt did leave review, so the
 * act lands it, but it lands with the seam's words as its note, and the
 * words are not said under the row as a problem. Shaped like
 * v19-home-shared-acts.test.mjs: the seam stood in, the real acts.
 */
const ws = vi.hoisted(() => ({
  approveWithOperation: vi.fn(), dismissReceipt: vi.fn(),
  wordsOf: (/** @type {unknown} */ e, fallback = "failed") => (e instanceof Error ? e.message : fallback),
}));
vi.mock("$lib/data/workspace.js", () => ws);
const { createReceiptActs } = await import("../../web/src/routes/inbox/acts.js");

beforeEach(() => { for (const fn of Object.values(ws)) if (typeof fn.mockReset === "function") fn.mockReset(); });

describe("W-R9: a replayed approval lands with its note", () => {
  const suggestion = { receiptId: "r1" };
  const NOTE = "It went in with the values from your earlier approval; your changes were not applied.";
  const amended = { title: "Amended", currency: "GBP", status: "active" };

  it("returns true, lands with (receipt, 'approve', null, message), reloads, and does not say the message", async () => {
    ws.approveWithOperation.mockResolvedValue({ replayed: true, message: NOTE });
    /** @type {unknown[][]} */
    const landed = [];
    /** @type {string[]} */
    const calls = [];
    /** @type {Array<string | null>} */
    const said = [];
    const acts = createReceiptActs({
      view: () => /** @type {any} */ ({ suggestions: [suggestion], primary: "h1" }),
      operationIds: new Map(),
      reload: async () => { calls.push("reload"); },
      say: (_id, words) => { said.push(words); },
      busy: () => {},
      landed: /** @type {any} */ ((...args) => { landed.push(args); }),
    });
    const receipt = { id: "r1" };
    expect(await acts.decide(receipt, "approve", { amended, sectionId: "s1" })).toBe(true);
    expect(landed).toEqual([[receipt, "approve", null, NOTE]]);
    expect(calls).toEqual(["reload"]);
    expect(said.filter((words) => words !== null), "the note is not said as a problem").toEqual([]);
  });

  it("a plain approval with an amendment still lands with the amendment and no note", async () => {
    ws.approveWithOperation.mockResolvedValue({ ok: true });
    /** @type {unknown[][]} */
    const landed = [];
    const acts = createReceiptActs({
      view: () => /** @type {any} */ ({ suggestions: [suggestion], primary: "h1" }),
      operationIds: new Map(),
      reload: async () => {},
      say: () => {},
      busy: () => {},
      landed: /** @type {any} */ ((...args) => { landed.push(args); }),
    });
    const receipt = { id: "r1" };
    expect(await acts.decide(receipt, "approve", { amended, sectionId: "s1" })).toBe(true);
    expect(landed).toEqual([[receipt, "approve", amended]]);
  });

  /* #1584 web-wr9-1: the link the pending sheet's (null, null) relies on. */
  it("A1. a pair with no amendment lands plain: landed(receipt, 'approve', null), nothing said", async () => {
    ws.approveWithOperation.mockResolvedValue({ ok: true });
    /** @type {unknown[][]} */
    const landed = [];
    /** @type {Array<string | null>} */
    const said = [];
    const acts = createReceiptActs({
      view: () => /** @type {any} */ ({ suggestions: [suggestion], primary: "h1" }),
      operationIds: new Map(),
      reload: async () => {},
      say: (_id, words) => { said.push(words); },
      busy: () => {},
      landed: /** @type {any} */ ((...args) => { landed.push(args); }),
    });
    const receipt = { id: "r1" };
    expect(await acts.decide(receipt, "approve", { amended: null, sectionId: null })).toBe(true);
    expect(landed).toEqual([[receipt, "approve", null]]);
    expect(landed[0], "no fourth argument").toHaveLength(3);
    expect(said.filter((words) => words !== null)).toEqual([]);
  });
});
