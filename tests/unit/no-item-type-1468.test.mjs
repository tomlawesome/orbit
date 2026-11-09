// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureApi } from "../support/fixture-api.mjs";
import * as entryModule from "../../web/src/routes/create/entry.js";
import { blankEntry, createCommandOf, entryOf, entryOfProposal, reviewItemOf } from "../../web/src/routes/create/entry.js";
import * as draftModule from "../../web/src/lib/editing/item-draft.js";
import { chooserAskOf, draftOf, editsOf } from "../../web/src/lib/editing/item-draft.js";
import * as held from "../../web/src/lib/data/held-document.js";
import { dialBodiesOf, manifestRowOf } from "../../web/src/lib/data/chart.js";
import { createPageLoader, settle } from "../support/svelte-page.mjs";

/*
 * ADR-0043 (#1466 note 53014 section 5, #1468 Part B): the browser asks
 * for a date and how it repeats, and nothing names a type. Each case fails
 * today because the type is still there.
 */

const matchMedia = (/** @type {string} */ query) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});

/* ── the create command ────────────────────────────────────────────────── */
describe("createCommandOf sends no kind", () => {
  const where = { householdId: "hh-1", currency: "GBP", id: "11111111-1111-4111-8111-111111111111" };
  const filled = (over = {}) => ({ ...blankEntry({ name: "Boiler cover", householdId: "hh-1" }), sectionId: "s-1", dueDate: "2026-12-20", ...over });

  it("has no kind on the command or on the item, with a date and every 12 months", () => {
    const command = createCommandOf(filled({ recurrence: 12 }), where);
    expect(command).not.toHaveProperty("kind");
    expect(command.item).not.toHaveProperty("kind");
    expect(command.item).not.toHaveProperty("subtype");
    expect(command.item).not.toHaveProperty("scheduleKind");
    expect(command).toMatchObject({ type: "item.upsert", householdId: "hh-1", item: { dueDate: "2026-12-20", recurrenceMonths: 12 } });
  });

  it("sends no kind even when a stale entry still carries one", () => {
    const command = createCommandOf({ ...filled(), kind: "inspection" }, where);
    expect(command).not.toHaveProperty("kind");
    expect(command.item).not.toHaveProperty("kind");
  });

  it("an entry holds no kind: blank, from an item, from a proposal, or as reviewed", () => {
    expect(blankEntry()).not.toHaveProperty("kind");
    expect(entryOf({ title: "MOT", kind: "inspection", dueDate: "2026-11-01" })).not.toHaveProperty("kind");
    expect(entryOfProposal({ title: "Policy", kind: "renewal" })).not.toHaveProperty("kind");
    expect(reviewItemOf({ ...filled(), kind: "service" }, "GBP")).not.toHaveProperty("kind");
  });

  it("entry.js exports no kind vocabulary", () => {
    for (const name of ["KINDS", "kindHasDate", "kindRecurs"]) expect(entryModule, name).not.toHaveProperty(name);
  });
});

/* ── the edit drawer's draft ───────────────────────────────────────────── */
describe("the edit drawer has no type chooser", () => {
  const stored = {
    id: "i1", householdId: "h1", sectionId: "vehicle", title: "MOT", subtype: "inspection", scheduleKind: "service",
    dueDate: "2026-11-01", recurrenceMonths: 12, currency: "GBP", reminderDays: [21, 7], status: "active",
  };
  const sections = [{ id: "vehicle", name: "Vehicles", icon: "car", visible: true }];

  it("draftOf holds no kind key, whatever the item says", () => {
    expect(draftOf(stored)).not.toHaveProperty("kind");
    expect(draftOf({ ...stored, kind: "inspection" })).not.toHaveProperty("kind");
  });

  it("editsOf sends no kind, and still never the engine's own subtype or schedule", () => {
    const edits = editsOf(draftOf(stored));
    expect(edits).not.toHaveProperty("kind");
    expect(edits).not.toHaveProperty("subtype");
    expect(edits).not.toHaveProperty("scheduleKind");
    expect(edits).toMatchObject({ dueDate: "2026-11-01", recurrenceMonths: 12 });
  });

  it("offers no type tiles and answers no 'type' chooser ask", () => {
    for (const name of ["TYPES", "typeChoices"]) expect(draftModule, name).not.toHaveProperty(name);
    const ask = chooserAskOf({ key: "type", label: "type" }, draftOf(stored), sections, "2026-10-08");
    expect(ask?.heading).not.toBe("type");
  });
});

/* ── the held hand-over from the home drawer ───────────────────────────── */
describe("held-document exports no held type", () => {
  it("has holdType and takeHeldType gone", () => {
    expect(held).not.toHaveProperty("holdType");
    expect(held).not.toHaveProperty("takeHeldType");
  });

  it("still hands a held file across once, and empties after taking it (#1243)", () => {
    const file = new File(["x"], "policy.pdf", { type: "application/pdf" });
    held.holdDocument(file);
    expect(held.takeHeldDocument()).toBe(file);
    expect(held.takeHeldDocument()).toBeNull();
  });
});

/* ── the chart: an expiry is told by its schedule kind alone ───────────── */
describe("the chart tells an expiry by scheduleKind, never by a kind", () => {
  const TODAY = "2026-08-13";
  const item = (over = {}) => ({
    id: "i-1", title: "Thing", sectionId: "s-home", status: "active", currency: "GBP", dueDate: "2026-07-20", ...over,
  });
  const household = (...items) => ({ id: "hh-1", sections: [{ id: "s-home", name: "Home" }], items, activities: [] });
  const past = "2026-07-20";

  it("an expiry past its date is ended, whatever kind a payload might still carry", () => {
    const home = household();
    for (const kind of [undefined, "service", "renewal"]) {
      expect(manifestRowOf(home, item({ scheduleKind: "expiry", kind, dueDate: past }), TODAY).band, `kind ${kind}`).toBe("ended");
    }
  });

  it("a renewal or service past its date is overdue, even when a stale kind says document", () => {
    const home = household();
    for (const scheduleKind of ["renewal", "service"]) {
      for (const kind of [undefined, "document"]) {
        expect(manifestRowOf(home, item({ scheduleKind, kind, subtype: "document", dueDate: past, recurrenceMonths: 12 }), TODAY).band, `${scheduleKind}/${kind}`).toBe("overdue");
      }
    }
  });

  it("dial bodies follow the same rule: only an expiry stops being owed", () => {
    const bodies = dialBodiesOf(household(
      item({ id: "e", scheduleKind: "expiry", dueDate: past }),
      item({ id: "r", scheduleKind: "renewal", kind: "document", dueDate: past }),
    ), { today: TODAY });
    expect(bodies.find((body) => body.id === "e")).toMatchObject({ overdue: false });
    expect(bodies.find((body) => body.id === "r")).toMatchObject({ overdue: true });
  });

  it("a row carries no kind of the five-kind vocabulary", () => {
    const row = manifestRowOf(household(), item({ scheduleKind: "service", subtype: "inspection", kind: "inspection", dueDate: "2026-09-20" }), TODAY);
    expect(["inspection", "document", "suggestion"]).not.toContain(row.kind);
  });
});

/* ── desk Add ──────────────────────────────────────────────────────────── */
describe("desk Add has no type group; the date and the repeat are always shown (ADR-0043)", () => {
  const loader = createPageLoader("no-item-type-1468-desk", {
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
  }

  it("draws no #types group and no type chips", async () => {
    await mountDesk();
    expect(document.getElementById("types")).toBeNull();
    expect(document.querySelector("[data-type]")).toBeNull();
    expect(document.getElementById("card")?.textContent ?? "").not.toMatch(/\b(inspection|suggestion)\b/u);
  });

  it("shows the key date and the repeat before anything is chosen", async () => {
    await mountDesk();
    expect(document.getElementById("f-date"), "the date is drawn with no type pressed").not.toBeNull();
    expect(document.getElementById("f-recur"), "the repeat is drawn with no type pressed").not.toBeNull();
  });
});

/* ── phone Add ─────────────────────────────────────────────────────────── */
describe("phone Add has no type group; the date and the repeat are always shown (ADR-0043)", () => {
  const loader = createPageLoader("no-item-type-1468-phone", {
    stub: (file) => /\/lib\/pocket\/(Sheet|Sky)\.svelte$/.test(file),
  });
  beforeAll(() => loader.setup("routes/create/EntryForm.svelte"));
  afterAll(() => loader.teardown());
  afterEach(() => { loader.unmount(); vi.unstubAllGlobals(); });

  async function mountForm() {
    vi.stubGlobal("matchMedia", matchMedia);
    const entry = blankEntry({ name: "Car MOT", householdId: "hh-1" });
    Object.assign(entry, { sectionId: "s-1" });
    const households = [{ id: "hh-1", name: "Home", currency: "GBP",
      sections: [{ id: "s-1", name: "Vehicles", icon: "car", accent: "a", visible: true }] }];
    await loader.mount("routes/create/EntryForm.svelte", { entry, households });
    await settle(6);
  }

  it("draws no .pc-kinds group and no type heading", async () => {
    await mountForm();
    expect(document.querySelector(".pc-kinds")).toBeNull();
    expect(document.querySelector('[id$="-type"]')).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/\b(inspection|suggestion)\b/u);
  });

  it("shows the due date and how it repeats with no type chosen", async () => {
    await mountForm();
    expect(document.querySelector('[id$="-due"]'), "the date is drawn").not.toBeNull();
    expect(document.querySelector(".pc-stepper, .pc-recur"), "the repeat is drawn").not.toBeNull();
  });
});
