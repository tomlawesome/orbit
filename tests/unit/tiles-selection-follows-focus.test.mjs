// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/*
 * #1494: Tiles follows the WAI-ARIA APG radio pattern. Every arrow, Home and
 * End moves focus to a tile AND calls onpick(value) for it, never oncommit;
 * Up/Down move a row where there is one and step like Left/Right (wrapping)
 * where there is not. A press, Enter and Space (all `click` on the button)
 * call onpick then oncommit, on the checked tile too.
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
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/tiles-follows-focus-"));
  compiledTiles = join(compiledDir, "tiles.mjs");
  writeFileSync(compiledTiles, js);
});
afterAll(() => { rmSync(compiledDir, { recursive: true, force: true }); });

/** @type {(() => void) | null} */
let unmountTiles = null;
afterEach(() => { unmountTiles?.(); unmountTiles = null; document.body.innerHTML = ""; });

const CHOICES = ["a", "b", "c", "d"].map((value) => ({ value, label: value.toUpperCase(), words: value.toUpperCase() }));

/** Mounts the tiles; the host echoes onpick back into `value`, as Settings does. */
async function mountTiles(/** @type {string} */ value, /** @type {number} */ cols) {
  const { mount, unmount, flushSync } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { proxy } = await import(pathToFileURL(join(svelteSrc, "internal/client/index.js")).href);
  const { default: Tiles } = await import(/* @vite-ignore */ compiledTiles);
  /** @type {string[]} */ const picks = [];
  /** @type {string[]} */ const commits = [];
  const props = proxy({
    choices: CHOICES, value, label: "Size", cols,
    onpick: (/** @type {string} */ v) => { picks.push(v); props.value = v; },
    oncommit: (/** @type {string} */ v) => { commits.push(v); },
  });
  const component = mount(Tiles, { target: document.body, props });
  unmountTiles = () => unmount(component);
  flushSync();
  const tile = (/** @type {number} */ i) => /** @type {HTMLElement} */ (document.querySelectorAll("[role=radio]")[i]);
  return {
    picks, commits, tile,
    press(/** @type {number} */ i, /** @type {string} */ key) {
      tile(i).focus();
      tile(i).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      flushSync();
    },
    checked: () => [...document.querySelectorAll("[role=radio]")].map((el) => el.getAttribute("aria-checked") === "true"),
    focused: () => [...document.querySelectorAll("[role=radio]")].indexOf(/** @type {Element} */ (document.activeElement)),
  };
}

describe("tiles: selection follows focus (#1494)", () => {
  it("Right and Left check the tile they reach, wrapping, and call onpick only", async () => {
    const t = await mountTiles("a", 4);
    t.press(0, "ArrowRight");
    expect(t.picks).toEqual(["b"]);
    expect(t.focused()).toBe(1);
    expect(t.checked()).toEqual([false, true, false, false]);
    t.press(0, "ArrowLeft");
    expect(t.picks).toEqual(["b", "d"]);
    expect(t.focused()).toBe(3);
    expect(t.checked()).toEqual([false, false, false, true]);
    expect(t.commits).toEqual([]);
  });

  it("Home and End check the first and last tile and call onpick only", async () => {
    const t = await mountTiles("b", 4);
    t.press(1, "End");
    t.press(3, "Home");
    expect(t.picks).toEqual(["d", "a"]);
    expect(t.focused()).toBe(0);
    expect(t.commits).toEqual([]);
  });

  it("Up and Down step like Left and Right, wrapping, where there is no row that way (one row)", async () => {
    const t = await mountTiles("a", 4);
    t.press(0, "ArrowDown");
    t.press(1, "ArrowDown");
    t.press(2, "ArrowDown");
    t.press(3, "ArrowDown");
    expect(t.picks).toEqual(["b", "c", "d", "a"]);
    t.press(0, "ArrowUp");
    expect(t.picks.at(-1)).toBe("d");
    expect(t.commits).toEqual([]);
  });

  it("with two rows, Up and Down move a row where there is one and step on where there is not", async () => {
    const t = await mountTiles("a", 2);
    t.press(0, "ArrowDown");
    expect(t.picks.at(-1)).toBe("c");
    t.press(2, "ArrowDown");
    expect(t.picks.at(-1)).toBe("d");
    t.press(3, "ArrowDown");
    expect(t.picks.at(-1)).toBe("a");
    t.press(0, "ArrowUp");
    expect(t.picks.at(-1)).toBe("d");
    t.press(3, "ArrowUp");
    expect(t.picks.at(-1)).toBe("b");
    expect(t.commits).toEqual([]);
  });

  it("a press, Enter and Space (click) call onpick then oncommit, on the checked tile too", async () => {
    const t = await mountTiles("a", 4);
    t.tile(2).click();
    expect(t.picks).toEqual(["c"]);
    expect(t.commits).toEqual(["c"]);
    t.tile(2).click();
    expect(t.picks).toEqual(["c", "c"]);
    expect(t.commits).toEqual(["c", "c"]);
  });
});
