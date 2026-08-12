/**
 * mail-in/core boundary: pure parsing logic only. No `getDb`/`db`/schema
 * imports and no `imapflow` import — see src/server/mail-in/README.md.
 * Moved as-is from src/server/imap-rotation.ts as part of the #298 module
 * split.
 */
export type ImapRotationConfigState = {
  currentGeneration: number;
  currentCommitment: string;
  previousGeneration?: number;
  previousExpiresAt?: Date;
  previousCommitment?: string;
};

export type ImapRotationState = {
  currentGeneration: number;
  currentCommitment: string;
  previousGeneration: number | null;
  previousExpiresAt: Date | null;
  previousCommitment: string | null;
};

/** Deliberately generic so stale configuration cannot expose key or alias data. */
export class ImapRotationStaleError extends Error {
  readonly code = "imap_rotation_stale";

  constructor() {
    super("IMAP alias rotation state is stale or invalid");
    this.name = "ImapRotationStaleError";
  }
}

function stale(): never {
  throw new ImapRotationStaleError();
}

function configuredPrevious(config: ImapRotationConfigState): { generation: number; expiresAt: Date; commitment: string } | undefined {
  const hasGeneration = config.previousGeneration !== undefined;
  const hasExpiry = config.previousExpiresAt !== undefined;
  const hasCommitment = config.previousCommitment !== undefined;
  if (hasGeneration !== hasExpiry || hasGeneration !== hasCommitment || (hasGeneration && config.previousGeneration === config.currentGeneration)) stale();
  return hasGeneration && hasExpiry
    ? { generation: config.previousGeneration!, expiresAt: config.previousExpiresAt!, commitment: config.previousCommitment! }
    : undefined;
}

function copyState(currentGeneration: number, currentCommitment: string, previousGeneration: number | null, previousExpiresAt: Date | null, previousCommitment: string | null): ImapRotationState {
  return { currentGeneration, currentCommitment, previousGeneration, previousExpiresAt, previousCommitment };
}

/**
 * Applies a process configuration to the singleton persisted rotation state.
 * The state is the authority: configuration can initialize it, advance it, or
 * explicitly clear its previous generation, but can never move it backwards,
 * resurrect an invalidated generation, or extend an authoritative expiry.
 */
export function decideImapRotationState(
  persisted: ImapRotationState | null,
  config: ImapRotationConfigState,
  now: Date,
): ImapRotationState {
  if (!config.currentCommitment) stale();
  const previous = configuredPrevious(config);
  const activePrevious = previous && previous.expiresAt.getTime() > now.getTime() ? previous : undefined;

  if (!persisted) {
    return copyState(config.currentGeneration, config.currentCommitment, activePrevious?.generation ?? null, activePrevious?.expiresAt ?? null, activePrevious?.commitment ?? null);
  }

  if (config.currentGeneration < persisted.currentGeneration) stale();

  if (config.currentGeneration > persisted.currentGeneration) {
    if (!activePrevious) return copyState(config.currentGeneration, config.currentCommitment, null, null, null);
    if (activePrevious.generation !== persisted.currentGeneration || activePrevious.commitment !== persisted.currentCommitment) stale();
    return copyState(config.currentGeneration, config.currentCommitment, activePrevious.generation, activePrevious.expiresAt, activePrevious.commitment);
  }

  if (config.currentCommitment !== persisted.currentCommitment) stale();
  if (!persisted.previousGeneration) {
    if (activePrevious) stale();
    return copyState(persisted.currentGeneration, persisted.currentCommitment, null, null, null);
  }

  if (!persisted.previousExpiresAt || persisted.previousExpiresAt.getTime() <= now.getTime()) {
    if (activePrevious) stale();
    return copyState(persisted.currentGeneration, persisted.currentCommitment, null, null, null);
  }

  if (!activePrevious) return copyState(persisted.currentGeneration, persisted.currentCommitment, null, null, null);
  if (activePrevious.generation !== persisted.previousGeneration
    || activePrevious.commitment !== persisted.previousCommitment
    || activePrevious.expiresAt.getTime() !== persisted.previousExpiresAt.getTime()) stale();
  return copyState(persisted.currentGeneration, persisted.currentCommitment, persisted.previousGeneration, persisted.previousExpiresAt, persisted.previousCommitment);
}

/** Exact read-time validation for lookup and receipt writes after reconciliation. */
export function assertImapRotationState(
  persisted: ImapRotationState | null,
  config: ImapRotationConfigState,
  now: Date,
): ImapRotationState {
  if (!persisted) stale();
  const decided = decideImapRotationState(persisted, config, now);
  if (decided.currentGeneration !== persisted.currentGeneration
    || decided.currentCommitment !== persisted.currentCommitment
    || decided.previousGeneration !== persisted.previousGeneration
    || decided.previousExpiresAt?.getTime() !== persisted.previousExpiresAt?.getTime()
    || decided.previousCommitment !== persisted.previousCommitment) stale();
  return persisted;
}
