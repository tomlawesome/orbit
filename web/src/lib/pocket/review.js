import { daysUntil } from "$lib/data/chart.js";
import { LOCKED, evidenceReadable, fieldState } from "$lib/data/metadata-status.js";
import { money } from "$lib/format.js";

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
 *   attachments?: { displayName?: string, sizeBytes?: number }[] | null,
 *   attachmentCount?: number,
 *   receivedAt?: string | null,
 *   expiresAt?: string | null,
 * }} Reviewable
 * @typedef {{ label: string, value: string, sure: boolean | null, field: "provider" | "reference" | "dueDate" | "cost" }} Reading
 * @typedef {{ label: string, value: string, sure: boolean, field: Reading["field"] }} FormReading
 *   a reading as create's form (EntryForm.svelte) takes it
 */

/** `11 Aug`. @param {string | null | undefined} iso */
export const caughtOf = (iso) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }) : "";

/** @param {string} iso */
const fullDate = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

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
    label: p.scheduleKind === "expiry" ? "ends" : "renews", value: fullDate(p.dueDate), sure: sure("dueDate"), field: "dueDate",
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
 * The documents riding with the mail. The list API names no files yet
 * (#467): the fixture carries the design's names, live data the count. The
 * card prints the name alone (round 3 §3.5); the sheet's reading card keeps
 * the size.
 * @param {Reviewable} mail
 * @returns {{ name: string, meta: string }[]}
 */
export const papersOf = (mail) =>
  mail.attachments?.map((a) => ({
    name: a.displayName ?? "document", meta: `${Math.round((a.sizeBytes ?? 0) / 1024)} KB`,
  })) ?? (mail.attachmentCount
    ? [{ name: `${mail.attachmentCount} document${mail.attachmentCount === 1 ? "" : "s"}`, meta: "" }]
    : []);
