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
  await call(make(scope));
}

/** @type {"pair" | "fails"} */
let readMode = "pair";
beforeEach(() => {
  readMode = "pair";
  vi.stubGlobal("fetch", vi.fn(async (/** @type {string} */ url) => {
    const href = String(url);
    const json = (/** @type {unknown} */ body, status = 200) => new Response(JSON.stringify(body), { status });
    if (href.includes("/api/settings/reminders")) {
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
    view, rowProblem: {}, previewPaper: null, reviewLockedOf: () => false,
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
