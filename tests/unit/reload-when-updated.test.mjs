import { describe, expect, it, vi } from "vitest";

import { reloadWhenUpdated } from "../../web/src/lib/reload-when-updated.js";

/*
 * #1738 A-F1: kit only notices a new version (`updated.current`); nothing
 * acts on it unless a navigation fails. The documented pattern is to make the
 * next navigation a full page load, so the reader lands on the new version.
 */
describe("reloadWhenUpdated (#1738 A-F1)", () => {
  const to = { url: new URL("https://orbit.example.test/household/1") };

  it("turns an in-app navigation into a full page load once a new version exists", () => {
    const go = vi.fn();
    reloadWhenUpdated({ willUnload: false, to }, { current: true }, go);
    expect(go).toHaveBeenCalledWith("https://orbit.example.test/household/1");
  });

  it("leaves navigation alone while the version is current", () => {
    const go = vi.fn();
    reloadWhenUpdated({ willUnload: false, to }, { current: false }, go);
    expect(go).not.toHaveBeenCalled();
  });

  it("does nothing for a navigation that already unloads the page, or has no target", () => {
    const go = vi.fn();
    reloadWhenUpdated({ willUnload: true, to }, { current: true }, go);
    reloadWhenUpdated({ willUnload: false, to: null }, { current: true }, go);
    expect(go).not.toHaveBeenCalled();
  });
});
