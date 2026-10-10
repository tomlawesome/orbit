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

beforeEach(() => {
  approveAnswers = [];
  approvalBodies = [];
  vi.stubGlobal("fetch", vi.fn(async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    if (String(url).includes("/api/auth/session")) {
      return new Response(JSON.stringify({ user: { id: "u1" }, csrfToken: "token" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    // Approving reads the receipt's review first (and files an unassigned
    // receipt under the household with a PUT); only the approval itself
    // takes a queued answer.
    if (String(url).includes("/api/imap-inbox/")) {
      const review = { receipt: { draftVersion: 1 }, sections: [{ id: "s1", name: "Home" }], attachments: [] };
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
