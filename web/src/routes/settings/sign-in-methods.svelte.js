/*
 * What settings does, held once for the desk's cards and the phone's rows
 * (#1353, web-12): changing a sign-in method, the two reminder switches, and
 * the sign-outs. The layouts differ in how they ask and how they answer, not
 * in what is sent, so each act takes:
 *   card     `{ busy, problem }`, held as `$state` by the layout;
 *   landed   what the layout closes or sets once the change is taken;
 *   say      the desk's line under the card, given the outcome;
 *   wake     the phone's line at the foot of the screen, given the same;
 *   keep     where the re-read methods go.
 * Nothing here holds state of its own.
 */

import {
  readSignInMethods, removeLocalPassword, startProviderLink, startStepUp, unlinkProviderIdentity, writeLocalPassword,
  writeReminders,
} from "$lib/data/workspace.js";
import { disableAlerts, enableAlerts, syncAlerts } from "$lib/push/alerts.js";
import { alertsWords, intentOf, methodWords, stepUpReturnOf } from "./helm.js";
import { signOutOfDevice, signOutOfEveryDevice } from "./sign-out.js";

/** @typedef {{ busy: boolean, problem: string | null }} Card */
/** @typedef {Awaited<ReturnType<typeof readSignInMethods>>} Methods */

const quiet = () => {};

/** A card's own state, for the layout to hold as `$state`. */
export const card = () => ({ busy: false, problem: /** @type {string | null} */ (null) });

/**
 * No password: the challenge is a fresh authentication at the provider, and
 * the way back carries the action so the screen re-arms it.
 * @param {string} action @param {Card} card
 */
export async function proveAtProvider(action, card) {
  card.problem = null;
  try {
    await startStepUp({ intent: intentOf(action), returnTo: stepUpReturnOf(action) });
  } catch (error) {
    card.problem = methodWords(error);
  }
}

/**
 * The change itself, carrying whichever proof applies: a step-up proof
 * travels as a cookie, a password in the body, and exactly one of them is in
 * play. Linking a provider leaves the screen for it, so nothing is said.
 * @param {string | null} action `password_set`, `password_change`, `password_remove`, `link_oidc` or `unlink:<identity id>`
 * @param {{ hasPassword: boolean, currentPassword: string, newPassword: string }} typed
 * @param {{ card: Card, landed: () => void, say?: (outcome: string) => void, wake?: (outcome: string) => void, keep: (methods: Methods) => void }} on
 */
export async function changeMethod(action, { hasPassword, currentPassword, newPassword }, { card, landed, say = quiet, wake = quiet, keep }) {
  if (!action || card.busy) return;
  card.busy = true;
  card.problem = null;
  const challenge = hasPassword ? { currentPassword } : {};
  try {
    let outcome = "";
    if (action === "link_oidc") {
      await startProviderLink({ returnTo: "/settings", ...challenge });
      return;
    }
    if (action === "password_set" || action === "password_change") {
      const result = await writeLocalPassword({ password: newPassword, ...challenge });
      outcome = result.changed ? "password changed · every other device was signed out" : "password set";
    } else if (action === "password_remove") {
      await removeLocalPassword(challenge);
      outcome = "password removed";
    } else if (action.startsWith("unlink:")) {
      await unlinkProviderIdentity(action.slice(7), challenge);
      outcome = "identity provider unlinked";
    }
    say(outcome);
    landed();
    wake(outcome);
    keep(await readSignInMethods());
  } catch (error) {
    card.problem = methodWords(error);
  } finally {
    card.busy = false;
  }
}

/**
 * The email reminders switch (#468). Optimistic: a switch that waits for a
 * round trip reads as dead, and the revert is what keeps it honest. The two
 * warning offsets are handed straight back, as there is no editor for them.
 * @param {Parameters<typeof writeReminders>[0]} reminders what the screen holds now (the offsets are handed back as they are)
 * @param {{ card: Card, shown: (enabled: boolean) => void, landed: (saved: any) => void, wake?: (words: string) => unknown }} on
 *   `shown` draws the switch (the guess, and the revert); `landed` takes the server's answer
 */
export async function toggleEmailReminders(reminders, { card, shown, landed, wake = quiet }) {
  if (card.busy) return;
  const next = !reminders.emailEnabled;
  shown(next);
  card.busy = true;
  card.problem = null;
  try {
    const saved = await writeReminders({
      emailEnabled: next,
      firstWarningDays: reminders.firstWarningDays,
      finalWarningDays: reminders.finalWarningDays,
    });
    /* The server's answer wins over the guess, sentences included. */
    landed(saved);
    wake(`saved · email reminders ${saved.emailEnabled ? "on" : "off"}`);
  } catch {
    shown(reminders.emailEnabled);
    card.problem = "not saved — Orbit could not reach your reminder settings";
  } finally {
    card.busy = false;
  }
}

/**
 * The browser alerts switch (#763), for this device alone. Not optimistic:
 * switching on opens the browser's own prompt, and the switch must not claim
 * to be on while that is still being answered.
 * @param {boolean} isOn whether alerts are on now
 * @param {{ card: Card, set: (on: boolean) => void, wake?: (words: string) => unknown, curly?: boolean }} on
 */
export async function toggleBrowserAlerts(isOn, { card, set, wake = quiet, curly = false }) {
  if (card.busy) return;
  card.busy = true;
  card.problem = null;
  try {
    if (isOn) await disableAlerts();
    else await enableAlerts();
    set(!isOn);
    wake(`saved · browser alerts ${isOn ? "off" : "on"} on this device`);
  } catch (error) {
    /* #1151 F9: reconcile against the server the same way the screen's own
       read does. currentSubscription() only reports whether the browser still
       holds a subscription object, which stays true even after the server has
       refused it (e.g. it belongs to another account on a shared device). */
    set(Boolean(await syncAlerts()));
    card.problem = alertsWords(error, { curly });
  } finally {
    card.busy = false;
  }
}

/**
 * One flag per screen, kept once this device has left: a second press then
 * sends nothing, and after this session has ended any request would answer
 * 401 and sign the reader straight back in through the provider (#1439).
 */
export const leaving = () => ({ out: false });

/**
 * Signs one device out (./sign-out.js). This device's own session plays the
 * goodbye; another device's just drops its row.
 * @param {{ id: string, current: boolean, device: string }} row
 * @param {{ leaving: { out: boolean }, descendFrom: ((redirectTo: string | null) => unknown) | undefined, begun?: () => void, dropped: () => void, failed: () => void, wake?: (words: string) => unknown }} on
 */
export async function signOutDevice(row, { leaving, descendFrom, begun = quiet, dropped, failed, wake = quiet }) {
  if (leaving.out) return;
  leaving.out = true;
  begun();
  try {
    if (await signOutOfDevice(row, descendFrom)) return;
    dropped();
    wake(`signed out of ${row.device}`);
  } catch {
    failed();
  }
  leaving.out = false;
}

/**
 * Signs out of every device, this one included, and leaves with the goodbye.
 * @param {{ leaving: { out: boolean }, descendFrom: ((redirectTo: string | null) => unknown) | undefined, begun?: () => void, failed: () => void }} on
 */
export async function signOutAll({ leaving, descendFrom, begun = quiet, failed }) {
  if (leaving.out) return;
  leaving.out = true;
  begun();
  try {
    await signOutOfEveryDevice(descendFrom);
  } catch {
    failed();
    leaving.out = false;
  }
}
