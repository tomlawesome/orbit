import { describe, expect, it } from "vitest";

import { holdUnsaved, anyUnsaved, unsavedAsker, markLeaving, resetLeaving } from "../../web/src/lib/unsaved.js";

/*
 * #1879 W-S1: a shared unsaved-changes registry. The create form holds an
 * isDirty() while mounted; the root layout asks whether anything is dirty.
 */
describe("unsaved registry (#1879 W-S1)", () => {
  it("is clean with nothing held", () => {
    expect(anyUnsaved()).toBe(false);
  });

  it("is dirty while any held isDirty() is true, and follows it live", () => {
    let dirty = false;
    const release = holdUnsaved(() => dirty);
    expect(anyUnsaved()).toBe(false);
    dirty = true;
    expect(anyUnsaved()).toBe(true);
    release();
  });

  it("counts one dirty holder among clean ones", () => {
    const a = holdUnsaved(() => false);
    const b = holdUnsaved(() => true);
    expect(anyUnsaved()).toBe(true);
    a();
    b();
  });

  it("stops counting a released holder, and release twice is harmless", () => {
    const release = holdUnsaved(() => true);
    expect(anyUnsaved()).toBe(true);
    release();
    expect(anyUnsaved()).toBe(false);
    expect(() => release()).not.toThrow();
  });

  it("unsavedAsker() gives the dirty holder's ask, undefined for a dirty holder without one", () => {
    const ask = async () => true;
    let dirty = false;
    const withAsk = holdUnsaved(() => dirty, { ask });
    expect(unsavedAsker()).toBeUndefined();
    dirty = true;
    expect(unsavedAsker()).toBe(ask);
    withAsk();
    expect(unsavedAsker()).toBeUndefined();
    const plain = holdUnsaved(() => true);
    expect(anyUnsaved()).toBe(true);
    expect(unsavedAsker()).toBeUndefined();
    plain();
  });

  it("unsavedAsker() ignores a clean holder's ask and a released one", () => {
    const clean = holdUnsaved(() => false, { ask: async () => true });
    const ask = async () => false;
    const dirty = holdUnsaved(() => true, { ask });
    expect(unsavedAsker()).toBe(ask);
    dirty();
    expect(unsavedAsker()).toBeUndefined();
    clean();
  });

  it("markLeaving() makes every holder read clean (the page is going away) until undone", () => {
    const release = holdUnsaved(() => true);
    expect(anyUnsaved()).toBe(true);
    const undo = markLeaving();
    expect(anyUnsaved()).toBe(false);
    undo();
    expect(anyUnsaved()).toBe(true);
    release();
  });

  it("resetLeaving() puts a page restored from the back-forward cache under guard again", () => {
    const release = holdUnsaved(() => true);
    markLeaving();
    expect(anyUnsaved()).toBe(false);
    resetLeaving();
    expect(anyUnsaved()).toBe(true);
    release();
  });

  /* #1883: only a visible form may ask; a hidden one still counts as unsaved. */
  it("#1883: a hidden dirty holder still counts as unsaved but is never the asker", () => {
    const ask = async () => true;
    const hidden = holdUnsaved(() => true, { ask, visible: () => false });
    expect(anyUnsaved()).toBe(true);
    expect(unsavedAsker()).toBeUndefined();
    hidden();
  });

  it("#1883: a dirty visible holder's ask is given, read live", () => {
    const ask = async () => true;
    let shown = true;
    const holder = holdUnsaved(() => true, { ask, visible: () => shown });
    expect(unsavedAsker()).toBe(ask);
    shown = false;
    expect(unsavedAsker()).toBeUndefined();
    shown = true;
    expect(unsavedAsker()).toBe(ask);
    holder();
  });

  it("#1883: with two dirty holders and only the second visible, the second's ask is given", () => {
    const first = async () => true;
    const second = async () => false;
    const a = holdUnsaved(() => true, { ask: first, visible: () => false });
    const b = holdUnsaved(() => true, { ask: second, visible: () => true });
    expect(unsavedAsker()).toBe(second);
    a();
    b();
  });

  it("#1883: visible defaults to true when not given", () => {
    const ask = async () => true;
    const holder = holdUnsaved(() => true, { ask });
    expect(unsavedAsker()).toBe(ask);
    holder();
  });

  it("#1883: a visible dirty holder without an ask gives no asker, so the layout's confirm runs", () => {
    const hiddenWithAsk = holdUnsaved(() => true, { ask: async () => true, visible: () => false });
    const desk = holdUnsaved(() => true, { visible: () => true });
    expect(anyUnsaved()).toBe(true);
    expect(unsavedAsker()).toBeUndefined();
    hiddenWithAsk();
    desk();
  });

  it("#1883: markLeaving() still clears both the count and the asker for a hidden and a visible holder", () => {
    const ask = async () => true;
    const a = holdUnsaved(() => true, { ask, visible: () => false });
    const b = holdUnsaved(() => true, { ask, visible: () => true });
    const undo = markLeaving();
    expect(anyUnsaved()).toBe(false);
    expect(unsavedAsker()).toBeUndefined();
    undo();
    expect(anyUnsaved()).toBe(true);
    a();
    b();
  });
});
