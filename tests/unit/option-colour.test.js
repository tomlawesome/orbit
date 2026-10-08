import { describe, expect, it } from "vitest";

// #1319 — a colour per section and per type (round 8). Only the shipped
// sections' fixed colours and the types' are pinned here: the rule for any
// other section is being decided again, so it is deliberately not tested.
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
