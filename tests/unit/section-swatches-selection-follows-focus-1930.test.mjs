// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/*
 * #1930: SectionSwatches follows the WAI-ARIA APG radio pattern, as Tiles does
 * (#1494). Left and Right walk the four swatches, wrapping; Up and Down do the
 * same (one row); Home and End go to the ends. Every move checks the swatch and
 * calls onpick(colour), so the colour applies and saves on every check. A press,
 * Enter and Space (all `click`) also call onpick.
 */
const web = resolve(import.meta.dirname, "../../web");
const svelteSrc = join(web, "node_modules/svelte/src");
/** @type {string} */
let compiledDir;
/** @type {string} */
let compiledSwatches;

beforeAll(async () => {
  const { compile } = await import(pathToFileURL(join(svelteSrc, "compiler/index.js")).href);
  const file = join(web, "src/lib/editing/SectionSwatches.svelte");
  const quoted = (/** @type {string} */ path) => JSON.stringify(path);
  const js = compile(readFileSync(file, "utf8"), { filename: file, generate: "client", dev: false }).js.code
    .replaceAll("'svelte/internal/client'", quoted(join(svelteSrc, "internal/client/index.js")))
    .replaceAll("'svelte/internal/disclose-version'", quoted(join(svelteSrc, "internal/disclose-version.js")))
    .replaceAll('"$lib/option-colour.js"', quoted(join(web, "src/lib/option-colour.js")))
    .replaceAll('from "svelte"', `from ${quoted(join(svelteSrc, "index-client.js"))}`);
  mkdirSync(resolve(import.meta.dirname, "../../tmp"), { recursive: true });
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/swatches-follows-focus-"));
  compiledSwatches = join(compiledDir, "swatches.mjs");
  writeFileSync(compiledSwatches, js);
});
afterAll(() => { rmSync(compiledDir, { recursive: true, force: true }); });

/** @type {(() => void) | null} */
let unmountSwatches = null;
afterEach(() => { unmountSwatches?.(); unmountSwatches = null; document.body.innerHTML = ""; });

/** Mounts the swatches; the host echoes onpick back into `value`, as the section editor does. */
async function mountSwatches(/** @type {string} */ value, layout = "desk") {
  const { mount, unmount, flushSync } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { proxy } = await import(pathToFileURL(join(svelteSrc, "internal/client/index.js")).href);
  const { default: SectionSwatches } = await import(/* @vite-ignore */ compiledSwatches);
  /** @type {string[]} */ const picks = [];
  const props = proxy({
    name: "Garage", value, layout,
    onpick: (/** @type {string} */ v) => { picks.push(v); props.value = v; },
  });
  const component = mount(SectionSwatches, { target: document.body, props });
  unmountSwatches = () => unmount(component);
  flushSync();
  const swatches = () => [...document.querySelectorAll("[role=radio]")];
  const swatch = (/** @type {number} */ i) => /** @type {HTMLElement} */ (swatches()[i]);
  return {
    picks, swatch,
    press(/** @type {number} */ i, /** @type {string} */ key) {
      swatch(i).focus();
      swatch(i).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      flushSync();
    },
    checked: () => swatches().map((el) => el.getAttribute("aria-checked") === "true"),
    tabbable: () => swatches().map((el) => el.getAttribute("tabindex") === "0"),
    focused: () => swatches().indexOf(/** @type {Element} */ (document.activeElement)),
  };
}

/* The four swatches, in order: option-colour.js SECTION_COLOURS. */
describe("section swatches: selection follows focus (#1930)", () => {
  it("Right and Left check the swatch they reach, wrapping, and call onpick for it", async () => {
    const t = await mountSwatches("home");
    t.press(0, "ArrowRight");
    expect(t.picks).toEqual(["vehicles"]);
    expect(t.focused()).toBe(1);
    expect(t.checked()).toEqual([false, true, false, false]);
    t.press(0, "ArrowLeft");
    expect(t.picks).toEqual(["vehicles", "services"]);
    expect(t.focused()).toBe(3);
    expect(t.checked()).toEqual([false, false, false, true]);
  });

  it("Up and Down do the same as Left and Right, wrapping (one row)", async () => {
    const t = await mountSwatches("home");
    t.press(0, "ArrowDown");
    t.press(1, "ArrowDown");
    t.press(2, "ArrowDown");
    t.press(3, "ArrowDown");
    expect(t.picks).toEqual(["vehicles", "devices", "services", "home"]);
    t.press(0, "ArrowUp");
    expect(t.picks.at(-1)).toBe("services");
    expect(t.focused()).toBe(3);
    expect(t.checked()).toEqual([false, false, false, true]);
  });

  it("Home and End check the first and last swatch and call onpick for them", async () => {
    const t = await mountSwatches("vehicles");
    t.press(1, "End");
    t.press(3, "Home");
    expect(t.picks).toEqual(["services", "home"]);
    expect(t.focused()).toBe(0);
    expect(t.checked()).toEqual([true, false, false, false]);
  });

  it("the pocket layout walks the same way", async () => {
    const t = await mountSwatches("home", "pocket");
    t.press(0, "ArrowRight");
    t.press(1, "ArrowDown");
    expect(t.picks).toEqual(["vehicles", "devices"]);
    expect(t.checked()).toEqual([false, false, true, false]);
  });

  it("only the checked swatch is in the tab order after an arrow", async () => {
    const t = await mountSwatches("home");
    t.press(0, "ArrowRight");
    expect(t.tabbable()).toEqual([false, true, false, false]);
  });

  it("a press, Enter and Space (click) call onpick, on the checked swatch too", async () => {
    const t = await mountSwatches("home");
    t.swatch(2).click();
    expect(t.picks).toEqual(["devices"]);
    t.swatch(2).click();
    expect(t.picks).toEqual(["devices", "devices"]);
  });
});
