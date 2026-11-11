/**
 * What the relay tab draws in each state (#1509, direction N), the desk and
 * the phone alike: design/v19/relay-settings/round-2/build.py, `statusOf`,
 * `dishState` and the "only what applies" rule.
 *
 * - no household mailbox (no address): the address slot and one line;
 * - an address but no checked sending address: status, waiting, the guide
 *   line and Sending addresses;
 * - usable: everything, rotate and pause included.
 */
import { addressUsable } from "$lib/relay-address.js";

export const NO_MAILBOX_MEMBER =
  "your administrator hasn’t set up the household mailbox yet · your address appears here when they do, with nothing to do on your side";
/* The administrator's line goes on with a link: "set it up under Administration → Mail". */
export const NO_MAILBOX_ADMIN = "the household mailbox isn’t set up yet";
export const NO_MAILBOX_LINK = "set it up under Administration → Mail";
export const READY_WORDS = "your address is ready · check the address you send from, then forward a document to try it";
export const ARMED_WORDS = "your old address keeps collecting for 14 days, so mail already on its way still arrives";
export const NOTHING_YET = "nothing yet · forward one to try";
const UNCHECKED = "no checked sending address";

/**
 * @param {{ address: string, status: string, ingest: string }} relay
 * @returns {{ mailbox: boolean, usable: boolean, unset: boolean, status: string, tone: "on" | "warm" | "quiet", dish: "" | "still" | "off" }}
 */
export function relayShape(relay) {
  const mailbox = addressUsable(relay.address);
  const usable = mailbox && relay.status !== UNCHECKED;
  const paused = relay.ingest === "paused";
  /* `not listening` with no address is the server saying the mailbox is not
     set up; `relay unavailable` is Orbit failing to read it, and gets no guide. */
  const unset = !mailbox && /not listening/iu.test(relay.status);
  if (!mailbox) return { mailbox, usable, unset, status: relay.status, tone: "quiet", dish: "off" };
  if (paused) return { mailbox, usable, unset, status: "paused · not collecting", tone: "warm", dish: "still" };
  if (!usable) return { mailbox, usable, unset, status: relay.status, tone: "warm", dish: "still" };
  const on = /listen|connect/iu.test(relay.status) && !/not listening/iu.test(relay.status);
  return { mailbox, usable, unset, status: relay.status, tone: on ? "on" : "warm", dish: on ? "" : "still" };
}
