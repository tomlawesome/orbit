import { describe, expect, it } from "vitest";

import { sectionCommandsOf, sectionRowsOf } from "../../web/src/lib/data/household.js";

/*
 * #1466 (colour part), spec sections 1 and 4: the sections editor's rows carry
 * the section's stored colour and the whole-list command sends it back, so a
 * pick travels with the list and an untouched pick is not lost by a rename.
 * A section that has none reads as null (the row's `colour`), and the editor
 * shows the effective colour (the mark's, via sectionColourOf) as checked.
 */
const household = (sections) => ({ id: "hh", name: "H", items: [], sections });
const section = (extra) => ({ id: "s-garden", name: "Garden", icon: "kite", accent: "sand", visible: true, ...extra });

describe("the editor's rows", () => {
  it("carry the stored colour", () => {
    const [row] = sectionRowsOf(household([section({ colour: "services" })]));
    expect(row.colour).toBe("services");
  });

  it("read null for a section with none, stored as null or missing", () => {
    const rows = sectionRowsOf(household([section({ colour: null }), section({ id: "s-b" })]));
    expect(rows.map((row) => row.colour ?? null)).toEqual([null, null]);
  });
});

describe("the sections.replace command", () => {
  it("sends each section's colour with it", () => {
    const rows = sectionRowsOf(household([section({ colour: "services" }), section({ id: "s-b", name: "Boat", colour: "home" })]));
    const [command] = sectionCommandsOf("hh", rows);
    expect(command.sections.map((one) => [one.id, one.colour])).toEqual([["s-garden", "services"], ["s-b", "home"]]);
  });

  it("sends a picked colour, even the one the mark would give, and keeps it through a rename", () => {
    const rows = sectionRowsOf(household([section({ id: "s-cal", icon: "calendar", colour: null })]));
    rows[0].colour = "home"; // the editor's pick: stored although the calendar mark gives home anyway
    rows[0].name = "Cellar";
    const [command] = sectionCommandsOf("hh", rows);
    expect(command.sections[0]).toMatchObject({ id: "s-cal", name: "Cellar", colour: "home" });
  });

  it("does not invent a colour for a section that has none: the engine reads the wrong kind as invalid", () => {
    const rows = sectionRowsOf(household([section({ colour: null })]));
    const [command] = sectionCommandsOf("hh", rows);
    for (const one of command.sections) expect(["vehicles", "home", "devices", "services", null, undefined]).toContain(one.colour);
    expect(command.sections[0].colour ?? null).toBeNull();
  });

  it("sends the colour in the drop commands that carry moveItemsTo too", () => {
    const rows = sectionRowsOf(household([section({ colour: "devices" }), section({ id: "s-b", name: "Boat", colour: "vehicles" })]));
    rows[1].removed = true;
    rows[1].moveTo = "s-garden";
    const commands = sectionCommandsOf("hh", rows);
    const withDestination = commands.find((one) => one.moveItemsTo);
    expect(withDestination.sections.map((one) => one.colour)).toEqual(["devices"]);
  });
});
