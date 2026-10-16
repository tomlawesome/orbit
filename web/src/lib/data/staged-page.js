/**
 * Loads one page of a preview (#1155): a staged attachment's page one for
 * the reading card and the phone sheet, and since #1300 every page the
 * reader turns to, staged or accepted -- the reader needs the response's
 * `X-Orbit-Page-Count` header, which an `<img>` never sees either.
 *
 * A bare `<img src>` cannot tell apart *gone* (the mail was decided or burned
 * up: 404/410) from *could not draw* (the renderer refused: 415/422/5xx) --
 * an `<img>` never sees a status code. So the reading card, the phone sheet
 * and the review-sheet unfold all go through this loader instead, and read
 * the outcome it hands back rather than an `<img>`'s own error event.
 *
 * #1151 W2-R5: both callers only ever abort this on their own close (the
 * card moving on, the sheet closing) -- there was no bound of this loader's
 * own, so a preview server that accepted the connection and then never
 * answered left the reading card spinning forever. `STAGED_PAGE_TIMEOUT_MS`
 * is this loader's own backstop, same idea as `STARTING_BACKSTOP_MS` in
 * flight/door-state.js (a loader must not trust the far end to ever answer),
 * sized for a preview render rather than a cold sign-in start.
 */

export const STAGED_PAGE_TIMEOUT_MS = 20_000;

/**
 * A preview endpoint's address for page `page` (#1300). Page one is the
 * endpoint's own address, unchanged, so every page-one request is the one it
 * always was.
 * @param {string} href
 * @param {number} page
 */
export function previewPageHref(href, page) {
  if (page === 1) return href;
  const [path, query = ""] = href.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("page", String(page));
  return `${path}?${params}`;
}

/**
 * The page count a preview response carries (#1300), or null when it does
 * not say -- a stand-in, or an older server.
 * @param {Response} response
 */
function pageCountOf(response) {
  const raw = response.headers?.get("x-orbit-page-count") ?? "";
  const count = /^[1-9][0-9]*$/u.test(raw) ? Number(raw) : 0;
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

/**
 * @param {string} href
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ kind: "page", url: string, pageCount: number | null } | { kind: "gone" } | { kind: "undrawable" }>}
 */
export async function loadStagedPage(href, signal) {
  const deadline = AbortSignal.timeout(STAGED_PAGE_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await fetch(href, { credentials: "same-origin", signal: combined });
    if (response.status === 404 || response.status === 410) return { kind: "gone" };
    if (!response.ok) return { kind: "undrawable" };
    const blob = await response.blob();
    return { kind: "page", url: URL.createObjectURL(blob), pageCount: pageCountOf(response) };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      /* The caller's own close still discards silently, same as before; the
         loader's own deadline firing is answered as a draw failure instead,
         so the card stops spinning rather than waiting forever. */
      if (signal?.aborted) throw error;
      return { kind: "undrawable" };
    }
    return { kind: "undrawable" };
  }
}
