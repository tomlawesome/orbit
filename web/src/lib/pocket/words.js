/**
 * A server's message on a row speaks its first clause at rest and the rest
 * when opened (round 3 §1, R6): the meta line shows the words up to the
 * first comma, dash or full stop, and the whole message is the panel's
 * `.p-prose`. An aside in brackets is cut with what follows it, so
 * "It carried no document Orbit can read (PDFs work best). Nothing was
 * kept." rests as "It carried no document Orbit can read" (§3.5's own
 * words). A hyphen inside a word ("picture-only") is not a dash.
 *
 * Durable fix, filed rather than built: a failure's reason code, so the
 * pocket can print `picture-only scan` instead of a clause (§3.5).
 * @param {string | null | undefined} message
 * @returns {string}
 */
export function firstClause(message) {
  const text = String(message ?? "").trim();
  const cut = text.search(/[,(]|\s[-–—]\s|[–—]|\.(?:\s|$)/);
  return (cut > 0 ? text.slice(0, cut) : text).trim();
}
