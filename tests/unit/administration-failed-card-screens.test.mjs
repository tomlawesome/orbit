import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Window } from "happy-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/*
 * #1443: the desk and phone administration screens say so, with a "try again",
 * when a card's read failed (upload limit, document jobs, key rotation,
 * metadata health, recovery bundle, and the people, owners, contact, mail and
 * operations panels of #1442). A retry that comes back with the card still
 * failed must be SEEN: the row says "(tried again, still no answer)".
 *
 * What is required (mounted: the real +page.svelte, which renders the desk
 * layout and the phone's pocket.svelte side by side, CSS choosing between
 * them):
 *   - readAdminScreen() resolves (it only rejects when the workspace read
 *     fails; a card read that fails again comes back as failed.<key> true).
 *     After a "try again" press whose answer still has a failed card, that
 *     card's row says "(tried again, still no answer)", on desk and phone;
 *   - when the retry succeeds the note is gone (the row itself is gone);
 *   - a row that never failed never shows the note;
 *   - the note belongs to the cards whose own read is still failed: a press
 *     that fixes one card and leaves another failed does not stamp the note
 *     on a card that is no longer failed, and a row that failed for the
 *     first time after an ordinary successful re-read does not say "tried
 *     again" (the counter resets on a successful re-read);
 *   - every error row that has a "try again" says it, including the people,
 *     owners, contact, mail and operations rows;
 *   - a second press while a re-read is in flight is ignored (one read).
 *
 * There is no Svelte plugin in this suite, so the page and everything it
 * imports under web/src are compiled for the browser here (as
 * sign-out-provider-session.test.mjs does), copied to a temporary folder with
 * their imports rewritten, and mounted in happy-dom. The server-reading
 * module ($lib/data/workspace.js) and the parts that touch the browser
 * (Chrome, the station backdrop, the media query) are stand-ins.
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

const NOTE = "(tried again, still no answer)";
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
    export const addMember = never, commandContact = never, commandMailbox = never, commandUploadLimit = never,
      createLocalUser = never, createSystem = never, hardDeleteHousehold = never, readSignInMethods = async () => [],
      restoreHousehold = never, retryDocumentJob = never, sendSetupLink = never, setUserDisabled = never,
      startStepUp = never, testMail = async () => ({});`,
  "$lib/Chrome.svelte": `<script>let { user = null, current = "", household = null } = $props();</script>`,
  "$lib/backdrops/station.js": `export const mountStation = () => () => {};`,
  "$lib/pocket/media.js": `export const isPocket = () => false; export const pocketQuery = "(max-width: 0px)";`,
  "$lib/pocket/wake.js": `export const wake = () => {};`,
  "$app/environment": `export const dev = false; export const browser = true;`,
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
  dir = mkdtempSync(path.join(tmpdir(), "orbit-admin-card-"));
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

const FAILED_KEYS = ["relay", "services", "instance", "owners", "users", "contact", "uploadLimit", "operations", "rotation", "metadata", "recoveryBundle"];

/** A screen the way readAdminScreen answers it, the named reads failed. @param {string[]} [failed] */
function screen(failed = []) {
  const bad = (/** @type {string} */ key) => failed.includes(key);
  return {
    user: { id: "u1", displayName: "Ada Admin", email: "ada@example.invalid", isInstanceAdmin: true },
    household: null,
    primary: null,
    today: "2026-10-01",
    users: bad("users") ? null : [{ id: "u1", displayName: "Ada Admin", email: "ada@example.invalid", isInstanceAdmin: true, disabledAt: null }],
    households: [],
    peopleMeta: {},
    relay: bad("relay") ? null : [],
    services: bad("services") ? null : [],
    instance: bad("instance") ? null : "orbit",
    failed: Object.fromEntries(FAILED_KEYS.map((key) => [key, bad(key)])),
    health: null,
    now: "2026-10-01T12:00:00Z",
    operations: bad("operations") ? null : { jobs: [], counts: {} },
    recoverable: [],
    mailbox: null,
    contact: bad("contact") ? null : { name: null, email: null },
    uploadLimit: bad("uploadLimit") ? null : { maxBytes: 26214400, defaultBytes: 26214400, overrideBytes: null, minBytes: 1048576, ceilingBytes: 104857600, version: 1, updatedAt: null },
    rotation: null,
    metadata: null,
    recoveryBundle: null,
    owners: {},
  };
}

const FLUSH = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

/** The error rows of one layout whose text starts with `lead`. Desk rows are .adminproblem, phone rows .p-error. */
const rows = (/** @type {"desk" | "phone"} */ layout) =>
  /** @type {HTMLElement[]} */ ([...document.querySelectorAll(layout === "desk" ? ".adminproblem" : ".p-error")])
    .filter((row) => row.querySelector("button"));
/** @param {"desk" | "phone"} layout @param {string} lead */
const rowFor = (layout, lead) => rows(layout).find((row) => (row.textContent ?? "").trim().startsWith(lead));
/** @param {HTMLElement | undefined} row */
const press = async (row) => {
  /** @type {HTMLElement} */ (row?.querySelector("button")).click();
  flushSync();
  await FLUSH();
};

/**
 * Mount the page; the first read answers `first`, and each later read the
 * next of `later` (the last one repeats). Counts every read.
 * @param {any} first @param {any[]} later
 */
async function mountWith(first, later) {
  const answers = [first, ...later];
  const reads = { started: 0 };
  /** @type {Array<(view: any) => void>} */
  const gates = [];
  /** @type {any} */ (globalThis).__readAdminScreen = () => {
    const answer = answers[Math.min(reads.started, answers.length - 1)];
    reads.started += 1;
    if (answer === "hold") return new Promise((resolve) => gates.push(resolve));
    return Promise.resolve(answer);
  };
  const target = document.body.appendChild(document.createElement("div"));
  const mounted = mount(Page, { target, props: { data: { fixtures: false } } });
  cleanups.push(() => unmount(mounted));
  flushSync();
  await FLUSH();
  return { reads, gates };
}

/** The error rows #1443 added: [the row's own words, the failed.<key> that shows it]. */
const CARDS = [
  ["key rotation not shown", "rotation"],
  ["encrypted-details health not shown", "metadata"],
  ["recovery bundle status not shown", "recoveryBundle"],
  ["not shown — Orbit could not reach the document jobs", "operations"],
  ["not shown — Orbit could not reach the upload limit", "uploadLimit"],
];
const UPLOAD = "not shown — Orbit could not reach the upload limit";
const LAYOUTS = /** @type {const} */ (["desk", "phone"]);
/** @param {"desk" | "phone"} layout */
const noteCount = (layout) => rows(layout).filter((row) => (row.textContent ?? "").includes(NOTE)).length;

describe.each(LAYOUTS)("administration %s: a retry that is still unanswered is said", (layout) => {
  it.each(CARDS)("%s: still failed after try again shows the note", async (lead, key) => {
    await mountWith(screen([key]), [screen([key])]);
    const row = rowFor(layout, lead);
    expect(row, `${layout}: no error row for ${key}`).toBeDefined();
    expect(row?.textContent).not.toContain(NOTE);
    await press(row);
    expect(rowFor(layout, lead)?.textContent, `${layout}: ${key} still failed and the press looks like nothing happened`).toContain(NOTE);
  });

  it("every error row that has a try again says so when its own read is still failed", async () => {
    await mountWith(screen(FAILED_KEYS), [screen(FAILED_KEYS)]);
    const before = rows(layout);
    expect(before.length, `${layout}: the error rows`).toBeGreaterThanOrEqual(9);
    await press(before[0]);
    const silent = rows(layout).filter((row) => !(row.textContent ?? "").includes(NOTE)).map((row) => (row.textContent ?? "").trim().slice(0, 40));
    expect(silent, `${layout}: error rows that swallow a failed retry`).toEqual([]);
  });

  it("the retry succeeds: the note is gone", async () => {
    await mountWith(screen(["uploadLimit"]), [screen(["uploadLimit"]), screen([])]);
    await press(rowFor(layout, UPLOAD));
    expect(rowFor(layout, UPLOAD)?.textContent).toContain(NOTE);
    await press(rowFor(layout, UPLOAD));
    expect(rowFor(layout, UPLOAD)).toBeUndefined();
    expect(noteCount(layout)).toBe(0);
  });

  it("a row that never failed never shows the note", async () => {
    await mountWith(screen(["uploadLimit"]), [screen(["uploadLimit"])]);
    await press(rowFor(layout, UPLOAD));
    expect(rowFor(layout, "key rotation not shown")).toBeUndefined();
    expect(rowFor(layout, "not shown — Orbit could not reach the document jobs")).toBeUndefined();
    expect(noteCount(layout), "only the one failed card says it").toBe(1);
  });

  it("a card that is fixed by the press is not stamped, and the one still failed says it", async () => {
    await mountWith(screen(["uploadLimit", "operations"]), [screen(["uploadLimit"])]);
    await press(rowFor(layout, UPLOAD));
    expect(rowFor(layout, "not shown — Orbit could not reach the document jobs")).toBeUndefined();
    expect(rowFor(layout, UPLOAD)?.textContent).toContain(NOTE);
    expect(noteCount(layout)).toBe(1);
  });

  it("a second press while a re-read is in flight is ignored", async () => {
    const { reads, gates } = await mountWith(screen(["uploadLimit"]), ["hold"]);
    expect(reads.started).toBe(1);
    const row = rowFor(layout, UPLOAD);
    await press(row);
    expect(reads.started, "the first press starts one re-read").toBe(2);
    await press(rowFor(layout, UPLOAD) ?? row);
    expect(reads.started, `${layout}: a second press during the re-read must not start another`).toBe(2);
    gates[0](screen(["uploadLimit"]));
    await FLUSH();
    expect(rowFor(layout, UPLOAD)?.textContent).toContain(NOTE);
    /* answered: the button works again */
    await press(rowFor(layout, UPLOAD));
    expect(reads.started).toBe(3);
  });
});

describe("administration desk: the count resets on a successful ordinary re-read", () => {
  it("a later first failure on another card does not say tried again", async () => {
    /* press try again: still failed (the note shows). Then an ordinary
       re-read that succeeds (the relay test's, which re-reads the screen)
       answers with a different card failing for the first time. */
    const first = screen(["uploadLimit"]);
    const later = [screen(["uploadLimit"]), screen(["rotation"])];
    await mountWith(first, later);
    await press(rowFor("desk", UPLOAD));
    expect(rowFor("desk", UPLOAD)?.textContent).toContain(NOTE);
    const test = /** @type {HTMLButtonElement | undefined} */ ([...document.querySelectorAll("button")].find((b) => b.textContent === "test the relay"));
    expect(test, "the desk's test the relay button").toBeDefined();
    test?.click();
    flushSync();
    await FLUSH();
    const fresh = rowFor("desk", "key rotation not shown");
    expect(fresh, "the rotation row from the ordinary re-read").toBeDefined();
    expect(fresh?.textContent, "nobody pressed try again for this card").not.toContain(NOTE);
  });
});
