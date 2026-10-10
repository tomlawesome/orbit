// @vitest-environment happy-dom
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ARM_MS, createArm, disarmOnElsewhere } from "../../web/src/lib/arm.js";

/*
 * #1342 (owner decision 2026-10-09): one two-tap arming helper, one timeout.
 * The helper lives at web/src/lib/arm.js (it was pocket/arm.js), holds for
 * 4 s everywhere, and disarms on scroll, Escape and a tap elsewhere.
 *
 * Keyed form, for one arm serving a list of buttons: `arm.tap(key)` arms for
 * that key (returns false), or, when that same key is already armed, fires
 * (returns true). `arm.armed` is the armed key (`armed === key` is true only
 * for that key); the unkeyed `arm.tap()` still arms with `armed === true`.
 * Tapping a different key re-arms for it and restarts the 4 s.
 */

const key = (k) => new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("the arm helper's home", () => {
  it("holds for 4 s", () => {
    expect(ARM_MS).toBe(4000);
  });
  it("is web/src/lib/arm.js, and pocket/arm.js is gone", () => {
    expect(existsSync(new URL("../../web/src/lib/arm.js", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../../web/src/lib/pocket/arm.js", import.meta.url))).toBe(false);
  });
});

describe("unkeyed arm, then fire", () => {
  it("is still armed at 3 999 ms and disarmed at 4 000 ms, telling onchange both times", () => {
    const changes = [];
    const arm = createArm({ onchange: (a) => changes.push(a) });
    expect(arm.tap()).toBe(false);
    expect(arm.armed).toBe(true);
    vi.advanceTimersByTime(3999);
    expect(arm.armed).toBe(true);
    expect(changes).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(arm.armed).toBe(false);
    expect(changes).toEqual([true, false]);
  });
  it("fires on the second tap, and disarm() clears the hold", () => {
    const changes = [];
    const arm = createArm({ onchange: (a) => changes.push(a) });
    expect(arm.tap()).toBe(false);
    expect(arm.tap()).toBe(true);
    expect(arm.armed).toBe(false);
    arm.tap();
    arm.disarm();
    expect(arm.armed).toBe(false);
    expect(changes).toEqual([true, false, true, false]);
    vi.advanceTimersByTime(ARM_MS * 2);
    expect(changes).toEqual([true, false, true, false]);
  });
});

describe("keyed arm, one arm for a list of buttons", () => {
  it("arms for one key, and armed === key is true for that key only", () => {
    const arm = createArm();
    expect(arm.tap("a")).toBe(false);
    expect(arm.armed === "a").toBe(true);
    expect(arm.armed === "b").toBe(false);
  });
  it("tapping the armed key again fires and disarms", () => {
    const arm = createArm();
    arm.tap("a");
    expect(arm.tap("a")).toBe(true);
    expect(arm.armed).toBeFalsy();
  });
  it("arming key b while a is armed re-arms for b alone, and restarts the 4 s", () => {
    const arm = createArm();
    arm.tap("a");
    vi.advanceTimersByTime(3000);
    expect(arm.tap("b")).toBe(false);
    expect(arm.armed === "a").toBe(false);
    expect(arm.armed === "b").toBe(true);
    /* a's original 4 s would have ended 1 s from now; b's has not started to run out */
    vi.advanceTimersByTime(3999);
    expect(arm.armed === "b").toBe(true);
    vi.advanceTimersByTime(1);
    expect(arm.armed).toBeFalsy();
    expect(arm.armed === "b").toBe(false);
  });
  it("tells onchange when it arms, re-arms and disarms", () => {
    const changes = [];
    const arm = createArm({ onchange: (a) => changes.push(a) });
    arm.tap("a");
    arm.tap("b");
    arm.disarm();
    expect(changes.at(0)).toBe("a");
    expect(changes.at(-1)).toBeFalsy();
    expect(changes).toContain("b");
  });
  it("disarm() clears the key, and the timer does not fire a stale change later", () => {
    const changes = [];
    const arm = createArm({ onchange: (a) => changes.push(a) });
    arm.tap("a");
    arm.disarm();
    expect(arm.armed === "a").toBe(false);
    expect(arm.armed).toBeFalsy();
    const seen = changes.length;
    vi.advanceTimersByTime(ARM_MS * 2);
    expect(changes.length).toBe(seen);
  });
  it("disarms on a press elsewhere, scroll and Escape, not on a press on the button", () => {
    const button = document.createElement("button");
    const other = document.createElement("button");
    document.body.append(button, other);
    const arm = createArm();
    const release = disarmOnElsewhere(button, arm.disarm);
    arm.tap("a");
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(arm.armed === "a").toBe(true);
    other.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(arm.armed).toBeFalsy();
    arm.tap("a");
    document.body.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 40 }));
    expect(arm.armed).toBeFalsy();
    arm.tap("b");
    other.dispatchEvent(new Event("touchmove", { bubbles: true }));
    expect(arm.armed).toBeFalsy();
    arm.tap("b");
    document.body.dispatchEvent(key("Escape"));
    expect(arm.armed).toBeFalsy();
    release();
  });
});
