import { readFileSync } from "node:fs";
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

/*
 * #1879 W-S1: with unsaved text, an update reload (or any navigation) first
 * asks the existing discard question. The pure function takes the pair
 * `{ isDirty, ask }` as a fourth argument and the navigation's `cancel`.
 */
describe("reloadWhenUpdated with unsaved text (#1879 W-S1)", () => {
  const to = { url: new URL("https://orbit.example.test/household/1") };
  const nav = () => ({ willUnload: false, to, cancel: vi.fn() });
  const href = "https://orbit.example.test/household/1";

  it("update pending and dirty, answer yes: asks once, then reloads to the target", () => {
    const go = vi.fn();
    const ask = vi.fn(() => true);
    const navigation = nav();
    reloadWhenUpdated(navigation, { current: true }, go, { isDirty: () => true, ask });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith(href);
    expect(navigation.cancel).not.toHaveBeenCalled();
  });

  it("update pending and dirty, answer no: cancels the navigation and does not reload", () => {
    const go = vi.fn();
    const navigation = nav();
    reloadWhenUpdated(navigation, { current: true }, go, { isDirty: () => true, ask: () => false });
    expect(navigation.cancel).toHaveBeenCalledTimes(1);
    expect(go).not.toHaveBeenCalled();
  });

  it("a later navigation asks again after a no", () => {
    const go = vi.fn();
    const ask = vi.fn(() => false);
    const guard = { isDirty: () => true, ask };
    reloadWhenUpdated(nav(), { current: true }, go, guard);
    reloadWhenUpdated(nav(), { current: true }, go, guard);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(go).not.toHaveBeenCalled();
  });

  it("update pending, not dirty: reloads with no question", () => {
    const go = vi.fn();
    const ask = vi.fn(() => true);
    reloadWhenUpdated(nav(), { current: true }, go, { isDirty: () => false, ask });
    expect(ask).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledWith(href);
  });

  it("no update pending, dirty: asks; yes navigates normally (no reload, no cancel)", () => {
    const go = vi.fn();
    const ask = vi.fn(() => true);
    const navigation = nav();
    reloadWhenUpdated(navigation, { current: false }, go, { isDirty: () => true, ask });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(go).not.toHaveBeenCalled();
    expect(navigation.cancel).not.toHaveBeenCalled();
  });

  it("no update pending, dirty: no cancels the navigation", () => {
    const go = vi.fn();
    const navigation = nav();
    reloadWhenUpdated(navigation, { current: false }, go, { isDirty: () => true, ask: () => false });
    expect(navigation.cancel).toHaveBeenCalledTimes(1);
    expect(go).not.toHaveBeenCalled();
  });

  it("no update pending, not dirty: nothing happens", () => {
    const go = vi.fn();
    const ask = vi.fn(() => true);
    const navigation = nav();
    reloadWhenUpdated(navigation, { current: false }, go, { isDirty: () => false, ask });
    expect(ask).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    expect(navigation.cancel).not.toHaveBeenCalled();
  });
});

describe("the question is asked once per navigation (#1879 W-S1)", () => {
  const read = (path) => readFileSync(new URL(`../../web/src/${path}`, import.meta.url), "utf8");

  it("the desk create page no longer carries its own beforeNavigate confirm", () => {
    const source = read("routes/create/+page.svelte");
    expect(source).not.toMatch(/beforeNavigate\s*\(/);
    expect(source).not.toContain("Discard this entry?");
  });

  it("the root layout owns the one guard, with the existing wording", () => {
    const layout = read("routes/+layout.svelte");
    expect(layout).toContain("Discard this entry? What you've typed will be lost.");
    expect(layout.match(/beforeNavigate\s*\(/g)).toHaveLength(1);
  });
});
