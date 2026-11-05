import { describe, expect, it } from "vitest";

// #1319 — a colour per section and per type (round 8). Only the shipped
// sections' own colours, a household's own sections by their mark, and the
// types'.
import { SECTION_COLOURS, TYPE_COLOURS, sectionColourOf, typeColourOf } from "../../web/src/lib/option-colour.js";
import { SHIPPED_SECTION_IDS } from "../../web/src/lib/marks.js";

describe("the colour names", () => {
  it("are four sections and three types, in round 8's order", () => {
    expect(SECTION_COLOURS).toEqual(["home", "vehicles", "devices", "services"]);
    expect(TYPE_COLOURS).toEqual(["service", "renewal", "inspection"]);
  });
});

describe("sectionColourOf, for the shipped sections", () => {
  it("gives each shipped section its own colour", () => {
    expect(sectionColourOf({ id: "home" })).toBe("home");
    expect(sectionColourOf({ id: "vehicle" })).toBe("vehicles");
    expect(sectionColourOf({ id: "device" })).toBe("devices");
    expect(sectionColourOf({ id: "service" })).toBe("services");
  });

  it("covers every shipped id, each with a different section colour", () => {
    const colours = [...SHIPPED_SECTION_IDS].map((id) => sectionColourOf({ id }));
    expect(colours.every((c) => SECTION_COLOURS.includes(c))).toBe(true);
    expect(new Set(colours).size).toBe(SHIPPED_SECTION_IDS.size);
  });

  it("goes by the id, whatever mark the section wears or its name", () => {
    expect(sectionColourOf({ id: "vehicle", icon: "kite" })).toBe("vehicles");
    expect(sectionColourOf({ id: "home", icon: "service" })).toBe("home");
    expect(sectionColourOf({ id: "service", icon: null })).toBe("services");
  });

  it("has none without a section", () => {
    expect(sectionColourOf(null)).toBeNull();
    expect(sectionColourOf(undefined)).toBeNull();
    expect(sectionColourOf({})).toBeNull();
    expect(sectionColourOf({ id: null, icon: null })).toBeNull();
    expect(sectionColourOf({ id: "", icon: "" })).toBeNull();
  });
});

describe("sectionColourOf, for a household's own sections", () => {
  it("takes the colour of its mark, the vocabulary's order cycling the four", () => {
    const marks = ["calendar", "hook", "kite", "ladle", "cross", "bow", "wedge", "belt"];
    const want = ["home", "vehicles", "devices", "services", "home", "vehicles", "devices", "services"];
    expect(marks.map((icon) => sectionColourOf({ id: "s-garden", icon }))).toEqual(want);
  });

  it("wears a shipped mark's colour on a new section", () => {
    expect(sectionColourOf({ id: "s-boat", icon: "vehicle" })).toBe("vehicles");
  });

  it("has none with no mark, or a mark Orbit does not know", () => {
    expect(sectionColourOf({ id: "s-garden" })).toBeNull();
    expect(sectionColourOf({ id: "s-garden", icon: "anchor" })).toBeNull();
  });

  it("follows the mark alone: the same mark on two sections, the same colour", () => {
    expect(sectionColourOf({ id: "s-a", icon: "kite" })).toBe(sectionColourOf({ id: "s-b", icon: "kite" }));
  });
});

// #1466 (colour part): a section's stored `colour` is the member's pick in the
// sections editor, and it wins over everything else; null (or absent) falls back
// to the rule above, the shipped id and then the mark.
describe("sectionColourOf, with a stored colour", () => {
  it("wins over the shipped id", () => {
    expect(sectionColourOf({ id: "home", icon: "home", colour: "services" })).toBe("services");
    expect(sectionColourOf({ id: "vehicle", colour: "home" })).toBe("home");
  });

  it("wins over the mark", () => {
    expect(sectionColourOf({ id: "s-garden", icon: "kite", colour: "vehicles" })).toBe("vehicles");
  });

  it("holds when the section is re-marked, because the pick does not move", () => {
    const picked = { id: "s-garden", colour: "services" };
    for (const icon of ["calendar", "hook", "kite", "ladle", "home"]) {
      expect(sectionColourOf({ ...picked, icon })).toBe("services");
    }
  });

  it("holds even when it is the colour the mark would give anyway", () => {
    expect(sectionColourOf({ id: "s-garden", icon: "calendar", colour: "home" })).toBe("home");
  });

  it("gives a section with no id or mark its pick", () => {
    expect(sectionColourOf({ colour: "devices" })).toBe("devices");
  });

  it("falls back to today's rule when the colour is null or absent", () => {
    expect(sectionColourOf({ id: "vehicle", icon: "vehicle", colour: null })).toBe("vehicles");
    expect(sectionColourOf({ id: "s-garden", icon: "kite", colour: null })).toBe("devices");
    expect(sectionColourOf({ id: "s-garden", icon: "kite" })).toBe("devices");
    expect(sectionColourOf({ id: "s-garden", colour: null })).toBeNull();
  });

  it("has none without a section, whatever else is passed", () => {
    expect(sectionColourOf(null)).toBeNull();
    expect(sectionColourOf({ colour: null })).toBeNull();
  });
});

describe("typeColourOf", () => {
  it("gives service, renewal and inspection their own", () => {
    expect(typeColourOf("service")).toBe("service");
    expect(typeColourOf("renewal")).toBe("renewal");
    expect(typeColourOf("inspection")).toBe("inspection");
  });

  it("has none for any other subtype", () => {
    expect(typeColourOf("document")).toBeNull();
    expect(typeColourOf("suggestion")).toBeNull();
    expect(typeColourOf("Service")).toBeNull();
    expect(typeColourOf("")).toBeNull();
    expect(typeColourOf(null)).toBeNull();
    expect(typeColourOf(undefined)).toBeNull();
  });
});
