/**
 * A server's message on a row speaks its first clause at rest and the rest
 * when opened (round 3 §1, R6): the meta line shows the words up to the
 * first comma, dash or full stop, and the whole message is the panel's
 * `.p-prose`. An aside in brackets is cut with what follows it, so
 * "It carried no document Orbit can read (PDFs work best). Nothing was
 * kept." rests as "It carried no document Orbit can read" (§3.5's own
 * words). A hyphen inside a word ("picture-only") is not a dash.
 *
 * Terminal failures now carry a stable `failureCode` (#1670 G-W3), which
 * `failureWords` keys on. A fuller reason code, so the pocket can print
 * `picture-only scan` instead of a clause (§3.5), is still not built.
 * @param {string | null | undefined} message
 * @returns {string}
 */
export function firstClause(message) {
  const text = String(message ?? "").trim();
  const cut = text.search(/[,(]|\s[-–—]\s|[–—]|\.(?:\s|$)/);
  return (cut > 0 ? text.slice(0, cut) : text).trim();
}

/**
 * A failed mail-in receipt's reason, in plain words (#1143). Mirrors
 * `JOB_REASONS` (`web/src/routes/administration/words.js`): the server
 * stays free of display prose, and the label is the row's meta at rest,
 * with the full `message` kept for the opened panel.
 */
export const REASON_WORDS = /** @type {Record<string, string>} */ ({
  no_document: "no readable document",
  too_large: "too large",
  malware: "scanner refused it",
  scanner_off: "scanner unavailable",
  not_kept: "couldn’t be kept",
  interrupted: "approval cut short",
  wrong_recipient: "not addressed to you",
  account_disabled: "account disabled",
  unknown: "reason not named",
});

/**
 * @param {string | null | undefined} reason
 * @returns {string}
 */
export function reasonWords(reason) {
  return REASON_WORDS[/** @type {string} */ (reason)] ?? REASON_WORDS.unknown;
}

const TERMINAL_LABELS_BY_CODE = /** @type {Record<string, string>} */ ({
  no_supported_pdf: "nothing to collect",
  message_too_large: "too large to collect",
});

/** Fallback for a row with no `failureCode` (an older server): the message wording. */
const TERMINAL_LABELS = /** @type {Record<string, string>} */ ({
  "no_document|no PDF attached": "nothing to collect",
  "too_large|message over the size limit": "too large to collect",
});

/**
 * The terminal outcomes of an attributed forward (#1652) say what the member
 * can act on, so they get their own labels, keyed by the server's
 * failure code (#1670 G-W3), falling back to reason and message wording when the row
 * has no code. Anything else keeps the reason's label.
 * @param {{ reason?: string | null, message?: string | null, failureCode?: string | null }} failure
 * @returns {string}
 */
export function failureWords(failure) {
  return (
    TERMINAL_LABELS_BY_CODE[failure.failureCode ?? ""] ??
    TERMINAL_LABELS[`${failure.reason}|${failure.message}`] ??
    reasonWords(failure.reason)
  );
}
