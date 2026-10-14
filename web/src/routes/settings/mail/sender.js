import { WorkspaceError } from "$lib/data/workspace.js";
import { clockOf, dayMonth, localZone } from "$lib/format.js";

/*
 * The sender check's words (#1410, ADR-0017 decision 7c, design note 36064),
 * held once for the desk card and the phone's pocket.svelte so the two cannot
 * drift. Every visible word of the block that is not a row label is here.
 */

/** What the `sender check` row says, the tone it is drawn in, and the button that goes with it.
 *  @param {import("$lib/data/workspace.js").RelaySender} sender
 *  @param {number} [now]
 *  @returns {{ says: string, tone: "ok" | "warm", button: string | null }} */
export function checkRow(sender, now = Date.now()) {
  if (sender.verified) return { says: "checked", tone: "ok", button: null };
  /* Lapsed is a link with an expiry in the past, whatever `verificationPending` says. */
  if (sender.expiresAt && Date.parse(sender.expiresAt) <= now) {
    return { says: "not yet checked · the last link lapsed", tone: "warm", button: "send the check email" };
  }
  if (!sender.verificationPending) return { says: "not yet checked", tone: "warm", button: "send the check email" };
  if (!sender.expiresAt) {
    /* A pending check the read cannot date: say what is true of every link. */
    return { says: "email sent · open the link within 24 hours", tone: "warm", button: "send it again" };
  }
  /* In the member's own zone, as the rest of the app tells time. */
  const zone = localZone();
  return {
    says: `email sent · link lapses ${dayMonth(sender.expiresAt, zone)} ${clockOf(sender.expiresAt, zone)}`,
    tone: "warm",
    button: "send it again",
  };
}

/** What this visit has learnt since the read, kept by the page so both layouts show it:
 *  the link just sent lapses at `sentExpires`, or the address turned out to be checked already.
 *  @typedef {{ sentExpires: string | null, checked: boolean }} Learnt
 *  @param {import("$lib/data/workspace.js").RelaySender} sender
 *  @param {Learnt} learnt
 *  @returns {import("$lib/data/workspace.js").RelaySender} */
export function withLearnt(sender, { sentExpires, checked }) {
  if (checked) return { ...sender, verified: true, verificationPending: false, expiresAt: null };
  return sentExpires && !sender.verified ? { ...sender, verificationPending: true, expiresAt: sentExpires } : sender;
}

export const SENDING = "sending…";
/** The good news after a 202: the desk's status line, and the phone's wake. */
export const sentWords = (/** @type {string} */ address) =>
  `check email sent to ${address} · open the link while signed in, within 24 hours`;
export const SENT_WAKE = "check email sent · open the link within 24 hours";
export const ALREADY_CHECKED = "already checked — nothing to send";
export const LINK_CHECKED = "address checked · your relay is listening";
export const LINK_FAILED =
  "that link didn't work — it may have lapsed, been used already, or belong to another sign-in. send a new check email";

const NOT_REACHED = "not sent — Orbit could not reach your relay. try again";

/** What a refused press says: the engine's own words, exactly as they arrived (ADR-0034
 *  decision 4). Only when there is no answer, or none with usable words, is it the browser's.
 *  @param {unknown} error
 *  @returns {string} */
export function refusalWords(error) {
  const spoken = error instanceof WorkspaceError ? error.message.trim() : "";
  return spoken || NOT_REACHED;
}

/** The engine's word that the address is checked already, as a status line (good news, not a
 *  refusal), or null for any other answer. Its own words; the constant only stands in when it sent none.
 *  @param {unknown} error
 *  @returns {string | null} */
export function alreadyCheckedWords(error) {
  if (!(error instanceof WorkspaceError) || error.code !== "sender_already_verified") return null;
  return error.message.trim() || ALREADY_CHECKED;
}

/** The `?sender=` the check email's link lands on (the verify route), or null for anything else.
 *  @param {URLSearchParams} query
 *  @returns {"verified" | "unverified" | null} */
export function landingOf(query) {
  const one = query.get("sender");
  return one === "verified" || one === "unverified" ? one : null;
}

/** The landing is read once and taken out of the address bar, so a reload does not announce it again. */
export function clearLanding() {
  const url = new URL(window.location.href);
  url.searchParams.delete("sender");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
