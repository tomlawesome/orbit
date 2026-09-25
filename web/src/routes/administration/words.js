/*
 * What administration says, held once so the desk's cards and the pocket's
 * rows say the same thing (#1123). Moved verbatim from +page.svelte.
 */

/** @param {string} name */
export const initialsOf = (name) =>
  name.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase();

/** The lapse date as a reader reads it, in UTC so the gate photographs one date. @param {string} iso */
export const lapses = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** The mailer's bounded word, said plainly. @param {string} reason */
export const sendWords = (reason) =>
  reason === "smtp_unconfigured"
    ? "this instance has no outgoing mail configured, so nothing was sent"
    : reason === "smtp_unavailable"
      ? "the mail server could not be reached, so nothing was sent"
      : reason === "smtp_rejected"
        ? "the mail server refused the message, so nothing was sent"
        : "the message could not be sent";

/** What a refused action means here, from the bounded code. @param {unknown} error */
export function setupWords(error) {
  const code = /** @type {{ code?: string, message?: string }} */ (error)?.code;
  if (code === "recent_authentication_required") return "that isn't your current password — nothing was created";
  if (code === "too_many_attempts") return "too many attempts at once; try again shortly";
  if (code === "provider_handover_unreadable") {
    return "not started — Orbit could not hand you to your identity provider";
  }
  return /** @type {{ message?: string }} */ (error)?.message ?? String(error);
}

/** @param {string} word */
export const plainly = (word) => word.replaceAll("_", " ");

/** @param {?string} iso */
export const stamp = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "UTC" }) : "never");

/**
 * How long the rotation card's subject has been open (#956), in the
 * sentence register — "open 3 days" — where format.js's ago() speaks in
 * chrome shorthand and appends "ago".
 * @param {string} iso
 */
export const openFor = (iso) => {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
};

/** The setup link's lifetime, in days, as the server bounds it (ADR-0023 §3). */
export const SETUP_LINK_DAYS = { min: 1, max: 14, fallback: 7 };
