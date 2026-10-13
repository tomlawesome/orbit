import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as heldCompletion from "../../web/src/lib/data/held-completion.js";
import {
  HELD_COMPLETION_KEY, createHeldCompletion, readHeldCompletionStash,
} from "../../web/src/lib/data/held-completion.js";

/*
 * #1319: home's desk drawer completes an item as the belt and the pocket do
 * (§1.13): the command is held for the wake's four seconds so `undo` is a
 * real undo, stashed before it is first sent (#1151 W1-R5/W1-S3) so a send
 * the page never lives to see is finished on the next load.
 */

function memoryStorage() {
  /** @type {Map<string, string>} */
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

/* timers are faked, so a turn of the microtask queue is the fake clock's */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("a held completion", () => {
  it("is stashed at once and sent only when the hold runs out", async () => {
    const storage = memoryStorage();
    const apply = vi.fn(async () => {});
    const onsent = vi.fn();
    const held = createHeldCompletion({ apply, onsent, holdMs: 4000, storage });
    held.hold({ type: "item.complete", itemId: "i1" });
    expect(readHeldCompletionStash(storage)).toHaveLength(1);
    expect(apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(onsent).toHaveBeenCalledTimes(1);
    expect(storage.getItem(HELD_COMPLETION_KEY)).toBeNull();
  });

  it("is never sent when undone inside the hold", async () => {
    const storage = memoryStorage();
    const apply = vi.fn(async () => {});
    const held = createHeldCompletion({ apply, holdMs: 4000, storage });
    const job = held.hold({ type: "item.complete", itemId: "i1" });
    held.undo(job);
    await vi.advanceTimersByTimeAsync(5000);
    expect(apply).not.toHaveBeenCalled();
    expect(readHeldCompletionStash(storage)).toEqual([]);
  });

  it("sends the first at once when a second is held, and keeps both until each confirms", async () => {
    const storage = memoryStorage();
    /** @type {(() => void)[]} */
    const pending = [];
    const apply = vi.fn(() => new Promise((resolve) => { pending.push(() => resolve(undefined)); }));
    const held = createHeldCompletion({ apply, holdMs: 4000, storage });
    held.hold({ itemId: "i1" });
    held.hold({ itemId: "i2" });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith({ itemId: "i1" });
    expect(readHeldCompletionStash(storage)).toHaveLength(2);
    pending.shift()?.();
    await flush();
    expect(readHeldCompletionStash(storage)).toEqual([{ itemId: "i2" }]);
  });

  it("stays stashed when its send fails, and says so", async () => {
    const storage = memoryStorage();
    const onfailed = vi.fn();
    const held = createHeldCompletion({ apply: async () => { throw new Error("offline"); }, onfailed, holdMs: 10, storage });
    held.hold({ itemId: "i1" });
    await vi.advanceTimersByTimeAsync(10);
    expect(onfailed).toHaveBeenCalledTimes(1);
    expect(readHeldCompletionStash(storage)).toEqual([{ itemId: "i1" }]);
  });

  it("finishes a previous visit's stash; a version conflict is reported, not counted as sent (#1316)", async () => {
    const storage = memoryStorage();
    storage.setItem(HELD_COMPLETION_KEY, JSON.stringify([{ itemId: "i1" }, { itemId: "i2" }]));
    const conflict = Object.assign(new Error("conflict"), { code: "version_conflict" });
    const apply = vi.fn(async (command) => { if (command.itemId === "i2") throw conflict; });
    const onsent = vi.fn();
    const onfailed = vi.fn();
    const held = createHeldCompletion({ apply, onsent, onfailed, holdMs: 4000, storage });
    held.retryStashed((error) => /** @type {any} */ (error)?.code === "version_conflict");
    await flush();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(onsent).toHaveBeenCalledTimes(1);
    expect(onfailed).toHaveBeenCalledWith(conflict, { itemId: "i2" });
    expect(readHeldCompletionStash(storage)).toEqual([]);
  });

  it("reports a dropped completion with the error and the dropped command, so the caller knows its itemId (#1316)", async () => {
    const storage = memoryStorage();
    storage.setItem(HELD_COMPLETION_KEY, JSON.stringify([{ type: "item.complete", itemId: "i2" }]));
    const conflict = Object.assign(new Error("conflict"), { code: "version_conflict" });
    const onfailed = vi.fn();
    const held = createHeldCompletion({ apply: async () => { throw conflict; }, onfailed, holdMs: 4000, storage });
    held.retryStashed((error) => /** @type {any} */ (error)?.code === "version_conflict");
    await flush();
    expect(onfailed).toHaveBeenCalledTimes(1);
    expect(onfailed).toHaveBeenCalledWith(conflict, { type: "item.complete", itemId: "i2" });
  });

  it("reports a failed live send with the error and the command too (#1316)", async () => {
    const storage = memoryStorage();
    const boom = new Error("offline");
    const onfailed = vi.fn();
    const held = createHeldCompletion({ apply: async () => { throw boom; }, onfailed, holdMs: 10, storage });
    held.hold({ type: "item.complete", itemId: "i1" });
    await vi.advanceTimersByTimeAsync(10);
    expect(onfailed).toHaveBeenCalledWith(boom, { type: "item.complete", itemId: "i1" });
  });

  it("reads the older single-slot stash the belt once wrote", () => {
    const storage = memoryStorage();
    storage.setItem(HELD_COMPLETION_KEY, JSON.stringify({ command: { itemId: "i1" } }));
    expect(readHeldCompletionStash(storage)).toEqual([{ itemId: "i1" }]);
  });
});

describe("the words for a dropped completion (#1316)", () => {
  /* The screens' shared helper, held-completion.js's droppedCompletionWords(title). */
  const wake = () => /** @type {any} */ (heldCompletion).droppedCompletionWords("Boiler service");

  it("names the item and says the tick was not recorded and must be marked again", () => {
    const words = String(wake());
    expect(words).toContain("Boiler service");
    expect(words).toMatch(/not recorded/i);
    expect(words).toMatch(/mark(ed)? (it )?(as done )?again/i);
  });

  it("does not tell the user to refresh and try again", () => {
    expect(String(wake())).not.toMatch(/refresh/i);
    expect(String(wake())).not.toMatch(/try again/i);
  });
});

describe("both home screens use the words for a dropped completion (#1316)", () => {
  /* The helper is proven above; this pins each screen's wiring against its
     own text (the screens cannot be driven without a browser): a refusal
     names the item the command was for, looked up by its itemId. */
  const read = (p) => readFileSync(resolve(import.meta.dirname, "../..", p), "utf8");
  /** The text from `from` (after `after`) up to the closing `});` at two-space indent. */
  const block = (src, after, from) => {
    const start = src.indexOf(from, src.indexOf(after));
    expect(src.indexOf(after)).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n  });", start);
    return src.slice(start, end === -1 ? undefined : end);
  };

  it("the desk's held completion (+page.svelte onfailed) names the refused item", () => {
    const onfailed = block(read("web/src/routes/home/+page.svelte"), "createHeldCompletion({", "onfailed:");
    expect(onfailed).toContain("isRefused(error)");
    expect(onfailed).toMatch(/\bcommand\)?\??\.itemId\b/u);
    expect(onfailed).toContain("droppedCompletionWords(");
  });

  it("the phone's stash replay (pocket.svelte catch) names the refused item", () => {
    const replay = block(read("web/src/routes/home/pocket.svelte"), "of readHeldCompletionStash()", ".catch(");
    expect(replay).toMatch(/\brefused\s*\?/u);
    expect(replay).toContain("rawItems.get(sent.itemId)");
    expect(replay).toContain("droppedCompletionWords(");
  });
});
