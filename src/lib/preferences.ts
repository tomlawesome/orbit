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

/**
 * The reader's own reminder timing (#468, settings §13). Two offsets, both in
 * days before the date: the first warning is the far one, the final warning
 * the near one, so the final must always be the smaller number — a pair that
 * crossed over would mean an item's last word arrived before its first.
 *
 * The bounds mirror the reminder offsets an item already accepts
 * (workspace.ts: 0-365 days) and the CHECK constraints on user_preferences,
 * so an out-of-range pair is refused by the schema, by the route, and by the
 * database rather than by any one of them alone.
 */
export const DEFAULT_FIRST_WARNING_DAYS = 14;
export const DEFAULT_FINAL_WARNING_DAYS = 3;

export const reminderPreferenceSchema = z.object({
  emailEnabled: z.boolean(),
  firstWarningDays: z.number().int().min(1).max(365),
  finalWarningDays: z.number().int().min(0).max(365),
}).superRefine((preference, context) => {
  if (preference.finalWarningDays >= preference.firstWarningDays) {
    context.addIssue({
      code: "custom",
      path: ["finalWarningDays"],
      message: "The final warning must be closer to the date than the first warning",
    });
  }
});

export type ReminderPreference = z.infer<typeof reminderPreferenceSchema>;

/** One warning: how many days before the date it fires, and which channels it may use. */
export interface ReminderOffset {
  daysBefore: number;
  emailEnabled: boolean;
  pushEnabled: boolean;
}

/** The recipient's own stored pair, as read from `user_preferences` (#468). */
export interface RecipientWarningDays {
  firstWarningDays: number | null;
  finalWarningDays: number | null;
}

/**
 * A stored offset that is missing, fractional, or outside the range the
 * settings screen and the CHECK constraints allow falls back to the
 * documented default for its own slot rather than scheduling a date nobody
 * asked for. Unreachable through the route or the database today; this is the
 * behaviour if a row ever arrives by another path.
 */
export function warningDaysOrDefault(stored: number | null, fallback: number, floor: number): number {
  if (stored === null || !Number.isInteger(stored) || stored < floor || stored > 365) return fallback;
  return stored;
}

/**
 * The offsets a single recipient's reminders for one item actually fire at
 * (#479). Pure and dependency-free by design (#487): it is the one truth
 * both the dispatch worker (src/server/notification-worker.ts, which
 * re-exports this exact function) and the in-app notification list
 * (src/lib/notifications.ts) compute reminder timing from, so it lives
 * somewhere a browser bundle can import safely.
 *
 * Precedence, as scoped in #479: an item that carries its own reminder
 * rules keeps them exactly: the reader set those per item, and the settings
 * screen never claimed to overrule them. The user-level pair is the default
 * for every item that says nothing.
 *
 * The pair is per recipient, not per household: two people in one household
 * therefore each hear about (or see) the same item on their own schedule.
 * Nothing here reads another user's row.
 *
 * The two warnings are returned as a set of offsets, not an ordered pair: the
 * first/final ordering is a promise the *labels* make ("14 days before closest
 * approach", then "3 days before"), and each offset is scheduled
 * independently, so a pair that somehow crossed over still raises two warnings
 * rather than none. A pair whose halves are equal is one warning, not a
 * duplicate. Both channels are open at this level because the item said
 * nothing about channels; the recipient's own toggles still gate them in
 * `enabledDeliveryChannels`.
 */
export function effectiveReminderOffsets(
  itemRules: readonly ReminderOffset[],
  recipient: RecipientWarningDays,
): ReminderOffset[] {
  if (itemRules.length) return [...itemRules];
  const first = warningDaysOrDefault(recipient.firstWarningDays, DEFAULT_FIRST_WARNING_DAYS, 1);
  const final = warningDaysOrDefault(recipient.finalWarningDays, DEFAULT_FINAL_WARNING_DAYS, 0);
  return [...new Set([first, final])]
    .sort((left, right) => right - left)
    .map((daysBefore) => ({ daysBefore, emailEnabled: true, pushEnabled: true }));
}

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
