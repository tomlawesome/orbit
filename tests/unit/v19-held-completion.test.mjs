import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("finishes a previous visit's stash, a version conflict counting as sent", async () => {
    const storage = memoryStorage();
    storage.setItem(HELD_COMPLETION_KEY, JSON.stringify([{ itemId: "i1" }, { itemId: "i2" }]));
    const conflict = Object.assign(new Error("conflict"), { code: "version_conflict" });
    const apply = vi.fn(async (command) => { if (command.itemId === "i2") throw conflict; });
    const onsent = vi.fn();
    const held = createHeldCompletion({ apply, onsent, holdMs: 4000, storage });
    held.retryStashed((error) => /** @type {any} */ (error)?.code === "version_conflict");
    await flush();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(onsent).toHaveBeenCalledTimes(2);
    expect(readHeldCompletionStash(storage)).toEqual([]);
  });

  it("reads the older single-slot stash the belt once wrote", () => {
    const storage = memoryStorage();
    storage.setItem(HELD_COMPLETION_KEY, JSON.stringify({ command: { itemId: "i1" } }));
    expect(readHeldCompletionStash(storage)).toEqual([{ itemId: "i1" }]);
  });
});
