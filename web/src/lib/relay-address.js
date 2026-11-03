import { wake } from "$lib/pocket/wake.js";

/*
 * The member's relay address as a thing to copy (#1658). One copy of the
 * logic and the words, for the phone's tap and the desk's click alike.
 */

/** What a screen shows when the member has no relay address at all. */
export const NO_ADDRESS = "no address yet";

/** Whether `address` is one to hand out (not the "no address yet" stand-in). */
export const addressUsable = (/** @type {string} */ address) => address !== NO_ADDRESS;

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
