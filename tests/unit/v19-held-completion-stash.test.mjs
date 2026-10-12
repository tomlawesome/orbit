import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HELD_COMPLETION_KEY, createHeldCompletion, readHeldCompletionStash,
} from "../../web/src/lib/data/held-completion.js";
import { WorkspaceError } from "../../web/src/lib/data/workspace.js";

/*
 * #1151 W1-R5 (the belt's item page, retired in #1319) and W1-S3
 * (home/pocket.svelte): a completion held for the undo wake, then flushed on leave, used to be sent
 * with a bare `.catch(() => {})` — a request cut off by the page actually
 * unloading (as opposed to merely refused) vanished with nothing said, and
 * the item quietly stayed "not completed" with no trace it was ever tried.
 *
 * The fix stashes the built command in `localStorage` before the first send
 * attempt, under the same literal key in both files, and clears it only on
 * confirmed success (including a version conflict, which means the send
 * landed after all); the next load of either screen picks up a leftover
 * stash and finishes the job, surfacing a failure through that screen's own
 * existing error pattern (item's `problem` banner; pocket's `wake(...,
 * { failure: true })` toast) rather than losing it silently.
 *
 * The pocket has no import surface a plain async-flow test can drive
 * without a browser — so, the way `v19-flight-mark-ride.test.mjs` pins a
 * `.svelte` fix, this pins the mechanism against the files' own text.
 */

const root = resolve(import.meta.dirname, "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const HOME_POCKET = read("web/src/routes/home/pocket.svelte");
const HELD_LIB = read("web/src/lib/data/held-completion.js");

describe("#1151 W1-R5/W1-S3: a held completion is stashed before it is sent", () => {
  it("home/pocket.svelte holds no completion since #1319 stage 2: complete asks first, then records at once", () => {
    expect(HOME_POCKET).not.toMatch(/stashHeldCompletion|WAKE_HOLD_MS/u);
  });

  it("home/pocket.svelte: a leftover stash is retried", () => {
    expect(HOME_POCKET).toMatch(/readHeldCompletionStash\(\)/u);
  });

  it("the pocket stashes under the same literal key as lib/data/held-completion.js", () => {
    const keyOf = (source) => source.match(/HELD_COMPLETION_KEY = "([^"]+)"/u)?.[1];
    expect(keyOf(HELD_LIB)).toBe("orbit:pending-completion");
    expect(keyOf(HOME_POCKET)).toBe(keyOf(HELD_LIB));
  });
});

/*
 * #1316 W2-F1 / W2-S1. A stashed completion from an older build is finished,
 * not refused forever, and a stash entry is never replayed endlessly. A
 * replayed completion the engine refuses with a version conflict is reported,
 * not read as done.
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

/* the callers' own conflict test, as they pass it today; a fixed retryStashed may ignore it */
const isConflict = (error) => /** @type {any} */ (error)?.code === "version_conflict";

/* a turn of the microtask queue (timers are faked in this block) */
const settle = () => vi.advanceTimersByTimeAsync(0);

const OLD_COMMAND = {
  type: "item.complete",
  householdId: "h1",
  itemId: "i1",
  expectedVersion: 3,
  completedDate: "2026-10-11",
  activity: { id: "a1", itemId: "i1", occurredAt: "2026-10-11T09:00:00.000Z", kind: "service_completed" },
  nextDate: "2026-11-01",
};

function stashedWith(command, apply) {
  const storage = memoryStorage();
  storage.setItem(HELD_COMPLETION_KEY, JSON.stringify([command]));
  const onsent = vi.fn();
  const onfailed = vi.fn();
  const held = createHeldCompletion({ apply, onsent, onfailed, holdMs: 4000, storage });
  return { storage, onsent, onfailed, held };
}

describe("#1316 W2-F1: retryStashed finishes an older build's completion and never replays a refused one", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("an old-shaped entry is sent without nextDate and activity.kind, and the stash empties on success", async () => {
    const apply = vi.fn(async () => ({}));
    const { storage, onsent, held } = stashedWith(OLD_COMMAND, apply);
    held.retryStashed(isConflict);
    await settle();
    expect(apply).toHaveBeenCalledTimes(1);
    const sent = /** @type {any} */ (apply.mock.calls[0][0]);
    expect(sent).not.toHaveProperty("nextDate");
    expect(sent.activity).not.toHaveProperty("kind");
    // the rest of the command is untouched
    expect(sent).toMatchObject({ type: "item.complete", householdId: "h1", itemId: "i1", expectedVersion: 3, completedDate: "2026-10-11" });
    expect(sent.activity).toMatchObject({ id: "a1", itemId: "i1", occurredAt: "2026-10-11T09:00:00.000Z" });
    expect(onsent).toHaveBeenCalledTimes(1);
    expect(readHeldCompletionStash(storage)).toEqual([]);
  });

  it("an entry the engine refuses with a 400 is reported once and dropped from the stash", async () => {
    const refusal = new WorkspaceError("not a valid command", { status: 400 });
    const apply = vi.fn(async () => { throw refusal; });
    const { storage, onsent, onfailed, held } = stashedWith(OLD_COMMAND, apply);
    held.retryStashed(isConflict);
    await settle();
    expect(onfailed).toHaveBeenCalledTimes(1);
    expect(onsent).not.toHaveBeenCalled();
    expect(readHeldCompletionStash(storage)).toEqual([]);
  });

  it("an entry that failed for want of a network stays stashed and is reported", async () => {
    const apply = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const { storage, onsent, onfailed, held } = stashedWith(OLD_COMMAND, apply);
    held.retryStashed(isConflict);
    await settle();
    expect(onfailed).toHaveBeenCalledTimes(1);
    expect(onsent).not.toHaveBeenCalled();
    expect(readHeldCompletionStash(storage)).toHaveLength(1);
  });
});

describe("#1316 W2-S1: a replayed completion refused with a version conflict is reported, not read as done", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("onfailed gets the conflict, onsent is not called, and the entry is cleared", async () => {
    const conflict = new WorkspaceError("changed elsewhere", { status: 409, code: "version_conflict" });
    const apply = vi.fn(async () => { throw conflict; });
    const { storage, onsent, onfailed, held } = stashedWith({ ...OLD_COMMAND, nextDate: undefined, activity: { id: "a1", itemId: "i1", occurredAt: "2026-10-11T09:00:00.000Z" } }, apply);
    held.retryStashed(isConflict);
    await settle();
    expect(onfailed).toHaveBeenCalledTimes(1);
    expect(onfailed).toHaveBeenCalledWith(conflict, expect.objectContaining({ itemId: "i1" }));
    expect(onsent).not.toHaveBeenCalled();
    expect(readHeldCompletionStash(storage)).toEqual([]);
  });
});

/* home/pocket.svelte keeps its own copy of the replay, so it is pinned by text. */
const comments = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu;
const POCKET_REPLAY = (() => {
  const start = HOME_POCKET.indexOf("for (const command of readHeldCompletionStash())");
  const end = HOME_POCKET.indexOf("\n  });", start);
  return start < 0 ? "" : HOME_POCKET.slice(start, end).replace(comments, "");
})();

describe("#1316 W2-F1/W2-S1: home/pocket.svelte's own stash replay", () => {
  it("finds the replay block", () => {
    expect(POCKET_REPLAY).toMatch(/applyCommand\(/u);
  });

  it("W2-F1: drops nextDate and activity.kind from an old entry before sending it", () => {
    expect(POCKET_REPLAY).toMatch(/nextDate/u);
    expect(POCKET_REPLAY).toMatch(/\bkind\b/u);
  });

  it("W2-F1: a refused (400) entry is cleared from the stash, not kept for ever", () => {
    expect(POCKET_REPLAY).toMatch(/400/u);
    expect(POCKET_REPLAY).toMatch(/clearHeldCompletionStash\(command\)/u);
  });

  it("W2-S1: a version conflict is no longer read as the replay succeeding", () => {
    expect(POCKET_REPLAY).not.toMatch(/version_conflict/u);
  });
});
