// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ARM_MS, createArm, disarmOnElsewhere } from "$lib/pocket/arm.js";
import { inertPage, tabbables, trapTab } from "$lib/pocket/focus.js";
import {
  chromeHidden, dragAxis, reorderTarget, sheetRelease, swipeOffset, swipeSettles,
} from "$lib/pocket/gesture.js";
import { mountRow } from "$lib/pocket/row.js";
import { holdSheet } from "$lib/pocket/sheet.js";
import { dismissWake, subscribeWake, undoWake, wake } from "$lib/pocket/wake.js";

/*
 * The pocket kit's behaviour without a browser (#1120): the row's swipe,
 * keyboard and hidden-button contract (owner decision §25), the sheet's
 * focus handling, arm-then-fire, and the wake. The same modules drive the
 * Svelte components; web/tests/fidelity/pocket-kit.spec.js proves the
 * layout-dependent half in a real browser.
 */

/** @param {string} key @param {Partial<KeyboardEventInit>} [init] */
const key = (key, init = {}) => new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("gesture arithmetic", () => {
  it("tells a sideways drag from a scroll only once it has moved", () => {
    expect(dragAxis(3, 2)).toBe(null);
    expect(dragAxis(-20, 4)).toBe("x");
    expect(dragAxis(4, 20)).toBe("y");
  });
  it("lets the face follow the finger toward the trailing side, never the other way", () => {
    expect(swipeOffset({ dx: 30, reveal: 150, open: false })).toBe(0);
    expect(swipeOffset({ dx: -60, reveal: 150, open: false })).toBe(-60);
    expect(swipeOffset({ dx: -250, reveal: 150, open: false })).toBeGreaterThan(-250);
    expect(swipeOffset({ dx: 50, reveal: 150, open: true })).toBe(-100);
  });
  it("settles open past a third, or on a flick", () => {
    expect(swipeSettles({ dx: -60, reveal: 150, open: false })).toBe(true);
    expect(swipeSettles({ dx: -40, reveal: 150, open: false })).toBe(false);
    expect(swipeSettles({ dx: -10, reveal: 150, open: false, velocity: -0.8 })).toBe(true);
    expect(swipeSettles({ dx: 60, reveal: 150, open: true })).toBe(false);
  });
  it("closes a sheet dragged a quarter down, grows a list sheet dragged up", () => {
    expect(sheetRelease({ dy: 120, height: 400, size: "list" })).toBe("close");
    expect(sheetRelease({ dy: 40, height: 400, size: "list" })).toBe("stay");
    expect(sheetRelease({ dy: 40, height: 400, size: "list", velocity: 0.9 })).toBe("close");
    expect(sheetRelease({ dy: -60, height: 400, size: "list" })).toBe("grow");
    expect(sheetRelease({ dy: -60, height: 400, size: "callout" })).toBe("stay");
    expect(sheetRelease({ dy: 200, height: 700, size: "list", grown: true })).toBe("shrink");
  });
  it("retracts the chrome going down, returns it going up, always shows it at the top", () => {
    expect(chromeHidden({ y: 300, lastY: 280, hidden: false, height: 56 })).toBe(true);
    expect(chromeHidden({ y: 280, lastY: 300, hidden: true, height: 56 })).toBe(false);
    expect(chromeHidden({ y: 302, lastY: 300, hidden: true, height: 56 })).toBe(true);
    expect(chromeHidden({ y: 40, lastY: 30, hidden: true, height: 56 })).toBe(false);
  });
  it("drops a lifted row on the nearest slot, inside the list", () => {
    expect(reorderTarget({ from: 0, dy: 120, rowHeight: 56, count: 4 })).toBe(2);
    expect(reorderTarget({ from: 1, dy: -400, rowHeight: 56, count: 4 })).toBe(0);
    expect(reorderTarget({ from: 2, dy: 900, rowHeight: 56, count: 4 })).toBe(3);
  });
});

describe("arm, then fire", () => {
  beforeEach(() => vi.useFakeTimers());
  it("arms on the first tap and fires on the second", () => {
    const changes = [];
    const arm = createArm({ onchange: (a) => changes.push(a) });
    expect(arm.tap()).toBe(false);
    expect(arm.armed).toBe(true);
    expect(arm.tap()).toBe(true);
    expect(arm.armed).toBe(false);
    expect(changes).toEqual([true, false]);
  });
  it("disarms by itself after 4s", () => {
    const arm = createArm();
    arm.tap();
    vi.advanceTimersByTime(ARM_MS - 1);
    expect(arm.armed).toBe(true);
    vi.advanceTimersByTime(1);
    expect(arm.armed).toBe(false);
    expect(arm.tap()).toBe(false);
  });
  it("disarms on a press elsewhere, on scroll and on Escape, not on a press on itself", () => {
    const button = document.createElement("button");
    const other = document.createElement("button");
    document.body.append(button, other);
    const arm = createArm();
    const release = disarmOnElsewhere(button, arm.disarm);
    arm.tap();
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(arm.armed).toBe(true);
    other.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(arm.armed).toBe(false);
    arm.tap();
    window.dispatchEvent(new Event("scroll"));
    expect(arm.armed).toBe(false);
    arm.tap();
    document.body.dispatchEvent(key("Escape"));
    expect(arm.armed).toBe(false);
    release();
  });
});

describe("the wake", () => {
  beforeEach(() => vi.useFakeTimers());
  it("shows one line for 4s, replaced by the next, and undo runs once", () => {
    /** @type {any[]} */
    const seen = [];
    const stop = subscribeWake((entry) => seen.push(entry?.message ?? null));
    const undo = vi.fn();
    wake("Emma Lawson removed", { undo });
    wake("Boiler service completed");
    expect(seen.at(-1)).toBe("Boiler service completed");
    vi.advanceTimersByTime(4000);
    expect(seen.at(-1)).toBe(null);
    wake("Rob Lawson removed", { undo });
    undoWake();
    undoWake();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe(null);
    stop();
  });
  it("a stale dismiss never puts away a newer wake", () => {
    const first = wake("one");
    wake("two");
    /** @type {string | null} */
    let now = null;
    const stop = subscribeWake((entry) => (now = entry?.message ?? null));
    dismissWake(first);
    expect(now).toBe("two");
    dismissWake();
    stop();
  });
});

/** Row.svelte's DOM, by hand. */
function rowFixture() {
  document.body.innerHTML = `
    <div data-row>
      <div data-row-face role="group" aria-label="Emma Lawson" tabindex="0">Emma Lawson</div>
      <div data-row-acts>
        <button aria-label="Hand over to Emma Lawson">hand over</button>
        <button aria-label="Remove Emma Lawson">remove</button>
      </div>
    </div>
    <button id="elsewhere">elsewhere</button>`;
  const row = /** @type {HTMLElement} */ (document.querySelector("[data-row]"));
  const face = /** @type {HTMLElement} */ (row.querySelector("[data-row-face]"));
  const [handOver, remove] = /** @type {HTMLButtonElement[]} */ ([...row.querySelectorAll("[data-row-acts] button")]);
  return { row, face, handOver, remove, control: mountRow(row) };
}

describe("the row's acts (owner decision §25)", () => {
  it("keeps every act a real named button, out of the Tab order, until revealed", () => {
    const { handOver, remove, control } = rowFixture();
    expect(remove.getAttribute("aria-label")).toBe("Remove Emma Lawson");
    expect(handOver.tabIndex).toBe(-1);
    expect(remove.tabIndex).toBe(-1);
    expect(tabbables(document.body).map((el) => el.textContent)).not.toContain("remove");
    control.destroy();
  });
  it("reveals on ← or → from the focused row, puts the acts in the Tab order, and Escape hides", () => {
    const { row, face, remove, control } = rowFixture();
    face.focus();
    face.dispatchEvent(key("ArrowLeft"));
    expect(control.isOpen).toBe(true);
    expect(row.hasAttribute("data-open")).toBe(true);
    expect(remove.tabIndex).toBe(0);
    remove.focus();
    remove.dispatchEvent(key("Escape"));
    expect(control.isOpen).toBe(false);
    expect(remove.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(face);
    face.dispatchEvent(key("ArrowRight"));
    expect(control.isOpen).toBe(true);
    face.dispatchEvent(key("ArrowRight"));
    expect(control.isOpen).toBe(false);
    control.destroy();
  });
  it("uncovers the row when a screen reader lands on a covered act", () => {
    const { remove, control } = rowFixture();
    remove.focus();
    expect(control.isOpen).toBe(true);
    control.destroy();
  });
  it("springs back on a tap elsewhere, on scroll, and after 6s, but not from under focus", () => {
    vi.useFakeTimers();
    const { face, remove, control } = rowFixture();
    const elsewhere = /** @type {HTMLElement} */ (document.getElementById("elsewhere"));
    control.open();
    elsewhere.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(control.isOpen).toBe(false);
    control.open();
    window.dispatchEvent(new Event("scroll"));
    expect(control.isOpen).toBe(false);
    control.open();
    face.focus();
    vi.advanceTimersByTime(6000);
    expect(control.isOpen).toBe(false);
    control.open();
    remove.focus();
    vi.advanceTimersByTime(6000);
    expect(control.isOpen).toBe(true);
    control.destroy();
  });
  it("never opens from a tap: only a swipe or a key does", () => {
    const { face, control } = rowFixture();
    face.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(control.isOpen).toBe(false);
    control.destroy();
  });
});

/** Sheet.svelte's DOM, by hand: a page, and a sheet layer on <body>. */
function sheetFixture() {
  document.body.innerHTML = `
    <div id="app"><button id="opener">open</button><a href="/x">page link</a></div>
    <div id="wake" data-pocket-above></div>
    <div id="layer"><div id="panel" role="dialog" tabindex="-1">
      <button data-sheet-close>close</button>
      <a href="/one" id="first">one</a>
      <button id="last">two</button>
    </div></div>`;
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  $("opener").focus();
  return { $, layer: $("layer"), panel: $("panel") };
}

describe("the sheet as a dialog", () => {
  it("moves focus to its first real control, inerts the page but not the wake, and gives focus back", () => {
    const { $, layer, panel } = sheetFixture();
    const release = holdSheet(layer, panel, { onescape: () => {} });
    expect(document.activeElement).toBe($("first"));
    expect($("app").hasAttribute("inert")).toBe(true);
    expect($("wake").hasAttribute("inert")).toBe(false);
    expect(layer.hasAttribute("inert")).toBe(false);
    release();
    expect($("app").hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe($("opener"));
  });
  it("holds Tab inside, both ways", () => {
    const { $, layer, panel } = sheetFixture();
    const release = holdSheet(layer, panel, { onescape: () => {} });
    $("last").focus();
    const forward = key("Tab");
    document.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement?.textContent).toBe("close");
    const back = key("Tab", { shiftKey: true });
    document.dispatchEvent(back);
    expect(document.activeElement).toBe($("last"));
    release();
  });
  it("asks to close on Escape", () => {
    const { layer, panel } = sheetFixture();
    const onescape = vi.fn();
    const release = holdSheet(layer, panel, { onescape });
    document.dispatchEvent(key("Escape"));
    expect(onescape).toHaveBeenCalledTimes(1);
    release();
  });
  it("leaves alone what was already inert", () => {
    const { $, layer } = sheetFixture();
    $("app").setAttribute("inert", "");
    const restore = inertPage(layer);
    restore();
    expect($("app").hasAttribute("inert")).toBe(true);
  });
  it("trapTab with nothing to focus keeps focus on the panel", () => {
    document.body.innerHTML = `<div id="p" tabindex="-1"></div>`;
    const panel = /** @type {HTMLElement} */ (document.getElementById("p"));
    const event = key("Tab");
    expect(trapTab(event, panel)).toBe(true);
    expect(document.activeElement).toBe(panel);
  });
});
