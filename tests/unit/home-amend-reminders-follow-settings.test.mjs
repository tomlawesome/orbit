import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { amendedOf, draftOf, editsOf, proposedItemOf } from "../../web/src/lib/editing/item-draft.js";
import { reminderPairOf } from "../../web/src/routes/create/entry.js";

/*
 * #1316 (round 4, finding S1), on the gap #1389 left: owner decision 7a on
 * #1316 says a new item's form starts its reminders from the signed-in
 * member's own Settings pair (firstWarningDays and finalWarningDays, GET
 * /api/settings/reminders), falling back to the default pair (14 and 3) when
 * the pair cannot be read or either day is null. The home drawer's "review &
 * amend" on a mail suggestion (the desk's and the phone's `startAmend`, which
 * seed the rows through `proposedItemOf`) still starts every suggestion at
 * 14 and 3, so a member whose pair is 30 and 7 files it with the wrong
 * warnings.
 *
 * Shaped like review-amend-reminders-follow-settings.test.mjs, with the
 * stubbed settings route as its seam. The home screens are `.svelte` files
 * of imperative DOM that no unit test mounts (see v19-home-amend-partial-lands),
 * so their `startAmend` is lifted out of the file's own text and run, over
 * the real `readReminders` and `proposedItemOf` and a stubbed fetch, with
 * the rest of the screen's state stood in for.
 */

const MEMBER_PAIR = [30, 7];
const DEFAULT_PAIR = [14, 3];
const root = resolve(import.meta.dirname, "../..");
const read = (/** @type {string} */ path) => readFileSync(resolve(root, path), "utf8");
const DESK = read("web/src/routes/home/+page.svelte");
const PHONE = read("web/src/routes/home/pocket.svelte");

const where = { householdId: "hh-1", sectionId: "s-home" };
const suggestion = {
  id: "r-1", receiptId: "r-1", householdId: "hh-1", title: "Boiler cover",
  proposal: { title: "Boiler cover", dueDate: "2027-03-01" },
};

describe("proposedItemOf starts the reminders from the member's pair", () => {
  it("with the member's pair 30 and 7, reminderDays is [30, 7]", () => {
    const item = proposedItemOf(/** @type {any} */ (suggestion), where, /** @type {any} */ ({ reminders: { firstWarningDays: 30, finalWarningDays: 7 } }));
    expect(item.reminderDays).toEqual(MEMBER_PAIR);
  });

  it("with no pair read (null), reminderDays is the default [14, 3]", () => {
    const item = proposedItemOf(/** @type {any} */ (suggestion), where, /** @type {any} */ ({ reminders: null }));
    expect(item.reminderDays).toEqual(DEFAULT_PAIR);
  });

  it("with null days in the pair, reminderDays is the default [14, 3]", () => {
    const item = proposedItemOf(/** @type {any} */ (suggestion), where, /** @type {any} */ ({ reminders: { firstWarningDays: null, finalWarningDays: null } }));
    expect(item.reminderDays).toEqual(DEFAULT_PAIR);
  });

  it("with no third argument, reminderDays is still the default [14, 3]", () => {
    expect(proposedItemOf(/** @type {any} */ (suggestion), where).reminderDays).toEqual(DEFAULT_PAIR);
  });

  it("the pair travels through the rows to the approval: editsOf and amendedOf carry [30, 7]", () => {
    const item = proposedItemOf(/** @type {any} */ (suggestion), where, /** @type {any} */ ({ reminders: { firstWarningDays: 30, finalWarningDays: 7 } }));
    const edits = editsOf(draftOf(item));
    expect(edits.reminderDays).toEqual(MEMBER_PAIR);
    expect(amendedOf(item, edits).item.reminderDays).toEqual(MEMBER_PAIR);
  });
});

/**
 * The text of `[async ]function <name>(...) { ... }`, braces balanced, or ""
 * when the file has no such function.
 * @param {string} source
 * @param {string} name
 */
function functionText(source, name) {
  const at = source.search(new RegExp(`function ${name}\\(`, "u"));
  if (at < 0) return "";
  const start = source.slice(Math.max(0, at - 6), at) === "async " ? at - 6 : at;
  const open = source.indexOf("{", source.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  return "";
}

/**
 * Runs a screen's `startAmend` over `names` as its surrounding script, and
 * answers what it handed `modes.startEdit`. Any name the function reaches for
 * that `names` does not give is a fault of this setup and throws.
 * @param {string} source
 * @param {Record<string, unknown>} names
 * @param {(fn: Function) => unknown} call
 */
async function runStartAmend(source, names, call) {
  await call(startAmendOf(source, names));
}

/**
 * The screen's `startAmend`, bound to `names` as its surrounding script.
 * @param {string} source
 * @param {Record<string, unknown>} names
 * @returns {Function}
 */
function startAmendOf(source, names) {
  const text = functionText(source, "startAmend");
  expect(text.length, "the screen has a startAmend").toBeGreaterThan(100);
  const body = text.startsWith("async") ? text : `async ${text}`;
  const scope = new Proxy(names, {
    has: () => true,
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return /** @type {any} */ (target)[key];
      if (key in globalThis) return /** @type {any} */ (globalThis)[key];
      throw new ReferenceError(`startAmend reached for ${String(key)}, which this test does not stand in`);
    },
  });
  const make = new Function("scope", `with (scope) { return (${body}); }`);
  return make(scope);
}

/** @type {"pair" | "fails" | "gated" | "never" | "slow"} */
let readMode = "pair";
/** The `init` of every settings read, so a test can see its abort signal. */
/** @type {any[]} */
let readInits = [];
/** The real timer, taken before any test fakes the clock. */
const realSetTimeout = globalThis.setTimeout;
/** @type {() => void} */
let answerRead = () => {};
beforeEach(() => {
  readMode = "pair";
  readInits = [];
  /** @type {Promise<void>} */
  const gate = new Promise((done) => { answerRead = () => done(); });
  vi.stubGlobal("fetch", vi.fn(async (/** @type {string} */ url, /** @type {any} */ init) => {
    const href = String(url);
    const json = (/** @type {unknown} */ body, status = 200) => new Response(JSON.stringify(body), { status });
    if (href.includes("/api/settings/reminders")) {
      readInits.push(init);
      if (readMode === "never") return new Promise(() => {});
      if (readMode === "slow") await new Promise((done) => setTimeout(done, 1000));
      if (readMode === "gated") await gate;
      if (readMode === "fails") return json({ error: { code: "unavailable", message: "not today" } }, 503);
      return json({
        reminders: {
          emailEnabled: true, firstWarningDays: 30, finalWarningDays: 7,
          firstWarning: "30 days before closest approach", finalWarning: "7 days before", outboundMail: "configured",
        },
      });
    }
    return json({ error: { code: "unavailable", message: "not today" } }, 503);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const sections = [{ id: "s-home", name: "Home", visible: true }];
const view = {
  primary: "hh-1", suggestions: [suggestion], households: [{ id: "hh-1", sections }], household: { id: "hh-1", sections },
};

/** What the screen handed the rows' editing, and what the approval would then carry. */
async function amendOnDesk() {
  const { readReminders } = await import("../../web/src/lib/data/workspace.js");
  /** @type {any[]} */
  const started = [];
  /** @type {Record<string, unknown>} */
  const names = {
    view, expanded: "r-1", asView: (/** @type {unknown} */ v) => v, armed: null, mailProblem: null, previewDoc: null,
    modes: { startEdit: (/** @type {any} */ item) => { started.push(item); } },
    focusInDrawer: () => {}, readReminders, proposedItemOf, reminderPairOf,
  };
  await runStartAmend(DESK, names, (startAmend) => /** @type {any} */ (startAmend)());
  return started;
}

async function amendOnPhone() {
  const { readReminders } = await import("../../web/src/lib/data/workspace.js");
  /** @type {any[]} */
  const started = [];
  /** @type {Record<string, unknown>} */
  const names = {
    view, lit: "r-1", rowProblem: {}, previewPaper: null, reviewLockedOf: () => false,
    modes: { startEdit: (/** @type {any} */ item) => { started.push(item); } },
    focusInRow: () => {}, readReminders, proposedItemOf, reminderPairOf,
  };
  await runStartAmend(PHONE, names, (startAmend) => /** @type {any} */ (startAmend)(suggestion));
  return started;
}

describe.each([
  ["the desk drawer (home/+page.svelte)", amendOnDesk],
  ["the phone row (home/pocket.svelte)", amendOnPhone],
])("#1316 S1: %s, review & amend", (_name, amend) => {
  it("with the member's pair stubbed as 30 and 7, the rows open at [30, 7] and the approval carries it", async () => {
    readMode = "pair";
    const started = await amend();
    expect(started, "the rows were opened once").toHaveLength(1);
    expect(started[0].reminderDays).toEqual(MEMBER_PAIR);
    const edits = editsOf(draftOf(started[0]));
    expect(amendedOf(started[0], edits).item.reminderDays).toEqual(MEMBER_PAIR);
  });

  it("with the settings read failing, the rows open at the default [14, 3] and the approval carries it", async () => {
    readMode = "fails";
    const started = await amend();
    expect(started, "the rows were opened once, not left shut by the failed read").toHaveLength(1);
    expect(started[0].reminderDays).toEqual(DEFAULT_PAIR);
    const edits = editsOf(draftOf(started[0]));
    expect(amendedOf(started[0], edits).item.reminderDays).toEqual(DEFAULT_PAIR);
  });
});

/* ---- #1316 round 5, U2: the read is awaited, so the screen can move on ---- */

/** Real time for the stubbed answer to travel through fetch, Response and the awaits. */
const settle = () => new Promise((done) => setTimeout(done, 25));

/**
 * One screen's `startAmend` with its drawer state mutable between the press
 * and the answer. `open` names the row the drawer is on (the desk's
 * `expanded`, the phone's `lit`).
 * @param {"desk" | "phone"} screen
 */
async function screenOf(screen) {
  const { readReminders } = await import("../../web/src/lib/data/workspace.js");
  /** @type {any[]} */
  const started = [];
  /** @type {any} */
  const modes = { id: null, startEdit: (/** @type {any} */ item) => { started.push(item); } };
  /** @type {Record<string, any>} */
  const names = screen === "desk"
    ? {
      view, expanded: "r-1", asView: (/** @type {unknown} */ v) => v, armed: null, mailProblem: null, previewDoc: null,
      modes, focusInDrawer: () => {}, readReminders, proposedItemOf, reminderPairOf,
    }
    : {
      view, lit: "r-1", rowProblem: {}, previewPaper: null, reviewLockedOf: () => false,
      modes, focusInRow: () => {}, readReminders, proposedItemOf, reminderPairOf,
    };
  const startAmend = startAmendOf(screen === "desk" ? DESK : PHONE, names);
  return {
    started, names, modes,
    press: () => /** @type {Promise<unknown>} */ (screen === "desk" ? startAmend() : startAmend(suggestion)),
    /** Moves the drawer to another row, or shuts it (null). */
    moveTo: (/** @type {string | null} */ id) => { names[screen === "desk" ? "expanded" : "lit"] = id; },
  };
}

describe("review & amend waits safely for the reminder pair (#1316 r5 U2)", () => {
  describe.each([["desk"], ["phone"]])("%s", (screen) => {
    const kind = /** @type {"desk" | "phone"} */ (screen);

    it("the drawer closed while the read is pending: the late answer starts no editor", async () => {
      readMode = "gated";
      const s = await screenOf(kind);
      const pressed = s.press();
      s.moveTo(null);
      answerRead();
      await pressed;
      await settle();
      expect(s.started).toHaveLength(0);
    });

    it("a different row opened while the read is pending: the late answer starts no editor", async () => {
      readMode = "gated";
      const s = await screenOf(kind);
      const pressed = s.press();
      s.moveTo("r-2");
      answerRead();
      await pressed;
      await settle();
      expect(s.started).toHaveLength(0);
    });

    it("another item's edit begun while the read is pending: the late answer leaves that draft alone", async () => {
      readMode = "gated";
      const s = await screenOf(kind);
      const pressed = s.press();
      s.modes.id = "item-9";
      answerRead();
      await pressed;
      await settle();
      expect(s.started, "no editor started over the other item's draft").toHaveLength(0);
      expect(s.modes.id).toBe("item-9");
    });

    it("pressing twice while the read is pending starts exactly one editor, at the member's pair", async () => {
      readMode = "gated";
      const s = await screenOf(kind);
      const first = s.press();
      const second = s.press();
      answerRead();
      await Promise.all([first, second]);
      await settle();
      expect(s.started).toHaveLength(1);
      expect(s.started[0].reminderDays).toEqual(MEMBER_PAIR);
    });

    it("pressing on a suggestion already being amended does not restart the editor (typed changes are kept)", async () => {
      readMode = "pair";
      const s = await screenOf(kind);
      s.modes.id = "r-1";
      s.modes.edit = { id: "r-1" };
      await s.press();
      await settle();
      expect(s.started, "startEdit was not called again over the draft in progress").toHaveLength(0);
    });

    it("a read that never answers is bounded: within 3 s the editor starts at the default [14, 3]", async () => {
      readMode = "never";
      const s = await screenOf(kind);
      vi.useFakeTimers();
      try {
        const pressed = s.press();
        await vi.advanceTimersByTimeAsync(3000);
        expect(s.started, "the editor opened within 3 s of fake time").toHaveLength(1);
        expect(s.started[0].reminderDays).toEqual(DEFAULT_PAIR);
        await pressed;
      } finally {
        vi.useRealTimers();
      }
    });

    it("the bound is 1.5 s: a read answered after 1000 ms starts the editor at the member's pair [30, 7]", async () => {
      readMode = "slow";
      const s = await screenOf(kind);
      vi.useFakeTimers();
      try {
        const pressed = s.press();
        await vi.advanceTimersByTimeAsync(1000);
        await Promise.race([pressed, new Promise((done) => realSetTimeout(done, 500))]);
        expect(s.started).toHaveLength(1);
        expect(s.started[0].reminderDays).toEqual(MEMBER_PAIR);
      } finally {
        vi.useRealTimers();
      }
    });

    it("the bound is 1.5 s: a never-answering read has started nothing at 1400 ms and [14, 3] by 1600 ms", async () => {
      readMode = "never";
      const s = await screenOf(kind);
      vi.useFakeTimers();
      try {
        const pressed = s.press();
        await vi.advanceTimersByTimeAsync(1400);
        expect(s.started, "nothing started before the bound").toHaveLength(0);
        await vi.advanceTimersByTimeAsync(200);
        expect(s.started, "the editor started once the bound passed").toHaveLength(1);
        expect(s.started[0].reminderDays).toEqual(DEFAULT_PAIR);
        await pressed;
      } finally {
        vi.useRealTimers();
      }
    });

    it("a never-answering read's fetch is aborted after the bound", async () => {
      readMode = "never";
      const s = await screenOf(kind);
      vi.useFakeTimers();
      try {
        const pressed = s.press();
        await vi.advanceTimersByTimeAsync(1400);
        expect(readInits).toHaveLength(1);
        expect(readInits[0]?.signal, "the read carries an abort signal").toBeTruthy();
        expect(readInits[0].signal.aborted, "not aborted before the bound").toBe(false);
        await vi.advanceTimersByTimeAsync(200);
        expect(readInits[0].signal.aborted, "aborted after the bound").toBe(true);
        await pressed;
      } finally {
        vi.useRealTimers();
      }
    });

    it("an immediate answer leaves no timer pending", async () => {
      readMode = "pair";
      const s = await screenOf(kind);
      vi.useFakeTimers();
      try {
        await s.press();
        expect(s.started).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("an immediate answer still starts the editor once, at the member's pair", async () => {
      readMode = "pair";
      const s = await screenOf(kind);
      await s.press();
      expect(s.started).toHaveLength(1);
      expect(s.started[0].reminderDays).toEqual(MEMBER_PAIR);
    });

    it("a failed read still starts the editor once, at the default [14, 3]", async () => {
      readMode = "fails";
      const s = await screenOf(kind);
      await s.press();
      expect(s.started).toHaveLength(1);
      expect(s.started[0].reminderDays).toEqual(DEFAULT_PAIR);
    });
  });

  describe("desk only", () => {
    it("the suggestion disappeared from the view while the read is pending: the late answer starts no editor", async () => {
      readMode = "gated";
      const s = await screenOf("desk");
      const pressed = s.press();
      s.names.view = { ...view, suggestions: [] };
      answerRead();
      await pressed;
      await settle();
      expect(s.started).toHaveLength(0);
    });
  });

  describe("phone only", () => {
    it("the suggestion became review-locked while the read is pending: the late answer starts no editor", async () => {
      readMode = "gated";
      const s = await screenOf("phone");
      const pressed = s.press();
      s.names.reviewLockedOf = () => true;
      answerRead();
      await pressed;
      await settle();
      expect(s.started).toHaveLength(0);
    });

    it("the suggestion disappeared from the view while the read is pending: the late answer starts no editor", async () => {
      readMode = "gated";
      const s = await screenOf("phone");
      const pressed = s.press();
      s.names.view = { ...view, suggestions: [] };
      answerRead();
      await pressed;
      await settle();
      expect(s.started).toHaveLength(0);
    });
  });
});
