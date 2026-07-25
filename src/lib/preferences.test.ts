import { describe, expect, it } from "vitest";
import { defaultSections } from "./domain";
import { colourways, sectionPreferenceSchema, themeModes, themePreferenceSchema } from "./preferences";

describe("personalisation preferences", () => {
  it("provides the four original sections as defaults", () => {
    expect(defaultSections.map((section) => section.name)).toEqual(["Home", "Vehicles", "Devices", "Services"]);
    expect(sectionPreferenceSchema.safeParse(defaultSections).success).toBe(true);
  });

  it("supports every colourway in every display mode", () => {
    for (const colourway of colourways) {
      for (const mode of themeModes) {
        expect(themePreferenceSchema.safeParse({ colourway: colourway.id, mode }).success).toBe(true);
      }
    }
  });

  it("rejects duplicate section identifiers", () => {
    expect(sectionPreferenceSchema.safeParse([defaultSections[0], defaultSections[0]]).success).toBe(false);
  });
});
