import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1584 W-F4, X-F2: a receipt decision that landed is never read back as
 * refused. createReceiptActs().decide (inbox/acts.js) sends the approval or
 * the dismissal, tells the screen it landed, and reloads the inbox. When
 * only the reload fails the receipt has left review: decide still answers
 * true (the phone's review sheet closes on it, and a second tap would be a
 * second item), says a `done — ... reload ...` line under the receipt, and
 * clears busy last. A partial approval and a refused command keep their own
 * answers (false, no landing, no reload).
 */
const ws = vi.hoisted(() => ({
  approveWithOperation: vi.fn(), dismissReceipt: vi.fn(),
  wordsOf: (/** @type {unknown} */ e, fallback = "failed") => (e instanceof Error ? e.message : fallback),
}));
vi.mock("$lib/data/workspace.js", () => ws);
const { createReceiptActs } = await import("../../web/src/routes/inbox/acts.js");

const DONE = /^done —.*reload/i;
beforeEach(() => { for (const fn of Object.values(ws)) if (typeof fn.mockReset === "function") fn.mockReset(); });

const suggestion = { receiptId: "r1" };
const make = (/** @type {() => Promise<unknown>} */ reload) => {
  const say = vi.fn();
  const busy = vi.fn();
  const landed = vi.fn();
  const acts = createReceiptActs({
    view: () => /** @type {any} */ ({ suggestions: [suggestion], primary: "h1" }),
    operationIds: new Map(),
    reload: vi.fn(reload),
    say, busy, landed,
  });
  return { acts, say, busy, landed };
};
const failedReload = async () => { throw new Error("the inbox would not load"); };

describe("a landed receipt decision is not read back as refused (#1584 W-F4, X-F2)", () => {
  for (const act of /** @type {const} */ (["approve", "dismiss"])) {
    it(`${act}: the command lands, the reload fails: true, landed once, the done line under the receipt, busy cleared last`, async () => {
      ws.approveWithOperation.mockResolvedValue({});
      ws.dismissReceipt.mockResolvedValue(undefined);
      const { acts, say, busy, landed } = make(failedReload);

      expect(await acts.decide({ id: "r1" }, act)).toBe(true);
      expect(landed).toHaveBeenCalledTimes(1);
      expect(landed.mock.calls[0][1]).toBe(act);
      expect(say.mock.calls.map((c) => c.slice(0, 2))).toEqual([["r1", null], ["r1", expect.stringMatching(DONE)]]);
      expect(busy.mock.calls.at(-1)).toEqual([null, null]);
    });
  }
});

describe("guards: a partial approval and a refused command keep their answers (pass today)", () => {
  it("a partial approval is false, lands nothing, reloads nothing, and says its message", async () => {
    ws.approveWithOperation.mockResolvedValue({ partial: true, message: "documents pending" });
    const reload = vi.fn(async () => {});
    const say = vi.fn();
    const landed = vi.fn();
    const acts = createReceiptActs({
      view: () => /** @type {any} */ ({ suggestions: [suggestion], primary: "h1" }),
      operationIds: new Map(), reload, say, busy: vi.fn(), landed,
    });
    expect(await acts.decide({ id: "r1" }, "approve")).toBe(false);
    expect(landed).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(say).toHaveBeenLastCalledWith("r1", "documents pending");
  });

  it("a refused command is false, says the error's words, lands nothing, reloads nothing", async () => {
    ws.dismissReceipt.mockRejectedValue(new Error("offline"));
    const reload = vi.fn(async () => {});
    const say = vi.fn();
    const landed = vi.fn();
    const acts = createReceiptActs({
      view: () => /** @type {any} */ ({ suggestions: [suggestion], primary: "h1" }),
      operationIds: new Map(), reload, say, busy: vi.fn(), landed,
    });
    expect(await acts.decide({ id: "r1" }, "dismiss")).toBe(false);
    expect(say).toHaveBeenLastCalledWith("r1", "offline");
    expect(landed).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("the sheet contract that makes the answer matter (source check, passes today)", () => {
  const src = (/** @type {string} */ p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
  it("the phone's approve returns decide's answer directly, and the review sheet closes on a truthy onsave", () => {
    expect(src("web/src/routes/inbox/pocket.svelte")).toMatch(/const approve = \([^)]*\) =>\s*receiptActs\.decide\(/u);
    expect(src("web/src/lib/pocket/ReviewSheet.svelte")).toMatch(/if \(await onsave\([^\n]*\)\) open = false/u);
  });
});

describe("an approval the scanner refuses as a flagged file (#1398 rework)", () => {
  it("reads the inbox again, so the card can show the flagged attachment and its two buttons; the receipt has not left review", async () => {
    ws.approveWithOperation.mockRejectedValue(Object.assign(
      new Error("not added — the virus scanner flagged an attachment; your mail is kept."), { code: "document_malware_detected", status: 422 }));
    const reload = vi.fn(async () => {});
    const landed = vi.fn();
    const acts = createReceiptActs({
      view: () => /** @type {any} */ ({ suggestions: [suggestion], primary: "h1" }),
      operationIds: new Map(), reload, say: vi.fn(), busy: vi.fn(), landed,
    });

    expect(await acts.decide({ id: "r1" }, "approve")).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(landed).not.toHaveBeenCalled();
  });
});
