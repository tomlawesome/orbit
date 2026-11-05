// @vitest-environment happy-dom
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Picking a theme on the home desk's account card must behave like every
 * other theme pick: the page changes, the server is told (savePreferences),
 * and the pick is counted in picksMade so a session read already in flight
 * cannot overwrite it. Otherwise the pick reverts on the next full page load.
 * The card ($lib/AccountCard.svelte, #1689) hands the pack id to home's
 * setSwatch; the data layer is stood in for, the real pick.js runs.
 */

const savePreferences = vi.fn(() => Promise.resolve());
vi.mock("$lib/data/workspace.js", async (importOriginal) => ({
  ...(await importOriginal()),
  savePreferences: (/** @type {unknown} */ change) => savePreferences(change),
}));

const { setSwatch } = await import("../../web/src/routes/home/swatches.js");
const { picksMade } = await import("../../web/src/lib/pick.js");

beforeEach(() => {
  savePreferences.mockClear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => vi.restoreAllMocks());

/*
 * The press itself: a real AccountCard, mounted, whose swatch click must reach
 * home's setSwatch and so the server (card press -> onpick -> setSwatch).
 * Home hands the card `onpick={setSwatch}` from ./swatches.js; that wiring is
 * asserted from its source below, because +page.svelte is not mountable here.
 */
const ROOT = path.resolve(import.meta.dirname, "../..");
const web = createRequire(path.join(ROOT, "web/package.json"));
const { compile } = web("svelte/compiler");
const url = (/** @type {string} */ file) => pathToFileURL(file).href;
/** @type {string} */
let dir;
/** @type {any} */
let AccountCard;
/** @type {typeof import("svelte").mount} */
let mount;
/** @type {typeof import("svelte").unmount} */
let unmount;
/** @type {any} */
let mounted;

beforeAll(async () => {
  dir = mkdtempSync(path.join(ROOT, "web", ".orbit-card-"));
  const clientIndex = web.resolve("svelte").replace(/index-server\.js$/u, "index-client.js");
  ({ mount, unmount } = await import(/* @vite-ignore */ url(clientIndex)));
  const stub = (/** @type {string} */ name, /** @type {string} */ code) => {
    const file = path.join(dir, name);
    writeFileSync(file, code);
    return url(file);
  };
  const map = /** @type {Record<string, string>} */ ({
    svelte: url(clientIndex),
    "svelte/internal/client": url(web.resolve("svelte/internal/client")),
    "svelte/internal/disclose-version": url(web.resolve("svelte/internal/disclose-version")),
    "svelte/internal/flags/legacy": url(web.resolve("svelte/internal/flags/legacy")),
    "svelte/internal/flags/async": url(web.resolve("svelte/internal/flags/async")),
    "$app/paths": stub("paths.mjs", "export const resolve = (p) => p;"),
    "$lib/theme.js": url(path.join(ROOT, "web/src/lib/theme.js")),
    "$lib/theme-swatches.js": url(path.join(ROOT, "web/src/lib/theme-swatches.js")),
  });
  let code = compile(readFileSync(path.join(ROOT, "web/src/lib/AccountCard.svelte"), "utf8"), { generate: "client", filename: "AccountCard.svelte" }).js.code;
  code = code.replace(/(["'])([^"'\n]+)\1/gu, (whole, quote, spec) => (spec in map ? JSON.stringify(map[spec]) : whole));
  const file = path.join(dir, "AccountCard.mjs");
  writeFileSync(file, code);
  AccountCard = (await import(/* @vite-ignore */ url(file))).default;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => { if (mounted) unmount(mounted); mounted = null; document.body.innerHTML = ""; });

describe("the account card on home's wiring", () => {
  it("a swatch press on the mounted card is saved to the server through setSwatch", () => {
    mounted = mount(AccountCard, {
      target: document.body,
      props: { onpick: setSwatch, onwatch() {}, signOut: { press() {}, signingOut: false, problem: "" } },
    });
    const dawn = /** @type {HTMLElement} */ (document.querySelector('#account .swatches button[title="dawn"]'));
    dawn.click();
    expect(savePreferences).toHaveBeenCalledWith({ theme: "dawn" });
    document.querySelector('#account .swatches button[title="after dark"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(savePreferences).toHaveBeenCalledWith({ theme: "afterdark" });
  });

  it("home renders the card and hands it setSwatch from ./swatches.js", () => {
    const page = readFileSync(path.join(ROOT, "web/src/routes/home/+page.svelte"), "utf8");
    expect(page).toMatch(/import \{ setSwatch \} from "\.\/swatches\.js";/u);
    expect(page).toMatch(/<AccountCard\b[\s\S]*?onpick=\{setSwatch\}/u);
  });
});

describe("home desk theme swatches", () => {
  it("saves the picked theme to the server", () => {
    setSwatch("dawn");
    expect(savePreferences).toHaveBeenCalledTimes(1);
    expect(savePreferences).toHaveBeenCalledWith({ theme: "dawn" });
  });

  it("saves the pack id for a two-word swatch title", () => {
    setSwatch("afterdark");
    expect(savePreferences).toHaveBeenCalledWith({ theme: "afterdark" });
  });

  it("counts the pick so an in-flight session read cannot overwrite it", () => {
    const before = picksMade();
    setSwatch("clouds");
    expect(picksMade()).toBe(before + 1);
  });

  it("still changes the page theme at once", () => {
    setSwatch("dawn");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dawn");
  });
});
