import { daysUntil } from "$lib/data/chart.js";
import { LOCKED, evidenceReadable, fieldState } from "$lib/data/metadata-status.js";
import { dayMonth, dayMonthYear, money, plural, sizeLabel } from "$lib/format.js";

/**
 * THE REVIEW CARD'S WORDS (round 3 §4, #1140): what ReviewCard.svelte and
 * ReviewSheet.svelte draw, read from a piece of mail in whichever shape the
 * screen holds it -- the inbox's receipt, home's suggestion, the receipt
 * page's item view. One reading, so the three screens say one thing.
 *
 * @typedef {{
 *   title?: string | null,
 *   proposal?: import('$lib/data/workspace.js').ItemProposal | null,
 *   fieldEvidence?: Record<string, { source: string, confidence: string }> | null,
 *   metadataStatus?: { proposal?: string, fieldEvidence?: string } | null,
 *   attachments?: { id?: string, displayName?: string, sizeBytes?: number,
 *     mediaType?: string, scanState?: "clean" | "unknown" }[] | null,
 *   attachmentCount?: number,
 *   receivedAt?: string | null,
 *   expiresAt?: string | null,
 * }} Reviewable
 * @typedef {{ label: string, value: string, sure: boolean | null, field: "provider" | "reference" | "dueDate" | "cost" }} Reading
 * @typedef {{ label: string, value: string, sure: boolean, field: Reading["field"] }} FormReading
 *   a reading as create's form (EntryForm.svelte) takes it
 */

/** `11 Aug`. @param {string | null | undefined} iso */
export const caughtOf = (iso) => (iso ? dayMonth(iso) : "");

/** @param {Reviewable} mail */
export const reviewTitleOf = (mail) => mail.proposal?.title ?? mail.title ?? "Forwarded email";

/** Days until it burns up, or null. @param {Reviewable} mail @param {string} today */
export const burnsInOf = (mail, today) => (mail.expiresAt ? daysUntil(mail.expiresAt.slice(0, 10), today) : null);

/** Nothing to add until an administrator restores the key (#941). @param {Reviewable} mail */
export const reviewLockedOf = (mail) => fieldState(mail.metadataStatus, "proposal") === LOCKED;

/**
 * The readings, label and value and the parser's confidence in a word.
 * #941: a mark Orbit can no longer stand behind is dropped, not guessed.
 * @param {Reviewable} mail
 * @returns {Reading[]}
 */
export function readingsOf(mail) {
  const p = mail.proposal ?? {};
  /** @param {string} field */
  const sure = (field) => {
    if (!evidenceReadable(mail.metadataStatus)) return null;
    const evidence = mail.fieldEvidence?.[field];
    return evidence ? evidence.confidence !== "low" : null;
  };
  /** @type {Reading[]} */
  const out = [];
  if (p.provider) out.push({ label: "provider", value: p.provider, sure: sure("provider"), field: "provider" });
  if (p.reference) out.push({ label: "reference", value: p.reference, sure: sure("reference"), field: "reference" });
  if (p.dueDate) out.push({
    label: p.scheduleKind === "expiry" ? "ends" : "renews", value: dayMonthYear(p.dueDate), sure: sure("dueDate"), field: "dueDate",
  });
  if (p.costMinor) out.push({
    label: "cost", value: money(p.costMinor, p.currency ?? "GBP", true), sure: sure("costMinor"), field: "cost",
  });
  return out;
}

/**
 * The readings as the review sheet's form takes them: every one it can copy
 * back, each value as typed in its field.
 * @param {Reviewable} mail
 * @returns {FormReading[]}
 */
export const formReadingsOf = (mail) =>
  readingsOf(mail).map((one) => ({
    ...one, sure: one.sure !== false,
    value: one.field === "dueDate" ? /** @type {string} */ (mail.proposal?.dueDate)
      : one.field === "cost" ? ((mail.proposal?.costMinor ?? 0) / 100).toFixed(2) : one.value,
  }));

/**
 * The preview route for a staged attachment (#1155): nested under the
 * receipt, because the staging context binds the bytes to
 * `(attachmentId, recipientUserId, receiptId)`
 * (`src/server/mail-in/imap-attachment-holding.ts:41-53`).
 * @param {string} receiptId
 * @param {string} attachmentId
 * @returns {string}
 */
export const stagedPreviewHref = (receiptId, attachmentId) =>
  `/api/imap-inbox/${encodeURIComponent(receiptId)}/attachments/${encodeURIComponent(attachmentId)}/preview`;

/**
 * The documents riding with the mail, named since #467 where the list names
 * them; a receipt with no `attachments` array degrades to the count alone.
 * The card prints the name alone (round 3 §3.5); the sheet's reading card
 * keeps the size. `drawable` is whether pressing the paper can open a page
 * (#1155): only a named, PDF attachment has one.
 * @param {Reviewable} mail
 * @returns {{ id: string | null, name: string, meta: string, drawable: boolean, clean: boolean }[]}
 */
export const papersOf = (mail) =>
  mail.attachments?.map((a) => ({
    id: a.id ?? null,
    name: a.displayName ?? "document",
    meta: sizeLabel(a.sizeBytes ?? 0),
    drawable: Boolean(a.id) && a.mediaType === "application/pdf",
    clean: a.scanState === "clean",
  })) ?? (mail.attachmentCount
    ? [{ id: null, name: plural(mail.attachmentCount, "document"), meta: "", drawable: false, clean: false }]
    : []);
