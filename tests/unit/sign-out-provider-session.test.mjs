import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Window } from "happy-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * #1316 (owner decision 9a, 2026-10-12, ships in v0.3): signing out must end
 * the IDENTITY PROVIDER's session too, not only Orbit's.
 *
 * signOut() answers the provider's own end-session URL (redirectTo) when the
 * household signs in through one. Today the page only keeps that URL on the
 * "Sign back in" anchor: the farewell moves the address to /logout with
 * history.replaceState (the page is never left, so the provider is never
 * asked), and Chrome's no-flight fallback sets location.href = "/logout". The
 * provider's single sign-on session therefore outlives the sign-out, and the
 * next "Sign back in" walks straight back in without asking anything.
 *
 * What is required:
 *   - after descendFrom(url) and the farewell beat, the window location is
 *     REPLACED (location.replace, so Back does not walk into the signed-out
 *     page) with that provider URL, not merely held by an anchor;
 *   - with a null redirectTo, there is no provider session to end: the
 *     location is not navigated and the address stays at /logout;
 *   - when the flight component cannot be had, Chrome's fallback goes to the
 *     provider URL rather than /logout (and to /logout with a null one).
 *
 * The components are .svelte files and this suite has no Svelte plugin, so
 * they are compiled for the browser here (as about-credits.test.mjs does for
 * the server), written to a temporary folder with their imports pointed at
 * small stand-ins, and mounted in happy-dom. The flight (Flight.svelte) and
 * dusk are stand-ins: the flight's farewell beat is "descend() then, a tick
 * later, onfarewell()". window.location and window.history are recording
 * fakes, since happy-dom would otherwise try to load the page it is sent to.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const web = createRequire(path.join(ROOT, "web/package.json"));
const { compile } = web("svelte/compiler");
const read = (/** @type {string} */ rel) => readFileSync(path.join(ROOT, rel), "utf8");
const url = (/** @type {string} */ file) => pathToFileURL(file).href;

/* Node's own import, not the test runner's: the compiled files and the Svelte
   runtime they share must be one set of modules, loaded the way Node loads
   them, with no transform in between. */
const nativeImport = (/** @type {string} */ specifier) => import(/* @vite-ignore */ specifier);

/* The DOM. Not the runner's happy-dom environment: that loads every import as
   browser code through the dev server, which cannot see the temporary folder
   the compiled components are written to. A happy-dom window is put on the
   globals by hand instead, and the suite stays in the node environment. */
const DOM_GLOBALS = [
  "window", "document", "Node", "Element", "HTMLElement", "SVGElement", "DocumentFragment", "Text", "Comment",
  "HTMLTemplateElement", "HTMLInputElement", "HTMLButtonElement", "HTMLAnchorElement", "Event", "CustomEvent",
  "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
  "MutationObserver", "navigator", "customElements", "NodeFilter", "Range", "ShadowRoot",
];
const win = new Window({ url: "http://orbit.invalid/home" });
for (const key of DOM_GLOBALS) {
  const value = /** @type {any} */ (win)[key];
  Object.defineProperty(globalThis, key, { value: typeof value === "function" && !/^[A-Z]/u.test(key) ? value.bind(win) : value, configurable: true, writable: true });
}
Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true, writable: true });
for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) {
  Object.defineProperty(globalThis, key, { value: /** @type {any} */ (win)[key].bind(win), configurable: true, writable: true });
}

const PROVIDER = "https://idp.invalid/end?post_logout_redirect_uri=https%3A%2F%2Forbit.invalid%2Flogout";

/** Svelte sources standing in for the parts that are not under test. */
const STUB_FLIGHT = `<script>
  let { name = "", onfarewell = () => {}, homes = [] } = $props();
  export function readyWorld() {}
  export function readyAtLeisure() { return () => {}; }
  export function ascend() {}
  export function descend() { setTimeout(() => onfarewell(), 0); }
</script>`;
const STUB_DUSK = `<script>
  let { landmark = false, gate = "" } = $props();
</script>
<div id="dusk" data-landmark={landmark}>{@html gate}</div>`;
const STUB_HATCH = `<script>
  let { open = $bindable(false) } = $props();
</script>`;
const STUB_TOP_CHROME = `<script>
  let { back = "", backLabel = "" } = $props();
</script>
<a href={back}>{backLabel}</a>`;

/** @type {string} */
let dir;
/** @type {typeof import("svelte").mount} */
let mount;
/** @type {typeof import("svelte").unmount} */
let unmount;
/** @type {any} */
let Leave;
/** @type {any} */
let Chrome;

/**
 * Compile a Svelte source for the browser and write it, its quoted import
 * specifiers pointed where `map` says.
 * @param {string} name @param {string} source @param {Record<string, string>} map
 */
function build(name, source, map) {
  const clientIndex = url(web.resolve("svelte").replace(/index-server\.js$/u, "index-client.js"));
  const all = {
    svelte: clientIndex,
    "svelte/internal/client": url(web.resolve("svelte/internal/client")),
    "svelte/internal/disclose-version": url(web.resolve("svelte/internal/disclose-version")),
    "svelte/internal/flags/legacy": url(web.resolve("svelte/internal/flags/legacy")),
    "svelte/internal/flags/async": url(web.resolve("svelte/internal/flags/async")),
    ...map,
  };
  let code = compile(source, { generate: "client", filename: `${name}.svelte` }).js.code;
  code = code.replace(/(["'])([^"'\n]+)\1/gu, (whole, quote, spec) => (spec in all ? JSON.stringify(all[spec]) : whole));
  const file = path.join(dir, `${name}.mjs`);
  writeFileSync(file, code);
  return file;
}

/** @param {string} name @param {string} code */
function plain(name, code) {
  const file = path.join(dir, name);
  writeFileSync(file, code);
  return url(file);
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "orbit-signout-"));
  ({ mount, unmount } = await nativeImport(url(web.resolve("svelte").replace(/index-server\.js$/u, "index-client.js"))));

  // Leave.svelte, over a stand-in flight and dusk.
  const flight = url(build("StubFlight", STUB_FLIGHT, {}));
  const dusk = url(build("StubDusk", STUB_DUSK, {}));
  const leaveFile = build("Leave", read("web/src/lib/flight/Leave.svelte"), {
    "./Flight.svelte": flight,
    "./Dusk.svelte": dusk,
  });
    Leave = (await nativeImport(url(leaveFile))).default;

  // Chrome.svelte, over stand-ins for everything it reaches. The flight it
  // loads on demand is one that cannot be had: that is the fallback path.
  const hatch = url(build("StubHatch", STUB_HATCH, {}));
  const topChrome = url(build("StubTopChrome", STUB_TOP_CHROME, {}));
  const chromeFile = build("Chrome", read("web/src/lib/Chrome.svelte"), {
    "$lib/format.js": plain("format.mjs", `export const initials = (n) => (n ?? "").slice(0, 2);`),
    "$app/paths": plain("paths.mjs", `export const resolve = (p) => p;`),
    "$app/state": plain("state.mjs", `export const page = { data: {} };`),
    "$lib/data/workspace.js": plain(
      "workspace.mjs",
      `export const signOut = () => globalThis.__orbitSignOut();
       export const wordsOf = (error, fallback) => fallback;`,
    ),
    "$lib/theme.js": plain("theme.mjs", `export const DEFAULT_THEME = "star-chart";`),
    "$lib/theme-swatches.js": plain("swatches.mjs", `export const SWATCHES = []; export const applyTheme = () => {};`),
    "$lib/tour/watch.js": plain("watch.mjs", `export const watchTour = async () => {};`),
    "$lib/pocket/Hatch.svelte": hatch,
    "$lib/pocket/TopChrome.svelte": topChrome,
    "$lib/flight/Leave.svelte": plain("no-flight.mjs", `throw new Error("the flight cannot be had");`),
  });
  Chrome = (await nativeImport(url(chromeFile))).default;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** @type {Array<() => void>} */
let cleanups = [];
afterEach(() => {
  for (const undo of cleanups.splice(0)) undo();
  vi.unstubAllGlobals();
  delete (/** @type {any} */ (globalThis)).__orbitSignOut;
  document.body.innerHTML = "";
});

/** A beat for timers and promise chains (the farewell lands on a timer). */
const settle = () => new Promise((done) => setTimeout(done, 60));

/**
 * Recording stand-ins for window.location and window.history, installed as
 * the globals the components read.
 */
function fakeWindow() {
  const base = "http://orbit.invalid/home";
  let href = base;
  /** @type {Array<{ how: string, to: string }>} every navigation, in order */
  const navigations = [];
  /** @type {Array<string | null>} every address history.replaceState was given */
  const addresses = [];
  /** @param {string} how @param {string | URL} to */
  const go = (how, to) => {
    href = new URL(String(to), href).href;
    navigations.push({ how, to: String(to) });
  };
  const location = {
    get href() { return href; },
    set href(to) { go("href", to); },
    replace: (/** @type {string} */ to) => go("replace", to),
    assign: (/** @type {string} */ to) => go("assign", to),
    get pathname() { return new URL(href).pathname; },
    origin: "http://orbit.invalid",
  };
  const history = {
    state: null,
    replaceState: (/** @type {unknown} */ _state, /** @type {string} */ _title, /** @type {string | null} */ address) => {
      addresses.push(address ?? null);
    },
    pushState: () => { throw new Error("a sign-out must never push a history entry"); },
  };
  vi.stubGlobal("location", location);
  vi.stubGlobal("history", history);
  return { navigations, addresses };
}

/** @param {any} Component @param {Record<string, unknown>} [props] */
function mountOnPage(Component, props = {}) {
  const target = document.body.appendChild(document.createElement("div"));
  const mounted = mount(Component, { target, props });
  cleanups.push(() => unmount(mounted));
  return /** @type {any} */ (mounted);
}

describe("#1316 9a: signing out ends the identity provider's session (Leave.svelte)", () => {
  it("replaces the window location with the provider's end-session URL once the farewell has landed", async () => {
    const win = fakeWindow();
    const leave = mountOnPage(Leave, { name: "The Household" });

    await leave.descendFrom(PROVIDER);
    await settle();

    // The farewell beat has landed (the dusk has its landmark)...
    expect(document.querySelector("#dusk")?.getAttribute("data-landmark")).toBe("true");
    // ...and the location was REPLACED with the provider's URL: not just held
    // by the "Sign back in" anchor, and not a pushed history entry.
    expect(win.navigations).toEqual([{ how: "replace", to: PROVIDER }]);
  });

  it("leaves the location alone, at /logout, when there is no provider session to end", async () => {
    const win = fakeWindow();
    const leave = mountOnPage(Leave, { name: "The Household" });

    await leave.descendFrom(null);
    await settle();

    expect(document.querySelector("#dusk")?.getAttribute("data-landmark")).toBe("true");
    expect(win.navigations).toEqual([]);
    expect(win.addresses.at(-1)).toBe("/logout");
  });
});

describe("#1316 9a: the no-flight fallback also ends the provider's session (Chrome.svelte)", () => {
  /** @param {string | null} answer */
  async function pressSignOutWithNoFlight(answer) {
    const win = fakeWindow();
    /** @type {any} */ (globalThis).__orbitSignOut = async () => answer;
    mountOnPage(Chrome, { user: { displayName: "Test Person" }, household: null, current: "settings" });
    const button = /** @type {HTMLButtonElement} */ (document.querySelector("button.signout"));
    expect(button).not.toBeNull();
    button.click();
    await settle();
    return win;
  }

  it("goes to the provider URL, rather than /logout, when the flight component cannot be had", async () => {
    const win = await pressSignOutWithNoFlight(PROVIDER);

    expect(win.navigations.at(-1)?.to).toBe(PROVIDER);
    expect(win.navigations.map((n) => n.to)).not.toContain("/logout");
  });

  it("still goes to /logout when the flight cannot be had and there is no provider session", async () => {
    const win = await pressSignOutWithNoFlight(null);

    expect(win.navigations.at(-1)?.to).toBe("/logout");
  });
});
