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

/*
 * #1879 W-S1, phone: a dirty holder may bring its own async ask (the pocket's
 * "Leave without adding?" callout). The guard then cancels, awaits that ask
 * instead of the native confirm, and on true resumes the same destination:
 * a full reload when an update is pending, else a normal in-app `goto`.
 * Guard shape: { isDirty, ask (native), holderAsk (the dirty holder's ask or
 * undefined, from unsavedAsker()) }; the fifth argument is `goto`.
 */
describe("reloadWhenUpdated with a holder's own ask (#1879 W-S1, phone)", () => {
  const to = { url: new URL("https://orbit.example.test/household/1") };
  const href = "https://orbit.example.test/household/1";
  const nav = () => ({ willUnload: false, to, cancel: vi.fn() });
  const setup = (answer, extra = {}) => {
    const go = vi.fn();
    const goto = vi.fn();
    const ask = vi.fn(() => true);
    const holderAsk = vi.fn(async () => answer);
    const guard = { isDirty: () => true, ask, holderAsk, ...extra };
    return { go, goto, ask, holderAsk, guard };
  };

  it("update pending, yes: cancels, awaits the holder's ask once, no native confirm, one full reload", async () => {
    const { go, goto, ask, holderAsk, guard } = setup(true);
    const navigation = nav();
    await reloadWhenUpdated(navigation, { current: true }, go, guard, goto);
    expect(navigation.cancel).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();
    expect(holderAsk).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith(href);
    expect(goto).not.toHaveBeenCalled();
  });

  it("update pending, no: cancelled, no navigation and no reload", async () => {
    const { go, goto, ask, holderAsk, guard } = setup(false);
    const navigation = nav();
    await reloadWhenUpdated(navigation, { current: true }, go, guard, goto);
    expect(navigation.cancel).toHaveBeenCalledTimes(1);
    expect(holderAsk).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    expect(goto).not.toHaveBeenCalled();
  });

  it("a second navigation asks again after a no", async () => {
    const { go, goto, holderAsk, guard } = setup(false);
    await reloadWhenUpdated(nav(), { current: true }, go, guard, goto);
    await reloadWhenUpdated(nav(), { current: true }, go, guard, goto);
    expect(holderAsk).toHaveBeenCalledTimes(2);
    expect(go).not.toHaveBeenCalled();
  });

  it("no update pending, yes: a normal in-app goto to the target, not a reload", async () => {
    const { go, goto, ask, holderAsk, guard } = setup(true);
    const navigation = nav();
    await reloadWhenUpdated(navigation, { current: false }, go, guard, goto);
    expect(navigation.cancel).toHaveBeenCalledTimes(1);
    expect(holderAsk).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();
    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto).toHaveBeenCalledWith(href);
    expect(go).not.toHaveBeenCalled();
  });

  it("no update pending, no: nothing happens after the cancel", async () => {
    const { go, goto, guard } = setup(false);
    await reloadWhenUpdated(nav(), { current: false }, go, guard, goto);
    expect(go).not.toHaveBeenCalled();
    expect(goto).not.toHaveBeenCalled();
  });

  it("a dirty holder without an ask uses the native confirm as before, with no cancel on yes", async () => {
    const { go, goto, ask, guard } = setup(true, { holderAsk: undefined });
    const navigation = nav();
    await reloadWhenUpdated(navigation, { current: true }, go, guard, goto);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(navigation.cancel).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledWith(href);
    expect(goto).not.toHaveBeenCalled();
  });
});

/*
 * #1879 review: on the desk a yes to the native question is followed by
 * `location.href = ...`, which fires the desk form's beforeunload and asks a
 * second time. Before a reload the guard calls `guard.leaving()` (the layout
 * passes the registry's markLeaving), so nothing prompts again.
 */
describe("reloadWhenUpdated marks the page as leaving before the reload (#1879 review)", () => {
  const to = { url: new URL("https://orbit.example.test/household/1") };
  const nav = () => ({ willUnload: false, to, cancel: vi.fn() });

  it("update pending, native yes: leaving() runs once, before the reload", () => {
    const order = [];
    const leaving = vi.fn(() => { order.push("leaving"); });
    const go = vi.fn(() => { order.push("go"); });
    reloadWhenUpdated(nav(), { current: true }, go, { isDirty: () => true, ask: () => true, leaving });
    expect(leaving).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["leaving", "go"]);
  });

  it("native no, or nothing typed, or no update: leaving() is never called", () => {
    const leaving = vi.fn();
    const go = vi.fn();
    reloadWhenUpdated(nav(), { current: true }, go, { isDirty: () => true, ask: () => false, leaving });
    reloadWhenUpdated(nav(), { current: false }, go, { isDirty: () => true, ask: () => true, leaving });
    expect(leaving).not.toHaveBeenCalled();
  });

  it("the layout wires it, and the desk's beforeunload reads the registry (not the form) so it goes quiet", () => {
    const read = (path) => readFileSync(new URL(`../../web/src/${path}`, import.meta.url), "utf8");
    expect(read("routes/+layout.svelte")).toMatch(/leaving:\s*markLeaving/);
    const page = read("routes/create/+page.svelte");
    const handler = page.slice(page.indexOf("function onBeforeUnload"));
    expect(handler.slice(0, handler.indexOf("\n  }"))).toMatch(/anyUnsaved\(\)/);
  });
});

/*
 * #1879 re-review: the leaving flag is set only for the navigation the reader
 * agreed to, and its undo (what `guard.leaving()` returns) runs when that
 * navigation settles or turns out not to unload the page.
 */
describe("the leaving flag is undone when the agreed navigation does not leave (#1879 re-review)", () => {
  const at = (href) => ({ url: new URL(href) });
  const nav = (from, to) => ({ willUnload: false, from: at(from), to: at(to), cancel: vi.fn() });
  const settled = async (result) => { await Promise.resolve(result).catch(() => {}); };

  it("holder's yes, no update: leaving is set before goto, and undone when goto fails", async () => {
    const order = [];
    const undo = vi.fn(() => { order.push("undo"); });
    const leaving = vi.fn(() => { order.push("leaving"); return undo; });
    const goto = vi.fn(async () => { order.push("goto"); throw new Error("refused"); });
    const result = reloadWhenUpdated(nav("https://o.test/create", "https://o.test/home"), { current: false }, vi.fn(),
      { isDirty: () => true, ask: () => true, holderAsk: async () => true, leaving }, goto);
    await settled(result);
    expect(order).toEqual(["leaving", "goto", "undo"]);
  });

  it("holder's yes, no update: the undo also runs when goto resolves", async () => {
    const undo = vi.fn();
    const result = reloadWhenUpdated(nav("https://o.test/create", "https://o.test/home"), { current: false }, vi.fn(),
      { isDirty: () => true, ask: () => true, holderAsk: async () => true, leaving: () => undo }, vi.fn(async () => {}));
    await settled(result);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("a planned reload that only changes the #hash does not unload the page: the undo runs", async () => {
    const undo = vi.fn();
    const go = vi.fn();
    const result = reloadWhenUpdated(nav("https://o.test/create#a", "https://o.test/create#b"), { current: true }, go,
      { isDirty: () => true, ask: () => true, leaving: () => undo });
    await settled(result);
    expect(go).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("the same for a holder's yes", async () => {
    const undo = vi.fn();
    const result = reloadWhenUpdated(nav("https://o.test/create#a", "https://o.test/create#b"), { current: true }, vi.fn(),
      { isDirty: () => true, ask: () => true, holderAsk: async () => true, leaving: () => undo });
    await settled(result);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("a reload to another page unloads it: the undo does not run", async () => {
    const undo = vi.fn();
    const result = reloadWhenUpdated(nav("https://o.test/create", "https://o.test/home"), { current: true }, vi.fn(),
      { isDirty: () => true, ask: () => true, leaving: () => undo });
    await settled(result);
    expect(undo).not.toHaveBeenCalled();
  });

  it("the layout resets the flag on a persisted pageshow", () => {
    const layout = readFileSync(new URL("../../web/src/routes/+layout.svelte", import.meta.url), "utf8");
    expect(layout).toMatch(/pageshow/);
    expect(layout).toMatch(/persisted/);
    expect(layout).toMatch(/resetLeaving/);
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

  it("pocket.svelte passes its own ask to holdUnsaved and asks no navigation question itself", () => {
    const pocket = read("routes/create/pocket.svelte");
    expect(pocket).not.toMatch(/beforeNavigate\s*\(/);
    expect(pocket).not.toContain("Discard this entry?");
    expect(pocket).toMatch(/holdUnsaved\([^\n]*,\s*\{\s*ask\b/);
  });

  it("the desk create page registers without an ask (native confirm stays)", () => {
    const page = read("routes/create/+page.svelte");
    expect(page).toMatch(/holdUnsaved\(/);
    expect(page).not.toMatch(/holdUnsaved\([^\n]*,\s*\{\s*ask\b/);
  });
});
