/**
 * What "the film has ended" means, once (T-Q22). The tour film's reading
 * (`window.__reading`, web/src/lib/tour/film.js) is over when it has a length
 * and the cursor has reached it. The specs that watch the film (the pocket
 * WebKit film, the transport-clash recorder) all ask this one question, from
 * inside the page where they sample, so `installFilmEnded` puts this very
 * function there as `window.__readingEnded(reading)` before the page loads.
 *
 * @param {{ total: number, cursor: number } | null | undefined} reading
 * @returns {boolean}
 */
export function filmEnded(reading) {
  return Boolean(reading && reading.total > 0 && reading.cursor >= reading.total);
}

/** @param {import("@playwright/test").Page} page */
export async function installFilmEnded(page) {
  await page.addInitScript(`window.__readingEnded = ${filmEnded};`);
}
