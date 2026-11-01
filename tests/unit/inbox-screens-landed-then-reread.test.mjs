import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Window } from "happy-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/*
 * #1584 (web-inbox-3): a failed message that was removed is never read back
 * as "not removed" when only the read of the inbox after it failed, and the
 * desk's failed entry says what happened to it.
 *
 * What is required (mounted: the real inbox/+page.svelte, which renders the
 * desk's lanes and the phone's pocket.svelte side by side, CSS choosing
 * between them):
 *   - phone: a remove whose command landed and whose re-read of the inbox
 *     failed wakes the done-but-unread line ("done — ... reload ...") once,
 *     as a plain wake (not a failure), and never "not removed". The command
 *     is sent once;
 *   - phone, guard: a remove whose command is refused wakes
 *     "not removed — <words>" as a failure, and reads nothing again;
 *   - desk: the same landed-then-unread remove puts the done line on the
 *     failed entry itself (a `.mail-problem` inside it), the entry stays on
 *     screen (nothing was re-read), and nothing is woken;
 *   - desk: a refused remove says its words on the failed entry, where the
 *     desk drew nothing before;
 *   - desk, guard: the review group's own line stays under the review
 *     receipt it belongs to, never under the failed entry, and a remove that
 *     lands and reads leaves no line anywhere.
 *
 * There is no Svelte plugin in this suite, so the page and everything it
 * imports under web/src are compiled for the browser here (as
 * administration-failed-card-screens.test.mjs does), copied to a temporary
 * folder with their imports rewritten, and mounted in happy-dom. The
 * server-reading module ($lib/data/workspace.js) and the parts that touch the
 * browser (Chrome, the sky, the wake, motion, the sheets) are stand-ins.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const web = createRequire(path.join(ROOT, "web/package.json"));
const { compile } = web("svelte/compiler");
const url = (/** @type {string} */ file) => pathToFileURL(file).href;
const nativeImport = (/** @type {string} */ specifier) => import(/* @vite-ignore */ specifier);

const DOM_GLOBALS = [
  "window", "document", "Node", "Element", "HTMLElement", "SVGElement", "DocumentFragment", "Text", "Comment",
  "HTMLTemplateElement", "HTMLInputElement", "HTMLButtonElement", "HTMLAnchorElement", "Event", "CustomEvent",
  "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
  "MutationObserver", "navigator", "location", "history", "sessionStorage", "localStorage", "customElements", "NodeFilter", "Range", "ShadowRoot",
  "matchMedia", "ResizeObserver", "IntersectionObserver", "PointerEvent", "FocusEvent", "AbortController",
];
const win = new Window({ url: "http://orbit.invalid/inbox" });
for (const key of Object.getOwnPropertyNames(win)) if (/^(HTML|SVG)\w*Element$/u.test(key)) DOM_GLOBALS.push(key);
for (const key of DOM_GLOBALS) {
  const value = /** @type {any} */ (win)[key];
  if (value === undefined) continue;
  Object.defineProperty(globalThis, key, { value: typeof value === "function" && !/^[A-Z]/u.test(key) ? value.bind(win) : value, configurable: true, writable: true });
}
Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true, writable: true });
for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) {
  Object.defineProperty(globalThis, key, { value: /** @type {any} */ (win)[key].bind(win), configurable: true, writable: true });
}

const DONE = /^done —.*reload/i;
const SRC = path.join(ROOT, "web/src");

/** @type {string} */
let dir;
/** @type {typeof import("svelte").mount} */
let mount;
/** @type {typeof import("svelte").flushSync} */
let flushSync;
/** @type {typeof import("svelte").unmount} */
let unmount;
/** @type {any} */
let Page;

/** The stand-ins, by the module the sources import ("$lib/..." from web/src/lib). */
const STUBS = {
  "$lib/data/workspace.js": `
    export const readInboxScreen = () => globalThis.__readInbox();
    export const dismissReceipt = (id) => globalThis.__dismissReceipt(id);
    export const approveWithOperation = () => { throw new Error("not under test"); };
    export const wordsOf = (error, fallback) => (error instanceof Error ? error.message : fallback);`,
  "$lib/Chrome.svelte": `<script>let { user = null, current = "", household = null } = $props();</script>`,
  "$lib/sky.js": `export const fillStarTiles = () => {}; export const seededRng = () => () => 0.5; export const TILED_LAYERS = []; export const TILED_SEED = 1;`,
  "$lib/motion.js": `export const prefersReducedMotion = () => true; export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";`,
  "$lib/pocket/wake.js": `export const wake = (...args) => { globalThis.__wakes.push(args); };`,
  "$lib/pocket/ReviewSheet.svelte": `<script>let { open = $bindable(false) } = $props();</script>`,
  "$lib/pocket/Sheet.svelte": `<script>let { open = $bindable(false) } = $props();</script>`,
  "$lib/pocket/StagedPage.svelte": `<script>let { href = "" } = $props();</script>`,
  "$lib/pocket/Sky.svelte": `<script></script>`,
  "$app/paths": `export const resolve = (p) => p;`,
};

/** @type {Map<string, string>} source file -> compiled copy */
const built = new Map();
/** @param {string} spec @param {string} from */
function resolveSource(spec, from) {
  if (spec.startsWith("$lib/")) return path.join(SRC, "lib", spec.slice(5));
  return path.resolve(path.dirname(from), spec);
}
/** The stand-in's name for a source the stubs replace, whichever way it was imported. @param {string} resolved */
function stubNameOf(resolved) {
  const name = "$lib/" + path.relative(path.join(SRC, "lib"), resolved).split(path.sep).join("/");
  return name in STUBS ? name : null;
}
const CLIENT = () => url(web.resolve("svelte").replace(/index-server\.js$/u, "index-client.js"));
const SVELTE_SRC = () => path.dirname(web.resolve("svelte"));
const RUNTIME = () => ({
  svelte: CLIENT(),
  "svelte/internal/client": url(web.resolve("svelte/internal/client")),
  "svelte/internal/disclose-version": url(web.resolve("svelte/internal/disclose-version")),
  "svelte/internal/flags/legacy": url(web.resolve("svelte/internal/flags/legacy")),
  "svelte/internal/flags/async": url(web.resolve("svelte/internal/flags/async")),
  /* the browser build: the server build's SvelteMap is not reactive */
  "svelte/reactivity": url(path.join(SVELTE_SRC(), "reactivity/index-client.js")),
  "svelte/animate": url(web.resolve("svelte/animate")),
  "svelte/easing": url(web.resolve("svelte/easing")),
  "svelte/transition": url(web.resolve("svelte/transition")),
});

/** Copy (compiling .svelte) a source file and, recursively, what it imports. @param {string} file */
function load(file) {
  const known = built.get(file);
  if (known) return known;
  const out = path.join(dir, String(built.size) + "-" + path.basename(file).replace(/\.svelte$/u, "") + ".mjs");
  built.set(file, out);
  let code = readFileSync(file, "utf8");
  if (file.endsWith(".svelte")) code = compile(code, { generate: "client", filename: file }).js.code;
  const runtime = /** @type {Record<string, string>} */ (RUNTIME());
  code = code.replace(/((?:from|import)\s*\(?\s*)(["'])([^"'\n]+)\2/gu, (whole, lead, quote, spec) => {
    if (spec in runtime) return `${lead}${quote}${runtime[spec]}${quote}`;
    if (spec.endsWith(".css")) return `${lead}${quote}${url(stub("css"))}${quote}`;
    if (spec in STUBS) return `${lead}${quote}${url(stub(spec))}${quote}`;
    if (spec.startsWith("$lib/") || spec.startsWith(".")) {
      const resolved = resolveSource(spec, file);
      const stubbed = stubNameOf(resolved);
      if (stubbed) return `${lead}${quote}${url(stub(stubbed))}${quote}`;
      return `${lead}${quote}${url(load(resolved))}${quote}`;
    }
    return whole;
  });
  writeFileSync(out, code);
  return out;
}
/** @param {string} spec */
function stub(spec) {
  const out = path.join(dir, "stub-" + spec.replace(/[^a-z]+/giu, "-") + (spec.endsWith(".svelte") ? ".svelte.mjs" : ".mjs"));
  const body = /** @type {Record<string, string>} */ (STUBS)[spec] ?? "export {};";
  if (spec.endsWith(".svelte")) {
    writeFileSync(out, compile(body, { generate: "client", filename: "stub.svelte" }).js.code.replace(/(["'])(svelte[^"'\n]*)\1/gu, (w, q, s) => (/** @type {any} */ (RUNTIME())[s] ? JSON.stringify(/** @type {any} */ (RUNTIME())[s]) : w)));
  } else writeFileSync(out, body);
  return out;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "orbit-inbox-landed-"));
  mkdirSync(dir, { recursive: true });
  ({ mount, unmount, flushSync } = await nativeImport(CLIENT()));
  Page = (await nativeImport(url(load(path.join(SRC, "routes/inbox/+page.svelte"))))).default;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** @type {Array<() => void>} */
let cleanups = [];
beforeEach(() => {
  /** @type {any} */ (globalThis).__wakes = [];
});
afterEach(() => {
  for (const undo of cleanups.splice(0)) undo();
  for (const hook of ["__readInbox", "__dismissReceipt", "__wakes"]) delete (/** @type {any} */ (globalThis))[hook];
  document.body.innerHTML = "";
});

const REVIEW = {
  id: "r1", status: "pending_review", classification: "ready", canApprove: true, canDiscard: true, householdId: "h1",
  receivedAt: "2026-10-20T09:00:00Z", expiresAt: "2026-12-01T00:00:00Z", attachmentCount: 0, attachments: [],
  message: "Ready for your review.",
  proposal: { title: "Mailed renewal", provider: "Synthetic Cover", costMinor: 9900, currency: "GBP", dueDate: "2031-03-01", scheduleKind: "renewal", kind: "renewal", recurrenceMonths: 12 },
  fieldEvidence: {},
};
const FAILURE = {
  id: "f1", status: "failed", canDiscard: true, reason: "no_document", receivedAt: "2026-10-18T09:00:00Z",
  message: "It carried no document Orbit can read. Nothing was kept.", metadataStatus: null,
};

/** The screen the way readInboxScreen answers it. @param {{ review?: any[], failed?: any[] }} [lanes] */
function screen({ review = [REVIEW], failed = [FAILURE] } = {}) {
  return {
    filed: [],
    user: { id: "u1", displayName: "Ada", email: "ada@example.invalid" },
    household: null,
    households: [{ id: "h1", name: "Home", sections: [], items: [] }],
    primary: "h1",
    today: "2026-10-31",
    now: "2026-10-31T12:00:00Z",
    relay: { address: "orbit@example.invalid", status: "listening" },
    retention: { receiptDays: 45 },
    lastCaught: null,
    review,
    reading: [],
    failed,
    suggestions: review.map((receipt) => ({ id: receipt.id, receiptId: receipt.id, title: receipt.proposal?.title })),
  };
}

const FLUSH = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const settle = async () => { flushSync(); await FLUSH(); };

/**
 * Mount the page. The first read answers `first`; each later read the next of
 * `later` (the last repeats); an Error is a rejection. `dismiss` answers every
 * dismissReceipt: undefined resolves, an Error rejects.
 * @param {any} first @param {any[]} later @param {Error | undefined} [dismiss]
 */
async function mountWith(first, later, dismiss = undefined) {
  const answers = [first, ...later];
  const calls = { reads: 0, dismissed: /** @type {string[]} */ ([]) };
  /** @type {any} */ (globalThis).__readInbox = async () => {
    const answer = answers[Math.min(calls.reads, answers.length - 1)];
    calls.reads += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  /** @type {any} */ (globalThis).__dismissReceipt = async (/** @type {string} */ id) => {
    calls.dismissed.push(id);
    if (dismiss) throw dismiss;
  };
  const target = document.body.appendChild(document.createElement("div"));
  const mounted = mount(Page, { target, props: {} });
  cleanups.push(() => unmount(mounted));
  await settle();
  return calls;
}

const wakes = () => /** @type {Array<[string, { failure?: boolean } | undefined]>} */ (/** @type {any} */ (globalThis).__wakes);
const click = async (/** @type {Element | null | undefined} */ element) => {
  /** @type {HTMLElement} */ (element).click();
  await settle();
};

/** The desk's failed entry and its act. */
const deskEntry = () => /** @type {HTMLElement | null} */ (document.querySelector(".inbox-page .failed"));
const deskRemove = () => deskEntry()?.querySelector("button");
const deskLine = () => deskEntry()?.querySelector(".mail-problem") ?? null;

/** The phone's failed row, opened by a tap on its face; its remove pill (armed once pressed). */
const phoneRow = () => document.querySelector('.pk-inbox [data-row-key="f1"]');
async function openPhoneRow() {
  await click(phoneRow()?.querySelector("[data-row-face]"));
  expect(phoneRow()?.querySelector('button[aria-label^="Remove the message from"]'), "the phone's remove pill").not.toBeNull();
}
const phonePill = () => /** @type {HTMLElement | null} */ (phoneRow()?.querySelector("button.arm") ?? null);

const READ_FAILS = new Error("the inbox would not load");

describe("phone: removing a failed message", () => {
  it("lands, then the re-read fails: woken as done (plain), never as not removed", async () => {
    const calls = await mountWith(screen(), [READ_FAILS]);
    await openPhoneRow();
    await click(phonePill());
    await click(phonePill());
    await FLUSH();

    expect(calls.dismissed, "the command is sent once, for this message").toEqual(["f1"]);
    expect(wakes().length, `wakes: ${JSON.stringify(wakes())}`).toBe(1);
    const [words, options] = wakes()[0];
    expect(words).toMatch(DONE);
    expect(options?.failure ?? false, "the message was removed: this is not a failure").toBe(false);
    expect(wakes().map(([one]) => one).join("\n")).not.toMatch(/not removed/);
  });

  it("guard: a refused remove wakes not removed as a failure and reads nothing again (passes today)", async () => {
    const calls = await mountWith(screen(), [screen()], new Error("offline"));
    await openPhoneRow();
    await click(phonePill());
    await click(phonePill());
    await FLUSH();

    expect(calls.dismissed).toEqual(["f1"]);
    expect(wakes().length).toBe(1);
    expect(wakes()[0][0]).toBe("not removed — offline");
    expect(wakes()[0][1]?.failure).toBe(true);
    expect(calls.reads, "no read after a refusal").toBe(1);
  });
});

describe("desk: removing a failed message", () => {
  it("lands, then the re-read fails: the entry says done, stays on screen, and nothing is woken", async () => {
    const calls = await mountWith(screen(), [READ_FAILS]);
    expect(deskRemove()?.textContent?.trim()).toBe("remove");
    await click(deskRemove());
    expect(deskRemove()?.textContent?.trim()).toBe("tap again to remove");
    expect(calls.dismissed, "the first tap only arms").toEqual([]);
    await click(deskRemove());
    await FLUSH();

    expect(calls.dismissed).toEqual(["f1"]);
    expect(deskEntry(), "the entry stays: nothing was re-read").not.toBeNull();
    expect(deskLine(), "a line inside the failed entry").not.toBeNull();
    expect(deskLine()?.textContent?.trim()).toMatch(DONE);
    expect(wakes(), "the desk wakes nothing").toEqual([]);
  });

  it("a refused remove says its words on the entry", async () => {
    const calls = await mountWith(screen(), [screen()], new Error("offline"));
    await click(deskRemove());
    await click(deskRemove());
    await FLUSH();

    expect(calls.dismissed).toEqual(["f1"]);
    expect(deskEntry()).not.toBeNull();
    expect(deskLine()?.textContent?.trim()).toBe("offline");
  });

  it("guard: a refused dismiss of the review receipt is said under that receipt, not under the failed entry (passes today)", async () => {
    await mountWith(screen(), [screen()], new Error("offline"));
    const receipt = document.querySelector(".inbox-page .receipt");
    const dismiss = [...(receipt?.querySelectorAll(".actions button") ?? [])].find((one) => one.textContent?.trim() === "Dismiss");
    expect(dismiss, "the review receipt's Dismiss").toBeDefined();
    await click(dismiss);
    await click([...(receipt?.querySelectorAll(".actions button") ?? [])].find((one) => /tap again to dismiss/.test(one.textContent ?? "")));
    await FLUSH();

    expect(receipt?.querySelector(".mail-problem")?.textContent?.trim()).toBe("offline");
    expect(deskLine(), "nothing under the failed entry").toBeNull();
  });

  it("guard: a remove that lands and reads leaves no line anywhere (passes today)", async () => {
    await mountWith(screen(), [screen({ failed: [] })]);
    await click(deskRemove());
    await click(deskRemove());
    await FLUSH();

    expect(deskEntry(), "the entry went with the re-read").toBeNull();
    expect(document.querySelectorAll(".mail-problem").length).toBe(0);
  });
});
