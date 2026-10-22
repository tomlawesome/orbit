import { DEFAULT_TEXT_SIZE, TEXT_SIZES, textSizeOrDefault } from "./text-size.js";
import { DEFAULT_THEME, THEME_PACKS, themeOrDefault } from "./theme.js";

/*
 * First-load sync of theme and text size with the server (#1180).
 *
 * The session cannot say whether a reader ever chose: user_preferences rows
 * are created with the account (and by the reminder and tour writes) holding
 * the defaults, so a default on the server may be "never chosen" or "chose the
 * default". Theme was never stored server-side before this change, so every
 * existing reader's choice lives only in this browser's cache.
 *
 * The rule, per field: a server value that is not the default wins. A server
 * default with a different valid cached value, before this browser has synced
 * once (MARKER), means the cache is the reader's choice: keep it and send it
 * up. After the first sync the server always wins.
 */

export const SYNCED_MARKER = "orbit-prefs-synced";

/**
 * @param {{ themeId?: string, textSize?: string }} user  the session's user
 * @param {{ theme: string | null, textSize: string | null, synced: boolean }} cache
 * @returns {{ theme: string, textSize: string, push: { theme?: string, textSize?: string } | null }}
 */
export function decideSync(user, cache) {
  const serverTheme = themeOrDefault(user.themeId);
  const serverSize = textSizeOrDefault(user.textSize);
  const push = /** @type {{ theme?: string, textSize?: string }} */ ({});
  let theme = serverTheme;
  let textSize = serverSize;
  if (!cache.synced) {
    if (serverTheme === DEFAULT_THEME && cache.theme && THEME_PACKS.includes(cache.theme) && cache.theme !== serverTheme) {
      theme = cache.theme;
      push.theme = theme;
    }
    if (serverSize === DEFAULT_TEXT_SIZE && cache.textSize && TEXT_SIZES.includes(cache.textSize) && cache.textSize !== serverSize) {
      textSize = cache.textSize;
      push.textSize = textSize;
    }
  }
  return { theme, textSize, push: push.theme || push.textSize ? push : null };
}

/** The cache as this browser holds it; blocked storage reads as empty. */
export function readCache() {
  try {
    return {
      theme: localStorage.getItem("orbit-theme"),
      textSize: localStorage.getItem("orbit-text-size"),
      synced: localStorage.getItem(SYNCED_MARKER) === "1",
    };
  } catch {
    return { theme: null, textSize: null, synced: true };
  }
}

export function markSynced() {
  try { localStorage.setItem(SYNCED_MARKER, "1"); } catch { /* private mode */ }
}
