import { describe, expect, it } from "vitest";

import { dialBodiesOf, sectionKeyOf } from "../../web/src/lib/data/chart.js";
import { pocketBodiesOf } from "../../web/src/routes/home/pocket-dial.js";
import { SECTION_COLOURS } from "../../web/src/lib/option-colour.js";
import { WORKSPACE_FIXTURE, WORKSPACE_FIXTURE_TODAY } from "../../web/src/lib/data/fixtures/workspace.js";

/*
 * #1466 (colour part), spec section 3: a planet wears its section's colour.
 *
 * Names this file fixes for the build (the spec leaves them open):
 *  - every ChartBody from `dialBodiesOf` carries `sectionColour`: the colour
 *    name sectionColourOf gives its section ("home" | "vehicles" | "devices" |
 *    "services"), or null when the section is unknown (not yet loaded: the
 *    paint falls back to --ink-2) and for a suggestion (it has no section).
 *    The desk, the pocket (`pocketBodiesOf` filters the same bodies) and the
 *    Settings preview (SkyPreview.svelte, same two functions) all read it.
 *  - `sectionKeyOf(sections, bodies?)`, exported from chart.js, is the key
 *    under the sky: `{ colour: string, name: string }[]`, one per colour worn
 *    by any visible section (not by planets; bodies are accepted and ignored),
 *    in SECTION_COLOURS order, named for EVERY visible section that wears the
 *    colour (owner answer 12a), in position order, joined with " · ". The
 *    sections carry no `position` field: array order is position order, and
 *    callers (home, pocket) pass the household's sections as stored.
 */
const TODAY = WORKSPACE_FIXTURE_TODAY;

const item = (id, sectionId, dueDate, extra = {}) => ({
  id, title: id, sectionId, status: "active", dueDate, subtype: "service", scheduleKind: "service",
  kind: "service", costMinor: 5000, currency: "GBP", recurrenceMonths: 12, ...extra,
});

const SECTIONS = [
  { id: "s-home", name: "Home", icon: "home", accent: "sage", visible: true },
  { id: "s-vehicles", name: "Vehicles", icon: "vehicle", accent: "blue", visible: true },
  { id: "s-devices", name: "Devices", icon: "device", accent: "sand", visible: true },
  { id: "s-services", name: "Services", icon: "service", accent: "plum", visible: true },
];
const ONE_PER_SECTION = [
  item("i-h", "s-home", "2026-08-20"), item("i-v", "s-vehicles", "2026-08-30"),
  item("i-d", "s-devices", "2026-09-30"), item("i-s", "s-services", "2026-12-30"),
];
const household = (items, sections = SECTIONS) => ({ id: "hh", name: "Test", sections, items });
const bodyOf = (bodies, id) => bodies.find((b) => b.id === id);

describe("dialBodiesOf: each body wears its section's colour", () => {
  it("gives every body the colour of its section", () => {
    const bodies = dialBodiesOf(household(ONE_PER_SECTION), { today: TODAY });
    expect(bodies.map((b) => [b.id, b.sectionColour]).sort()).toEqual([
      ["i-d", "devices"], ["i-h", "home"], ["i-s", "services"], ["i-v", "vehicles"],
    ]);
  });

  it("takes a stored pick over the section's mark and shipped id", () => {
    const picked = SECTIONS.map((s) => (s.id === "s-home" ? { ...s, colour: "vehicles" } : s));
    const bodies = dialBodiesOf(household(ONE_PER_SECTION, picked), { today: TODAY });
    expect(bodyOf(bodies, "i-h").sectionColour).toBe("vehicles");
    expect(bodyOf(bodies, "i-v").sectionColour).toBe("vehicles");
  });

  it("follows the mark for a section of the household's own with no pick", () => {
    const own = [{ id: "s-garden", name: "Garden", icon: "kite", accent: "sand", visible: true, colour: null }];
    const [body] = dialBodiesOf(household([item("i-g", "s-garden", "2026-08-30")], own), { today: TODAY });
    expect(body.sectionColour).toBe("devices");
  });

  it("is null when the section is not known (not yet loaded), and for a suggestion", () => {
    const hh = household([item("i-x", "s-gone", "2026-08-30")]);
    const bodies = dialBodiesOf(hh, { today: TODAY, suggestions: [{ id: "sug", title: "Insurance", renewsOn: "2026-09-30", costMinor: 100, currency: "GBP" }] });
    expect(bodyOf(bodies, "i-x").sectionColour).toBeNull();
    expect(bodyOf(bodies, "sug").sectionColour ?? null).toBeNull();
    expect(dialBodiesOf({ id: "hh", name: "T", items: [item("i-y", "s-home", "2026-08-30")] }, { today: TODAY })[0].sectionColour).toBeNull();
  });

  it("does not change with the urgency band: the same section, overdue or far, one colour", () => {
    const hh = household([item("late", "s-home", "2026-07-01"), item("far", "s-home", "2027-06-01")]);
    const bodies = dialBodiesOf(hh, { today: TODAY });
    expect(bodyOf(bodies, "late").sectionColour).toBe("home");
    expect(bodyOf(bodies, "far").sectionColour).toBe("home");
    expect(bodyOf(bodies, "late").paint).not.toBe(bodyOf(bodies, "far").paint); // the band stays, for the rings and the horizon
  });

  it("colours Harlow's planets by their sections", () => {
    const harlow = WORKSPACE_FIXTURE.households.find((one) => one.id === "hh-harlow-1");
    const bodies = dialBodiesOf(harlow, { today: TODAY });
    const want = { "i-gutter": "home", "i-mot": "vehicles", "i-boiler": "home", "i-chimney": "home", "i-smoke": "devices", "i-svc": "vehicles", "i-roof": "home" };
    for (const [id, colour] of Object.entries(want)) expect(bodyOf(bodies, id).sectionColour, id).toBe(colour);
  });
});

describe("pocketBodiesOf: the pocket keeps each body's colour", () => {
  it("passes the colour through the pocket's filter", () => {
    const harlow = WORKSPACE_FIXTURE.households.find((one) => one.id === "hh-harlow-1");
    const all = dialBodiesOf(harlow, { today: TODAY });
    const pocket = pocketBodiesOf(all);
    expect(pocket.length).toBeGreaterThan(0);
    for (const body of pocket) expect(body.sectionColour).toBe(bodyOf(all, body.id).sectionColour);
    expect(bodyOf(pocket, "i-gutter").sectionColour).toBe("home"); // overdue: always drawn
    expect(bodyOf(pocket, "i-mot").sectionColour).toBe("vehicles"); // closest approach: always drawn
  });
});

/* NEEDS #1463 (importance): the names below, `planetSize: "importance"` and a
   body's `hollow` flag, are #1463's, not this change's. This test cannot pass
   until both changes are in; it fails today because nothing is hollow. */
describe("under importance sizing (needs #1463)", () => {
  it("a not-set body stays hollow, and keeps its section's colour", () => {
    const set = item("i-set", "s-home", "2026-08-20", { importance: "high" });
    const notSet = item("i-notset", "s-vehicles", "2026-08-25", { importance: null });
    const bodies = dialBodiesOf(household([set, notSet]), { today: TODAY, planetSize: "importance" });
    expect(bodyOf(bodies, "i-notset").hollow).toBe(true);
    expect(bodyOf(bodies, "i-notset").sectionColour).toBe("vehicles");
    expect(bodyOf(bodies, "i-set").hollow).toBeFalsy();
    expect(bodyOf(bodies, "i-set").sectionColour).toBe("home");
    expect(bodyOf(pocketBodiesOf(bodies), "i-notset")?.sectionColour ?? "vehicles").toBe("vehicles");
  });
});

describe("sectionKeyOf: the key under the sky", () => {
  const keyOf = (sections) => sectionKeyOf(sections);

  it("reads Home, Vehicles, Devices, Services for the four default sections", () => {
    expect(keyOf(SECTIONS)).toEqual([
      { colour: "home", name: "Home" }, { colour: "vehicles", name: "Vehicles" },
      { colour: "devices", name: "Devices" }, { colour: "services", name: "Services" },
    ]);
  });

  it("lists Harlow's four although no Harlow planet is in Services (colours of sections, not planets); Dates & renewals shares Home's colour", () => {
    const harlow = WORKSPACE_FIXTURE.households.find((one) => one.id === "hh-harlow-1");
    expect(sectionKeyOf(harlow.sections).map((one) => one.name)).toEqual(["Home · Dates & renewals", "Vehicles", "Devices", "Services"]);
    // bodies are optional and change nothing
    const bodies = dialBodiesOf(harlow, { today: TODAY });
    expect(sectionKeyOf(harlow.sections, bodies)).toEqual(sectionKeyOf(harlow.sections));
  });

  it("keeps SECTION_COLOURS order whatever the order of the sections", () => {
    expect(keyOf([...SECTIONS].reverse()).map((one) => one.colour)).toEqual([...SECTION_COLOURS]);
  });

  it("leaves out a colour no visible section wears", () => {
    expect(keyOf(SECTIONS.filter((one) => one.id !== "s-services")).map((one) => one.name)).toEqual(["Home", "Vehicles", "Devices"]);
    expect(keyOf(SECTIONS.map((one) => (one.id === "s-services" ? { ...one, visible: false } : one))).map((one) => one.name)).toEqual(["Home", "Vehicles", "Devices"]);
    expect(keyOf([])).toEqual([]);
  });

  it("follows a pick: Home picked 'vehicles' leaves Home's own dot out and names vehicles for Home and Vehicles", () => {
    const picked = SECTIONS.map((s) => (s.id === "s-home" ? { ...s, colour: "vehicles" } : s));
    expect(keyOf(picked)).toEqual([
      { colour: "vehicles", name: "Home · Vehicles" }, { colour: "devices", name: "Devices" }, { colour: "services", name: "Services" },
    ]);
  });

  it("names a shared colour for every visible section that wears it, in position order, joined with ' · '", () => {
    const shared = [
      { id: "s-a", name: "Allotment", icon: "home", accent: "sage", visible: false },   // hidden: left out of its colour's label
      { id: "s-b", name: "Boat", icon: "vehicle", accent: "blue", visible: true, colour: "home" },
      { id: "s-c", name: "Cellar", icon: "calendar", accent: "coral", visible: true },  // calendar mark: home colour
      { id: "s-d", name: "Dens", icon: "device", accent: "sand", visible: true, colour: "home" },
    ];
    expect(keyOf(shared)).toEqual([{ colour: "home", name: "Boat · Cellar · Dens" }]);
  });

  it("lists the sections of a shared colour in the order given, not alphabetically", () => {
    const shared = [
      { id: "s-z", name: "Zed", icon: "vehicle", visible: true, colour: "services" },
      { id: "s-a", name: "Alpha", icon: "device", visible: true, colour: "services" },
      { id: "s-m", name: "Mid", icon: "home", visible: true, colour: "home" },
    ];
    expect(keyOf(shared)).toEqual([{ colour: "home", name: "Mid" }, { colour: "services", name: "Zed · Alpha" }]);
  });

  it("leaves a hidden section out of its colour's label, and the colour out when only hidden ones wear it", () => {
    const sections = SECTIONS.map((one) => (one.id === "s-devices" ? { ...one, colour: "vehicles" } : one))
      .concat([{ id: "s-x", name: "Hidden", icon: "home", visible: false, colour: "vehicles" }, { id: "s-y", name: "Ghost", icon: "home", visible: false, colour: "services" }])
      .map((one) => (one.id === "s-services" ? { ...one, visible: false } : one));
    expect(keyOf(sections)).toEqual([{ colour: "home", name: "Home" }, { colour: "vehicles", name: "Vehicles · Devices" }]);
  });

  it("skips a section whose colour is unknown (no mark Orbit knows, no pick)", () => {
    expect(keyOf([{ id: "s-x", name: "Odd", icon: "anchor", visible: true }])).toEqual([]);
  });
});
