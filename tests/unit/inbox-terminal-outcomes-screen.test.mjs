import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Window } from "happy-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/*
 * #1652: a forward attributed to a member but with nothing to collect is
 * listed once in the review page's failed lane as "<label> · <message>", and
 * the member can remove it. Wording picked by the test author, in the shape
 * the desk row already prints:
 *   no_supported_pdf                 -> "nothing to collect · no PDF attached"
 *   message_too_large                -> "too large to collect · message over the size limit"
 *   attachment_processing_exhausted  -> "couldn’t be kept · attachment could not be processed"
 * Mounted like inbox-screens-landed-then-reread.test.mjs (same stand-ins).
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

const FAILURES = [
  { id: "f1", status: "failed", canDiscard: true, reason: "no_document", receivedAt: "2026-10-18T09:00:00Z", message: "no PDF attached", metadataStatus: null },
  { id: "f2", status: "failed", canDiscard: true, reason: "too_large", receivedAt: "2026-10-18T10:00:00Z", message: "message over the size limit", metadataStatus: null },
  { id: "f3", status: "recoverable", canDiscard: true, reason: "not_kept", receivedAt: "2026-10-18T11:00:00Z", message: "attachment could not be processed", metadataStatus: null },
];

function screen(failed) {
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
    review: [],
    reading: [],
    failed,
    suggestions: [],
  };
}

const FLUSH = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const settle = async () => { flushSync(); await FLUSH(); };

async function mountWith(first, later) {
  const answers = [first, ...later];
  const calls = { reads: 0, dismissed: [] };
  globalThis.__readInbox = async () => {
    const answer = answers[Math.min(calls.reads, answers.length - 1)];
    calls.reads += 1;
    return answer;
  };
  globalThis.__dismissReceipt = async (id) => { calls.dismissed.push(id); };
  const target = document.body.appendChild(document.createElement("div"));
  const mounted = mount(Page, { target, props: {} });
  cleanups.push(() => unmount(mounted));
  await settle();
  return calls;
}

const click = async (element) => { element.click(); await settle(); };
const entries = () => [...document.querySelectorAll(".inbox-page .failed")];
const text = (element) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("the review page lists a forward with nothing to collect (#1652)", () => {
  it.each([
    ["f1", "nothing to collect · no PDF attached"],
    ["f2", "too large to collect · message over the size limit"],
    ["f3", "couldn’t be kept · attachment could not be processed"],
  ])("shows %s once, as %s", async (id, words) => {
    await mountWith(screen(FAILURES), []);
    const matching = entries().filter((entry) => text(entry).includes(words));
    expect(matching, `entries: ${entries().map(text).join(" | ")}`).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/no longer available for review/);
  });

  it("removes the entry after two taps, sending one dismissal for that message", async () => {
    const calls = await mountWith(screen(FAILURES), [screen(FAILURES.slice(1))]);
    const first = entries().find((entry) => text(entry).includes("no PDF attached"));
    expect(first, "the no-PDF entry").toBeDefined();
    await click(first.querySelector("button"));
    expect(calls.dismissed, "the first tap only arms").toEqual([]);
    await click(entries().find((entry) => text(entry).includes("tap again to remove")).querySelector("button"));
    await FLUSH();

    expect(calls.dismissed).toEqual(["f1"]);
    expect(entries().map(text).join(" | ")).not.toContain("no PDF attached");
    expect(entries()).toHaveLength(2);
  });
});
