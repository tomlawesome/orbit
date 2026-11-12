/**
 * #1437: "you already hold this document". The words every surface says when
 * the server reports that the household already holds a file byte for byte
 * (`alreadyHeld` on the upload answer and on a mail-in attachment), carried
 * verbatim from design/v19/duplicate-alert/round-1 (owner verdicts 3a, 4a,
 * 5a): the desk's reading lane and the phone's reading card on Add, the desk
 * receipt and the phone review card in the inbox.
 */
import { MONTHS } from "$lib/format.js";
import { daysUntil } from "./chart.js";

/** @typedef {import("./workspace.js").AlreadyHeld} AlreadyHeld */

export const ALREADY_HEAD = "Already in your orbit";
export const YOU_HOLD = "You already hold this document.";
export const NOTHING_READ = "nothing has been read from it yet — keep it, and orbit reads it as usual";
export const RENEW_ADD = "If you meant to add this year’s certificate, this is last year’s file.";
export const RENEW_MAIL = "If this was meant to be the new certificate, it is last year’s file.";
export const MAIL_KEEPS = "Add to orbit keeps it as a second copy";
export const MAIL_DISMISS = "dismiss drops the mail, not the one you hold";

/** The day the first copy was added, as the mock-up writes it: "3 Mar 2026". @param {string} iso */
export function addedDay(iso) {
  const day = new Date(iso);
  if (Number.isNaN(day.getTime())) return "";
  return `${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
}

/** "kept as a second copy · the first is on <entry>" @param {AlreadyHeld} held */
export function keptWords(held) {
  return held.entry ? `kept as a second copy · the first is on ${held.entry.title}` : "kept as a second copy";
}

/**
 * The days until the entry holding the first copy is due, when that falls
 * inside the home sky's 30-day window or is past (owner 4a); null otherwise,
 * and when the entry or its date is not in the workspace this browser holds.
 *
 * @param {AlreadyHeld | null | undefined} held
 * @param {{ items?: { id: string, dueDate?: string | null }[] }[]} households
 * @param {string} today  YYYY-MM-DD
 * @returns {number | null}
 */
export function renewalDays(held, households, today) {
  const itemId = held?.entry?.itemId;
  if (!itemId) return null;
  const item = households.flatMap((household) => household.items ?? []).find((one) => one.id === itemId);
  const days = daysUntil(item?.dueDate, today);
  return days !== null && days <= 30 ? days : null;
}

/** "Car MOT — Volvo V60 is due in 16 days." @param {string} title @param {number} days */
export function dueWords(title, days) {
  const count = (/** @type {number} */ n) => `${n} ${n === 1 ? "day" : "days"}`;
  if (days < 0) return `${title} is ${count(-days)} overdue.`;
  if (days === 0) return `${title} is due today.`;
  return `${title} is due in ${count(days)}.`;
}
