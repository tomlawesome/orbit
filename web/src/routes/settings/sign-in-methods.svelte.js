/*
 * What changing a sign-in method does, held once for the desk's "You" card
 * and the phone's callout (#1353, web-12). The layouts differ in how they
 * ask and how they answer, not in what is sent, so each act takes:
 *   card     `{ busy, problem }`, held as `$state` by the layout;
 *   landed   what the layout closes once the change is taken;
 *   say      the desk's line under the card, given the outcome;
 *   wake     the phone's line at the foot of the screen, given the same;
 *   keep     where the re-read methods go.
 * Nothing here holds state of its own.
 */

import {
  readSignInMethods, removeLocalPassword, startProviderLink, startStepUp, unlinkProviderIdentity, writeLocalPassword,
} from "$lib/data/workspace.js";
import { intentOf, methodWords, stepUpReturnOf } from "./helm.js";

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
