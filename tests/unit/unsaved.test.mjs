import { describe, expect, it } from "vitest";

import { holdUnsaved, anyUnsaved } from "../../web/src/lib/unsaved.js";

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
});
