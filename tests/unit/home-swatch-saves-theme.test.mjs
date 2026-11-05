// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Picking a theme on the home desk's account card must behave like every
 * other theme pick: the page changes, the server is told (savePreferences),
 * and the pick is counted in picksMade so a session read already in flight
 * cannot overwrite it. Otherwise the pick reverts on the next full page load.
 * The card ($lib/AccountCard.svelte, #1689) hands the pack id to home's
 * setSwatch; the data layer is stood in for, the real pick.js runs.
 */

const savePreferences = vi.fn(() => Promise.resolve());
vi.mock("$lib/data/workspace.js", async (importOriginal) => ({
  ...(await importOriginal()),
  savePreferences: (/** @type {unknown} */ change) => savePreferences(change),
}));

const { setSwatch } = await import("../../web/src/routes/home/swatches.js");
const { picksMade } = await import("../../web/src/lib/pick.js");

beforeEach(() => {
  savePreferences.mockClear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => vi.restoreAllMocks());

describe("home desk theme swatches", () => {
  it("saves the picked theme to the server", () => {
    setSwatch("dawn");
    expect(savePreferences).toHaveBeenCalledTimes(1);
    expect(savePreferences).toHaveBeenCalledWith({ theme: "dawn" });
  });

  it("saves the pack id for a two-word swatch title", () => {
    setSwatch("afterdark");
    expect(savePreferences).toHaveBeenCalledWith({ theme: "afterdark" });
  });

  it("counts the pick so an in-flight session read cannot overwrite it", () => {
    const before = picksMade();
    setSwatch("clouds");
    expect(picksMade()).toBe(before + 1);
  });

  it("still changes the page theme at once", () => {
    setSwatch("dawn");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dawn");
  });
});
