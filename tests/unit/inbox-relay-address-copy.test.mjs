import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Window } from "happy-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1658: on the Inbox empty state, clicking the relay address copies it, with
 * the phone's words ("copied · your relay address" / "not copied — your
 * browser kept the clipboard closed"). It cannot be clicked while it cannot
 * be used (no address yet); its name is "Copy your relay address, <address>"
 * and a visible "click to copy" hint sits with it. Harness as
 * inbox-screens-landed-then-reread.test.mjs.
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
  dir = mkdtempSync(path.join(tmpdir(), "orbit-inbox-copy-"));
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

const ADDRESS = "ada.k3x9@relay.example.test";

/** An empty queue, with the relay as the screen read it. */
function emptyScreen(/** @type {{ address: string, status: string }} */ relay) {
  return {
    filed: [],
    user: { id: "u1", displayName: "Ada", email: "ada@example.invalid" },
    household: null,
    households: [{ id: "h1", name: "Home", sections: [], items: [] }],
    primary: "h1",
    today: "2026-10-31",
    now: "2026-10-31T12:00:00Z",
    relay,
    retention: { receiptDays: 45 },
    lastCaught: null,
    review: [],
    reading: [],
    failed: [],
    suggestions: [],
  };
}

const FLUSH = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const settle = async () => { flushSync(); await FLUSH(); };

async function mountEmpty(/** @type {{ address: string, status: string }} */ relay) {
  /** @type {any} */ (globalThis).__readInbox = async () => emptyScreen(relay);
  /** @type {any} */ (globalThis).__dismissReceipt = async () => {};
  const target = document.body.appendChild(document.createElement("div"));
  const mounted = mount(Page, { target, props: {} });
  cleanups.push(() => unmount(mounted));
  await settle();
}

const wakes = () => /** @type {Array<[string, { failure?: boolean } | undefined]>} */ (/** @type {any} */ (globalThis).__wakes);
const text = (/** @type {Element | null | undefined} */ element) => (element?.textContent ?? "").replace(/\s+/gu, " ").trim();

/** The desk's relay bar; the phone's own layout is a different tree. */
const deskCopy = () => /** @type {HTMLButtonElement | null} */ (
  [...document.querySelectorAll('button[aria-label^="Copy your relay address"]')].find((one) => !one.closest(".pk-inbox")) ?? null
);
const said = () => text(document.body) + " | " + wakes().map(([message]) => message).join(" | ");

/** @type {import("vitest").Mock} */
let writeText;
const stubClipboard = (/** @type {boolean} */ works) => {
  writeText = vi.fn(() => (works ? Promise.resolve() : Promise.reject(new DOMException("denied", "NotAllowedError"))));
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
};

describe("#1658: the relay address on the Inbox empty state copies on a click", () => {
  it("is a named button with a visible hint, and a click copies the address", async () => {
    stubClipboard(true);
    await mountEmpty({ address: ADDRESS, status: "connected · listening" });
    expect(text(document.body), "the empty state shows the address").toContain(ADDRESS);
    const button = deskCopy();
    expect(button, "the address is a button").not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe(`Copy your relay address, ${ADDRESS}`);
    expect(text(button)).toContain(ADDRESS);
    expect(text(button)).toMatch(/click to copy/iu);
    button?.click();
    await settle();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(ADDRESS);
    expect(said()).toContain("copied · your relay address");
    expect(said()).not.toContain("not copied");
  });

  it("says so when the browser refuses the copy", async () => {
    stubClipboard(false);
    await mountEmpty({ address: ADDRESS, status: "connected · listening" });
    deskCopy()?.click();
    await settle();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(said()).toContain("not copied — your browser kept the clipboard closed");
    expect(said()).not.toContain("copied · your relay address");
  });

  it("cannot be clicked while there is no address to use", async () => {
    stubClipboard(true);
    await mountEmpty({ address: "no address yet", status: "not listening" });
    const button = deskCopy();
    expect(button, "the control is still there").not.toBeNull();
    expect(button?.disabled).toBe(true);
    button?.click();
    await settle();
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("#1670 G-W2: with no address the inbox copy button does not offer to copy", () => {
  it("the disabled button is named \"No relay address yet\", not \"Copy your relay address\"", async () => {
    await mountEmpty({ address: "no address yet", status: "not listening" });
    const button = /** @type {HTMLButtonElement | null} */ (document.querySelector(".relaybar button.copy"));
    expect(button, "the control is still there").not.toBeNull();
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-label") ?? "").not.toMatch(/copy/iu);
    expect(button?.getAttribute("aria-label")).toBe("No relay address yet");
  });
});
