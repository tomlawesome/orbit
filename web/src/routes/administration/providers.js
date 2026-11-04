/*
 * The Sign-in providers card, held once for the desk's card and the phone's
 * (#1676, ADR-0041 §6, design/v19/provider-removal/round-3/t-the-one-line.html).
 * Like ./acts.svelte.js this holds no state of its own: each layout keeps
 * `providerState()` as `$state`, makes one `createArm()` for the two-tap, and
 * draws it in its own dialect.
 *
 * The card lists only a provider that is off in configuration and still has
 * links, one `.kv` row each. Only the primary administrator, with a local
 * password, can remove them (the server refuses everyone else); the others see
 * a quiet line where the button would be. The confirm opens under the row with
 * the password and the two-tap. The result is the row's own words, People's
 * green line, and one problem line for each person who could not be mailed.
 */

import { readSessions } from "$lib/data/workspace.js";
import { dayMonth } from "$lib/format.js";
import { card, readProviderLinks, removeProviderLinks } from "./acts.svelte.js";
import { SETUP_LINK_DAYS } from "./words.js";

/**
 * @typedef {{ count: number, at: string, sent: number, planned: number, until: string,
 *   notMailed: { userId: string, name: string, reason: string | null }[] }} ProviderDone
 * @typedef {{ issuer: string, provider: import("./acts.svelte.js").Provider | null, done: ProviderDone | null }} ProviderRow
 * @typedef {ReturnType<typeof providerState>} ProviderState
 * @typedef {{ user?: { id: string } | null } | null} ProviderView
 */

/** The card's state, for a screen to hold as `$state`. */
export const providerState = () => ({
  /** @type {import("./acts.svelte.js").ProviderLinks | null} */
  links: null,
  /** The issuer whose confirm is open. @type {string | null} */
  open: null,
  password: "",
  armed: false,
  /** The no-mail refusal, under its row. @type {string | null} */
  refusal: null,
  /**
   * What each removal did, by issuer, kept on the page until it is left: the
   * administrator's own provider session may have ended with the others, and
   * a re-read would then send them to sign in and lose it.
   * @type {Record<string, ProviderDone>}
   */
  results: {},
  /** Whether this browser's own session began at the provider. */
  viaProvider: false,
  card: card(),
});

/** Reads the preview and whether this session came through the provider. @param {ProviderState} state @param {() => boolean} [gone] */
export async function loadProviders(state, gone = () => false) {
  try {
    const [next, own] = await Promise.all([readProviderLinks(), readSessions().catch(() => [])]);
    if (gone()) return;
    state.links = next;
    state.viaProvider = own.some((row) => row.current && row.viaProvider);
  } catch { /* additive: no card rather than a sunk screen */ }
}

/** True when the viewer may remove (the server decides again). @param {ProviderState} state */
export const canRemove = (state) => Boolean(state.links?.viewerIsPrimary && state.links.viewerHasPassword);

/**
 * The rows: a provider that is off with links left, and one this page has just
 * emptied (which stays, saying so, until the page is left).
 * @param {ProviderState} state @returns {ProviderRow[]}
 */
export function providerRows(state) {
  const listed = (state.links?.providers ?? []).filter((provider) => !provider.configured)
    .map((provider) => ({ issuer: provider.issuer, provider, done: state.results[provider.issuer] ?? null }));
  const emptied = Object.keys(state.results).filter((issuer) => !listed.some((row) => row.issuer === issuer))
    .map((issuer) => ({ issuer, provider: null, done: state.results[issuer] }));
  return [...listed, ...emptied];
}

/** Whether the confirm says the viewer is signed out too. @param {ProviderState} state @param {import("./acts.svelte.js").Provider} provider @param {ProviderView} view */
export const signedOutToo = (state, provider, view) =>
  state.viaProvider && provider.members.some((one) => one.userId === view?.user?.id);

/** @param {ProviderState} state @param {import("./acts.svelte.js").Provider} provider */
export function openConfirm(state, provider) {
  state.refusal = null;
  state.card.problem = null;
  /* No step-up here: the preview only offers this act to a primary
     administrator who has a password, and the server refuses anyone else. */
  state.open = provider.issuer;
  state.password = "";
}

/** @param {ProviderState} state @param {{ disarm: () => void }} arm */
export function closeConfirm(state, arm) {
  arm.disarm();
  state.open = null;
  state.password = "";
}

/**
 * The two-tap: the first tap arms the button, the second on the same one fires.
 * @param {ProviderState} state @param {{ tap: (key?: string, button?: HTMLElement | null) => boolean, disarm: () => void }} arm
 * @param {import("./acts.svelte.js").Provider} provider @param {HTMLElement | null} button
 */
export function tapRemove(state, arm, provider, button) {
  if (arm.tap(provider.issuer, button)) removeNow(state, arm, provider);
}

/** @param {ProviderState} state @param {{ disarm: () => void }} arm @param {import("./acts.svelte.js").Provider} provider */
export function removeNow(state, arm, provider) {
  return removeProviderLinks(provider, state.password, {
    card: state.card,
    cleared: () => { state.password = ""; },
    refused: () => { state.refusal = provider.issuer; closeConfirm(state, arm); },
    landed: (answer) => {
      const { removed: count, recipients } = answer;
      const names = new Map(provider.members.map((member) => [member.userId, member.displayName]));
      /* A disabled member is never mailed and is waiting for nothing. */
      const asked = recipients.filter((one) => one.reason !== "member_disabled");
      const now = Date.now();
      state.results = {
        ...state.results,
        [provider.issuer]: {
          count,
          at: new Date(now).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
          sent: asked.filter((one) => one.mailed).length,
          planned: asked.length,
          until: dayMonth(new Date(now + SETUP_LINK_DAYS.fallback * 86_400_000).toISOString()),
          notMailed: asked.filter((one) => !one.mailed).map((one) => ({
            userId: one.userId,
            name: names.get(one.userId) ?? "a member",
            reason: one.reason,
          })),
        },
      };
      closeConfirm(state, arm);
    },
  });
}
