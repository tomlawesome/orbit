// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/*
 * The Text size tiles are a radio group with one tile in the tab order: the
 * chosen one. The settings page starts its text size at the default and only
 * learns the applied step after mount, so the tile in the tab order has to
 * follow the `value` prop when it changes from outside, not be fixed at first
 * render. Focusing a tile still makes it the tab stop.
 *
 * Tiles.svelte is compiled with Svelte's own compiler and mounted in happy-dom
 * (the shape of v19-newcomer-empty-subline.test.mjs).
 */

const web = resolve(import.meta.dirname, "../../web");
const svelteSrc = join(web, "node_modules/svelte/src");
/** @type {string} */
let compiledDir;
/** @type {string} */
let compiledTiles;

beforeAll(async () => {
  const { compile } = await import(pathToFileURL(join(svelteSrc, "compiler/index.js")).href);
  const file = join(web, "src/lib/editing/Tiles.svelte");
  const quoted = (/** @type {string} */ path) => JSON.stringify(path);
  const js = compile(readFileSync(file, "utf8"), { filename: file, generate: "client", dev: false }).js.code
    .replaceAll("'svelte/internal/client'", quoted(join(svelteSrc, "internal/client/index.js")))
    .replaceAll("'svelte/internal/disclose-version'", quoted(join(svelteSrc, "internal/disclose-version.js")))
    .replaceAll('from "svelte"', `from ${quoted(join(svelteSrc, "index-client.js"))}`);
  mkdirSync(resolve(import.meta.dirname, "../../tmp"), { recursive: true });
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/tiles-tab-stop-"));
  compiledTiles = join(compiledDir, "tiles.mjs");
  writeFileSync(compiledTiles, js);
});
afterAll(() => { rmSync(compiledDir, { recursive: true, force: true }); });

/** @type {(() => void) | null} */
let unmountTiles = null;
afterEach(() => { unmountTiles?.(); unmountTiles = null; document.body.innerHTML = ""; });

const CHOICES = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
  { value: "c", label: "C" },
  { value: "d", label: "D" },
];

/** Mounts the tiles with a reactive `value` the test can change. */
async function mountTiles(/** @type {string} */ value) {
  const { mount, unmount, flushSync } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { proxy } = await import(pathToFileURL(join(svelteSrc, "internal/client/index.js")).href);
  const { default: Tiles } = await import(/* @vite-ignore */ compiledTiles);
  const props = proxy({ choices: CHOICES, value, label: "Text size", cols: 4, onpick: () => {} });
  const component = mount(Tiles, { target: document.body, props });
  unmountTiles = () => unmount(component);
  flushSync();
  return {
    setValue(/** @type {string} */ next) { props.value = next; flushSync(); },
    flush: flushSync,
    tabStops: () => [...document.querySelectorAll("[role=radio]")]
      .map((el, i) => (el.getAttribute("tabindex") === "0" ? CHOICES[i].value : null))
      .filter(Boolean),
    tile: (/** @type {number} */ i) => /** @type {HTMLElement} */ (document.querySelectorAll("[role=radio]")[i]),
  };
}

describe("text-size tiles: the tab stop follows the chosen tile", () => {
  it("starts on the tile for the initial value", async () => {
    const tiles = await mountTiles("b");
    expect(tiles.tabStops()).toEqual(["b"]);
  });

  it("moves the tab stop to the new tile when the value prop changes from A to C", async () => {
    const tiles = await mountTiles("a");
    expect(tiles.tabStops()).toEqual(["a"]);
    tiles.setValue("c");
    expect(tiles.tabStops()).toEqual(["c"]);
    expect(tiles.tile(2).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps exactly one tab stop after several value changes", async () => {
    const tiles = await mountTiles("a");
    tiles.setValue("d");
    tiles.setValue("b");
    expect(tiles.tabStops()).toEqual(["b"]);
  });

  it("focusing a tile still makes it the tab stop", async () => {
    const tiles = await mountTiles("a");
    tiles.tile(3).dispatchEvent(new FocusEvent("focus"));
    tiles.flush();
    expect(tiles.tabStops()).toEqual(["d"]);
  });
});
