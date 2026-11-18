// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureApi } from "../support/fixture-api.mjs";
import { REMINDER_CHOICES, blankEntry } from "../../web/src/routes/create/entry.js";
import { createPageLoader, runtime, settle } from "../support/svelte-page.mjs";

/*
 * #1892 (owner decision 52d; round 1 verdict "61a T", 2026-11-17; design
 * design/v19/reminder-days/round-1/t-one-scale.html and its README): the Add
 * form's reminders chooser offers ONE set of presets, 1 / 3 / 7 / 14 / 30 /
 * 60 / 90, the same on desk and phone, and a field where the person types a
 * whole number of days, 1 to 365. Typing a preset's number presses that
 * preset (never a twin); a typed day is a lit chip with a cross that removes
 * it; a saved day that is no preset (21) shows as a typed day.
 *
 * The design leaves some hooks open; these tests find them by role, not by
 * class: the field is the chooser card's `input[inputmode=numeric]`; "add"
 * is Enter in the field, or the button whose words begin "add"; a chip is a
 * `button` whose words are "<n>d" (as DayChips draws them); a typed chip is
 * lit and its words or accessible name carry a cross or "remove". The one
 * line says its words as the README's wording table gives them.
 *
 * Every case that needs the feature fails today because it is missing.
 */

const PRESETS = [1, 3, 7, 14, 30, 60, 90];
const REFUSAL = /a whole number of days, 1 to 365/iu;

const matchMedia = (/** @type {string} */ query) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});

/** @param {Element | null} el */
async function press(el) {
  expect(el, "the control to press is drawn").not.toBeNull();
  /** @type {HTMLElement} */ (el).click();
  await flush();
}
async function flush() {
  const { flushSync } = await runtime();
  flushSync();
  await settle(4);
  flushSync();
}

/** The reminders chooser card standing now. */
const chooser = () => [...document.querySelectorAll('[role="dialog"]')]
  .find((one) => /^Choose reminders/iu.test(one.getAttribute("aria-label") ?? "")) ?? null;
/** A chip's own words, cross and all. @param {Element} el */
const words = (el) => `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""}`.replace(/\s+/gu, " ").trim();
/** The day a chip is for, or null when it is not a day chip. @param {Element} el */
const dayOf = (el) => { const m = /^\s*(\d+)\s*d\b/iu.exec(el.textContent ?? ""); return m ? Number(m[1]) : null; };
/** Every day chip in the card, in drawn order. @param {Element | null} root */
const chips = (root) => [...root?.querySelectorAll("button") ?? []].filter((one) => dayOf(one) !== null);
/** @param {Element | null} root @param {number} day */
const chipFor = (root, day) => chips(root).find((one) => dayOf(one) === day) ?? null;
const lit = (/** @type {Element | null} */ chip) => chip?.getAttribute("aria-pressed") === "true" || chip?.hasAttribute("data-extra") === true;
const field = (/** @type {Element | null} */ root) => /** @type {HTMLInputElement | null} */ (root?.querySelector('input[inputmode="numeric"]') ?? null);

/** Types into the field the way a person does. @param {Element | null} root @param {string} text */
async function type(root, text) {
  const input = field(root);
  expect(input, "the card has a field to type a number of days in (input, inputmode numeric)").not.toBeNull();
  const el = /** @type {HTMLInputElement} */ (input);
  el.focus();
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
}
/** Enter in the field adds. @param {Element | null} root */
async function enter(root) {
  field(root)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await flush();
}
/** Types, then adds with Enter. @param {Element | null} root @param {string} text */
async function typeAndAdd(root, text) {
  await type(root, text);
  await enter(root);
}
/** The explicit add the phone's number pad needs. @param {Element | null} root */
const addButton = (root) => [...root?.querySelectorAll("button") ?? []].find((one) => /^\s*add\b/iu.test(words(one))) ?? null;

/* ── the presets, one scale ───────────────────────────────────────────── */
describe("the preset days are one scale (#1892)", () => {
  it("entry.js offers 1, 3, 7, 14, 30, 60, 90, ascending, and no 21", () => {
    expect(REMINDER_CHOICES).toEqual(PRESETS);
  });

  describe("desk Add", () => {
    const loader = createPageLoader("reminder-days-1892-desk", {
      stub: (file) => /\/(lib\/Chrome|lib\/PageSky|routes\/create\/pocket)\.svelte$/.test(file),
      stubs: { "$lib/backdrops/constellations.js": "export const mountConstellations = () => () => {};" },
    });
    beforeAll(() => loader.setup("routes/create/+page.svelte"));
    afterAll(() => loader.teardown());
    afterEach(() => { loader.unmount(); vi.unstubAllGlobals(); });

    async function openDesk() {
      vi.stubGlobal("fetch", fixtureApi().fetch);
      vi.stubGlobal("matchMedia", matchMedia);
      await loader.mount("routes/create/+page.svelte", { data: { fixtures: true } }, { url: "http://localhost/create" });
      await settle(10);
      await press(document.getElementById("f-reminder"));
      return chooser();
    }

    it("shows 1d 3d 7d 14d 30d 60d 90d, ascending, in the reminders card", async () => {
      const card = await openDesk();
      expect(card, "the reminders chooser card stands").not.toBeNull();
      expect(chips(card).map((one) => one.textContent?.trim().replace(/\s*×$/u, ""))).toEqual(PRESETS.map((day) => `${day}d`));
    });

    it("presses the settings pair, 3 and 14, and can turn 3 off and on again (#1738 W-F20)", async () => {
      const card = await openDesk();
      expect(PRESETS.filter((day) => lit(chipFor(card, day)))).toEqual([3, 14]);
      await press(chipFor(card, 3));
      expect(lit(chipFor(chooser(), 3)), "3d is off").toBe(false);
      expect(chipFor(chooser(), 3), "3d is still a preset chip to turn back on").not.toBeNull();
      await press(chipFor(chooser(), 3));
      expect(lit(chipFor(chooser(), 3)), "3d is on again").toBe(true);
    });

    it("has a field for typed days: numeric keypad, at most three digits", async () => {
      const input = field(await openDesk());
      expect(input, "a numeric field").not.toBeNull();
      expect(Number(input?.getAttribute("maxlength"))).toBe(3);
    });
  });

  describe("phone Add", () => {
    const loader = createPageLoader("reminder-days-1892-phone", {
      stub: (file) => /\/lib\/pocket\/(Sheet|Sky)\.svelte$/.test(file),
    });
    beforeAll(() => loader.setup("routes/create/EntryForm.svelte"));
    afterAll(() => loader.teardown());
    afterEach(() => { loader.unmount(); vi.unstubAllGlobals(); });

    /** @param {number[]} reminderDays */
    async function openPhone(reminderDays) {
      vi.stubGlobal("matchMedia", matchMedia);
      const entry = blankEntry({ name: "Boiler service", householdId: "hh-1" });
      Object.assign(entry, { sectionId: "s-1", dueDate: "2026-09-04", reminderDays });
      const households = [{ id: "hh-1", name: "Home", currency: "GBP",
        sections: [{ id: "s-1", name: "Home", icon: "home", accent: "a", visible: true }] }];
      await loader.mount("routes/create/EntryForm.svelte", { entry, households });
      await settle(6);
      await press(document.querySelector('button[aria-label^="Reminders:"]'));
      return { card: chooser(), entry };
    }

    it("opens the chooser card, not a separate Reminders sheet, with the same seven presets", async () => {
      const { card } = await openPhone([14, 3]);
      expect(card, "the chooser card ('Choose reminders') stands as the phone's sheet").not.toBeNull();
      expect(chips(card).map((one) => dayOf(one))).toEqual(PRESETS);
      expect(chipFor(card, 21), "21 is no longer a preset").toBeNull();
      expect(PRESETS.filter((day) => lit(chipFor(card, day)))).toEqual([3, 14]);
    });

    it("has the field and an explicit add the number pad can reach", async () => {
      const { card } = await openPhone([14, 3]);
      await type(card, "21");
      expect(addButton(card), "an add button saying 'add 21 d'").not.toBeNull();
      expect(words(/** @type {Element} */ (addButton(card)))).toMatch(/add 21 ?d/iu);
    });

    it("adds a typed 21 to the entry with the explicit add, as a lit chip with a cross", async () => {
      const { card, entry } = await openPhone([14, 3]);
      await type(card, "21");
      await press(addButton(card));
      expect(entry.reminderDays.slice().sort((a, b) => a - b)).toEqual([3, 14, 21]);
      const typed = chipFor(chooser(), 21);
      expect(typed, "21d stands as a chip").not.toBeNull();
      expect(lit(typed)).toBe(true);
      expect(words(/** @type {Element} */ (typed))).toMatch(/×|remove/iu);
    });

    it("shows a saved 21 as a typed day, in its place on the scale, with a cross", async () => {
      const { card } = await openPhone([21, 14]);
      expect(chips(card).map((one) => dayOf(one))).toEqual([1, 3, 7, 14, 21, 30, 60, 90]);
      const saved = chipFor(card, 21);
      expect(lit(saved)).toBe(true);
      expect(words(/** @type {Element} */ (saved))).toMatch(/×|remove/iu);
    });
  });
});

/* ── typing a number of days (desk card; the body is shared) ───────────── */
describe("typing a number of days (#1892)", () => {
  const loader = createPageLoader("reminder-days-1892-typing", {
    stub: (file) => /\/(lib\/Chrome|lib\/PageSky|routes\/create\/pocket)\.svelte$/.test(file),
    stubs: { "$lib/backdrops/constellations.js": "export const mountConstellations = () => () => {};" },
  });
  beforeAll(() => loader.setup("routes/create/+page.svelte"));
  afterAll(() => loader.teardown());
  afterEach(() => { loader.unmount(); vi.unstubAllGlobals(); });

  async function openDesk() {
    vi.stubGlobal("fetch", fixtureApi().fetch);
    vi.stubGlobal("matchMedia", matchMedia);
    await loader.mount("routes/create/+page.svelte", { data: { fixtures: true } }, { url: "http://localhost/create" });
    await settle(10);
    await press(document.getElementById("f-reminder"));
    return chooser();
  }
  const reminderValue = () => document.getElementById("f-reminder")?.textContent ?? "";
  const lineText = () => chooser()?.textContent ?? "";

  it.each(["21", "1", "365", "100"])("accepts %s: it becomes a lit chip and the field clears", async (text) => {
    const card = await openDesk();
    await typeAndAdd(card, text);
    const day = Number(text);
    expect(lit(chipFor(chooser(), day)), `${day}d is a lit chip`).toBe(true);
    expect(field(chooser())?.value, "the field clears").toBe("");
    expect(lineText()).not.toMatch(REFUSAL);
    expect(reminderValue(), "the pressed value on the form says it").toMatch(new RegExp(`\\b${day} d\\b`, "u"));
  });

  it("puts a typed day in its place on the scale, between the presets", async () => {
    const card = await openDesk();
    await typeAndAdd(card, "21");
    expect(chips(chooser()).map((one) => dayOf(one))).toEqual([1, 3, 7, 14, 21, 30, 60, 90]);
  });

  it("gives a typed day a cross, and the cross removes it", async () => {
    const card = await openDesk();
    await typeAndAdd(card, "21");
    const typed = chipFor(chooser(), 21);
    expect(words(/** @type {Element} */ (typed)), "the chip carries a cross").toMatch(/×|remove/iu);
    expect(/** @type {Element} */ (typed).getAttribute("aria-label") ?? "", "the cross says it removes").toMatch(/remove/iu);
    await press(typed);
    expect(chipFor(chooser(), 21), "the typed chip is gone, not just unlit").toBeNull();
    expect(chips(chooser()).map((one) => dayOf(one))).toEqual(PRESETS);
    expect(reminderValue()).not.toMatch(/\b21 d\b/u);
  });

  it.each([
    ["0", "zero"],
    ["-3", "a negative"],
    ["2.5", "a decimal"],
    ["366", "one past the ceiling"],
    ["400", "past the ceiling"],
    ["abc", "text"],
    ["", "a blank"],
  ])("refuses %j (%s): keeps the text, adds nothing, says the refusal line", async (text) => {
    const card = await openDesk();
    const before = chips(card).map((one) => `${dayOf(one)}:${lit(one)}`);
    await typeAndAdd(card, text);
    expect(lineText(), "the refusal in the design's words").toMatch(REFUSAL);
    expect(chips(chooser()).map((one) => `${dayOf(one)}:${lit(one)}`), "no chip was added or changed").toEqual(before);
    if (text) expect(field(chooser())?.value, "the text stays in the field").toBe(text);
    expect(field(chooser())?.getAttribute("aria-invalid"), "the field is marked invalid").toBe("true");
  });

  it("presses a preset that is off when its number is typed, and adds no twin", async () => {
    const card = await openDesk();
    expect(lit(chipFor(card, 30))).toBe(false);
    await typeAndAdd(card, "30");
    expect(lit(chipFor(chooser(), 30)), "30d comes on").toBe(true);
    expect(chips(chooser()).filter((one) => dayOf(one) === 30), "one 30d chip only").toHaveLength(1);
    expect(chips(chooser()).map((one) => dayOf(one))).toEqual(PRESETS);
    expect(field(chooser())?.value, "the field clears").toBe("");
    expect(lineText()).not.toMatch(/already chosen/iu);
  });

  it("says '14 d is already chosen' for a day already on, keeps it on, and adds no twin", async () => {
    const card = await openDesk();
    expect(lit(chipFor(card, 14))).toBe(true);
    await typeAndAdd(card, "14");
    expect(lineText()).toMatch(/14 d is already chosen/iu);
    expect(lit(chipFor(chooser(), 14)), "14d stays on: typing never turns a day off").toBe(true);
    expect(chips(chooser()).filter((one) => dayOf(one) === 14)).toHaveLength(1);
    expect(field(chooser())?.value, "the field clears").toBe("");
  });

  it("says already chosen for a typed day typed twice, without a second chip", async () => {
    const card = await openDesk();
    await typeAndAdd(card, "21");
    await typeAndAdd(chooser(), "21");
    expect(lineText()).toMatch(/21 d is already chosen/iu);
    expect(chips(chooser()).filter((one) => dayOf(one) === 21)).toHaveLength(1);
  });

  it("offers the explicit add for the typed number, as the phone's number pad needs", async () => {
    const card = await openDesk();
    await type(card, "21");
    expect(words(/** @type {Element} */ (addButton(card)))).toMatch(/add 21 ?d/iu);
  });
});

/* ── the shared body, mounted alone: a saved day that is no preset ─────── */
describe("a saved reminder at a non-preset day (#1892)", () => {
  const loader = createPageLoader("reminder-days-1892-saved");
  beforeAll(() => loader.setup("lib/editing/DayChips.svelte"));
  afterAll(() => loader.teardown());
  afterEach(() => { loader.unmount(); vi.unstubAllGlobals(); });

  it("shows a saved 21 as a typed day: lit, crossed, between 14 and 30; the presets are still seven", async () => {
    await loader.mount("lib/editing/DayChips.svelte", { days: [21, 14], due: "2026-09-04", onpick() {} });
    await settle(4);
    const root = document.body;
    expect(chips(root).map((one) => dayOf(one))).toEqual([1, 3, 7, 14, 21, 30, 60, 90]);
    const saved = chipFor(root, 21);
    expect(lit(saved)).toBe(true);
    expect(words(/** @type {Element} */ (saved))).toMatch(/×|remove/iu);
    expect(lit(chipFor(root, 14))).toBe(true);
    expect(chipFor(root, 14)?.hasAttribute("data-extra"), "a preset is not a typed day").toBe(false);
  });

  it("keeps the foot line verbatim, landing dates in calendar order", async () => {
    await loader.mount("lib/editing/DayChips.svelte", { days: [3, 14, 21], due: "2026-09-04", onpick() {} });
    await settle(4);
    expect(document.body.textContent?.replace(/\s+/gu, " ")).toMatch(/3 d, 14 d and 21 d before/u);
    expect(document.body.textContent?.replace(/\s+/gu, " ")).toMatch(/14 Aug · 21 Aug · 01 Sep/u);
  });
});
