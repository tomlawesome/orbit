/**
 * mail-in/core boundary: pure parsing logic only. No `getDb`/`db`/schema
 * imports and no `imapflow` import — see src/server/mail-in/README.md.
 *
 * The per-user relay generation contract (ADR-0017 decision 2, slice 3,
 * orbit#744). It replaces the instance-wide rotation state machine that used
 * to live in `imap-rotation.ts`: there is no second authority to reconcile
 * against any more, so what is left is arithmetic on one user's own row.
 *
 * Exactly one current generation; at most one previous, with an explicit
 * expiry. Generations are a per-user monotonic counter — never lowered, never
 * reused, and meaningful only inside that user's row, so two members sitting
 * at generation 1 is normal and says nothing about either of them.
 */

/** One user's generations, as `mail_in_relays` stores them. */
export type RelayGenerationState = {
  currentGeneration: number;
  previousGeneration: number | null;
  previousExpiresAt: Date | null;
};

/**
 * How long a rotated-away address keeps attributing mail. Fixed by the
 * product, not chosen by the user (ADR-0017 decision 2, amending ADR-0005's
 * administrator-selected transition).
 */
export const RELAY_PREVIOUS_GRACE_MS = 14 * 86_400_000;

/** `rotate and cut off`: the old address stops attributing immediately. */
export const RELAY_CUT_OFF_GRACE_MS = 0;

/**
 * The ceiling on any grace, including the administrator's instance-wide
 * emergency key rotation — the same 90 days the environment-era configuration
 * capped a transition at (`core/config.ts`, `MAX_PREVIOUS_ALIAS_TRANSITION_MS`).
 */
export const RELAY_MAX_GRACE_MS = 90 * 86_400_000;

/** Deliberately generic: nothing here may name a key, a digest or an address. */
export class RelayGenerationError extends Error {
  readonly code = "relay_generation_invalid";

  constructor() {
    super("The relay generation state is invalid");
    this.name = "RelayGenerationError";
  }
}

function assertGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new RelayGenerationError();
}

/** A relay row is only usable if its generations satisfy the paired contract. */
export function assertRelayGenerationState(state: RelayGenerationState): RelayGenerationState {
  assertGeneration(state.currentGeneration);
  const hasPrevious = state.previousGeneration !== null;
  if (hasPrevious !== (state.previousExpiresAt !== null)) throw new RelayGenerationError();
  if (hasPrevious) {
    assertGeneration(state.previousGeneration!);
    if (state.previousGeneration! >= state.currentGeneration) throw new RelayGenerationError();
  }
  return state;
}

/**
 * The next state after a rotation.
 *
 * The same arithmetic serves all three callers, because they differ only in
 * how long the outgoing address survives: `rotate` gives it
 * `RELAY_PREVIOUS_GRACE_MS`, `rotate and cut off` gives it none, and the
 * administrator's emergency key rotation gives it whatever they chose, up to
 * `RELAY_MAX_GRACE_MS`.
 *
 * Whatever was previous is simply dropped — the caller marks its alias row
 * `legacy_inactive` in the same transaction. That is what keeps "at most one
 * previous" true without ever lowering or reusing a number: the new current is
 * always the old current plus one, no matter how many rotations came before.
 */
export function nextRelayGeneration(state: RelayGenerationState, graceMs: number, now: Date): RelayGenerationState {
  assertRelayGenerationState(state);
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > RELAY_MAX_GRACE_MS) throw new RelayGenerationError();
  return {
    currentGeneration: state.currentGeneration + 1,
    previousGeneration: state.currentGeneration,
    previousExpiresAt: new Date(now.getTime() + graceMs),
  };
}

/** Whether a row's previous generation still attributes mail at `now`. */
export function relayPreviousIsActive(state: RelayGenerationState, now: Date): boolean {
  return Boolean(state.previousGeneration && state.previousExpiresAt && state.previousExpiresAt.getTime() > now.getTime());
}

/**
 * The generations a lookup may consider for one user at `now`: always the
 * current one, plus the previous one while its explicit expiry is in the
 * future. An expired previous is not "nearly valid" — it is gone, and the
 * receipt path reports `recipient_alias_expired` for it.
 */
export function activeRelayGenerations(state: RelayGenerationState, now: Date): number[] {
  assertRelayGenerationState(state);
  return relayPreviousIsActive(state, now) ? [state.currentGeneration, state.previousGeneration!] : [state.currentGeneration];
}
