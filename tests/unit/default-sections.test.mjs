import { describe, expect, it } from "vitest";
import { defaultSections } from "../../src/lib/domain.ts";
import { createHousehold } from "../../src/lib/workspace.ts";

// #1466 (colour part), owner 2026-11-05: "a new household keeps the four
// default sections: Home, Vehicles, Devices, Services". This pins it, so the
// colour change cannot add, drop or reorder one. A pin, so it passes today.
describe("the default sections", () => {
  it("are Home, Vehicles, Devices, Services, in that order", () => {
    expect(defaultSections.map((section) => section.name)).toEqual(["Home", "Vehicles", "Devices", "Services"]);
    expect(defaultSections.map((section) => section.id)).toEqual(["home", "vehicle", "device", "service"]);
    expect(defaultSections.map((section) => section.icon)).toEqual(["home", "vehicle", "device", "service"]);
    expect(defaultSections.every((section) => section.visible)).toBe(true);
  });

  it("are what a new household gets", () => {
    const household = createHousehold({ id: "hh-new", name: "New place" });
    expect(household.sections.map((section) => section.name)).toEqual(["Home", "Vehicles", "Devices", "Services"]);
  });

  it("choose no colour of their own: each follows its mark until a member picks one", () => {
    for (const section of defaultSections) expect(section.colour ?? null).toBeNull();
    const household = createHousehold({ id: "hh-new", name: "New place" });
    for (const section of household.sections) expect(section.colour ?? null).toBeNull();
  });
});
