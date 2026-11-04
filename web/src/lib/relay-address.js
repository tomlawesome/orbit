import { wake } from "$lib/pocket/wake.js";

/*
 * The member's relay address as a thing to copy (#1658). One copy of the
 * logic and the words, for the phone's tap and the desk's click alike.
 */

/** What a screen shows when the member has no relay address at all. */
export const NO_ADDRESS = "no address yet";

/** Whether `address` is one to hand out (not the "no address yet" stand-in). */
export const addressUsable = (/** @type {string} */ address) => address !== NO_ADDRESS;

/**
 * The copy button's accessible name. With no address the button is disabled
 * and offers nothing to copy, so its name says so instead (#1670 G-W2, as the
 * Settings phone screen already has it).
 */
export const relayAddressLabel = (/** @type {string} */ address) =>
  addressUsable(address) ? `Copy your relay address, ${address}` : "No relay address yet";

/** Copies the address and says how it went, in the wake line. */
export async function copyRelayAddress(/** @type {string} */ address) {
  if (!addressUsable(address)) return;
  try {
    await navigator.clipboard.writeText(address);
    wake("copied · your relay address");
  } catch {
    wake("not copied — your browser kept the clipboard closed", { failure: true });
  }
}

/** The line under the address while the administrator has paused ingest (#1654). */
export const ADMIN_PAUSED_WORDS =
  "collection is paused by the administrator · mail sent now waits and is read when it resumes";
