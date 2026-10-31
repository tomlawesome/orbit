import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `approveWithOperation` (#1343): the one place a mail-in receipt is approved
 * under its per-receipt operation id. The engine answers `{ outcome:
 * "approved" | "partial_success", itemId }` from /api/reviewed-intake/approve
 * (src/server/reviewed-intake.ts, ApprovalOutcome; the e2e and integration
 * tests show the same wire shape). `partial_success` means the item is
 * recorded but its documents failed. The caller branches on the shape of the
 * answer, never on its words. A fake fetch rather than a server: only the URL,
 * the body and the answer are read.
 */

const PARTIAL_SENTENCE = "The item is recorded, but its documents need another try — try once more to finish.";

/** @type {Array<{ status: number, body: unknown }>} */
let approveAnswers = [];
/** @type {Array<Record<string, any>>} */
let approvalBodies = [];
/** Reviews to answer the next GETs with, in order; the default review when empty.
 *  @type {Array<Record<string, any>>} */
let reviewAnswers = [];
/** When set, a review GET waits on it before answering (a test opens it).
 *  @type {Promise<void> | null} */
let reviewGate = null;
/** Statuses to answer the next review GETs with, in order; 200 when empty.
 *  @type {number[]} */
let reviewStatuses = [];

beforeEach(() => {
  approveAnswers = [];
  approvalBodies = [];
  reviewAnswers = [];
  reviewGate = null;
  reviewStatuses = [];
  vi.stubGlobal("fetch", vi.fn(async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    if (String(url).includes("/api/auth/session")) {
      return new Response(JSON.stringify({ user: { id: "u1" }, csrfToken: "token" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    // Approving reads the receipt's review first (and files an unassigned
    // receipt under the household with a PUT); only the approval itself
    // takes a queued answer.
    if (String(url).includes("/api/imap-inbox/")) {
      if (reviewGate) await reviewGate;
      const status = init?.method === "PUT" ? 200 : reviewStatuses.shift() ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ error: { code: "unavailable", message: "Try again." } }), { status, headers: { "content-type": "application/json" } });
      }
      const review = reviewAnswers.shift() ?? { receipt: { draftVersion: 1 }, sections: [{ id: "s1", name: "Home" }], attachments: [] };
      return new Response(JSON.stringify(init?.method === "PUT" ? {} : review), { status: 200, headers: { "content-type": "application/json" } });
    }
    const next = approveAnswers.shift();
    if (!next) throw new Error(`no answer queued for ${url}`);
    approvalBodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function seam() {
  return await import("../../web/src/lib/data/workspace.js");
}

/** @param {string} receiptId */
function suggestionOf(receiptId) {
  return {
    id: receiptId,
    receiptId,
    draftVersion: 3,
    householdId: "h-1",
    title: "Reviewed intake",
    proposal: { title: "Reviewed intake" },
    attachmentCount: 0,
  };
}

describe("approveWithOperation", () => {
  it("is exported beside approveReceipt", async () => {
    const mod = await seam();
    expect(typeof mod.approveReceipt).toBe("function");
    expect(typeof mod.approveWithOperation).toBe("function");
  });

  it("resolves { ok: true } when the engine approves", async () => {
    const { approveWithOperation } = await seam();
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: "i-1" } });
    await expect(approveWithOperation(suggestionOf("r-1"), new Map(), "h-1")).resolves.toEqual({ ok: true });
    expect(approvalBodies).toHaveLength(1);
  });

  it("resolves { partial: true, message } with the one sentence on partial_success", async () => {
    const { approveWithOperation } = await seam();
    approveAnswers.push({ status: 200, body: { outcome: "partial_success", itemId: "i-1" } });
    await expect(approveWithOperation(suggestionOf("r-1"), new Map(), "h-1")).resolves.toEqual({ partial: true, message: PARTIAL_SENTENCE });
  });

  it("keeps the operation id and sends the same one again on a retry", async () => {
    const { approveWithOperation } = await seam();
    const operationIds = new Map();
    approveAnswers.push({ status: 200, body: { outcome: "partial_success", itemId: "i-1" } });
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: "i-1" } });
    const suggestion = suggestionOf("r-1");
    await approveWithOperation(suggestion, operationIds, "h-1");
    expect(operationIds.size).toBe(1);
    const kept = [...operationIds.values()][0];
    expect(typeof kept).toBe("string");
    await approveWithOperation(suggestion, operationIds, "h-1");
    expect(approvalBodies).toHaveLength(2);
    expect(approvalBodies[0].operationId).toBe(kept);
    expect(approvalBodies[1].operationId).toBe(kept);
  });

  it("uses an id already in the map rather than making a new one", async () => {
    const { approveWithOperation } = await seam();
    const given = "6f1f2d1e-3b7a-4c52-9a77-0d1c2b3a4e5f";
    const operationIds = new Map([["r-1", given]]);
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: "i-1" } });
    await approveWithOperation(suggestionOf("r-1"), operationIds, "h-1");
    expect(approvalBodies[0].operationId).toBe(given);
  });

  it("gives a different suggestion a different id", async () => {
    const { approveWithOperation } = await seam();
    const operationIds = new Map();
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: "i-1" } });
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: "i-2" } });
    await approveWithOperation(suggestionOf("r-1"), operationIds, "h-1");
    await approveWithOperation(suggestionOf("r-2"), operationIds, "h-1");
    expect(approvalBodies[0].operationId).toBeTruthy();
    expect(approvalBodies[1].operationId).toBeTruthy();
    expect(approvalBodies[0].operationId).not.toBe(approvalBodies[1].operationId);
  });

  it("throws on a refusal, as approveReceipt does", async () => {
    const { approveWithOperation } = await seam();
    approveAnswers.push({ status: 409, body: { error: { code: "stale_draft", message: "This email changed; look again." } } });
    await expect(approveWithOperation(suggestionOf("r-1"), new Map(), "h-1")).rejects.toThrow();
  });
});

/*
 * Retry after a reload or a refusal (#1396). The server keeps the request it
 * accepted and the review read reports it as `approval: { operationId,
 * request }` for a receipt the owner may retry (ADR-0005; the browser persists
 * nothing, ADR-0006). The client replays a reported pair verbatim; otherwise it
 * mints the key and builds the body once, and pins the whole body it sent.
 * A fresh module import below stands for a page reload: no map, no pin.
 */

/** @param {Record<string, any>} [over] */
function reviewOf(over = {}) {
  return {
    receipt: { draftVersion: 1, proposal: { title: "From the review" } },
    sections: [{ id: "s1", name: "Home" }, { id: "s2", name: "Other" }],
    attachments: [],
    ...over,
  };
}

const REPORTED_ID = "7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a";
const reportedRequest = () => ({
  source: { kind: "mailbox_draft", receiptId: "r-1", draftVersion: 2 },
  householdId: "h-1",
  sectionId: "s2",
  action: "create_separate",
  item: { kind: "service", title: "Amended before the reload", currency: "GBP", status: "active" },
  attachmentIds: ["a-1"],
});
const reportedPair = () => ({ operationId: REPORTED_ID, request: reportedRequest() });

describe("approveWithOperation replays the pair the server reports (#1396)", () => {
  it("after a reload (no map, no pin), sends the reported operationId and request verbatim", async () => {
    const { approveWithOperation } = await seam();
    // The review now lists different values than the accepted request carries.
    reviewAnswers.push(reviewOf({ receipt: { draftVersion: 9, proposal: { title: "Different now" } }, attachments: [{ id: "a-1" }, { id: "a-2" }], approval: reportedPair() }));
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: REPORTED_ID } });
    const operationIds = new Map();
    await expect(approveWithOperation(suggestionOf("r-1"), operationIds, "h-1")).resolves.toEqual({ ok: true });
    expect(approvalBodies).toEqual([{ ...reportedRequest(), operationId: REPORTED_ID }]);
    expect(operationIds.size).toBe(0);
  });

  it("ignores an id this tab already holds for the receipt", async () => {
    const { approveWithOperation } = await seam();
    reviewAnswers.push(reviewOf({ approval: reportedPair() }));
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: REPORTED_ID } });
    const operationIds = new Map([["r-1", "11111111-2222-4333-8444-555555555555"]]);
    await approveWithOperation(suggestionOf("r-1"), operationIds, "h-1");
    expect(approvalBodies).toHaveLength(1);
    expect(approvalBodies[0].operationId).toBe(REPORTED_ID);
  });

  it("sends the stored pair, not a new amendment or section, when the member amends differently", async () => {
    const { approveWithOperation } = await seam();
    reviewAnswers.push(reviewOf({ approval: reportedPair() }));
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: REPORTED_ID } });
    const amended = { kind: "service", title: "A different amendment", currency: "GBP", status: "active" };
    await approveWithOperation(suggestionOf("r-1"), new Map(), "h-1", amended, "s1");
    expect(approvalBodies).toEqual([{ ...reportedRequest(), operationId: REPORTED_ID }]);
  });

  it("a second device with no memory sends the same pair as the first", async () => {
    const first = await seam();
    reviewAnswers.push(reviewOf({ approval: reportedPair() }));
    approveAnswers.push({ status: 200, body: { outcome: "partial_success", itemId: REPORTED_ID } });
    await first.approveWithOperation(suggestionOf("r-1"), new Map(), "h-1");
    vi.resetModules();
    const second = await seam();
    reviewAnswers.push(reviewOf({ approval: reportedPair() }));
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: REPORTED_ID } });
    await expect(second.approveWithOperation(suggestionOf("r-1"), new Map(), "h-1")).resolves.toEqual({ ok: true });
    expect(approvalBodies).toHaveLength(2);
    expect(approvalBodies[1]).toEqual(approvalBodies[0]);
  });

  it("builds from the review as before when the review reports no approval", async () => {
    const { approveWithOperation } = await seam();
    reviewAnswers.push(reviewOf({ attachments: [{ id: "a-9" }] }));
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: "i-1" } });
    await approveWithOperation(suggestionOf("r-1"), new Map(), "h-1");
    expect(approvalBodies[0]).toMatchObject({
      source: { kind: "mailbox_draft", receiptId: "r-1", draftVersion: 1 },
      householdId: "h-1",
      sectionId: "s1",
      action: "create_separate",
      attachmentIds: ["a-9"],
    });
    expect(approvalBodies[0].operationId).not.toBe(REPORTED_ID);
  });
});

describe("approveWithOperation pins the whole body it sent (#1396)", () => {
  const amended = { kind: "service", title: "Amended in this tab", currency: "GBP", status: "active" };
  const firstReview = () => reviewOf({ receipt: { draftVersion: 1, proposal: { title: "First read" } }, attachments: [{ id: "a-1" }] });
  const laterReview = () => reviewOf({ receipt: { draftVersion: 4, proposal: { title: "Later read" } }, attachments: [{ id: "a-1" }, { id: "a-2" }] });

  it.each([
    ["a lost answer", { status: 502, body: { error: { code: "bad_gateway", message: "Try again." } } }],
    ["partial_success", { status: 200, body: { outcome: "partial_success", itemId: "i-1" } }],
  ])("after %s, a retry in the same tab resends the identical body under the same key", async (_label, first) => {
    const { approveWithOperation } = await seam();
    const operationIds = new Map();
    reviewAnswers.push(firstReview(), laterReview());
    approveAnswers.push(first, { status: 200, body: { outcome: "approved", itemId: "i-1" } });
    await approveWithOperation(suggestionOf("r-1"), operationIds, "h-1", amended, "s2").catch(() => {});
    // The review has moved on (draft version, attachments, proposal); the body must not.
    await approveWithOperation(suggestionOf("r-1"), operationIds, "h-1");
    expect(approvalBodies).toHaveLength(2);
    expect(approvalBodies[1]).toEqual(approvalBodies[0]);
    expect(approvalBodies[1].source.draftVersion).toBe(1);
    expect(approvalBodies[1].attachmentIds).toEqual(["a-1"]);
  });

  it("pins a body built from the review too, when no amendment was given", async () => {
    const { approveWithOperation } = await seam();
    const operationIds = new Map();
    reviewAnswers.push(firstReview(), laterReview());
    approveAnswers.push({ status: 200, body: { outcome: "partial_success", itemId: "i-1" } }, { status: 200, body: { outcome: "approved", itemId: "i-1" } });
    await approveWithOperation(suggestionOf("r-1"), operationIds, "h-1");
    await approveWithOperation(suggestionOf("r-1"), operationIds, "h-1");
    expect(approvalBodies[1]).toEqual(approvalBodies[0]);
  });

  it("drops the pin on a refusal: the next tap sends what the review lists now", async () => {
    const { approveWithOperation } = await seam();
    const operationIds = new Map();
    reviewAnswers.push(firstReview(), laterReview());
    approveAnswers.push(
      { status: 404, body: { error: { code: "attachment_not_found", message: "That staged attachment is not available" } } },
      { status: 200, body: { outcome: "approved", itemId: "i-1" } },
    );
    await expect(approveWithOperation(suggestionOf("r-1"), operationIds, "h-1", amended, "s2")).rejects.toThrow();
    await approveWithOperation(suggestionOf("r-1"), operationIds, "h-1");
    expect(approvalBodies).toHaveLength(2);
    expect(approvalBodies[1].source.draftVersion).toBe(4);
    expect(approvalBodies[1].attachmentIds).toEqual(["a-1", "a-2"]);
    expect(approvalBodies[1].sectionId).toBe("s1");
  });

  it("drops the pair on success: the next approval of the receipt makes a new key and a fresh body", async () => {
    const { approveWithOperation } = await seam();
    const operationIds = new Map();
    reviewAnswers.push(firstReview(), laterReview());
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: "i-1" } }, { status: 200, body: { outcome: "approved", itemId: "i-2" } });
    await approveWithOperation(suggestionOf("r-1"), operationIds, "h-1", amended, "s2");
    expect(operationIds.size).toBe(0);
    await approveWithOperation(suggestionOf("r-1"), operationIds, "h-1");
    expect(approvalBodies[1].operationId).not.toBe(approvalBodies[0].operationId);
    expect(approvalBodies[1].source.draftVersion).toBe(4);
  });
});

/*
 * W-R9 (design-mailin fix 5): a replay that dropped the member's amendment.
 * The pair the review reports is sent verbatim, so an amendment given beside
 * it is not what the engine approved. The seam says so, by the shape of its
 * answer: `{ replayed: true, message }`, never `{ ok: true }`.
 */
describe("approveWithOperation reports a replay that dropped an amendment (W-R9)", () => {
  const amended = { kind: "service", title: "Amended after the pair appeared", currency: "GBP", status: "active" };

  it("8. an amendment given, a pair reported, the engine approves: { replayed: true, message }, the stored pair sent", async () => {
    const { approveWithOperation } = await seam();
    const operationIds = new Map();
    reviewAnswers.push(reviewOf({ approval: reportedPair() }));
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: REPORTED_ID } });
    const result = await approveWithOperation(suggestionOf("r-1"), operationIds, "h-1", amended, "s1");
    expect(approvalBodies).toEqual([{ ...reportedRequest(), operationId: REPORTED_ID }]);
    expect(result).toEqual({ replayed: true, message: expect.any(String) });
    expect(/** @type {any} */ (result).message.trim()).not.toBe("");
    expect(operationIds.size, "the operation id is dropped as for ok").toBe(0);
    // The pin is cleared as for ok: the next approval of the receipt is built afresh.
    reviewAnswers.push(reviewOf({ receipt: { draftVersion: 4, proposal: { title: "Later read" } } }));
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: "i-2" } });
    await approveWithOperation(suggestionOf("r-1"), operationIds, "h-1");
    expect(approvalBodies[1].operationId).not.toBe(REPORTED_ID);
    expect(approvalBodies[1].source.draftVersion).toBe(4);
  });

  it("9. no amendment given, a pair reported: { ok: true } (unchanged)", async () => {
    const { approveWithOperation } = await seam();
    reviewAnswers.push(reviewOf({ approval: reportedPair() }));
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: REPORTED_ID } });
    await expect(approveWithOperation(suggestionOf("r-1"), new Map(), "h-1")).resolves.toEqual({ ok: true });
  });

  it("10. an amendment given, no pair reported: { ok: true } (unchanged)", async () => {
    const { approveWithOperation } = await seam();
    reviewAnswers.push(reviewOf());
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: "i-1" } });
    await expect(approveWithOperation(suggestionOf("r-1"), new Map(), "h-1", amended, "s1")).resolves.toEqual({ ok: true });
    expect(approvalBodies[0].item).toMatchObject({ title: "Amended after the pair appeared" });
  });

  it("11. an amendment given, a pair reported, partial_success: the retry sentence stands", async () => {
    const { approveWithOperation } = await seam();
    const operationIds = new Map();
    reviewAnswers.push(reviewOf({ approval: reportedPair() }));
    approveAnswers.push({ status: 200, body: { outcome: "partial_success", itemId: REPORTED_ID } });
    await expect(approveWithOperation(suggestionOf("r-1"), operationIds, "h-1", amended, "s1"))
      .resolves.toEqual({ partial: true, message: PARTIAL_SENTENCE });
  });

  it("12. readPendingApproval passes a timeout signal to its fetch", async () => {
    const { readPendingApproval } = await seam();
    await readPendingApproval("r-1", "h-1");
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/api/imap-inbox/r-1"));
    expect(calls).toHaveLength(1);
    const signal = /** @type {RequestInit | undefined} */ (calls[0][1])?.signal;
    expect(signal, "init.signal is an AbortSignal").toBeInstanceOf(AbortSignal);
    expect(/** @type {AbortSignal} */ (signal).aborted, "not already aborted").toBe(false);
  });
});

/*
 * Two overlapping approvals of one receipt (a double tap, or the pocket's and
 * the desk's handlers firing together) are one send: a second call for the
 * receipt while one is in flight joins it, so the engine sees one body under
 * one operation id and both callers get the one outcome.
 */

/** A gate the test opens by hand. @returns {{ gate: Promise<void>, open: () => void }} */
function gateOf() {
  /** @type {() => void} */
  let open = () => {};
  const gate = new Promise((resolve) => { open = () => resolve(undefined); });
  return { gate: /** @type {Promise<void>} */ (gate), open };
}

describe("approveWithOperation sends once for overlapping calls on one receipt", () => {
  it("two overlapping calls send one request with one id", async () => {
    const { approveWithOperation } = await seam();
    const operationIds = new Map();
    const held = gateOf();
    reviewGate = held.gate;
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: "i-1" } });
    const suggestion = suggestionOf("r-1");
    const first = approveWithOperation(suggestion, operationIds, "h-1");
    const second = approveWithOperation(suggestion, operationIds, "h-1");
    held.open();
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(approvalBodies).toHaveLength(1);
    expect(operationIds.size).toBe(0);
  });

  it("overlapping callers get one outcome: the same partial answer, the id kept", async () => {
    const { approveWithOperation } = await seam();
    const operationIds = new Map();
    const held = gateOf();
    reviewGate = held.gate;
    approveAnswers.push({ status: 200, body: { outcome: "partial_success", itemId: "i-1" } });
    const suggestion = suggestionOf("r-1");
    const first = approveWithOperation(suggestion, operationIds, "h-1");
    const second = approveWithOperation(suggestion, operationIds, "h-1");
    held.open();
    const [one, two] = await Promise.all([first, second]);
    expect(one).toEqual({ partial: true, message: PARTIAL_SENTENCE });
    expect(two).toEqual(one);
    expect(approvalBodies).toHaveLength(1);
    expect(operationIds.size).toBe(1);
  });

  it("after it settles, the receipt can be sent again under the same id", async () => {
    const { approveWithOperation } = await seam();
    const operationIds = new Map();
    const held = gateOf();
    reviewGate = held.gate;
    approveAnswers.push({ status: 200, body: { outcome: "partial_success", itemId: "i-1" } });
    const suggestion = suggestionOf("r-1");
    const first = approveWithOperation(suggestion, operationIds, "h-1");
    const second = approveWithOperation(suggestion, operationIds, "h-1");
    held.open();
    await Promise.all([first, second]);
    reviewGate = null;
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: "i-1" } });
    await expect(approveWithOperation(suggestion, operationIds, "h-1")).resolves.toEqual({ ok: true });
    expect(approvalBodies).toHaveLength(2);
    expect(approvalBodies[1].operationId).toBe(approvalBodies[0].operationId);
  });

  it("a failed read lets the next tap try again", async () => {
    const { approveWithOperation } = await seam();
    const operationIds = new Map();
    const suggestion = suggestionOf("r-1");
    reviewStatuses.push(503);
    await expect(approveWithOperation(suggestion, operationIds, "h-1")).rejects.toThrow();
    expect(approvalBodies).toHaveLength(0);
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: "i-1" } });
    await expect(approveWithOperation(suggestion, operationIds, "h-1")).resolves.toEqual({ ok: true });
    expect(approvalBodies).toHaveLength(1);
  });

  it("different receipts do not share a flight", async () => {
    const { approveWithOperation } = await seam();
    const operationIds = new Map();
    const held = gateOf();
    reviewGate = held.gate;
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: "i-1" } });
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: "i-2" } });
    const first = approveWithOperation(suggestionOf("r-1"), operationIds, "h-1");
    const second = approveWithOperation(suggestionOf("r-2"), operationIds, "h-1");
    held.open();
    await Promise.all([first, second]);
    expect(approvalBodies).toHaveLength(2);
    expect(approvalBodies[0].operationId).toBeTruthy();
    expect(approvalBodies[0].operationId).not.toBe(approvalBodies[1].operationId);
  });

  it("the id is taken before the first read", async () => {
    const { approveWithOperation } = await seam();
    const operationIds = new Map();
    const held = gateOf();
    reviewGate = held.gate;
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: "i-1" } });
    const pending = approveWithOperation(suggestionOf("r-1"), operationIds, "h-1");
    expect(typeof operationIds.get("r-1")).toBe("string");
    held.open();
    await pending;
    expect(approvalBodies).toHaveLength(1);
  });
});

/** @param {string} dir @returns {string[]} */
function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === ".svelte-kit") return [];
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("one wording, one call (#1343 tripwire)", () => {
  const files = filesUnder("web/src").filter((f) => /\.(js|ts|svelte|mjs)$/.test(f));

  it("no screen branches on the words of the partial-success message", () => {
    const offenders = files.filter((f) => /startsWith\(\s*["'`]The item is recorded/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the sentence appears in exactly one file, the seam", () => {
    const holders = files.filter((f) => readFileSync(f, "utf8").includes(PARTIAL_SENTENCE));
    expect(holders).toEqual(["web/src/lib/data/workspace.js"]);
  });

  it("no wording of it survives anywhere else", () => {
    const strays = files.filter((f) => f !== "web/src/lib/data/workspace.js" && readFileSync(f, "utf8").includes("The item is recorded"));
    expect(strays).toEqual([]);
  });

  it.each([
    "web/src/routes/home/+page.svelte",
    "web/src/routes/home/pocket.svelte",
    "web/src/routes/inbox/+page.svelte",
    "web/src/routes/inbox/pocket.svelte",
  ])("%s does not read partial_success itself", (screen) => {
    expect(readFileSync(screen, "utf8").includes("partial_success")).toBe(false);
  });
});

describe("one wording for the replay, one call (W-R9 extends the #1343 tripwire)", () => {
  const SEAM = "web/src/lib/data/workspace.js";
  const files = filesUnder("web/src").filter((f) => /\.(js|ts|svelte|mjs)$/.test(f));

  /** The sentence the seam gives for a replay that dropped an amendment. */
  async function replayedSentence() {
    const { approveWithOperation } = await seam();
    reviewAnswers.push(reviewOf({ approval: reportedPair() }));
    approveAnswers.push({ status: 200, body: { outcome: "approved", itemId: REPORTED_ID } });
    const amended = { kind: "service", title: "Amended", currency: "GBP", status: "active" };
    const result = /** @type {any} */ (await approveWithOperation(suggestionOf("r-1"), new Map(), "h-1", amended, "s1"));
    expect(typeof result.message, "the seam gives a sentence for a dropped amendment").toBe("string");
    expect(result.message.length).toBeGreaterThan(20);
    return /** @type {string} */ (result.message);
  }

  it("13a. the sentence appears in exactly one file, the seam", async () => {
    const sentence = await replayedSentence();
    const holders = files.filter((f) => readFileSync(f, "utf8").includes(sentence));
    expect(holders).toEqual([SEAM]);
  });

  it("13b. no screen branches on its words", async () => {
    const sentence = await replayedSentence();
    const lead = sentence.slice(0, 20);
    const strays = files.filter((f) => f !== SEAM && readFileSync(f, "utf8").includes(lead));
    expect(strays).toEqual([]);
  });
});
