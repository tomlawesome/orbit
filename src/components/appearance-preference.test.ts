import { describe, expect, it } from "vitest";
import { resolvePersistedThemePreference, type AppearanceSessionUser } from "./appearance-preference";

const currentUser: AppearanceSessionUser = {
  id: "synthetic-current-user",
  themeMode: "dark",
  themeId: "afterdark",
  textSize: "large",
  urgencyPalette: "themed",
  emailNotifications: true,
  pushNotifications: true,
};

const staleCachedTheme = JSON.stringify({
  mode: "light",
  colourway: "berry",
  textSize: "standard",
  urgencyPalette: "classic",
  emailNotifications: false,
  pushNotifications: false,
});

describe("persisted appearance ownership", () => {
  it("uses the current session preference before a stale cache can be reused", () => {
    expect(resolvePersistedThemePreference(staleCachedTheme, currentUser, "synthetic-previous-user")).toMatchObject({
      theme: "afterdark",
      textSize: "large",
    });
  });

  it("uses the safe default while no session user is known", () => {
    expect(resolvePersistedThemePreference(staleCachedTheme, undefined, "synthetic-previous-user")).toMatchObject({
      theme: "starchart",
      textSize: "comfortable",
    });
  });

  it("keeps same-user local optimistic changes after hydration", () => {
    const optimistic = JSON.stringify({
      ...currentUser,
      theme: currentUser.themeId,
      textSize: "extra-large",
    });
    expect(resolvePersistedThemePreference(optimistic, currentUser, currentUser.id)).toMatchObject({
      textSize: "extra-large",
    });
  });

  it("migrates a legacy colourway + mode cache to the nearest theme pack", () => {
    // "berry" + "light" -> dawn, per the documented legacy mapping (#325).
    expect(resolvePersistedThemePreference(staleCachedTheme, currentUser, currentUser.id)).toMatchObject({
      theme: "dawn",
      textSize: "standard",
    });
  });

  it("migrates a legacy session row (themeId/themeMode) to the nearest theme pack", () => {
    const legacySessionUser: AppearanceSessionUser = {
      ...currentUser,
      id: "legacy-session-user",
      themeId: "verdant",
      themeMode: "dark",
    };
    expect(resolvePersistedThemePreference(staleCachedTheme, legacySessionUser, "synthetic-previous-user")).toMatchObject({
      theme: "starchart",
    });
  });
});
