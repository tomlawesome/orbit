/**
 * TURNING PAGES (#1300): the words and arrows both page-turners draw, the
 * preview's small pager (Pager.svelte) and the reader (Reader.svelte), as
 * design/v19/document-card/round-6 places them. The reader's head says
 * "page N of M"; its foot and the preview's pager say "N of M"; an arrow
 * stands only where there is a page that way. A one-page file says "one
 * page" and has no arrows. M is the preview response's `X-Orbit-Page-Count`
 * (Orbit stores no page count), so until one has arrived `count` is null:
 * nothing claims a count and nothing turns.
 *
 * @param {number} page
 * @param {number | null} count
 * @returns {{ head: string, of: string, arrows: boolean, back: boolean, forward: boolean }}
 */
export function pageTurn(page, count) {
  if (count === 1) return { head: "one page", of: "one page", arrows: false, back: false, forward: false };
  if (!count) return { head: `page ${page}`, of: "", arrows: false, back: false, forward: false };
  return { head: `page ${page} of ${count}`, of: `${page} of ${count}`, arrows: true, back: page > 1, forward: page < count };
}

/**
 * The page a key turns to: ← and PageUp back one, → and PageDown forward
 * one, Home the first, End the last. `null` for a page key with nowhere to
 * go (it is still the page's key, never the belt's); `undefined` for any
 * other key.
 *
 * @param {string} key
 * @param {number} page
 * @param {number | null} count
 * @returns {number | null | undefined}
 */
export function pageKeyTarget(key, page, count) {
  const wanted = key === "ArrowLeft" || key === "PageUp" ? page - 1
    : key === "ArrowRight" || key === "PageDown" ? page + 1
      : key === "Home" ? 1
        : key === "End" ? (count ?? page)
          : undefined;
  if (wanted === undefined) return undefined;
  if (!count || count < 2) return null;
  const target = Math.min(count, Math.max(1, wanted));
  return target === page ? null : target;
}
