import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Window } from "happy-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/*
 * #1823 W-F3: on the review card's flagged branch, "Add without it" is
 * disabled while the mail is held for an unchecked sending address (`held`),
 * as the unflagged branch's "Add to orbit" already is, and enabled when it is
 * not held. ReviewCard.svelte is compiled for the browser (as
 * inbox-screens-landed-then-reread.test.mjs does) and mounted in happy-dom.
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

/** The stand-ins, by the module the sources import ("$lib/..." from web/src/lib). */
const STUBS = {};

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

/** @type {any} */
let Card;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "orbit-review-card-"));
  mkdirSync(dir, { recursive: true });
  ({ mount, unmount, flushSync } = await nativeImport(CLIENT()));
  Card = (await nativeImport(url(load(path.join(SRC, "lib/pocket/ReviewCard.svelte"))))).default;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** @type {Array<() => void>} */
let cleanups = [];
afterEach(() => {
  for (const undo of cleanups.splice(0)) undo();
  document.body.innerHTML = "";
});

const FLAGGED_PAPER = { id: "a1", name: "invoice.pdf", drawable: false, flagged: true };
const CLEAN_PAPER = { id: "a2", name: "cover.pdf", drawable: true };

/** @param {Record<string, unknown>} props */
function render(props) {
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(Card, {
    target,
    props: { title: "Mailed renewal", caught: "caught 11 Aug", onapprove: () => {}, ondismiss: () => {}, onamend: () => {}, ...props },
  });
  cleanups.push(() => unmount(mounted));
  flushSync();
  return target;
}
/** @param {HTMLElement} root @param {RegExp} words */
const buttonSaying = (root, words) => /** @type {HTMLButtonElement | undefined} */ (
  [...root.querySelectorAll("button")].find((button) => words.test(button.textContent ?? "")));

describe("W-F3 (#1823): the flagged branch of the review card while the mail is held", () => {
  it("disables Add without it while the mail is held", () => {
    // Fails today: the flagged branch's pill ignores `held`.
    const root = render({ papers: [CLEAN_PAPER, FLAGGED_PAPER], held: "Please verify sending address" });
    const add = buttonSaying(root, /Add without it/u);
    expect(add, "the flagged branch draws Add without it").toBeDefined();
    expect(add?.disabled).toBe(true);
  });

  it("leaves Add without it enabled when the mail is not held, and Discard everything enabled either way", () => {
    const free = render({ papers: [CLEAN_PAPER, FLAGGED_PAPER], held: null });
    expect(buttonSaying(free, /Add without it/u)?.disabled).toBe(false);
    const held = render({ papers: [CLEAN_PAPER, FLAGGED_PAPER], held: "Please verify sending address" });
    expect(buttonSaying(held, /Discard everything/u)?.disabled).toBe(false);
  });

  it("guard: the unflagged branch's Add to orbit is disabled while held (as it is today)", () => {
    const root = render({ papers: [CLEAN_PAPER], held: "Please verify sending address" });
    expect(buttonSaying(root, /Add to orbit/u)?.disabled).toBe(true);
  });
});
