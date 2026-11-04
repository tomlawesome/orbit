/*
 * The Sign-in providers card, held once for the desk's card and the phone's
 * (#1676, ADR-0041, design/v19/provider-removal/round-2/
 * s-the-providers-card.html). Like ./acts.svelte.js this holds no state of its
 * own: each layout keeps `providerState()` as `$state`, makes one
 * `createArm()` for the two-tap, and draws it in its own dialect. What is
 * read, what is posted and what the result says are the same.
 *
 * Only the primary administrator, with a local password, can remove a
 * provider's links (the server refuses everyone else); the others see a quiet
 * line where the act would be. The act is checked first where the screen can
 * tell (a provider still configured opens nothing), then confirmed under the
 * row with the password, the host typed and two taps. The result is a count of
 * the mailed and, by name, only those who could not be mailed (verdict 48).
 */

import { readSessions } from "$lib/data/workspace.js";
import { dayMonth, plural } from "$lib/format.js";
import { card, readProviderLinks, removeProviderLinks } from "./acts.svelte.js";
import { SETUP_LINK_DAYS, signInWords } from "./words.js";

/**
 * @typedef {{ removed: number, planned: number, sent: number, others: number, at: string, atMs: number, until: string, signedOut: boolean,
 *   notMailed: { userId: string, name: string, email: string | null, reason: string | null }[] }} ProviderDone
 * @typedef {{ issuer: string, provider: import("./acts.svelte.js").Provider | null, record: import("./acts.svelte.js").ProviderRemovalRecord | null }} ProviderRow
 * @typedef {ReturnType<typeof providerState>} ProviderState
 * @typedef {{ user?: { id: string } | null, users: { id: string, email?: string }[] | null } | null} ProviderView
 */

/** The card's state, for a screen to hold as `$state`. */
export const providerState = () => ({
  /** @type {import("./acts.svelte.js").ProviderLinks | null} */
  links: null,
  /** The issuer whose confirm is open. @type {string | null} */
  open: null,
  days: SETUP_LINK_DAYS.fallback,
  password: "",
  typed: "",
  armed: false,
  /** @type {{ issuer: string, kind: "configured" | "no-mail" } | null} */
  refusal: null,
  /**
   * What each removal did, by issuer, kept on the page: the administrator's
   * own provider session may have ended with the others, and a re-read would
   * then send them to sign in and lose it.
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
    /* Whether this browser's own session began at the provider is for the
       signed-out lines; where it cannot be read they are left out. */
    const [next, own] = await Promise.all([readProviderLinks(), readSessions().catch(() => [])]);
    if (gone()) return;
    state.links = next;
    state.viaProvider = own.some((row) => row.current && row.viaProvider);
  } catch { /* additive: no card rather than a sunk screen */ }
}

/** True when the viewer may remove (the server decides again). @param {ProviderState} state */
export const canRemove = (state) => Boolean(state.links?.viewerIsPrimary && state.links.viewerHasPassword);

/** The rows: what the preview lists, what a removal has since done, and earlier removals. @param {ProviderState} state @returns {ProviderRow[]} */
export function providerRows(state) {
  const listed = (state.links?.providers ?? []).map((provider) => ({ issuer: provider.issuer, provider, record: null }));
  const gone = Object.keys(state.results).filter((issuer) => !listed.some((row) => row.issuer === issuer))
    .map((issuer) => ({ issuer, provider: null, record: null }));
  /* The preview is read once, when the page opens, and never again after a
     removal, so its records are exactly the removals made before this page
     opened; one made here is a result row of its own and cannot repeat it. */
  const earlier = (state.links?.removed ?? [])
    .map((record) => ({ issuer: `removed-${record.removedAt}`, provider: null, record }));
  return [...listed, ...gone, ...earlier];
}

/** The card head's count. @param {ProviderState} state */
export function providerCount(state) {
  const rows = providerRows(state);
  const links = rows.reduce((sum, row) => sum + (state.results[row.issuer] ? 0 : (row.provider?.members.length ?? 0)), 0);
  return `${plural(rows.length, "provider")} · ${links === 0 ? "no links" : plural(links, "link")}`;
}

/** Whether the stake line says the viewer is signed out too. @param {ProviderState} state @param {import("./acts.svelte.js").Provider} provider @param {ProviderView} view */
export const signedOutToo = (state, provider, view) =>
  state.viaProvider && provider.members.some((one) => one.userId === view?.user?.id);

/** A person's sign-in state words, once a removal is on record; null before. @param {ProviderState} state @param {string} userId */
export function personState(state, userId) {
  if (!state.links || state.links.removed.length === 0) return null;
  return signInWords(state.links.people.find((one) => one.userId === userId)?.signIn);
}

/** The check first: a provider still configured opens nothing. @param {ProviderState} state @param {import("./acts.svelte.js").Provider} provider */
export function openConfirm(state, provider) {
  state.refusal = null;
  state.card.problem = null;
  if (provider.configured) { state.refusal = { issuer: provider.issuer, kind: "configured" }; return; }
  /* No step-up here: the preview only offers this act to a primary
     administrator who has a password, and the server refuses anyone else. */
  state.open = provider.issuer;
  state.days = SETUP_LINK_DAYS.fallback;
  state.password = "";
  state.typed = "";
}

/** @param {ProviderState} state @param {{ disarm: () => void }} arm */
export function closeConfirm(state, arm) {
  arm.disarm();
  state.open = null;
  state.password = "";
  state.typed = "";
}

/**
 * The two-tap: the first tap arms the button, the second on the same one fires.
 * @param {ProviderState} state @param {{ tap: (key?: string, button?: HTMLElement | null) => boolean, disarm: () => void }} arm
 * @param {import("./acts.svelte.js").Provider} provider @param {HTMLElement | null} button @param {ProviderView} view
 */
export function tapRemove(state, arm, provider, button, view) {
  if (arm.tap(provider.issuer, button)) removeNow(state, arm, provider, view);
}

/** @param {ProviderState} state @param {{ disarm: () => void }} arm @param {import("./acts.svelte.js").Provider} provider @param {ProviderView} view */
export function removeNow(state, arm, provider, view) {
  return removeProviderLinks(provider, state.days, state.password, {
    card: state.card,
    cleared: () => { state.password = ""; },
    refused: (kind) => { state.refusal = { issuer: provider.issuer, kind }; closeConfirm(state, arm); },
    landed: (answer) => {
      const names = new Map(provider.members.map((member) => [member.userId, member.displayName]));
      const sent = answer.recipients.filter((one) => one.mailed).length;
      const now = Date.now();
      state.results = {
        ...state.results,
        [provider.issuer]: {
          removed: answer.removed,
          planned: answer.recipients.length,
          sent,
          others: Math.max(0, answer.members - answer.recipients.length),
          at: new Date(now).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
          atMs: now,
          until: dayMonth(new Date(now + state.days * 86_400_000).toISOString()),
          signedOut: signedOutToo(state, provider, view),
          notMailed: answer.recipients.filter((one) => !one.mailed).map((one) => ({
            userId: one.userId,
            name: names.get(one.userId) ?? "a member",
            email: view?.users?.find((person) => person.id === one.userId)?.email ?? null,
            reason: one.reason,
          })),
        },
      };
      closeConfirm(state, arm);
    },
  });
}
