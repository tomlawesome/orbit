// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/*
 * #1930: RepeatBand follows the WAI-ARIA APG radio pattern, as Tiles does
 * (#1494). Every arrow, Home and End moves focus to a cell, checks it and calls
 * onpick(value) for it, never oncommit; arrows wrap. A press, Enter and Space
 * (all `click` on the button) call onpick then the new optional oncommit. The
 * foot line reads the cell the arrows landed on.
 */
const web = resolve(import.meta.dirname, "../../web");
const svelteSrc = join(web, "node_modules/svelte/src");
/** @type {string} */
let compiledDir;
/** @type {string} */
let compiledBand;

beforeAll(async () => {
  const { compile } = await import(pathToFileURL(join(svelteSrc, "compiler/index.js")).href);
  const file = join(web, "src/lib/editing/RepeatBand.svelte");
  const quoted = (/** @type {string} */ path) => JSON.stringify(path);
  const js = compile(readFileSync(file, "utf8"), { filename: file, generate: "client", dev: false }).js.code
    .replaceAll("'svelte/internal/client'", quoted(join(svelteSrc, "internal/client/index.js")))
    .replaceAll("'svelte/internal/disclose-version'", quoted(join(svelteSrc, "internal/disclose-version.js")))
    .replaceAll('from "svelte"', `from ${quoted(join(svelteSrc, "index-client.js"))}`);
  mkdirSync(resolve(import.meta.dirname, "../../tmp"), { recursive: true });
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/band-follows-focus-"));
  compiledBand = join(compiledDir, "band.mjs");
  writeFileSync(compiledBand, js);
});
afterAll(() => { rmSync(compiledDir, { recursive: true, force: true }); });

/** @type {(() => void) | null} */
let unmountBand = null;
afterEach(() => { unmountBand?.(); unmountBand = null; document.body.innerHTML = ""; });

const CHOICES = [["1", "month"], ["3", "3 months"], ["6", "6 months"], ["12", "year"]].map(([value, words]) => ({
  value, words, colour: null, figure: value, unit: "", note: `note for ${words}`,
}));

/** Mounts the band; the host echoes onpick back into `value`, as the card's staging does. */
async function mountBand(/** @type {string} */ value, { withCommit = true } = {}) {
  const { mount, unmount, flushSync } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { proxy } = await import(pathToFileURL(join(svelteSrc, "internal/client/index.js")).href);
  const { default: RepeatBand } = await import(/* @vite-ignore */ compiledBand);
  /** @type {string[]} */ const picks = [];
  /** @type {string[]} */ const commits = [];
  /** @type {string[]} */ const log = [];
  /** @type {Record<string, unknown>} */
  const props = proxy({
    choices: CHOICES, value, label: "Repeat",
    onpick: (/** @type {string} */ v) => { picks.push(v); log.push(`pick:${v}`); props.value = v; },
  });
  if (withCommit) props.oncommit = (/** @type {string} */ v) => { commits.push(v); log.push(`commit:${v}`); };
  const component = mount(RepeatBand, { target: document.body, props });
  unmountBand = () => unmount(component);
  flushSync();
  const cells = () => [...document.querySelectorAll("[role=radio]")];
  const cell = (/** @type {number} */ i) => /** @type {HTMLElement} */ (cells()[i]);
  return {
    picks, commits, log, cell,
    press(/** @type {number} */ i, /** @type {string} */ key) {
      cell(i).focus();
      cell(i).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      flushSync();
    },
    checked: () => cells().map((el) => el.getAttribute("aria-checked") === "true"),
    tabbable: () => cells().map((el) => el.getAttribute("tabindex") === "0"),
    focused: () => cells().indexOf(/** @type {Element} */ (document.activeElement)),
    foot: () => document.querySelector(".foot .when")?.textContent?.trim(),
  };
}

describe("repeat band: selection follows focus (#1930)", () => {
  it("Right and Left check the cell they reach, wrapping, and call onpick only", async () => {
    const t = await mountBand("1");
    t.press(0, "ArrowRight");
    expect(t.picks).toEqual(["3"]);
    expect(t.focused()).toBe(1);
    expect(t.checked()).toEqual([false, true, false, false]);
    t.press(0, "ArrowLeft");
    expect(t.picks).toEqual(["3", "12"]);
    expect(t.focused()).toBe(3);
    expect(t.checked()).toEqual([false, false, false, true]);
    expect(t.commits).toEqual([]);
  });

  it("Up and Down do the same as Left and Right, wrapping, and call onpick only", async () => {
    const t = await mountBand("1");
    t.press(0, "ArrowDown");
    t.press(1, "ArrowDown");
    t.press(2, "ArrowDown");
    t.press(3, "ArrowDown");
    expect(t.picks).toEqual(["3", "6", "12", "1"]);
    t.press(0, "ArrowUp");
    expect(t.picks.at(-1)).toBe("12");
    expect(t.checked()).toEqual([false, false, false, true]);
    expect(t.commits).toEqual([]);
  });

  it("Home and End check the first and last cell and call onpick only", async () => {
    const t = await mountBand("3");
    t.press(1, "End");
    t.press(3, "Home");
    expect(t.picks).toEqual(["12", "1"]);
    expect(t.focused()).toBe(0);
    expect(t.checked()).toEqual([true, false, false, false]);
    expect(t.commits).toEqual([]);
  });

  it("the foot line reads the cell the arrows landed on", async () => {
    const t = await mountBand("1");
    expect(t.foot()).toBe("month");
    t.press(0, "ArrowRight");
    expect(t.foot()).toBe("3 months");
    t.press(1, "End");
    expect(t.foot()).toBe("year");
  });

  it("only the checked cell is in the tab order after an arrow", async () => {
    const t = await mountBand("1");
    t.press(0, "ArrowRight");
    expect(t.tabbable()).toEqual([false, true, false, false]);
  });

  it("a press, Enter and Space (click) call onpick then oncommit, on the checked cell too", async () => {
    const t = await mountBand("1");
    t.cell(2).click();
    expect(t.log).toEqual(["pick:6", "commit:6"]);
    t.cell(2).click();
    expect(t.log).toEqual(["pick:6", "commit:6", "pick:6", "commit:6"]);
  });

  it("oncommit is optional: a press without it still calls onpick", async () => {
    const t = await mountBand("1", { withCommit: false });
    t.cell(1).click();
    expect(t.picks).toEqual(["3"]);
  });
});
