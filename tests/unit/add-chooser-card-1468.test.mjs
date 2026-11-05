// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureApi } from "../support/fixture-api.mjs";
import { blankEntry } from "../../web/src/routes/create/entry.js";
import { createPageLoader, runtime, settle } from "../support/svelte-page.mjs";

/*
 * #1468 Part A (spec: note 53008; owner decision 43; round 6 direction Q,
 * design/v19/home-sun/round-6/q-add-chooser-card.html): the Add forms and the
 * first-run card carry no native picker. A date, a repeat, a reminder, a time
 * zone and a currency are each a pressed value (a button with
 * aria-haspopup="dialog" showing the current value) that opens the chooser
 * card (web/src/lib/editing/ChooserCard.svelte): the month calendar
 * (Calendar.svelte, role=grid), the repeat band (RepeatBand.svelte, a
 * radiogroup), the pick-list (PickList.svelte, #1338, a listbox named "Time
 * zones" or "Currencies") or tiles. The chooser card is a role=dialog named
 * "Choose <heading>".
 *
 * The real components are compiled and mounted in happy-dom (tests/support/
 * svelte-page.mjs). Every case fails today because the control is native.
 * The pressed values keep the ids their labels point at (#f-date, #f-recur,
 * #f-reminder on the desk; #tz and #cur on the arrival card; "-due" on the
 * phone), so the label still names the control.
 */

const matchMedia = (/** @type {string} */ query) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});

/** Presses an element and lets the page settle. @param {Element | null} el */
async function press(el) {
  expect(el, "the pressed value is drawn").not.toBeNull();
  /** @type {HTMLElement} */ (el).click();
  const { flushSync } = await runtime();
  flushSync();
  await settle(4);
  flushSync();
}

/** The chooser card standing now, by the name it is given. @param {RegExp} name */
const card = (name) => [...document.querySelectorAll('[role="dialog"]')]
  .find((one) => name.test(one.getAttribute("aria-label") ?? "")) ?? null;

/** Whether the card named so stands and holds the body. @param {RegExp} name @param {string} body */
const stands = (name, body) => card(name)?.querySelector(body) != null;

/** A pressed value: a real button that says it opens a dialog. @param {Element | null} el @param {string} what */
function expectPressedValue(el, what) {
  expect(el, `${what} is drawn`).not.toBeNull();
  expect(el?.tagName, `${what} is a native ${el?.tagName?.toLowerCase()}, not a pressed value`).toBe("BUTTON");
  expect(el?.getAttribute("aria-haspopup"), `${what} says it opens a dialog`).toBe("dialog");
}

/* ── desk Add (+page.svelte), direction Q ──────────────────────────────── */
describe("desk Add: key date, repeat and reminder are pressed values (#1468, Q)", () => {
  const loader = createPageLoader("add-chooser-1468-desk", {
    stub: (file) => /\/(lib\/Chrome|lib\/PageSky|routes\/create\/pocket)\.svelte$/.test(file),
    stubs: { "$lib/backdrops/constellations.js": "export const mountConstellations = () => () => {};" },
  });
  beforeAll(() => loader.setup("routes/create/+page.svelte"));
  afterAll(() => loader.teardown());
  afterEach(() => { loader.unmount(); vi.unstubAllGlobals(); });

  async function mountDesk() {
    vi.stubGlobal("fetch", fixtureApi().fetch);
    vi.stubGlobal("matchMedia", matchMedia);
    await loader.mount("routes/create/+page.svelte", { data: { fixtures: true } }, { url: "http://localhost/create" });
    await settle(10);
    return document.getElementById("card");
  }

  it("has no native select or date input in the form", async () => {
    const form = await mountDesk();
    expect(form, "the desk form (#card) is drawn").not.toBeNull();
    expect([...form?.querySelectorAll("select, input[type=date]") ?? []].map((one) => one.id)).toEqual([]);
  });

  it("draws the key date as a pressed value that opens a dialog, with no #f-date input", async () => {
    await mountDesk();
    expect(document.querySelector("input#f-date, select#f-date")).toBeNull();
    expectPressedValue(document.getElementById("f-date"), "the key date");
  });

  it("draws repeat as a pressed value showing the current repeat, with no #f-recur select", async () => {
    await mountDesk();
    expect(document.querySelector("select#f-recur, input#f-recur")).toBeNull();
    const repeat = document.getElementById("f-recur");
    expectPressedValue(repeat, "the repeat");
    expect(repeat?.textContent, "yearly is the default today").toMatch(/every 12 months|yearly/iu);
  });

  it("draws the reminder as a pressed value showing the current days, with no #f-reminder select", async () => {
    await mountDesk();
    expect(document.querySelector("select#f-reminder, input#f-reminder")).toBeNull();
    const reminder = document.getElementById("f-reminder");
    expectPressedValue(reminder, "the reminder");
    expect(reminder?.textContent, "14 days is the default first reminder").toMatch(/14\s*d.*before/iu);
  });

  it("opens the calendar, the repeat band and the day chips from those values, one card at a time", async () => {
    await mountDesk();
    await press(document.getElementById("f-date"));
    expect(stands(/^Choose key date/iu, '[role="grid"]'), "the key date opens the calendar").toBe(true);
    await press(document.getElementById("f-recur"));
    expect(card(/^Choose key date/iu), "the calendar closed for the next value").toBeNull();
    expect(stands(/^Choose repeat/iu, '[role="radiogroup"]'), "repeat opens the band").toBe(true);
    await press(document.getElementById("f-reminder"));
    const chips = card(/^Choose reminders/iu);
    expect(chips, "reminders open the day chips").not.toBeNull();
    expect([...chips?.querySelectorAll("button[aria-pressed]") ?? []].map((one) => one.textContent?.trim()))
      .toEqual(["7d", "14d", "30d", "60d", "90d"]);
    expect(chips?.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Remind me this many days before");
  });
});

/* ── phone Add (EntryForm.svelte) ──────────────────────────────────────── */
describe("phone Add: the due date is the chooser card's calendar (#1468)", () => {
  const loader = createPageLoader("add-chooser-1468-phone", {
    stub: (file) => /\/lib\/pocket\/(Sheet|Sky)\.svelte$/.test(file),
  });
  beforeAll(() => loader.setup("routes/create/EntryForm.svelte"));
  afterAll(() => loader.teardown());
  afterEach(() => { loader.unmount(); vi.unstubAllGlobals(); });

  async function mountForm() {
    vi.stubGlobal("matchMedia", matchMedia);
    const entry = blankEntry({ name: "Car MOT", householdId: "hh-1" });
    Object.assign(entry, { sectionId: "s-1", dueDate: "2026-09-02" });
    const households = [{ id: "hh-1", name: "Home", currency: "GBP",
      sections: [{ id: "s-1", name: "Vehicles", icon: "car", accent: "a", visible: true }] }];
    await loader.mount("routes/create/EntryForm.svelte", { entry, households });
    await settle(6);
  }
  const due = () => document.querySelector('[id$="-due"]');

  it("draws the due date as a pressed value, not an input type=date", async () => {
    await mountForm();
    expect(document.querySelector("input[type=date]")).toBeNull();
    expectPressedValue(due(), "the due date");
    expect(due()?.textContent, "it shows the current date").toMatch(/2 Sep(tember)? 2026/u);
  });

  it("opens the chooser card's calendar when pressed", async () => {
    await mountForm();
    await press(due());
    expect(stands(/^Choose due date/iu, '[role="grid"]'), "the calendar stands").toBe(true);
  });
});

/* ── first-run card (CreateSystem.svelte) ──────────────────────────────── */
describe("arrival: time zone and currency use the chooser card's pick-list (#1468, #1338)", () => {
  const loader = createPageLoader("add-chooser-1468-arrival");
  beforeAll(() => loader.setup("lib/arrival/CreateSystem.svelte"));
  afterAll(() => loader.teardown());
  afterEach(() => { loader.unmount(); vi.unstubAllGlobals(); });

  async function mountCard() {
    vi.stubGlobal("matchMedia", matchMedia);
    await loader.mount("lib/arrival/CreateSystem.svelte", {});
    await settle(4);
  }

  it("has no select on the card", async () => {
    await mountCard();
    expect([...document.querySelectorAll("select")].map((one) => one.id)).toEqual([]);
  });

  it("draws the time zone as a pressed value that opens the time-zone pick-list", async () => {
    await mountCard();
    expectPressedValue(document.getElementById("tz"), "the time zone");
    await press(document.getElementById("tz"));
    expect(stands(/^Choose time zone/iu, '[role="listbox"][aria-label="Time zones"]'), "the time-zone list stands").toBe(true);
  });

  it("draws the currency as a pressed value showing the code, that opens the currency pick-list", async () => {
    await mountCard();
    const currency = document.getElementById("cur");
    expectPressedValue(currency, "the currency");
    expect(currency?.textContent).toMatch(/^\s*[A-Z]{3}\b/u);
    await press(currency);
    expect(stands(/^Choose currency/iu, '[role="listbox"][aria-label="Currencies"]'), "the currency list stands").toBe(true);
  });
});
