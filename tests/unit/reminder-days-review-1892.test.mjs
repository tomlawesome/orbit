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

/* ── the cap: at most REMINDER_MAX (8) reminders (#1892 call 1) ─────────── */
describe("the reminder cap (#1892)", async () => {
  const { readFileSync } = await import("node:fs");
  const { REMINDER_MAX } = await import("../../src/lib/domain.ts");
  const { REMINDER_MAX: WEB_MAX } = await import("../../web/src/lib/editing/reminder-days.js");
  const loader = createPageLoader("reminder-days-1892-cap");
  beforeAll(() => loader.setup("lib/editing/DayChips.svelte"));
  afterAll(() => loader.teardown());
  afterEach(() => loader.unmount());

  /** @param {number[]} days */
  async function mount(days) {
    const picked = /** @type {string[]} */ ([]);
    await loader.mount("lib/editing/DayChips.svelte", { days, due: "2026-09-04", onpick: (/** @type {string} */ d) => picked.push(d) });
    await settle(4);
    return picked;
  }
  const chips = () => [...document.querySelectorAll("button")].filter((one) => /^\s*\d+\s*d\b/u.test(one.textContent ?? ""));
  const line = () => document.querySelector(".line");
  const eight = [1, 3, 7, 14, 30, 60, 90, 21];

  it("web's cap equals the server's", () => { expect(WEB_MAX).toBe(REMINDER_MAX); expect(REMINDER_MAX).toBe(8); });

  it("below the cap nothing is disabled and the line is empty", async () => {
    await mount([3, 14]);
    expect(chips().some((one) => /** @type {HTMLButtonElement} */ (one).disabled)).toBe(false);
    expect(field().disabled).toBe(false);
    expect(line()?.textContent?.trim()).toBe("");
  });

  it("at 8, off chips and the field are disabled; on chips stay pressable; the quiet line speaks", async () => {
    const picked = await mount(eight);
    expect(chips()).toHaveLength(8);
    expect(chips().every((one) => /** @type {HTMLButtonElement} */ (one).disabled === false), "all eight are on, so none disabled").toBe(true);
    expect(field().disabled).toBe(true);
    expect(line()?.textContent?.trim()).toBe("8 at most · turn one off to add more");
    expect(line()?.classList.contains("warm")).toBe(false);
    chips()[0].click();
    await settle(2);
    expect(picked).toEqual(["1"]);
  });

  it("at 8, a preset that is off is disabled", async () => {
    await mount([1, 3, 7, 14, 30, 60, 21, 45]);
    const off = chips().find((one) => one.textContent?.trim() === "90d");
    expect(/** @type {HTMLButtonElement} */ (off).disabled).toBe(true);
    expect(chips().filter((one) => /** @type {HTMLButtonElement} */ (one).disabled).map((one) => one.textContent?.trim())).toEqual(["90d"]);
  });

  it("over 8, every saved day shows and can be removed; the line is warm and counts what must go", async () => {
    const picked = await mount([...eight, 45]);
    expect(chips()).toHaveLength(9);
    expect(chips().some((one) => /** @type {HTMLButtonElement} */ (one).disabled)).toBe(false);
    expect(field().disabled).toBe(true);
    expect(line()?.textContent?.trim()).toBe("8 at most · turn 1 off to save");
    expect(line()?.classList.contains("warm")).toBe(true);
    chips().find((one) => /45d/u.test(one.textContent ?? ""))?.click();
    await settle(2);
    expect(picked).toEqual(["45"]);
  });

  it("over 8 by two says turn 2 off", async () => {
    await mount([...eight, 45, 120]);
    expect(line()?.textContent?.trim()).toBe("8 at most · turn 2 off to save");
  });

  it("the phone's add slot is 44px and the desk's stays 24px", () => {
    const css = readFileSync("web/src/lib/editing/DayChips.svelte", "utf8");
    const phone = /@media \(max-width: 839\.98px\)[^{]*\{([\s\S]*?)\n  \}/u.exec(css)?.[1] ?? "";
    expect(phone).toMatch(/\.line\{[^}]*min-height:44px[^}]*margin-top:0/u);
    expect(phone).toMatch(/\.line \.add\{[^}]*min-height:44px/u);
    expect(css).toMatch(/\n  \.line\{[^}]*min-height:24px/u);
  });
});
