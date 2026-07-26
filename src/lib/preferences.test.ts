import { describe, expect, it } from "vitest";
import { defaultSections } from "./domain";
import {
  colourways,
  sectionPreferenceSchema,
  textSizes,
  themeModes,
  themePreferenceSchema,
  urgencyPalettes,
} from "./preferences";

describe("personalisation preferences", () => {
  it("provides the four original sections as defaults", () => {
    expect(defaultSections.map((section) => section.name)).toEqual(["Home", "Vehicles", "Devices", "Services"]);
    expect(sectionPreferenceSchema.safeParse(defaultSections).success).toBe(true);
  });

  it("supports every colourway in every display mode", () => {
    for (const colourway of colourways) {
      for (const mode of themeModes) {
        for (const textSize of textSizes) {
          for (const urgencyPalette of urgencyPalettes) {
            expect(themePreferenceSchema.safeParse({
              colourway: colourway.id,
              mode,
              textSize,
              urgencyPalette,
            }).success).toBe(true);
          }
        }
      }
    }
  });

  it("adds readable defaults to legacy theme preferences", () => {
    expect(themePreferenceSchema.parse({ colourway: "after-dark", mode: "system" })).toMatchObject({
      textSize: "comfortable",
      urgencyPalette: "themed",
    });
  });

  it("rejects duplicate section identifiers", () => {
    expect(sectionPreferenceSchema.safeParse([defaultSections[0], defaultSections[0]]).success).toBe(false);
  });
});
