import { inspectPickedDocument, previewPickedDocument } from "./workspace.js";
import { saveProblem } from "./metadata-status.js";

/**
 * READING A PICKED DOCUMENT, for both of /create's forms (#1245, #1279).
 *
 * The desk's form (create.behaviour.js) and the phone's (pocket.svelte with
 * EntryForm.svelte) start the same two requests from one pick, independent of
 * each other: the household's pre-attachment preview route draws page one,
 * and the inspection route scans and reads the same bytes alongside. Neither
 * keeps anything; the save attaches the file through the item's own
 * documents route. This module is that request-and-outcome half, so the two
 * dialects cannot drift apart: the desk writes the outcomes into its lane's
 * DOM, the pocket binds them as state.
 *
 * The words are the desk lane's, carried from design/v19/create-v3.html and
 * document-card/round-6, and the phone mockup (design/v19/
 * create-phone-reading.html, owner's "14a") carries them verbatim. A `WHY_*`
 * constant is two lines joined by `<br>`; `whyLines` splits it, and a
 * server's own words stay one line of text whatever they contain.
 */

export const READING_HEAD = "Reading your document";
export const PAGE_HEAD = "Page one";
export const FOCUS_READING = "Focusing on the anomaly";
export const WHY_READING = "orbit is reading the pages it was given<br>nothing is saved, and nothing is assumed";
export const FOCUS_UNDRAWABLE = "Orbit could not draw a picture of this document.";
export const WHY_UNDRAWABLE = "it is still attached when you add this entry<br>orbit just could not turn it into a page to read here";
export const TOO_LARGE = "this file is too large to send — it is larger than this orbit accepts";
export const WHY_TOO_LARGE = `${TOO_LARGE}<br>choose a smaller document`;
export const FOCUS_REFUSED = "Orbit refused this file.";
export const WHY_REFUSED = "it did not pass what orbit checks before keeping a file<br>choose another document";
export const CAP_READING = "orbit is reading the pages it was given";
export const CAP_CARRIED = "the fields marked ◆ from document are what orbit read across into the form";
export const CAP_NOTHING = "orbit read the pages and found nothing to carry across";
export const CAP_UNREAD = "orbit could not read the pages this time";

/** The suggestion fields both forms have a slot (and a "◆ from document"
    mark) for; the rest of the inspection's eight stay with the person's own
    choices (#1058c maps kind to schedule). */
export const SUGGESTION_FIELDS = /** @type {const} */ (["provider", "reference", "dueDate", "cost"]);

/**
 * @typedef {typeof SUGGESTION_FIELDS[number]} SuggestionField
 * @typedef {{ kind: "up", url: string, scanned: boolean }
 *   | { kind: "refused", why: string }
 *   | { kind: "undrawable", why: string }} PageOutcome
 * @typedef {{ kind: "refused", why: string }
 *   | { kind: "read", extracted: boolean, suggestions: { field: SuggestionField, value: string }[], message: string }
 *   | { kind: "unread", message: string }} ReadOutcome
 *
 * The phone form's state for one pick (pocket.svelte holds it, EntryForm.svelte
 * draws it): `page` is page one's object URL once drawn; `settled` stops the
 * focus block breathing on `line` / `why` (a refusal, or a page that could not
 * be drawn); `read` is the read being done, and `caption` what it ended on.
 * @typedef {{
 *   key: number, name: string, size: number, page: string | null, scanned: boolean,
 *   refused: boolean, settled: boolean, line: string, why: string, read: boolean, caption: string,
 * }} PickedRead
 */

/** @param {string} why */
export function whyLines(why) {
  return why === WHY_READING || why === WHY_UNDRAWABLE || why === WHY_TOO_LARGE || why === WHY_REFUSED ? why.split("<br>") : [why];
}

/** @param {unknown} error */
const codeOf = (error) => /** @type {{ code?: string }} */ (error)?.code;

/**
 * A file refused for its size, by Orbit's own limit or by a proxy in front of
 * it (#1284): Orbit was reached, so it is not "could not be reached". A 413
 * that names another code (a storage quota) is not about this file's size.
 * @param {unknown} error
 */
const tooLarge = (error) =>
  codeOf(error) === "document_too_large" ||
  (/** @type {{ status?: number }} */ (error)?.status === 413 && codeOf(error) === undefined);

/**
 * Starts both requests from one pick. Each promise resolves with how its
 * half ended and never rejects; an aborted read resolves too, so the caller
 * decides by its own `current()` check whether the outcome is still wanted
 * (and revokes an `up` page's object URL when it is not).
 *
 * @param {string} householdId
 * @param {File} file
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {{ page: Promise<PageOutcome>, read: Promise<ReadOutcome> }}
 */
export function readPickedDocument(householdId, file, { signal } = {}) {
  const page = previewPickedDocument(householdId, file, { signal }).then(
    (preview) => /** @type {PageOutcome} */ ({ kind: "up", url: preview.url, scanned: preview.scanned }),
    (error) => {
      const code = codeOf(error);
      if (code === "document_malware_detected") return /** @type {PageOutcome} */ ({ kind: "refused", why: WHY_REFUSED });
      if (tooLarge(error)) return /** @type {PageOutcome} */ ({ kind: "undrawable", why: WHY_TOO_LARGE });
      /* Unsupported or undrawable is the page's own fault and the file is
         fine; anything else (the scanner, the connection) is said in the
         server's own words, since the save will meet the same wall. */
      const ordinary = code === "document_preview_unsupported" || code === "document_preview_failed";
      return /** @type {PageOutcome} */ ({
        kind: "undrawable",
        why: ordinary ? WHY_UNDRAWABLE : saveProblem(/** @type {{ message?: string }} */ (error)),
      });
    },
  );

  const read = inspectPickedDocument(householdId, file, { signal }).then(
    (result) => {
      /* The upload would refuse it too, so it leaves the entry now. */
      if (result.attachmentDisposition === "rejected") {
        return /** @type {ReadOutcome} */ ({ kind: "refused", why: result.message ?? WHY_REFUSED });
      }
      const fields = /** @type {readonly string[]} */ (SUGGESTION_FIELDS);
      return /** @type {ReadOutcome} */ ({
        kind: "read",
        extracted: Boolean(result.extracted),
        suggestions: (result.suggestions ?? [])
          .filter((one) => fields.includes(one.field))
          .map((one) => ({ field: /** @type {SuggestionField} */ (one.field), value: one.value })),
        message: result.message ?? "",
      });
    },
    (error) => /** @type {ReadOutcome} */ ({
      kind: "unread",
      message: tooLarge(error) ? TOO_LARGE : saveProblem(/** @type {{ message?: string }} */ (error)),
    }),
  );

  return { page, read };
}

/**
 * What a read carries into the form: each suggestion whose field is still
 * empty, never over what someone typed.
 *
 * @param {{ field: SuggestionField, value: string }[]} suggestions
 * @param {(field: SuggestionField) => string} valueOf  the field's current value
 */
export function suggestionsToCarry(suggestions, valueOf) {
  return suggestions.filter((one) => !String(valueOf(one.field) ?? "").trim());
}

/**
 * The caption's second line once the read is done.
 *
 * @param {Extract<ReadOutcome, { kind: "read" | "unread" }>} read
 * @param {number} carried  how many fields it filled
 */
export function captionOf(read, carried) {
  if (read.kind === "unread" || !read.extracted) return CAP_UNREAD;
  return carried ? CAP_CARRIED : CAP_NOTHING;
}
