/**
 * Loads a staged attachment's page-one preview (#1155).
 *
 * A bare `<img src>` cannot tell apart *gone* (the mail was decided or burned
 * up: 404/410) from *could not draw* (the renderer refused: 415/422/5xx) --
 * an `<img>` never sees a status code. So the reading card, the phone sheet
 * and the review-sheet unfold all go through this loader instead, and read
 * the outcome it hands back rather than an `<img>`'s own error event.
 */

/**
 * @param {string} href
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ kind: "page", url: string } | { kind: "gone" } | { kind: "undrawable" }>}
 */
export async function loadStagedPage(href, signal) {
  try {
    const response = await fetch(href, { credentials: "same-origin", signal });
    if (response.status === 404 || response.status === 410) return { kind: "gone" };
    if (!response.ok) return { kind: "undrawable" };
    const blob = await response.blob();
    return { kind: "page", url: URL.createObjectURL(blob) };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { kind: "undrawable" };
  }
}
