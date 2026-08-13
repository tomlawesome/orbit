import { z } from "zod";
import { sectionAccents, sectionIcons } from "./domain";

export const textSizes = ["standard", "comfortable", "large", "extra-large"] as const;
export type TextSize = (typeof textSizes)[number];

/**
 * Legacy due-date colour mode. No longer a user-facing choice as of #325:
 * the v19 semantic status tokens (--ok/--warm/--overdue/--upcoming/
 * --degraded) are flat and fixed per theme pack, so there is nothing left
 * for "classic" vs "themed" to switch between. Retained only as a type so
 * the raw session/DB plumbing (lib/auth/session.ts, lib/preview-workspace.ts)
 * still type-checks against stored rows that predate this change.
 */
export type UrgencyPalette = "classic" | "themed";

/** The four v19 theme packs (issue #325), replacing the old five-colourway
 *  x display-mode matrix. Token values for each pack live in
 *  src/app/theme-tokens.css. */
export const themePacks = ["starchart", "afterdark", "atlas", "dawn"] as const;
export type ThemePack = (typeof themePacks)[number];

export const themePackInfo: Record<ThemePack, { name: string; description: string; swatches: readonly [string, string, string] }> = {
  starchart: { name: "Star-chart", description: "Deep indigo sky, warm gold wayfinding", swatches: ["#060b1c", "#d8b45a", "#4ade80"] },
  afterdark: { name: "After Dark", description: "Near-black, cool electric blue", swatches: ["#05070d", "#7dd3fc", "#4ade80"] },
  atlas: { name: "Atlas", description: "Warm parchment, bronze ink", swatches: ["#efe9db", "#b4842c", "#1e7a45"] },
  dawn: { name: "Dawn", description: "Cool paper white, clear sky blue", swatches: ["#eef1f6", "#1f7ac2", "#178a4c"] },
};

/**
 * Maps a legacy (pre-#325) colourway id + display mode to the nearest of
 * the four v19 theme packs. Documented mapping:
 *  - "after-dark"               -> afterdark  (name match, cool accent, dark)
 *  - "coast"   + light/system   -> dawn        (cool blue accent, light)
 *  - "coast"   + dark           -> afterdark   (cool blue accent, dark)
 *  - "verdant" + light/system   -> atlas       (warm accent, light)
 *  - "verdant" + dark           -> starchart   (warm accent, dark)
 *  - "ember"   + light/system   -> atlas       (warm accent, light)
 *  - "ember"   + dark           -> starchart   (warm accent, dark)
 *  - "berry"   + light/system   -> dawn        (cool-leaning accent, light)
 *  - "berry"   + dark           -> afterdark   (cool-leaning accent, dark)
 *  - anything unrecognised      -> starchart   (the new default pack)
 */
export function legacyToThemePack(colourway: string, mode: string): ThemePack {
  const dark = mode === "dark";
  switch (colourway) {
    case "after-dark":
      return "afterdark";
    case "coast":
      return dark ? "afterdark" : "dawn";
    case "verdant":
      return dark ? "starchart" : "atlas";
    case "ember":
      return dark ? "starchart" : "atlas";
    case "berry":
      return dark ? "afterdark" : "dawn";
    default:
      return "starchart";
  }
}

export const themePreferenceSchema = z.object({
  theme: z.enum(themePacks),
  textSize: z.enum(textSizes).default("comfortable"),
  emailNotifications: z.boolean().default(true),
  pushNotifications: z.boolean().default(true),
});

export type ThemePreference = z.infer<typeof themePreferenceSchema>;

export const sectionPreferenceSchema = z.array(z.object({
  id: z.string().min(1).max(80),
  name: z.string().max(30),
  icon: z.enum(sectionIcons),
  accent: z.enum(sectionAccents),
  visible: z.boolean(),
})).max(12).superRefine((sections, context) => {
  if (new Set(sections.map((section) => section.id)).size !== sections.length) {
    context.addIssue({ code: "custom", message: "Section identifiers must be unique" });
  }
});
