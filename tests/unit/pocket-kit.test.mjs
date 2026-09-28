// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ARM_MS, createArm, disarmOnElsewhere } from "$lib/pocket/arm.js";
import { inertPage, tabbables, trapTab } from "$lib/pocket/focus.js";
import {
  chromeHidden, dragAxis, reorderTarget, sheetRelease,
} from "$lib/pocket/gesture.js";
import { mountRow, rowOf } from "$lib/pocket/row.js";
import { holdSheet } from "$lib/pocket/sheet.js";
import { dismissWake, subscribeWake, undoWake, wake } from "$lib/pocket/wake.js";
import { firstClause, reasonWords } from "$lib/pocket/words.js";

/*
 * The pocket kit's behaviour without a browser (#1120): the row that opens
 * on a tap (review round §1.1), its keyboard and one-open-per-group, the sheet's
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

describe("a failure's first clause (round 3 §1, R6)", () => {
  it("rests on the words before the first comma, dash, full stop or aside", () => {
    expect(firstClause("Its attachment is a picture-only scan, and Orbit couldn’t read any text from it."))
      .toBe("Its attachment is a picture-only scan");
    expect(firstClause("It carried no document Orbit can read (PDFs work best). Nothing was kept."))
      .toBe("It carried no document Orbit can read");
    expect(firstClause("Its document could not be prepared.")).toBe("Its document could not be prepared");
    expect(firstClause("The scanner is away — try later")).toBe("The scanner is away");
    expect(firstClause("Version 1.2 is too old")).toBe("Version 1.2 is too old");
    expect(firstClause("")).toBe("");
  });
});

describe("a failed receipt's reason, in plain words (#1143)", () => {
  it("looks up every listed code and falls back to unknown", () => {
    expect(reasonWords("no_document")).toBe("no readable document");
    expect(reasonWords("too_large")).toBe("too large");
    expect(reasonWords("malware")).toBe("scanner refused it");
    expect(reasonWords("scanner_off")).toBe("scanner unavailable");
    expect(reasonWords("not_kept")).toBe("couldn’t be kept");
    expect(reasonWords("wrong_recipient")).toBe("not addressed to you");
    expect(reasonWords("account_disabled")).toBe("account disabled");
    expect(reasonWords("older_review")).toBe("needs cleanup");
    expect(reasonWords("unknown")).toBe("reason not named");
    expect(reasonWords("some_unlisted_code")).toBe("reason not named");
    expect(reasonWords(null)).toBe("reason not named");
    expect(reasonWords(undefined)).toBe("reason not named");
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
  it("disarms on a press elsewhere, on the reader's scroll and on Escape, not on a press on itself", () => {
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
    /* the reader scrolls: a wheel, a touch drag, a scrolling key */
    arm.tap();
    document.body.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 40 }));
    expect(arm.armed).toBe(false);
    arm.tap();
    other.dispatchEvent(new Event("touchmove", { bubbles: true }));
    expect(arm.armed).toBe(false);
    arm.tap();
    document.body.dispatchEvent(key("PageDown"));
    expect(arm.armed).toBe(false);
    arm.tap();
    document.body.dispatchEvent(key("Escape"));
    expect(arm.armed).toBe(false);
    release();
  });
  it("stays armed when the browser scrolls the tapped pill into view, or the finger wobbles on it", () => {
    /* #1120: a browser that focuses on tap scrolls a pill at a sheet's edge
       into view; that scroll is not the reader's, and disarming on it left
       the second tap only arming again. */
    const scroller = document.createElement("div");
    const button = document.createElement("button");
    scroller.append(button);
    document.body.append(scroller);
    const arm = createArm();
    const release = disarmOnElsewhere(button, arm.disarm);
    arm.tap();
    scroller.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("scroll"));
    button.dispatchEvent(new Event("touchmove", { bubbles: true }));
    button.dispatchEvent(key(" "));
    expect(arm.armed).toBe(true);
    expect(arm.tap()).toBe(true);
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

/** Row.svelte's DOM, by hand: two rows in one group, a third outside it. */
function rowFixture() {
  document.body.innerHTML = `
    <div data-row-group>
      <div data-row id="emma">
        <div class="face"><button data-row-face aria-controls="emma-panel">Emma Lawson</button></div>
        <div data-row-panel id="emma-panel">
          <button aria-label="Hand over to Emma Lawson">hand over</button>
          <button aria-label="Remove Emma Lawson">remove</button>
        </div>
      </div>
      <div data-row id="rob">
        <div class="face"><button data-row-face>Rob Lawson</button></div>
        <div data-row-panel><button aria-label="Remove Rob Lawson">remove</button></div>
      </div>
    </div>
    <div data-row-group>
      <div data-row id="ada">
        <div class="face"><button data-row-face>Ada Lawson</button></div>
        <div data-row-panel><button aria-label="Remove Ada Lawson">remove</button></div>
      </div>
    </div>
    <button id="elsewhere">elsewhere</button>`;
  /** @param {string} id */
  const one = (id) => {
    const row = /** @type {HTMLElement} */ (document.getElementById(id));
    const face = /** @type {HTMLElement} */ (row.querySelector("[data-row-face]"));
    const panel = /** @type {HTMLElement} */ (row.querySelector("[data-row-panel]"));
    const [first, last] = /** @type {HTMLButtonElement[]} */ ([...panel.querySelectorAll("button")]);
    return { row, face, panel, first, last, control: mountRow(row, { closeMs: 0 }) };
  };
  return { emma: one("emma"), rob: one("rob"), ada: one("ada") };
}

describe("the row opens on a tap (review round §1.1)", () => {
  it("is shut at rest: its acts are hidden, out of the Tab order, the face says collapsed", () => {
    const { emma } = rowFixture();
    expect(emma.panel.hidden).toBe(true);
    expect(emma.face.getAttribute("aria-expanded")).toBe("false");
    expect(tabbables(document.body).map((el) => el.textContent)).not.toContain("hand over");
    expect(emma.last.getAttribute("aria-label")).toBe("Remove Emma Lawson");
  });
  it("opens on a tap on the face and closes on the next, keeping its acts named", () => {
    const { emma } = rowFixture();
    emma.face.click();
    expect(emma.control.isOpen).toBe(true);
    expect(emma.row.hasAttribute("data-open")).toBe(true);
    expect(emma.panel.hidden).toBe(false);
    expect(emma.face.getAttribute("aria-expanded")).toBe("true");
    expect(tabbables(document.body).map((el) => el.getAttribute("aria-label")))
      .toEqual(expect.arrayContaining(["Hand over to Emma Lawson", "Remove Emma Lawson"]));
    emma.face.click();
    expect(emma.control.isOpen).toBe(false);
    expect(emma.panel.hidden).toBe(true);
    expect(emma.face.getAttribute("aria-expanded")).toBe("false");
  });
  it("closes on Escape from its panel and hands focus back to the face", () => {
    const { emma } = rowFixture();
    emma.face.click();
    emma.last.focus();
    emma.last.dispatchEvent(key("Escape"));
    expect(emma.control.isOpen).toBe(false);
    expect(document.activeElement).toBe(emma.face);
  });
  it("stays open once tapped: a tap elsewhere, a scroll or a timer never closes it", () => {
    /* The desk's rule, and the owner's on the phone (2026-09-27, #1159):
       "The drawer should just stay open once tapped like it does on
       desktop". Only its own face, Escape, or another row in its group
       closes it. */
    vi.useFakeTimers();
    const { emma } = rowFixture();
    const elsewhere = /** @type {HTMLElement} */ (document.getElementById("elsewhere"));
    emma.control.open();
    emma.last.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    elsewhere.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 400 }));
    elsewhere.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
    window.dispatchEvent(new Event("scroll"));
    elsewhere.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 400 }));
    elsewhere.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 101, clientY: 401 }));
    elsewhere.click();
    vi.advanceTimersByTime(60_000);
    expect(emma.control.isOpen).toBe(true);
    emma.face.click();
    expect(emma.control.isOpen).toBe(false);
  });
  it("keeps one open per group: opening another row in the list closes the first", () => {
    const { emma, rob, ada } = rowFixture();
    emma.control.open();
    rob.control.open();
    expect(emma.control.isOpen).toBe(false);
    expect(rob.control.isOpen).toBe(true);
    ada.control.open();
    expect(rob.control.isOpen).toBe(true);
    expect(ada.control.isOpen).toBe(true);
  });
  it("keeps the panel in the page until the close has played", () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div data-row><button data-row-face>Tom</button><div data-row-panel><button>remove</button></div></div>`;
    const row = /** @type {HTMLElement} */ (document.querySelector("[data-row]"));
    const panel = /** @type {HTMLElement} */ (row.querySelector("[data-row-panel]"));
    const control = mountRow(row, { closeMs: 200 });
    control.open();
    control.close();
    expect(row.hasAttribute("data-open")).toBe(false);
    expect(panel.hidden).toBe(false);
    vi.advanceTimersByTime(200);
    expect(panel.hidden).toBe(true);
    control.destroy();
  });
  it("is found by any element inside it, so a screen can open it from elsewhere", () => {
    const { emma } = rowFixture();
    expect(rowOf(emma.last)).toBe(emma.control);
    rowOf(document.getElementById("emma"))?.open();
    expect(emma.control.isOpen).toBe(true);
    expect(rowOf(document.getElementById("elsewhere"))).toBe(null);
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
