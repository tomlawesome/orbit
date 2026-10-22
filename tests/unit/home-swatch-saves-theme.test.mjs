// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Picking a theme on the home desk's account card must behave like every
 * other theme pick: the page changes, the server is told (savePreferences),
 * and the pick is counted in picksMade so a session read already in flight
 * cannot overwrite it. Otherwise the pick reverts on the next full page load.
 * The data layer is stood in for; the real pick.js and home.behaviour.js run.
 */

const savePreferences = vi.fn(() => Promise.resolve());
vi.mock("$lib/data/workspace.js", async (importOriginal) => ({
  ...(await importOriginal()),
  savePreferences: (/** @type {unknown} */ change) => savePreferences(change),
}));

const { mountAccount } = await import("../../web/src/routes/home/home.behaviour.js");
const { picksMade } = await import("../../web/src/lib/pick.js");

/** @type {() => void} */
let teardown;

beforeEach(() => {
  savePreferences.mockClear();
  document.documentElement.removeAttribute("data-theme");
  document.body.innerHTML = `
    <button class="orb" aria-expanded="false"></button>
    <div id="account">
      <div class="swatches">
        <button title="star-chart"></button>
        <button title="after dark"></button>
        <button title="clouds"></button>
        <button title="dawn"></button>
        <button title="retrograde"></button>
      </div>
    </div>`;
  teardown = mountAccount();
});

afterEach(() => teardown?.());

const swatch = (/** @type {string} */ title) =>
  /** @type {HTMLElement} */ (document.querySelector(`#account .swatches button[title="${title}"]`));

describe("home desk theme swatches", () => {
  it("saves the picked theme to the server", () => {
    swatch("dawn").click();
    expect(savePreferences).toHaveBeenCalledTimes(1);
    expect(savePreferences).toHaveBeenCalledWith({ theme: "dawn" });
  });

  it("saves the pack id for a two-word swatch title", () => {
    swatch("after dark").click();
    expect(savePreferences).toHaveBeenCalledWith({ theme: "afterdark" });
  });

  it("counts the pick so an in-flight session read cannot overwrite it", () => {
    const before = picksMade();
    swatch("clouds").click();
    expect(picksMade()).toBe(before + 1);
  });

  it("still changes the page theme at once", () => {
    swatch("dawn").click();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dawn");
  });
});
