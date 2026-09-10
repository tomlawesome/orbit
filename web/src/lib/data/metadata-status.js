/**
 * What a member is told when a Tier 1 field cannot be shown (#941).
 *
 * Two states, one vocabulary learned once (Fable, 2026-09-10): **damaged** —
 * the value is gone and retyping replaces it — and **locked** — the value is
 * safe and waiting for an administrator to restore Orbit's encryption key.
 * Members never see key mechanics, counts, or the word for the key itself
 * beyond "Orbit's encryption key"; locked copy always names an administrator
 * as who fixes it, because a member cannot.
 *
 * Pure and shared, like belt.js and inbox.js beside it, for one reason: the
 * same two states appear on the item card, in its edit and complete panels, on
 * the mail-in review lane and on the amend-then-accept card. Four screens
 * saying it four slightly different ways is the failure this module exists to
 * prevent, and it is what the unit suite pins.
 */

/** The marker the API sends for a value that failed its integrity check. */
export const DAMAGED = "metadata_integrity_failed";
/** The marker the API sends when the instance holds no usable encryption key. */
export const LOCKED = "metadata_locked";

/** The reference row's mark, in the kv row's own quiet type. */
export const REFERENCE_WORDS = {
  [DAMAGED]: "damaged — can't be recovered",
  [LOCKED]: "locked — safe, but unreadable right now",
};

/** The notes section, in place of the paragraph that would otherwise be blank. */
export const NOTES_WORDS = {
  [DAMAGED]: "These notes can no longer be read — the stored copy is damaged beyond recovery. Typing new notes replaces it.",
  [LOCKED]: "These notes are locked. They're intact, and will be readable again once an administrator restores Orbit's encryption key.",
};

/**
 * What a damaged field's input says while it is empty. The panel is where the
 * damage has to be visible, because saving the panel is what clears it: a
 * full-row upsert writes the untouched field too, so a member who saves past
 * this placeholder has decided, and one who was never shown it has not.
 */
export const DAMAGED_PLACEHOLDER = "damaged — whatever you save replaces it";

/** The one line above the buttons when the whole panel is read-only. */
export const PANEL_LOCKED = "Editing is paused — this item's encrypted details are locked until an administrator restores Orbit's encryption key. Nothing is lost.";

/**
 * The stale submit: a panel opened before the key went away, sent afterwards.
 * The server refuses it with a 503 and this is that refusal in the member's
 * words, in the `.problem` alert the panel already has.
 */
export const SAVE_REFUSED = "not saved — encrypted details are locked until the key is restored. The stored values are intact.";

/** A mail-in message whose extract cannot be read, in the two states. */
export const RECEIPT_WORDS = {
  [LOCKED]: "This message is locked — Orbit can read it again once an administrator restores the encryption key.",
  [DAMAGED]: "Orbit's copy of this message is damaged and can't be read. The original is still in your mailbox — forward it again and Orbit will re-read it.",
};

/**
 * The API's per-field markers, for an item or a receipt.
 * @typedef {{ reference?: string, notes?: string, proposal?: string, fieldEvidence?: string } | null | undefined} MetadataStatus
 */

/**
 * The state of one named field, or null when it has none. Anything the server
 * has not taught this screen about reads as no state rather than as damage:
 * inventing a failure is the same sin as hiding one.
 * @param {MetadataStatus} status
 * @param {"reference" | "notes" | "proposal" | "fieldEvidence"} field
 * @returns {"metadata_integrity_failed" | "metadata_locked" | null}
 */
export function fieldState(status, field) {
  const state = status?.[field];
  return state === DAMAGED || state === LOCKED ? state : null;
}

/**
 * Whether an item's encrypted details are locked. Locked pauses ALL of that
 * item's editing, not only its two encrypted fields: `item.upsert` is a
 * full-row write through the metadata writer, so every edit is refused while
 * the key is away. Either field reading locked is the whole item locked.
 * @param {MetadataStatus} status
 */
export const itemLocked = (status) =>
  fieldState(status, "reference") === LOCKED || fieldState(status, "notes") === LOCKED;

/**
 * Whether the from-document marks may be shown. `fieldEvidence` damaged on its
 * own loses the provenance, not the values, so the READ · SURE / READ · UNSURE
 * marks and their accents go and nothing else does — a mark Orbit can no
 * longer stand behind is worse than no mark.
 * @param {MetadataStatus} status
 */
export const evidenceReadable = (status) => fieldState(status, "fieldEvidence") === null;

/**
 * The words for a mail-in message Orbit cannot read, or null when it can. The
 * proposal is what decides: `fieldEvidence` alone is handled above.
 * @param {MetadataStatus} status
 * @returns {string | null}
 */
export function receiptWords(status) {
  const state = fieldState(status, "proposal");
  return state ? RECEIPT_WORDS[state] : null;
}

/**
 * The message the `.problem` alert shows for a failed save. Only the locked
 * refusal is rewritten; every other failure keeps the server's own words,
 * which are already the ones the member needs.
 * @param {{ code?: string, message?: string }} error
 * @returns {string}
 */
export function saveProblem(error) {
  if (error?.code === "metadata_locked") return SAVE_REFUSED;
  return error?.message ?? String(error);
}
