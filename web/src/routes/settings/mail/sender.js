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
  /* Read before the other three (#1681, design note 52496): the address is
     checked, but the member's mail service did not sign their last forward,
     so Orbit could not keep it. Theirs to act on, so warm; nothing to press. */
  if (sender.verified && sender.lastForwardSigned === false) {
    return { says: "checked · but your last forward wasn't signed, so it wasn't kept", tone: "warm", button: null };
  }
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
 *  @param {string} [unreached]  the browser's words for this press, when the engine said none
 *  @returns {string} */
export function refusalWords(error, unreached = NOT_REACHED) {
  const spoken = error instanceof WorkspaceError ? error.message.trim() : "";
  return spoken || unreached;
}

/** The browser's words when an add or a remove (#1650) got no worded answer. */
export const NOT_ADDED = "not added — Orbit could not reach your relay. try again";
export const NOT_REMOVED = "not removed — Orbit could not reach your relay. try again";

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

/*
 * More than one sending address (#1650, design note 49429; note 54816 for the
 * days left). The sign-in row keeps the words above; the extra rows, the add
 * input and its limit say these, on the desk and the phone alike.
 */

/** Five addresses at most, the sign-in one included (the server's `MAX_SENDER_ADDRESSES_PER_USER`). */
export const SENDER_LIMIT = 5;
export const ADD_PLACEHOLDER = "another address you send from";
export const AT_LIMIT = "five is the most";
export const SEND_CHECK = "send check";
export const REMOVE = "remove";
export const ADD = "add";

/** @typedef {import("$lib/data/workspace.js").RelaySenderRow} SenderRow */

/** The member's extra rows, in the order the server lists them; never the sign-in row.
 *  @param {readonly SenderRow[] | undefined} senders
 *  @returns {SenderRow[]} */
export const extrasOf = (senders) => (senders ?? []).filter((row) => row.source === "manual");

/** Whether the list is full, so `add` is held with the caption.
 *  @param {readonly SenderRow[] | undefined} senders */
export const atLimit = (senders) => (senders ?? []).length >= SENDER_LIMIT;

/** What an extra row's state says, and its tone: checked, a check sent, or unchecked,
 *  with the whole days left before an unchecked row is removed (note 54816).
 *  @param {SenderRow} row
 *  @param {number} [now]
 *  @returns {{ says: string, tone: "ok" | "warm", canCheck: boolean }} */
export function extraRow(row, now = Date.now()) {
  /* A row Orbit cannot read is kept, never deleted on a read (#1810 item 4):
     it says so, and the member may remove it. */
  if (row.metadataStatus?.address === "metadata_integrity_failed") return { says: "can't be read \u00b7 remove and add it again", tone: "warm", canCheck: false };
  if (row.verified) {
    return row.lastForwardSigned === false
      ? { says: checkRow(row, now).says, tone: "warm", canCheck: false }
      : { says: "checked", tone: "ok", canCheck: false };
  }
  const live = row.verificationPending && !(row.expiresAt && Date.parse(row.expiresAt) <= now);
  const left = row.daysLeft === null || row.daysLeft === undefined
    ? ""
    : ` · removed in ${row.daysLeft} ${row.daysLeft === 1 ? "day" : "days"}`;
  return { says: `${live ? "check sent" : "unchecked"}${left}`, tone: "warm", canCheck: true };
}

/** The list once a check has gone to one row: that row's link is out until `expiresAt`.
 *  @param {readonly SenderRow[]} senders
 *  @param {string} id
 *  @param {string | null} expiresAt
 *  @returns {SenderRow[]} */
export const withCheckSent = (senders, id, expiresAt) =>
  senders.map((row) => (row.id === id ? { ...row, verificationPending: true, expiresAt } : row));
