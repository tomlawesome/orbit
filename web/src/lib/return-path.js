/**
 * Mirrors `safeReturnPath` in `src/lib/auth/crypto.ts`, which the callback
 * route applies server-side and which is the real defence. A value that is
 * not application-relative is dropped rather than followed: no leading "/",
 * a protocol-relative "//", a control character (including DEL, 0x7f), or a
 * backslash -- which WHATWG URL parsing normalises to "/" on special schemes,
 * so "/\evil.com" would otherwise resolve to an external origin once joined
 * with the app URL. Checking here too keeps a hostile link from ever reaching
 * the button.
 *
 * Written as an explicit scan rather than a character-class regular
 * expression: the control-character range is exactly the part an editor or a
 * careless escape silently corrupts, and a wrong range here fails open.
 *
 * @param {string | null} value
 * @returns {boolean}
 */
export function isApplicationRelative(value) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return false;
  for (const character of value) {
    if (character === "\\") return false;
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}
