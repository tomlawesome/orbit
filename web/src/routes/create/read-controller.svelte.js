import { captionOf, focusAfterScan, readPickedDocument, suggestionsToCarry } from "$lib/data/document-read.js";

/**
 * Reading a picked or dropped document on /create (#1354 part 3): the one
 * flow both the desk (create.behaviour.js) and the phone (pocket.svelte)
 * drive over `readPickedDocument`. One AbortController per pick; every
 * outcome is checked against `current()` first; a stale page's object URL is
 * revoked; page one and the read are handled independently; a refusal by
 * either half stops the pick; suggestions are carried only into empty
 * fields; the caption is `captionOf`'s; an undrawn page is settled once the
 * read is done. What a driver DOES with an outcome (DOM or state) is its
 * handlers' business. Plain JS, no runes, so it also runs under plain vitest.
 *
 * @typedef {import("$lib/data/document-read.js").PageOutcome} PageOutcome
 * @typedef {import("$lib/data/document-read.js").ReadOutcome} ReadOutcome
 * @typedef {import("$lib/data/document-read.js").SuggestionField} SuggestionField
 * @typedef {{ field: SuggestionField, value: string }} Carried
 * @typedef {{
 *   onScanned?: (scanned: boolean) => void,
 *   onPage?: (page: { url: string, scanned: boolean }) => void,
 *   onPageUndrawn?: (why: string) => void,
 *   onRefused?: (why: string) => void,
 *   onRead?: (read: { outcome: Extract<ReadOutcome, { kind: "read" | "unread" | "attached" }>, carry: Carried[], caption: string }) => void,
 *   onSettleUndrawn?: (why: string) => void,
 * }} ReadHandlers
 * @typedef {{
 *   householdId: string, documentReading?: boolean, readAfter?: Promise<unknown>,
 *   valueOf: (field: SuggestionField) => string, wanted?: () => boolean,
 * }} StartOptions
 */

/** The focus line once the virus check is done (the same words both forms use). */
export const lineAfterScan = focusAfterScan;

/**
 * @param {ReadHandlers} handlers
 * @param {{ readPicked?: typeof readPickedDocument }} [deps]
 */
export function createReadController(handlers, { readPicked = readPickedDocument } = {}) {
  /** @type {{ abort: AbortController, alive: boolean } | null} */
  let active = null;

  /** @param {{ abort: AbortController, alive: boolean }} pick */
  function end(pick) {
    pick.alive = false;
    pick.abort.abort();
  }

  function stop() {
    if (active) end(active);
    active = null;
  }

  /** A handler's own failure is the driver's bug, never the pick's. @param {() => void} call */
  function safely(call) {
    try { call(); } catch { /* the driver's handler failed; the pick carries on */ }
  }

  /**
   * @param {File} file
   * @param {StartOptions} options
   */
  function start(file, { householdId, documentReading, readAfter, valueOf, wanted = () => true }) {
    stop();
    const pick = { abort: new AbortController(), alive: true };
    active = pick;
    const current = () => pick.alive && wanted();
    let pageIn = false;
    let readDone = false;
    /** @type {string | null} */
    let undrawn = null;

    /** @param {string} why */
    const refuse = (why) => {
      end(pick);
      safely(() => handlers.onRefused?.(why));
    };
    const settle = () => {
      if (readDone && undrawn !== null && current()) {
        const why = undrawn;
        safely(() => handlers.onSettleUndrawn?.(why));
      }
    };

    const outcomes = readPicked(householdId, file, {
      signal: pick.abort.signal,
      documentReading,
      readAfter,
      onScanned: (scanned) => {
        if (!current() || pageIn) return;
        safely(() => handlers.onScanned?.(scanned));
      },
    });

    const page = Promise.resolve(outcomes.page).then((outcome) => {
      pageIn = true;
      if (!current()) {
        if (outcome.kind === "up") URL.revokeObjectURL(outcome.url);
        return;
      }
      if (outcome.kind === "up") {
        safely(() => handlers.onPage?.({ url: outcome.url, scanned: outcome.scanned }));
      } else if (outcome.kind === "refused") {
        refuse(outcome.why);
      } else {
        undrawn = outcome.why;
        safely(() => handlers.onPageUndrawn?.(outcome.why));
        settle();
      }
    });

    const read = Promise.resolve(outcomes.read).then((outcome) => {
      if (!current()) return;
      if (outcome.kind === "refused") {
        refuse(outcome.why);
        return;
      }
      try {
        /** @type {Carried[]} */
        const carry = outcome.kind === "read" ? suggestionsToCarry(outcome.suggestions, valueOf) : [];
        const caption = captionOf(outcome, carry.length);
        safely(() => handlers.onRead?.({ outcome, carry, caption }));
      } finally {
        // As the drivers' old `.finally`: a field read that throws still
        // settles an undrawn page.
        readDone = true;
        settle();
      }
    });

    const done = Promise.allSettled([page, read]).then(() => undefined);
    return { current, done };
  }

  return { start, stop };
}
