/**
 * A coarse, non-identifying description of a session's device (#482).
 *
 * The sessions list must never show a caller's raw user agent — that string
 * carries far more than a reader needs (exact browser build, OS patch level)
 * and is the kind of fingerprint-shaped data ADR-0011 asks features to avoid
 * collecting unless something needs it. What the "where you're signed in"
 * screen needs is much coarser: which browser, roughly, and which kind of
 * device. This function is the whole of that reduction, kept pure and
 * separately tested so the mapping is easy to check against real user-agent
 * strings without a database or a request in the loop.
 */

export type BrowserFamily = "Chrome" | "Firefox" | "Safari" | "Edge" | "other";
export type DevicePlatform = "Linux" | "Windows" | "Mac" | "iPhone" | "iPad" | "Android" | "other";

function detectBrowser(userAgent: string): BrowserFamily {
  // Order matters: Chromium Edge's UA also contains "Chrome/" and "Safari/",
  // and Chrome's own UA also contains "Safari/", so the more specific tokens
  // are checked first. Mobile variants (CriOS, FxiOS) count as their desktop
  // family — the reader cares which browser, not which OS shipped it.
  if (/Edg\//u.test(userAgent) || /Edge\//u.test(userAgent)) return "Edge";
  if (/Firefox\//u.test(userAgent) || /FxiOS\//u.test(userAgent)) return "Firefox";
  if (/Chrome\//u.test(userAgent) || /CriOS\//u.test(userAgent)) return "Chrome";
  if (/Safari\//u.test(userAgent)) return "Safari";
  return "other";
}

function detectPlatform(userAgent: string): DevicePlatform {
  // iPhone/iPad/Android checked before Windows/Mac/Linux: an Android UA
  // contains "Linux", and iPadOS 13+ can present a "Macintosh"-shaped UA, so
  // the more specific device tokens win.
  if (/iPhone/u.test(userAgent)) return "iPhone";
  if (/iPad/u.test(userAgent)) return "iPad";
  if (/Android/u.test(userAgent)) return "Android";
  if (/Windows/u.test(userAgent)) return "Windows";
  if (/Macintosh|Mac OS X/u.test(userAgent)) return "Mac";
  if (/Linux/u.test(userAgent)) return "Linux";
  return "other";
}

/**
 * "Chrome · Linux", "Safari · iPhone", and so on — never the raw string.
 *
 * `null`/`undefined`/empty (no user agent was recorded) and a string that
 * matches neither axis both answer "unknown device", since neither tells the
 * reader anything. A string that matches one axis but not the other — an
 * unfamiliar browser on a recognised OS, say — still reports the axis it
 * does know, e.g. "other · Linux".
 */
export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return "unknown device";
  const browser = detectBrowser(userAgent);
  const platform = detectPlatform(userAgent);
  if (browser === "other" && platform === "other") return "unknown device";
  return `${browser} · ${platform}`;
}
