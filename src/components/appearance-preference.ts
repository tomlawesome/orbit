"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { PREFERENCE_EVENT, storePreference, THEME_STORAGE_KEY } from "@/components/dashboard-utils";
import { themePreferenceSchema, type ThemePreference } from "@/lib/preferences";
import type { WorkspaceSession } from "@/lib/preview-workspace";

const DEFAULT_THEME: ThemePreference = {
  mode: "system",
  colourway: "after-dark",
  textSize: "comfortable",
  urgencyPalette: "themed",
  emailNotifications: true,
  pushNotifications: true,
};
const DEFAULT_THEME_JSON = JSON.stringify(DEFAULT_THEME);
const THEME_SESSION_HYDRATED_KEY = "orbit:theme-session-user:v1";

export type AppearanceSessionUser = Pick<WorkspaceSession["user"],
  "id" | "themeMode" | "themeId" | "textSize" | "urgencyPalette" | "emailNotifications" | "pushNotifications"
>;

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

function sessionThemePreference(user: AppearanceSessionUser): ThemePreference {
  const parsed = themePreferenceSchema.safeParse({
    mode: user.themeMode,
    colourway: user.themeId,
    textSize: user.textSize,
    urgencyPalette: user.urgencyPalette,
    emailNotifications: user.emailNotifications,
    pushNotifications: user.pushNotifications,
  });
  return parsed.success ? parsed.data : DEFAULT_THEME;
}

function parseThemePreference(storedTheme: string): ThemePreference {
  try {
    const parsed = themePreferenceSchema.safeParse(JSON.parse(storedTheme));
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
