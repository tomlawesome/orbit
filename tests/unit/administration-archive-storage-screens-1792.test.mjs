import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Window } from "happy-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";


/*
 * #1792 (spec-security-fixes.md 2.4, L16), mounted: the real +page.svelte
 * (desk layout and the phone's pocket.svelte side by side) with the new
 * "Exports kept" card: how long an export is kept, how many per system, and
 * the space for them all.
 *
 *   - desk: `#archive-storage-card` shows the three values and who set them
 *     ("the defaults", or "an administrator · defaults 6 h · 2 · 10 GB");
 *   - a failed read shows the `not shown` block with a retry;
 *   - phone: `#ad-archives` holds one row, meta "6 h · 2 per system · 10 GB",
 *     which opens the "Exports kept" sheet;
 *   - "use the defaults" sends `{ action: "default" }` with the version read.
 *
 * Same harness as administration-mail-settings-screens.test.mjs; the phone's
 * sheet stand-in renders its content only while open.
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
];
const win = new Window({ url: "http://orbit.invalid/administration" });
for (const key of Object.getOwnPropertyNames(win)) if (/^(HTML|SVG)\w*Element$/u.test(key)) DOM_GLOBALS.push(key);
for (const key of DOM_GLOBALS) {
  const value = /** @type {any} */ (win)[key];
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

/** The stand-ins, by the specifier the sources import. */
const STUBS = {
  "$lib/data/workspace.js": `
    export const readAdminScreen = () => globalThis.__readAdminScreen();
    export const wordsOf = (error, fallback) => fallback;
    const never = () => { throw new Error("not under test"); };
    export const addMember = never, commandContact = never, commandMailbox = never, commandMailLimit = never, commandSending = never,
      commandUploadLimit = never, createLocalUser = never, createSystem = never, hardDeleteHousehold = never,
      readSignInMethods = async () => [], restoreHousehold = never, retryDocumentJob = never, sendSetupLink = never,
      setUserDisabled = never, startStepUp = never, testMail = async () => ({}), postAdminJson = never, readAdminJson = never,
      fetchArchiveStorageSettings = never;
    export const commandArchiveStorage = (command) => globalThis.__commandArchiveStorage(command);`,
  /* Renders its content only while open, so a test can see the sheet open. */
  "$lib/pocket/Sheet.svelte": `<script>let { open = $bindable(false), title = "", children, foot } = $props();</script>
    {#if open}<section data-sheet={title}>{@render children?.()}{@render foot?.()}</section>{/if}`,
  "$lib/Chrome.svelte": `<script>let { user = null, current = "", household = null } = $props();</script>`,
  "$lib/backdrops/station.js": `export const mountStation = () => () => {};`,
  "$lib/pocket/media.js": `export const isPocket = () => false; export const pocketQuery = "(max-width: 0px)";`,
  "$lib/pocket/wake.js": `export const wake = () => {};`,
  "$app/env": `export const dev = false; export const browser = true;`,
  "$app/navigation": `export const beforeNavigate = () => {}; export const goto = async () => {}; export const pushState = () => {}; export const replaceState = () => {};`,
  "$app/state": `export const page = { data: {}, state: {}, url: new URL("http://orbit.invalid/administration") };`,
  "$app/paths": `export const resolve = (p) => p;`,
};

/** @type {Map<string, string>} source file -> compiled copy */
const built = new Map();
/** @param {string} spec @param {string} from */
function resolveSource(spec, from) {
  if (spec.startsWith("$lib/")) return path.join(SRC, "lib", spec.slice(5));
  return path.resolve(path.dirname(from), spec);
}
const CLIENT = () => url(web.resolve("svelte").replace(/index-server\.js$/u, "index-client.js"));
const RUNTIME = () => ({
  svelte: CLIENT(),
  "svelte/internal/client": url(web.resolve("svelte/internal/client")),
  "svelte/internal/disclose-version": url(web.resolve("svelte/internal/disclose-version")),
  "svelte/internal/flags/legacy": url(web.resolve("svelte/internal/flags/legacy")),
  "svelte/internal/flags/async": url(web.resolve("svelte/internal/flags/async")),
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
    if (spec in STUBS) return `${lead}${quote}${url(stub(spec))}${quote}`;
    if (spec.endsWith(".css")) return `${lead}${quote}${url(stub("css"))}${quote}`;
    if (spec.startsWith("$lib/") || spec.startsWith(".")) return `${lead}${quote}${url(load(resolveSource(spec, file)))}${quote}`;
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
  dir = mkdtempSync(path.join(tmpdir(), "orbit-admin-archives-"));
  mkdirSync(dir, { recursive: true });
  ({ mount, unmount, flushSync } = await nativeImport(CLIENT()));
  Page = (await nativeImport(url(load(path.join(SRC, "routes/administration/+page.svelte"))))).default;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** @type {Array<() => void>} */
let cleanups = [];
afterEach(() => {
  for (const undo of cleanups.splice(0)) undo();
  delete (/** @type {any} */ (globalThis)).__readAdminScreen;
  document.body.innerHTML = "";
});

afterEach(() => { delete (/** @type {any} */ (globalThis)).__commandArchiveStorage; });

const FLUSH = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const FAILED_KEYS = ["relay", "services", "instance", "owners", "users", "contact", "uploadLimit", "mailLimit", "sending", "operations", "rotation", "metadata", "recoveryBundle", "archiveStorage"];
const GIB = 1_073_741_824;

/** The settings as /api/admin/archive-storage answers them: the defaults unless `overrides` says otherwise. @param {Record<string, number | null>} [overrides] */
function archiveStorage(overrides = {}) {
  const defaults = { retentionHours: 6, keepPerHousehold: 2, maxTotalBytes: 10 * GIB };
  const set = { retentionHours: null, keepPerHousehold: null, maxTotalBytes: null, ...overrides };
  return {
    retentionHours: set.retentionHours ?? defaults.retentionHours,
    keepPerHousehold: set.keepPerHousehold ?? defaults.keepPerHousehold,
    maxTotalBytes: set.maxTotalBytes ?? defaults.maxTotalBytes,
    defaults,
    overrides: set,
    bounds: { retentionHours: [1, 720], keepPerHousehold: [1, 10], maxTotalGigabytes: [1, 102_400] },
    version: 4,
    updatedAt: null,
  };
}

/** @param {{ archives?: any, failed?: boolean }} [options] */
function screen({ archives = archiveStorage(), failed = false } = {}) {
  return {
    user: { id: "u1", displayName: "Ada Admin", email: "ada@example.invalid", isInstanceAdmin: true },
    household: null, primary: null, today: "2026-10-01",
    users: [{ id: "u1", displayName: "Ada Admin", email: "ada@example.invalid", isInstanceAdmin: true, disabledAt: null }],
    households: [], peopleMeta: {}, relay: [], services: [], instance: "orbit",
    failed: { ...Object.fromEntries(FAILED_KEYS.map((key) => [key, false])), archiveStorage: failed },
    health: null, now: "2026-10-01T12:00:00Z", operations: { jobs: [], counts: {} }, recoverable: [],
    mailbox: null, sending: null, contact: { name: null, email: null },
    uploadLimit: { maxBytes: 26214400, defaultBytes: 26214400, overrideBytes: null, minBytes: 1048576, ceilingBytes: 104857600, version: 1, updatedAt: null },
    mailLimit: null,
    archiveStorage: failed ? null : archives,
    rotation: null, metadata: null, recoveryBundle: null, owners: {},
  };
}

/** @param {any} view @param {any} [after] what the screen reads once a command has landed @returns {Promise<any[]>} the commands sent */
async function mountWith(view, after = view) {
  /** @type {any[]} */
  const sent = [];
  let reads = 0;
  /** @type {any} */ (globalThis).__readAdminScreen = () => Promise.resolve(reads++ === 0 ? view : after);
  /** @type {any} */ (globalThis).__commandArchiveStorage = async (/** @type {any} */ command) => { sent.push(command); return { archiveStorage: after.archiveStorage }; };
  const target = document.body.appendChild(document.createElement("div"));
  const mounted = mount(Page, { target, props: { data: { fixtures: false } } });
  cleanups.push(() => unmount(mounted));
  flushSync();
  await FLUSH();
  return sent;
}

const text = (/** @type {Element | null} */ node) => (node?.textContent ?? "").replace(/\s+/gu, " ").trim();
const deskCard = () => document.getElementById("archive-storage-card");
const pocketCard = () => document.getElementById("ad-archives");
const sheet = () => document.querySelector('[data-sheet="Exports kept"]');
/** @param {ParentNode | null} root @param {RegExp} name */
const buttonIn = (root, name) => /** @type {HTMLButtonElement | undefined} */ ([...(root?.querySelectorAll("button") ?? [])].find((b) => name.test(text(b))));
async function click(/** @type {HTMLElement | undefined} */ button) {
  expect(button, "the button is there").toBeDefined();
  button?.click();
  flushSync();
  await FLUSH();
}

describe("administration desk: the Exports kept card (#1792)", () => {
  it("shows the three values and that they are the defaults", async () => {
    await mountWith(screen());
    const card = deskCard();
    expect(card, "#archive-storage-card").not.toBeNull();
    const words = text(card);
    expect(words).toMatch(/Exports kept/u);
    expect(words).toMatch(/kept for\s*6 hours/u);
    expect(words).toMatch(/kept per system\s*2/u);
    expect(words).toMatch(/space for them all\s*10 GB/u);
    expect(words).toMatch(/set by\s*the defaults/u);
    expect(buttonIn(card, /^use the defaults/u), "no way back to the defaults when they are in force").toBeUndefined();
  });

  it("sits directly under the Upload size limit card", async () => {
    await mountWith(screen());
    expect(document.getElementById("upload-limit-card")?.nextElementSibling?.id).toBe("archive-storage-card");
  });

  it("after a set, says an administrator set them and what the defaults are", async () => {
    const changed = archiveStorage({ retentionHours: 2, keepPerHousehold: 3 });
    const sent = await mountWith(screen(), screen({ archives: changed }));
    await click(buttonIn(deskCard(), /^change…$/u));
    const form = deskCard()?.querySelector("form");
    expect(form, "the editor").not.toBeNull();
    const labels = text(form);
    expect(labels).toMatch(/kept for, in hours/u);
    expect(labels).toMatch(/exports kept per system/u);
    expect(labels).toMatch(/space for all exports, in GB/u);
    expect(labels).toMatch(/A shorter time applies to exports already written/u);
    const inputs = /** @type {HTMLInputElement[]} */ ([...(form?.querySelectorAll("input[type=number]") ?? [])]);
    expect(inputs.map((input) => [input.min, input.max])).toEqual([["1", "720"], ["1", "10"], ["1", "102400"]]);
    for (const [input, value] of /** @type {const} */ ([[inputs[0], "2"], [inputs[1], "3"]])) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    flushSync();
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    flushSync();
    await FLUSH();
    expect(sent).toEqual([{ action: "set", expectedVersion: 4, retentionHours: 2, keepPerHousehold: 3, maxTotalGigabytes: 10 }]);
    expect(text(deskCard())).toMatch(/set by\s*an administrator · defaults 6 h · 2 · 10 GB/u);
    expect(text(deskCard())).toMatch(/kept for\s*2 hours/u);
  });

  it("use the defaults sends { action: \"default\" } with the version it read", async () => {
    const sent = await mountWith(screen({ archives: archiveStorage({ retentionHours: 2 }) }), screen());
    expect(text(deskCard())).toMatch(/set by\s*an administrator · defaults 6 h · 2 · 10 GB/u);
    await click(buttonIn(deskCard(), /^change…$/u));
    await click(buttonIn(deskCard(), /^use the defaults/u));
    expect(sent).toEqual([{ action: "default", expectedVersion: 4 }]);
  });

  it("a failed read shows the not-shown block with a retry", async () => {
    await mountWith(screen({ failed: true }));
    const card = deskCard();
    expect(card, "#archive-storage-card still drawn, to say so").not.toBeNull();
    expect(text(card)).toMatch(/not shown — Orbit could not reach the export settings/u);
    expect(buttonIn(card, /^try again$/u), "a retry").toBeDefined();
  });
});

describe("administration phone: the Exports kept row (#1792)", () => {
  it("shows one row, 6 h · 2 per system · 10 GB, that opens the Exports kept sheet", async () => {
    await mountWith(screen());
    const card = pocketCard();
    expect(card, "#ad-archives").not.toBeNull();
    expect(text(card)).toMatch(/Exports kept/u);
    expect(text(card)).toMatch(/6 h · 2 per system · 10 GB/u);
    expect(document.getElementById("ad-uploads")?.compareDocumentPosition(/** @type {Node} */ (card)) ?? 0, "after ad-uploads")
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(sheet(), "the sheet is closed until asked").toBeNull();
    await click(buttonIn(card, /Exports kept|change/u));
    expect(sheet(), "the Exports kept sheet").not.toBeNull();
    expect(sheet()?.querySelectorAll("input[type=number]")).toHaveLength(3);
  });

  it("use the defaults in the sheet sends { action: \"default\" }", async () => {
    const sent = await mountWith(screen({ archives: archiveStorage({ keepPerHousehold: 5 }) }), screen());
    await click(buttonIn(pocketCard(), /Exports kept|change/u));
    await click(buttonIn(sheet(), /^use the defaults?$/u));
    expect(sent).toEqual([{ action: "default", expectedVersion: 4 }]);
  });

  it("a failed read shows the not-shown block with a retry", async () => {
    await mountWith(screen({ failed: true }));
    const card = pocketCard();
    expect(card, "#ad-archives still drawn, to say so").not.toBeNull();
    expect(text(card)).toMatch(/not shown — Orbit could not reach the export settings/u);
    expect(buttonIn(card, /^try again$/u)).toBeDefined();
  });
});
