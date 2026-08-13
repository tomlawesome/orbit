import { describe, expect, it } from "vitest";
import { defaultSections } from "./domain";
import {
  legacyToThemePack,
  sectionPreferenceSchema,
  textSizes,
  themePackInfo,
  themePacks,
  themePreferenceSchema,
} from "./preferences";

describe("personalisation preferences", () => {
  it("provides the four original sections as defaults", () => {
    expect(defaultSections.map((section) => section.name)).toEqual(["Home", "Vehicles", "Devices", "Services"]);
    expect(sectionPreferenceSchema.safeParse(defaultSections).success).toBe(true);
  });

  it("supports every theme pack in every text size", () => {
    for (const theme of themePacks) {
      for (const textSize of textSizes) {
        expect(themePreferenceSchema.safeParse({
          theme,
          textSize,
          emailNotifications: true,
          pushNotifications: true,
        }).success).toBe(true);
      }
    }
  });

  it("adds readable defaults to a minimal theme preference", () => {
    expect(themePreferenceSchema.parse({ theme: "starchart" })).toMatchObject({
      textSize: "comfortable",
      emailNotifications: true,
      pushNotifications: true,
    });
  });

  it("rejects a theme id outside the four v19 packs", () => {
    expect(themePreferenceSchema.safeParse({ theme: "after-dark" }).success).toBe(false);
  });

  it("every theme pack has a name, description and three swatches", () => {
    for (const theme of themePacks) {
      expect(themePackInfo[theme].name.length).toBeGreaterThan(0);
      expect(themePackInfo[theme].description.length).toBeGreaterThan(0);
      expect(themePackInfo[theme].swatches).toHaveLength(3);
    }
  });

  it("maps every legacy colourway to its nearest theme pack (#325)", () => {
    expect(legacyToThemePack("after-dark", "system")).toBe("afterdark");
    expect(legacyToThemePack("coast", "light")).toBe("dawn");
    expect(legacyToThemePack("coast", "dark")).toBe("afterdark");
    expect(legacyToThemePack("verdant", "system")).toBe("atlas");
    expect(legacyToThemePack("verdant", "dark")).toBe("starchart");
    expect(legacyToThemePack("ember", "light")).toBe("atlas");
    expect(legacyToThemePack("ember", "dark")).toBe("starchart");
    expect(legacyToThemePack("berry", "system")).toBe("dawn");
    expect(legacyToThemePack("berry", "dark")).toBe("afterdark");
    expect(legacyToThemePack("unknown-legacy-id", "dark")).toBe("starchart");
  });

  it("rejects duplicate section identifiers", () => {
    expect(sectionPreferenceSchema.safeParse([defaultSections[0], defaultSections[0]]).success).toBe(false);
  });
});
