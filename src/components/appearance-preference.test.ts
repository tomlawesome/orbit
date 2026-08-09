import { describe, expect, it } from "vitest";
import { resolvePersistedThemePreference, type AppearanceSessionUser } from "./appearance-preference";

const currentUser: AppearanceSessionUser = {
  id: "synthetic-current-user",
  themeMode: "dark",
  themeId: "coast",
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
      mode: "dark",
      colourway: "coast",
      textSize: "large",
      urgencyPalette: "themed",
    });
  });

  it("uses the safe default while no session user is known", () => {
    expect(resolvePersistedThemePreference(staleCachedTheme, undefined, "synthetic-previous-user")).toMatchObject({
      mode: "system",
      colourway: "after-dark",
      textSize: "comfortable",
      urgencyPalette: "themed",
    });
  });

  it("keeps same-user local optimistic changes after hydration", () => {
    const optimistic = JSON.stringify({
      ...currentUser,
      mode: currentUser.themeMode,
      colourway: currentUser.themeId,
      textSize: "extra-large",
    });
    expect(resolvePersistedThemePreference(optimistic, currentUser, currentUser.id)).toMatchObject({
      textSize: "extra-large",
    });
  });
});
