// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureApi } from "../support/fixture-api.mjs";
import { createPageLoader, runtime, settle } from "../support/svelte-page.mjs";

/*
 * #1892 review follow-ups: focus lands on the first chip when the chooser
 * opens; after a typed chip is removed or "add N d" is pressed, focus goes to
 * the number field, never the page body; the field points at the refusal line.
 */
const matchMedia = (/** @type {string} */ query) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});
async function flush() {
  const { flushSync } = await runtime();
  flushSync();
  await settle(4);
  flushSync();
  await new Promise((done) => setTimeout(done, 50));
  flushSync();
}
const root = () => document.querySelector('[role="dialog"]') ?? document.body;
const field = () => /** @type {HTMLInputElement} */ (document.querySelector('input[inputmode="numeric"]'));
async function type(text) {
  field().focus();
  field().value = text;
  field().dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
}
const button = (/** @type {RegExp} */ re) => [...root().querySelectorAll("button")].find((one) => re.test(`${one.textContent} ${one.getAttribute("aria-label") ?? ""}`));

describe("the reminders chooser's focus and announcements (#1892 review)", () => {
  const loader = createPageLoader("reminder-days-1892-review", {
    stub: (file) => /\/(lib\/Chrome|lib\/PageSky|routes\/create\/pocket)\.svelte$/.test(file),
    stubs: { "$lib/backdrops/constellations.js": "export const mountConstellations = () => () => {};" },
  });
  beforeAll(() => loader.setup("routes/create/+page.svelte"));
  afterAll(() => loader.teardown());
  afterEach(() => { loader.unmount(); vi.unstubAllGlobals(); });

  async function openDesk() {
    vi.stubGlobal("fetch", fixtureApi().fetch);
    vi.stubGlobal("matchMedia", matchMedia);
    vi.stubGlobal("requestAnimationFrame", (/** @type {() => void} */ fn) => setTimeout(fn, 0));
    await loader.mount("routes/create/+page.svelte", { data: { fixtures: true } }, { url: "http://localhost/create" });
    await settle(10);
    document.getElementById("f-reminder")?.click();
    await flush();
  }

  it("moves focus to the first chip when the chooser opens", async () => {
    await openDesk();
    const first = root().querySelector("button[aria-pressed]");
    expect(first?.textContent?.trim(), "the first chip is 1d").toBe("1d");
    expect(document.activeElement).toBe(first);
  });

  it("keeps focus in the field after a typed chip is removed", async () => {
    await openDesk();
    await type("21");
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flush();
    const cross = /** @type {HTMLElement | undefined} */ (button(/21d, remove/u));
    cross?.focus();
    cross?.click();
    await flush();
    expect(button(/21d, remove/u)).toBeUndefined();
    expect(document.activeElement).toBe(field());
  });

  it("keeps focus in the field after the add button is used", async () => {
    await openDesk();
    await type("21");
    const add = /** @type {HTMLElement | undefined} */ (button(/^\s*add 21/u));
    add?.focus();
    add?.click();
    await flush();
    expect(button(/21d, remove/u), "21d was added").toBeDefined();
    expect(document.activeElement).toBe(field());
  });

  it("points the field at the refusal line", async () => {
    await openDesk();
    expect(field().getAttribute("aria-describedby")).toBeNull();
    await type("400");
    const id = field().getAttribute("aria-describedby");
    expect(id, "the field names the refusal line").toBeTruthy();
    expect(document.getElementById(/** @type {string} */ (id))?.textContent).toMatch(/a whole number of days, 1 to 365/u);
  });
});
