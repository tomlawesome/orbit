"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { PREFERENCE_EVENT, storePreference, THEME_STORAGE_KEY } from "@/components/dashboard-utils";
import { legacyToThemePack, themePacks, themePreferenceSchema, type ThemePack, type ThemePreference } from "@/lib/preferences";
import type { WorkspaceSession } from "@/lib/preview-workspace";

const DEFAULT_THEME: ThemePreference = {
  theme: "starchart",
  textSize: "comfortable",
  emailNotifications: true,
  pushNotifications: true,
};
const DEFAULT_THEME_JSON = JSON.stringify(DEFAULT_THEME);
const THEME_SESSION_HYDRATED_KEY = "orbit:theme-session-user:v1";

export type AppearanceSessionUser = Pick<WorkspaceSession["user"],
  "id" | "themeMode" | "themeId" | "textSize" | "urgencyPalette" | "emailNotifications" | "pushNotifications"
>;

function isThemePack(value: string): value is ThemePack {
  return (themePacks as readonly string[]).includes(value);
}

function useLocalStorageValue(key: string, fallback: string): string {
  const subscribe = useCallback((onStoreChange: () => void) => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === key) onStoreChange();
    };
    const handlePreference = (event: Event) => {
      if ((event as CustomEvent<string>).detail === key) onStoreChange();
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(PREFERENCE_EVENT, handlePreference);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(PREFERENCE_EVENT, handlePreference);
    };
  }, [key]);
  const getSnapshot = useCallback(() => window.localStorage.getItem(key) ?? fallback, [fallback, key]);
  const getServerSnapshot = useCallback(() => fallback, [fallback]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Resolves a raw, DB-shaped (themeId, themeMode) pair to a v19 theme pack:
 *  a value already stored in the new pack format passes straight through,
 *  otherwise it is migrated via the documented legacy mapping (#325). */
function resolveThemePack(themeId: string, themeMode: string): ThemePack {
  return isThemePack(themeId) ? themeId : legacyToThemePack(themeId, themeMode);
}

function sessionThemePreference(user: AppearanceSessionUser): ThemePreference {
  const parsed = themePreferenceSchema.safeParse({
    theme: resolveThemePack(user.themeId, user.themeMode),
    textSize: user.textSize,
    emailNotifications: user.emailNotifications,
    pushNotifications: user.pushNotifications,
  });
  return parsed.success ? parsed.data : DEFAULT_THEME;
}

function parseThemePreference(storedTheme: string): ThemePreference {
  try {
    const raw = JSON.parse(storedTheme) as Record<string, unknown>;
    const candidate = typeof raw.theme === "string"
      ? raw
      : { ...raw, theme: resolveThemePack(String(raw.colourway ?? ""), String(raw.mode ?? "")) };
    const parsed = themePreferenceSchema.safeParse(candidate);
    return parsed.success ? parsed.data : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function resolvePersistedThemePreference(
  storedTheme: string,
  user: AppearanceSessionUser | undefined,
  hydratedUserId: string | null,
): ThemePreference {
  if (!user) return DEFAULT_THEME;
  if (hydratedUserId !== user.id) return sessionThemePreference(user);
  return parseThemePreference(storedTheme);
}

function readHydratedUserId(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(THEME_SESSION_HYDRATED_KEY);
}

function useHydratedUserId(): string | null {
  const subscribe = useCallback((onStoreChange: () => void) => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === THEME_SESSION_HYDRATED_KEY) onStoreChange();
    };
    const handleHydration = (event: Event) => {
      if ((event as CustomEvent<string>).detail === THEME_SESSION_HYDRATED_KEY) onStoreChange();
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(PREFERENCE_EVENT, handleHydration);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(PREFERENCE_EVENT, handleHydration);
    };
  }, []);
  const getSnapshot = useCallback(() => readHydratedUserId(), []);
  const getServerSnapshot = useCallback(() => null, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function usePersistedThemePreference(user?: AppearanceSessionUser): ThemePreference {
  const storedTheme = useLocalStorageValue(THEME_STORAGE_KEY, DEFAULT_THEME_JSON);
  const hydratedUserId = useHydratedUserId();
  const themePreference = useMemo(
    () => resolvePersistedThemePreference(storedTheme, user, hydratedUserId),
    [hydratedUserId, storedTheme, user],
  );

  useEffect(() => {
    if (!user || hydratedUserId === user.id) return;
    storePreference(THEME_STORAGE_KEY, sessionThemePreference(user));
    window.sessionStorage.setItem(THEME_SESSION_HYDRATED_KEY, user.id);
    window.dispatchEvent(new CustomEvent(PREFERENCE_EVENT, { detail: THEME_SESSION_HYDRATED_KEY }));
  }, [hydratedUserId, user]);

  return themePreference;
}
