/*
 * WHETHER THIS IS A FIRST VISIT (#1253; carried out of first-light.js by
 * #1371, whose first light is now the shared door's `dawn.light()`). The
 * door's first sight on a first visit is always at least one lap of the
 * ring's running light (`firstVisit`), so the browser keeps when it last saw
 * the door.
 */

/** localStorage key: when this browser last saw the door. */
export const SEEN_KEY = "orbit-door-seen";

/** A browser that has not seen the door for this long sees a first visit again. */
export const SEEN_FRESH_MS = 36 * 3600e3;

/** The longest the ring runs on for the flight's shaders (the site's 9 s). */
export const COMPILE_CAP_MS = 9000;

/**
 * Whether this is a first visit: nothing seen, or nothing seen for 36 hours
 * (the pictures are no longer kept, so the door has to come again). Records
 * this visit. A browser that will not say is a first visit.
 * @param {Pick<Storage, "getItem" | "setItem"> | undefined} storage
 * @param {number} [now]
 */
export function isFirstVisit(storage, now = Date.now()) {
  try {
    if (!storage) return true;
    const seen = storage.getItem(SEEN_KEY);
    storage.setItem(SEEN_KEY, String(now));
    return !seen || now - Number(seen) > SEEN_FRESH_MS;
  } catch { return true; }
}

/**
 * A promise, or nothing at all, waited for at most `ms` (the folder leaves
 * the cap on what first light waits for to the host).
 * @param {Promise<unknown> | null | undefined} p
 * @param {number} ms
 * @returns {Promise<unknown>}
 */
export function within(p, ms) {
  return Promise.race([Promise.resolve(p).catch(() => {}), new Promise((resolve) => setTimeout(resolve, ms))]);
}
