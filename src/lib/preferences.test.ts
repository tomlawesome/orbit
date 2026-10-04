import { describe, expect, it } from "vitest";
import { defaultSections } from "./domain";
import {
  DEFAULT_THEME_PACK,
  effectiveReminderOffsets,
  legacyToThemePack,
  sectionPreferenceSchema,
  textSizes,
  themePackInfo,
  themePackOrDefault,
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

  it("rejects a theme id outside the v19 packs this schema validates", () => {
    expect(themePreferenceSchema.safeParse({ theme: "after-dark" }).success).toBe(false);
  });

  it("no longer accepts atlas, removed at #865", () => {
    expect(themePacks).not.toContain("atlas");
    expect(themePreferenceSchema.safeParse({ theme: "atlas" }).success).toBe(false);
  });

  it("defaults to after dark (#865)", () => {
    expect(DEFAULT_THEME_PACK).toBe("afterdark");
  });

  it("resolves a stored preference naming a theme that no longer exists to after dark", () => {
    expect(themePackOrDefault("atlas")).toBe("afterdark");
    expect(themePackOrDefault("not-a-real-pack")).toBe("afterdark");
    expect(themePackOrDefault(null)).toBe("afterdark");
    expect(themePackOrDefault(undefined)).toBe("afterdark");
  });

  it("still honours a valid stored preference", () => {
    for (const theme of themePacks) expect(themePackOrDefault(theme)).toBe(theme);
  });

  it("every theme pack has a name, description and three swatches", () => {
    for (const theme of themePacks) {
      expect(themePackInfo[theme].name.length).toBeGreaterThan(0);
      expect(themePackInfo[theme].description.length).toBeGreaterThan(0);
      expect(themePackInfo[theme].swatches).toHaveLength(3);
    }
  });

  it("maps every legacy colourway to its nearest theme pack (#325, #865)", () => {
    expect(legacyToThemePack("after-dark", "system")).toBe("afterdark");
    expect(legacyToThemePack("coast", "light")).toBe("dawn");
    expect(legacyToThemePack("coast", "dark")).toBe("afterdark");
    /* atlas, the light-mode nearest match for a warm accent, left the roster
       at #865 — both modes of a warm-accent legacy colourway now land on
       starchart, the one remaining warm-accent pack. */
    expect(legacyToThemePack("verdant", "system")).toBe("starchart");
    expect(legacyToThemePack("verdant", "dark")).toBe("starchart");
    expect(legacyToThemePack("ember", "light")).toBe("starchart");
    expect(legacyToThemePack("ember", "dark")).toBe("starchart");
    expect(legacyToThemePack("berry", "system")).toBe("dawn");
    expect(legacyToThemePack("berry", "dark")).toBe("afterdark");
    /* Unrecognised lands on the default pack, which #865 made after dark. */
    expect(legacyToThemePack("unknown-legacy-id", "dark")).toBe("afterdark");
  });

  it("rejects duplicate section identifiers", () => {
    expect(sectionPreferenceSchema.safeParse([defaultSections[0], defaultSections[0]]).success).toBe(false);
  });
});

describe("effectiveReminderOffsets (#1151 A4-F1)", () => {
  const recipient = { firstWarningDays: 14, finalWarningDays: 3 };

  it("returns an item's own rules furthest-out first, whatever order they were read in", () => {
    // A plain SELECT with no ORDER BY can hand rows back in either order --
    // this is the row order a reader (`warningFor`) must not be able to get
    // backwards.
    const closestFirst = effectiveReminderOffsets(
      [
        { daysBefore: 3, emailEnabled: true, pushEnabled: true },
        { daysBefore: 14, emailEnabled: true, pushEnabled: true },
      ],
      recipient,
    );
    expect(closestFirst.map((offset) => offset.daysBefore)).toEqual([14, 3]);

    const furthestFirst = effectiveReminderOffsets(
      [
        { daysBefore: 14, emailEnabled: true, pushEnabled: true },
        { daysBefore: 3, emailEnabled: true, pushEnabled: true },
      ],
      recipient,
    );
    expect(furthestFirst.map((offset) => offset.daysBefore)).toEqual([14, 3]);
  });

  it("sorts three or more of an item's own rules the same way", () => {
    const offsets = effectiveReminderOffsets(
      [
        { daysBefore: 1, emailEnabled: true, pushEnabled: true },
        { daysBefore: 30, emailEnabled: true, pushEnabled: true },
        { daysBefore: 7, emailEnabled: true, pushEnabled: true },
      ],
      recipient,
    );
    expect(offsets.map((offset) => offset.daysBefore)).toEqual([30, 7, 1]);
  });

  it("still sorts the fallback pair furthest-out first, as it always has", () => {
    const offsets = effectiveReminderOffsets([], recipient);
    expect(offsets.map((offset) => offset.daysBefore)).toEqual([14, 3]);
  });
});
