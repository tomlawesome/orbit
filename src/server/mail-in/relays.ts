/**
 * Per-user relay state (ADR-0017 decision 2, slice 3, orbit#744).
 *
 * This is the whole authority for which address belongs to whom. The
 * instance-wide `imap_recipient_rotation_state` singleton and the
 * drift-detection state machine that policed it against the environment are
 * retired with this module's arrival: the environment is no longer a second
 * authority, so there is nothing left to reconcile.
 *
 * The SIBLING INVARIANT is the rule this file exists to keep. A user-initiated
 * rotate, cut-off, pause or resume touches only rows whose `user_id` is the
 * session's own user, and no statement on that path carries a wider predicate.
 * The only operation that moves every member is the administrator's emergency
 * alias-key rotation at the bottom of this file, which is deliberately the one
 * place a `user_id` predicate is absent.
 *
 * Addresses and digests never leave here: the raw alias is derived per use and
 * only its sha256 digest is written, so nothing in this module may put an
 * address in a row, a log, an audit `changes` blob or an error.
 */
import { and, eq, inArray, isNotNull, lte, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, imapRecipientAliases, mailInRelays, users } from "@/db/schema";
import type { ImapIngestionConfig } from "./core/config";
import { deriveImapRecipientAlias, digestImapRecipientAlias } from "./core/imap-recipient";
import {
  activeRelayGenerations,
  nextRelayGeneration,
  RELAY_CUT_OFF_GRACE_MS,
  RELAY_MAX_GRACE_MS,
  RELAY_PREVIOUS_GRACE_MS,
  type RelayGenerationState,
} from "./core/relay-generations";

export type RelayRow = RelayGenerationState & {
  userId: string;
  ingestPausedAt: Date | null;
  rotatedAt: Date | null;
  version: number;
};

/** `rotate` keeps the old address for fourteen days; `cut_off` keeps it for none. */
export type RelayRotationMode = "rotate" | "cut_off";

/**
 * Deliberately generic, like every other refusal on this path: a conflicting
 * rotation must not tell the caller anything about the relay it lost to.
 */
export class RelayConflictError extends Error {
  readonly code = "relay_conflict";

  constructor() {
    super("The relay changed while this request was in flight");
    this.name = "RelayConflictError";
  }
}

type RelayExecutor = Pick<ReturnType<typeof getDb>, "select" | "insert" | "update">;

const relayColumns = {
  userId: mailInRelays.userId,
  currentGeneration: mailInRelays.currentGeneration,
  previousGeneration: mailInRelays.previousGeneration,
  previousExpiresAt: mailInRelays.previousExpiresAt,
  ingestPausedAt: mailInRelays.ingestPausedAt,
  rotatedAt: mailInRelays.rotatedAt,
  version: mailInRelays.version,
};

/** Reads one user's relay row. Never reads anybody else's. */
export async function readRelayRow(userId: string, executor: RelayExecutor = getDb()): Promise<RelayRow | undefined> {
  const [row] = await executor.select(relayColumns).from(mailInRelays).where(eq(mailInRelays.userId, userId)).limit(1);
  return row;
}

/**
 * Seats a user at generation 1 if they have no row yet, and returns the row
 * either way. Enrolment is idempotent and races safely: a concurrent poll
 * cycle and a first visit to the relay page both take the `onConflictDoNothing`
 * path and then read the winner.
 */
export async function ensureRelayRow(userId: string, executor: RelayExecutor = getDb()): Promise<RelayRow> {
  const existing = await readRelayRow(userId, executor);
  if (existing) return existing;
  await executor.insert(mailInRelays).values({ userId }).onConflictDoNothing();
  const seated = await readRelayRow(userId, executor);
  if (!seated) throw new RelayConflictError();
  return seated;
}

/** The address this user's current generation derives to. Never persisted. */
export function relayAddressFor(userId: string, generation: number, config: ImapIngestionConfig): string {
  return deriveImapRecipientAlias(userId, config.aliasBase, { generation, secret: config.aliasCurrent.secret });
}

function aliasDigest(userId: string, generation: number, config: ImapIngestionConfig, secret: string): string {
  return digestImapRecipientAlias(deriveImapRecipientAlias(userId, config.aliasBase, { generation, secret }));
}

/**
 * Writes one user's alias rows so they say exactly what their relay row says:
 * the current generation active with no expiry, the previous one active until
 * its explicit expiry, and anything else `legacy_inactive` from now.
 *
 * Every statement names `user_id`, which is what makes reconciliation and
 * rotation both safe to run against a single member.
 */
async function materialiseRelayAliases(
  executor: RelayExecutor,
  userId: string,
  state: RelayGenerationState,
  config: ImapIngestionConfig,
  aliasSecret: string,
  aliasKeySecretId: string | null,
  now: Date,
): Promise<void> {
  const retained: number[] = [state.currentGeneration];
  const currentDigest = aliasDigest(userId, state.currentGeneration, config, aliasSecret);
  await executor.insert(imapRecipientAliases).values({
    userId,
    generation: state.currentGeneration,
    aliasSha256: currentDigest,
    aliasKeySecretId,
    status: "active",
    activeUntil: null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [imapRecipientAliases.userId, imapRecipientAliases.generation],
    set: { aliasSha256: currentDigest, aliasKeySecretId, status: "active", activeUntil: null, updatedAt: now },
  });

  if (state.previousGeneration !== null && state.previousExpiresAt) {
    retained.push(state.previousGeneration);
    // The previous row keeps whichever key derived it: after an emergency key
    // rotation the outgoing address is still spelt in the OLD key's bytes, and
    // rewriting the digest under the new one would silently cut off the very
    // grace period the administrator granted. Only the expiry moves.
    await executor.update(imapRecipientAliases)
      .set({ status: "active", activeUntil: state.previousExpiresAt, updatedAt: now })
      .where(and(
        eq(imapRecipientAliases.userId, userId),
        eq(imapRecipientAliases.generation, state.previousGeneration),
      ));
  }

  await executor.update(imapRecipientAliases)
    .set({ status: "legacy_inactive", activeUntil: now, updatedAt: now })
    .where(and(
      eq(imapRecipientAliases.userId, userId),
      eq(imapRecipientAliases.status, "active"),
      notInArray(imapRecipientAliases.generation, retained),
    ));
}

/**
 * Enrols a user and brings their alias rows into step with their relay row.
 * Used by the poll cycle's reconciliation and by the relay page's first read,
 * so an address is never shown before the row that attributes it exists.
 */
export async function ensureRelayAliases(userId: string, config: ImapIngestionConfig, now = new Date()): Promise<RelayRow> {
  return getDb().transaction(async (transaction) => {
    const relay = await ensureRelayRow(userId, transaction);
    await materialiseRelayAliases(
      transaction, userId, relay, config, config.aliasCurrent.secret, config.aliasKeySecretId ?? null, now,
    );
    return relay;
  });
}

function graceFor(mode: RelayRotationMode): number {
  return mode === "cut_off" ? RELAY_CUT_OFF_GRACE_MS : RELAY_PREVIOUS_GRACE_MS;
}

export type RelayRotationResult = {
  relay: RelayRow;
  fromGeneration: number;
  toGeneration: number;
  previousExpiresAt: Date;
};

/**
 * Rotates the acting user's own relay.
 *
 * There is no user parameter to spoof: the caller passes the session's own
 * user, exactly as `readRelaySettings` does, and every statement below is
 * predicated on that id. The `version` guard is the same optimistic-concurrency
 * discipline `instance_maintenance` uses (ADR-0013), so two rotations racing
 * each other cannot both consume the same generation.
 */
export async function rotateRelay(
  userId: string,
  mode: RelayRotationMode,
  config: ImapIngestionConfig,
  now = new Date(),
): Promise<RelayRotationResult> {
  return getDb().transaction(async (transaction) => {
    const relay = await ensureRelayRow(userId, transaction);
    const next = nextRelayGeneration(relay, graceFor(mode), now);
    const [updated] = await transaction.update(mailInRelays).set({
      currentGeneration: next.currentGeneration,
      previousGeneration: next.previousGeneration,
      previousExpiresAt: next.previousExpiresAt,
      rotatedAt: now,
      version: relay.version + 1,
      updatedAt: now,
    }).where(and(
      eq(mailInRelays.userId, userId),
      eq(mailInRelays.version, relay.version),
    )).returning(relayColumns);
    if (!updated) throw new RelayConflictError();

    await materialiseRelayAliases(
      transaction, userId, updated, config, config.aliasCurrent.secret, config.aliasKeySecretId ?? null, now,
    );

    // Bounded, non-secret changes only: generations and one timestamp. An
    // address or a digest here would put a capability in a table an
    // administrator can read (ADR-0017 decision 5).
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId: userId,
      entityType: "mail_in_relay",
      entityId: userId,
      action: "mail_in_relay_rotated",
      changes: {
        fromGeneration: relay.currentGeneration,
        toGeneration: updated.currentGeneration,
        previousExpiresAt: updated.previousExpiresAt?.toISOString() ?? null,
      },
    });

    return {
      relay: updated,
      fromGeneration: relay.currentGeneration,
      toGeneration: updated.currentGeneration,
      previousExpiresAt: updated.previousExpiresAt!,
    };
  });
}

/**
 * Expires the alias rows whose grace has run out, for every user at once.
 *
 * This is not a sibling-invariant breach: it changes no generation and takes
 * no action a user did not already take themselves — it only lets the expiry
 * each user's own rotation wrote actually take effect in the lookup index.
 */
export async function expireLapsedRelayAliases(now = new Date()): Promise<void> {
  await getDb().update(imapRecipientAliases)
    .set({ status: "legacy_inactive", updatedAt: now })
    .where(and(
      eq(imapRecipientAliases.status, "active"),
      isNotNull(imapRecipientAliases.activeUntil),
      lte(imapRecipientAliases.activeUntil, now),
    ));
}

/** The generations a lookup may consider for one user right now. */
export function relayLookupGenerations(relay: RelayGenerationState, now: Date): number[] {
  return activeRelayGenerations(relay, now);
}

/**
 * The administrator's emergency instance-wide alias-key rotation — the ONLY
 * operation that changes every member's address, and the only place in this
 * file without a `user_id` predicate.
 *
 * The caller has already inserted the new `alias_key` secret row and pointed
 * the mailbox at it; what happens here is one transaction that rotates every
 * user with the grace the administrator chose (0 to 90 days, the same ceiling
 * the environment era capped a transition at). The superseded key row is kept
 * until the grace lapses, because the outgoing digests are spelt in its bytes
 * and `imap_recipient_aliases.alias_key_secret_id` is what names it.
 */
export async function rotateAllRelaysForNewAliasKey(
  executor: RelayExecutor,
  actorUserId: string,
  config: ImapIngestionConfig,
  aliasKeySecretId: string,
  graceMs: number,
  now = new Date(),
): Promise<{ users: number; graceUntil: Date }> {
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > RELAY_MAX_GRACE_MS) throw new RelayConflictError();
  const graceUntil = new Date(now.getTime() + graceMs);
  const candidates = await executor.select({ id: users.id }).from(users);
  for (const candidate of candidates) {
    const relay = await ensureRelayRow(candidate.id, executor);
    const next = nextRelayGeneration(relay, graceMs, now);
    const [updated] = await executor.update(mailInRelays).set({
      currentGeneration: next.currentGeneration,
      previousGeneration: next.previousGeneration,
      previousExpiresAt: next.previousExpiresAt,
      rotatedAt: now,
      version: relay.version + 1,
      updatedAt: now,
    }).where(and(
      eq(mailInRelays.userId, candidate.id),
      eq(mailInRelays.version, relay.version),
    )).returning(relayColumns);
    if (!updated) throw new RelayConflictError();
    await materialiseRelayAliases(
      executor, candidate.id, updated, config, config.aliasCurrent.secret, aliasKeySecretId, now,
    );
  }
  await executor.insert(auditLog).values({
    householdId: null,
    actorUserId,
    entityType: "mail_in_mailbox",
    entityId: aliasKeySecretId,
    action: "mail_in_alias_key_rotated",
    changes: { users: candidates.length, graceUntil: graceUntil.toISOString() },
  });
  return { users: candidates.length, graceUntil };
}

/**
 * Moves every relay on to the next generation with no previous at all, for the
 * case where the mailbox account itself moved.
 *
 * There is no grace to give: the old addresses were sub-addresses of an account
 * this instance no longer collects from, so nothing can arrive at them however
 * long they are left active. Bumping the generation rather than re-deriving the
 * same one under the new key is what keeps the counter honest — one generation
 * number is one address, for the life of the row.
 */
export async function resetAllRelaysForMovedAccount(executor: RelayExecutor, now = new Date()): Promise<void> {
  await executor.update(mailInRelays).set({
    currentGeneration: sql`${mailInRelays.currentGeneration} + 1`,
    previousGeneration: null,
    previousExpiresAt: null,
    rotatedAt: now,
    version: sql`${mailInRelays.version} + 1`,
    updatedAt: now,
  });
  await executor.update(imapRecipientAliases)
    .set({ status: "legacy_inactive", activeUntil: now, updatedAt: now })
    .where(eq(imapRecipientAliases.status, "active"));
}

/**
 * Retires every alias row of a user who has been disabled, without touching
 * their generations: a disabled account keeps its place in the counter, so
 * re-enabling it never reissues an address somebody already holds.
 */
export async function retireAliasesForDisabledUsers(now = new Date()): Promise<void> {
  const disabled = await getDb().select({ id: users.id }).from(users).where(isNotNull(users.disabledAt));
  if (disabled.length === 0) return;
  await getDb().update(imapRecipientAliases)
    .set({ status: "legacy_inactive", activeUntil: now, updatedAt: now })
    .where(and(
      inArray(imapRecipientAliases.userId, disabled.map((row) => row.id)),
      eq(imapRecipientAliases.status, "active"),
    ));
}
