// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1389 (the gap #1316 left), owner decision 7a on #1316: "Review & amend" on
 * a mail suggestion creates a new item too, so its form starts the reminders
 * from the signed-in member's own Settings pair (firstWarningDays and
 * finalWarningDays, GET /api/settings/reminders), falling back to the default
 * pair (14 and 3) when the pair cannot be read or either day is null. A
 * member who changes the reminders in the sheet still sends what they chose,
 * and the approval carries the resulting reminderDays with the item.
 *
 * Shaped like create-reminders-follow-settings.test.mjs: the sheet
 * (ReviewSheet.svelte) is compiled and mounted in happy-dom, with only the
 * entry form and the sky stood in for, and the sheet's frame reduced to a
 * stand-in that draws its body. It runs over the real workspace.js and a
 * stubbed fetch, so the member's pair is stubbed at the route.
 */

/** What the stand-in EntryForm was handed: the sheet's `entry` binding. */
const entryForm = vi.hoisted(() => ({ props: /** @type {any} */ (null) }));
vi.mock("../../web/src/routes/create/EntryForm.svelte", () => ({
  default: (/** @type {unknown} */ _anchor, /** @type {any} */ props) => { entryForm.props = props; },
}));
/* The frame draws its body and nothing else (no gestures, no focus trap). */
vi.mock("../../web/src/lib/pocket/Sheet.svelte", () => ({
  default: (/** @type {any} */ anchor, /** @type {any} */ props) => { props.children?.(anchor); },
}));

/** @typedef {"pair" | "nulls" | "fails"} ReadMode */
/** What the settings route answers: the member's own pair, null days, or a failure. @type {ReadMode} */
let readMode = "pair";
const MEMBER_PAIR = [30, 7];
const DEFAULT_PAIR = [14, 3];

const household = {
  id: "hh-1", name: "Home", currency: "GBP", items: [],
  sections: [{ id: "s-home", name: "Home", accent: "a", visible: true }],
};
const workspace = { activeHouseholdId: "hh-1", households: [household] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function remindersAnswer() {
  if (readMode === "fails") return json({ error: { code: "unavailable", message: "not today" } }, 503);
  const days = readMode === "pair" ? MEMBER_PAIR : [null, null];
  return json({
    reminders: {
      emailEnabled: true,
      firstWarningDays: days[0],
      finalWarningDays: days[1],
      firstWarning: "30 days before closest approach",
      finalWarning: "7 days before",
      outboundMail: "configured",
    },
  });
}

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) return json({ user: { id: "u1" }, csrfToken: "t1" });
    if (href.includes("/api/settings/reminders") && (!init?.method || init.method === "GET")) return remindersAnswer();
    if (href.endsWith("/api/workspace") && !init?.method) return json({ workspace });
    /* The sheet holds its button to the engine's dry run: accepted whatever it is asked. */
    if (href.includes("/api/workspace/commands") && init?.method === "POST") return json({});
    return json({ error: { code: "unavailable", message: "not today" } }, 503);
  }));
}

const web = resolve(import.meta.dirname, "../../web");
const svelteSrc = join(web, "node_modules/svelte/src");
/** @type {string} */
let compiledDir;
/** @type {string} */
let compiledSheet;

beforeAll(async () => {
  const { compile } = await import(pathToFileURL(join(svelteSrc, "compiler/index.js")).href);
  const file = join(web, "src/lib/pocket/ReviewSheet.svelte");
  const quoted = (/** @type {string} */ path) => JSON.stringify(path);
  const js = compile(readFileSync(file, "utf8"), { filename: file, generate: "client", dev: false }).js.code
    .replaceAll("'svelte/internal/client'", quoted(join(svelteSrc, "internal/client/index.js")))
    .replaceAll("'svelte/internal/disclose-version'", quoted(join(svelteSrc, "internal/disclose-version.js")))
    .replaceAll('from "svelte"', `from ${quoted(join(svelteSrc, "index-client.js"))}`)
    .replaceAll('"$lib/data/dry-run.js"', quoted(join(web, "src/lib/data/dry-run.js")))
    .replaceAll('"./Sheet.svelte"', quoted(join(web, "src/lib/pocket/Sheet.svelte")))
    .replaceAll('"../../routes/create/EntryForm.svelte"', quoted(join(web, "src/routes/create/EntryForm.svelte")))
    .replaceAll('"../../routes/create/entry.js"', quoted(join(web, "src/routes/create/entry.js")));
  /* Inside the checkout (tmp/ is git-ignored), so the module resolves Svelte,
     the $lib alias and the vitest transforms the way any web/ module does. */
  mkdirSync(resolve(import.meta.dirname, "../../tmp"), { recursive: true });
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/review-amend-reminders-follow-settings-"));
  compiledSheet = join(compiledDir, "review-sheet.mjs");
  writeFileSync(compiledSheet, js);
});
afterAll(() => { rmSync(compiledDir, { recursive: true, force: true }); });

/** @type {(() => void) | null} */
let unmountSheet = null;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  readMode = "pair";
  document.body.innerHTML = "";
  stubFetch();
});
afterEach(() => {
  unmountSheet?.();
  unmountSheet = null;
  entryForm.props = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let promises and the dry run's 300 ms timer settle. */
const settle = async () => { await vi.advanceTimersByTimeAsync(400); };

/**
 * Opens Review & amend on a proposal, then approves it. `chosen` is the
 * reminders the member then sets, if they change them. Answers the reminders
 * the form started with and every item the approval sent.
 */
async function reviewAndApprove({ chosen = /** @type {number[] | null} */ (null) } = {}) {
  const { mount, unmount, flushSync } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { default: ReviewSheet } = await import(/* @vite-ignore */ compiledSheet);
  /** @type {any[]} */
  const approved = [];
  const component = mount(ReviewSheet, {
    target: document.body,
    props: {
      open: true,
      title: "Boiler cover",
      proposal: { title: "Boiler cover" },
      householdId: "hh-1",
      households: [household],
      onsave: async (/** @type {any} */ item) => { approved.push(item); return true; },
    },
  });
  unmountSheet = () => unmount(component);
  await settle(); // the sheet opens and the member's pair is read
  expect(entryForm.props, "the form is on screen").not.toBeNull();
  const startedWith = [...entryForm.props.entry.reminderDays];
  entryForm.props.entry = { ...entryForm.props.entry, name: "Boiler cover", sectionId: "s-home" };
  if (chosen) entryForm.props.entry = { ...entryForm.props.entry, reminderDays: chosen };
  flushSync();
  await settle(); // the engine's check of the filled entry
  document.querySelector("form[aria-label^='Review']")
    ?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  await settle();
  return { startedWith, approved };
}

describe("#1389: Review & amend starts its reminders from the member's own Settings pair", () => {
  it("with the member's pair stubbed as 30 and 7, the form starts at 30 and 7 and the approval carries reminderDays [30, 7]", async () => {
    readMode = "pair";
    const { startedWith, approved } = await reviewAndApprove();
    expect(startedWith).toEqual(MEMBER_PAIR);
    expect(approved).toHaveLength(1);
    expect(approved[0].reminderDays).toEqual(MEMBER_PAIR);
  });

  it("with the read failing, the form starts at the default pair [14, 3] and the approval carries it", async () => {
    readMode = "fails";
    const { startedWith, approved } = await reviewAndApprove();
    expect(startedWith).toEqual(DEFAULT_PAIR);
    expect(approved).toHaveLength(1);
    expect(approved[0].reminderDays).toEqual(DEFAULT_PAIR);
  });

  it("with the read answering nulls, the form starts at the default pair [14, 3] and the approval carries it", async () => {
    readMode = "nulls";
    const { startedWith, approved } = await reviewAndApprove();
    expect(startedWith).toEqual(DEFAULT_PAIR);
    expect(approved).toHaveLength(1);
    expect(approved[0].reminderDays).toEqual(DEFAULT_PAIR);
  });

  it("a member who changes the reminders in the sheet still sends what they chose", async () => {
    readMode = "pair";
    const { approved } = await reviewAndApprove({ chosen: [60, 1] });
    expect(approved).toHaveLength(1);
    expect(approved[0].reminderDays).toEqual([60, 1]);
  });
});
