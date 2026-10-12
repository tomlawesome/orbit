import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1316: an amended approve that answers `partial_success` (the item is
 * recorded, its documents are not) has landed. Home treated it as a failed
 * save: the desk's and the phone's `addSuggestion` threw the answer's words
 * into the rows' save, so the rows stayed open reading "not saved — The item
 * is recorded, but its documents need another try …", and the reader could edit
 * the due date and press add again: a second approve under the SAME operation
 * id with a DIFFERENT item. The engine keys an approval by its operation id,
 * so that second body is either dropped or refused, and the reader is told
 * "not saved" about an item that exists.
 *
 * What home must do instead:
 *   - the rows close (no edit draft open, the row not editable);
 *   - the sentence shown is the recorded-but-documents-pending one, never
 *     "not saved …" or "not added …";
 *   - the home view is re-read, so the suggestion shows as the item it is;
 *   - nothing can send a different item under that operation id: with no
 *     draft open there is nothing to edit, and a second press on the
 *     suggestion is the plain approve, under the same operation id.
 *
 * The desk (+page.svelte) and the phone (pocket.svelte) are `.svelte` files
 * this suite does not compile, and the home screen is imperative DOM that no
 * unit test mounts (see v19-home-signout-inflight-guard, v19-home-load-problem),
 * so, as the neighbouring home and create tests do, the second half pins the
 * wiring against the files' own text -- the functions that carry the answer
 * from the approve to the rows -- and the first half drives the data seam the
 * second press goes through, with a stubbed fetch.
 *
 * tests/e2e/v19-mail-review.spec.ts proves the journey in a browser.
 */

const PARTIAL_SENTENCE = "The item is recorded, but its documents need another try — try once more to finish.";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const DESK = read("web/src/routes/home/+page.svelte");
const PHONE = read("web/src/routes/home/pocket.svelte");

/**
 * The text of `function <name>(...) { ... }`, braces balanced, or "" when the
 * file has no such function. Strings and comments in these functions carry no
 * unbalanced braces.
 */
function functionText(source, name) {
  const start = source.search(new RegExp(`function ${name}\\(`, "u"));
  if (start < 0) return "";
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  return "";
}

/** The function's lines that mention the answer's `.message` without throwing it. */
const messageUsedWithoutThrow = (text) =>
  text.split("\n").filter((line) => /\.message\b/u.test(line) && !/\bthrow\b/u.test(line));

describe("#1316: the approve's partial answer, through the data seam both screens call", () => {
  /** @type {Array<Record<string, any>>} */
  let approvalBodies = [];
  let approveAnswer = { outcome: "partial_success", itemId: "i-1" };

  beforeEach(() => {
    approvalBodies = [];
    approveAnswer = { outcome: "partial_success", itemId: "i-1" };
    vi.stubGlobal("fetch", vi.fn(async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
      const href = String(url);
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (href.includes("/api/auth/session")) return json({ user: { id: "u1" }, csrfToken: "token" });
      if (href.includes("/api/imap-inbox/")) {
        return json(init?.method === "PUT" ? {} : { receipt: { draftVersion: 1 }, sections: [{ id: "s1", name: "Home" }, { id: "s2", name: "Garage" }], attachments: [] });
      }
      if (href.includes("/api/reviewed-intake/approve")) {
        approvalBodies.push(JSON.parse(String(init.body)));
        return json(approveAnswer);
      }
      throw new Error(`unexpected fetch: ${href}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const suggestion = {
    id: "r-1", receiptId: "r-1", draftVersion: 3, householdId: "h-1",
    title: "Boiler cover", proposal: { title: "Boiler cover" }, attachmentCount: 1,
  };

  it("answers the recorded-but-documents-pending sentence, and a second press sends the same operation id", async () => {
    const { approveWithOperation } = await import("../../web/src/lib/data/workspace.js");
    const operationIds = new Map();
    const amended = { title: "Boiler cover (amended)", kind: "service" };

    const first = await approveWithOperation(suggestion, operationIds, "h-1", amended, "s2");
    expect(first).toEqual({ partial: true, message: PARTIAL_SENTENCE });

    // The second press on the suggestion is the plain approve: no amended item.
    approveAnswer = { outcome: "approved", itemId: "i-1" };
    await expect(approveWithOperation(suggestion, operationIds, "h-1")).resolves.toEqual({ ok: true });

    expect(approvalBodies).toHaveLength(2);
    expect(approvalBodies[0].item).toMatchObject({ title: "Boiler cover (amended)" });
    expect(approvalBodies[1].operationId).toBe(approvalBodies[0].operationId);
    // Same operation id means the engine treats the second body as the first
    // one again, so it must BE the first one: the amended item and the section
    // the reader chose, not the proposal's own item and the first section.
    expect(approvalBodies[0].sectionId).toBe("s2");
    expect(approvalBodies[1].item).toEqual(approvalBodies[0].item);
    expect(approvalBodies[1].sectionId).toBe(approvalBodies[0].sectionId);
  });
});

describe.each([
  ["the desk (+page.svelte)", DESK],
  ["the phone (pocket.svelte)", PHONE],
])("#1316: %s does not turn a partial landing into a failed save", (_name, source) => {
  const addSuggestion = functionText(source, "addSuggestion");

  it("finds the rows' save for a suggestion", () => {
    expect(addSuggestion.length, "addSuggestion is in the file").toBeGreaterThan(100);
    expect(addSuggestion).toMatch(/amend(Receipt|ed)|onamend/u);
  });

  it("does not throw the partial answer's words into the rows' save", () => {
    // A throw out of the save is what EditSession.commit() turns into
    // "not saved — <words>" under rows that stay open for another edit.
    expect(addSuggestion).not.toMatch(/throw\s+new\s+Error\(\s*(problem|result|answer)\.message\b/u);
    expect(addSuggestion).not.toMatch(/throw\s+(problem|result|answer)\b/u);
  });
});

describe("#1316: the screens show the recorded sentence and re-read home on a partial landing", () => {
  const amendReceipt = functionText(DESK, "amendReceipt");

  it("finds amendReceipt, the one approve both screens' amends call", () => {
    expect(amendReceipt.length).toBeGreaterThan(100);
    expect(DESK).toMatch(/onamend=\{amendReceipt\}/u);
  });

  it("re-reads home before it hands a partial answer back", () => {
    const partial = amendReceipt.search(/["']partial["']\s+in\s+\w+/u);
    expect(partial, "amendReceipt looks at the partial answer").toBeGreaterThan(0);
    const returned = amendReceipt.indexOf("return", partial);
    expect(returned).toBeGreaterThan(partial);
    // The home read has to sit between the approve and the partial return: the
    // suggestion has become an item, and home must say so.
    const reads = [...amendReceipt.matchAll(/readHome(In)?\(/gu)].map((match) => match.index);
    expect(reads.length, "amendReceipt reads home").toBeGreaterThan(0);
    expect(Math.min(...reads), "the home read comes before the partial answer is returned").toBeLessThan(returned);
  });

  it.each([
    ["the desk", () => [functionText(DESK, "addSuggestion"), amendReceipt, functionText(DESK, "addAmended")]],
    ["the phone", () => [functionText(PHONE, "addSuggestion"), functionText(PHONE, "addAmended"), amendReceipt]],
  ])("%s puts the partial answer's message on screen without throwing it", (_name, parts) => {
    const used = parts().flatMap(messageUsedWithoutThrow);
    expect(used.length, "the answer's message is used somewhere other than a throw").toBeGreaterThan(0);
  });
});
