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
});
