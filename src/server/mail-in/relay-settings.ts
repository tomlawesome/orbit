/**
 * The signed-in user's own relay, in bounded words (#432).
 *
 * Two rules shape everything here. The address is a CAPABILITY: anyone holding
 * it can post documents into that user's review queue, so it is derived per
 * request from `deriveImapRecipientAlias`, never stored, never logged, and
 * never placed in an error — `digestImapRecipientAlias` exists precisely so the
 * raw alias never reaches the database, and this module must not undo that.
 * And the state is BOUNDED (#411): host, port, mailbox, TLS name, provider
 * errors, versions and paths are operator diagnostics, not a user's business,
 * so the caller only ever learns which of a handful of fixed words applies.
 *
 * There is no user parameter by design. The caller passes the session's own
 * user, so there is nothing to name and therefore no way to read someone
 * else's relay.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { imapIngestionMessages } from "@/db/schema";
import { getImapIngestionConfig } from "./mailbox-config";
import type { ImapIngestionConfig } from "./core/config";
import { ensureRelayAliases, readRelayRow, relayAddressFor, rotateRelay, setRelayIngestPaused, type RelayRotationMode } from "./relays";
import { hasVerifiedSenderAddress, seedSenderAddress } from "./sender-addresses";

/** Mail-in is configured, switched on, and this account has a mailbox. */
export const RELAY_LISTENING = "connected · listening";
/** Mail-in is off for this instance — unconfigured, disabled, or unresolvable. */
export const RELAY_NOT_LISTENING = "not listening";
/**
 * Instance admins have no private mailbox: `listImapInbox` answers empty for
 * them and `getImapReview` refuses. Handing one an address would be a trap —
 * mail would be attributed and then be unreviewable — so they are told plainly
 * that this account has no relay rather than being shown a dead one.
 */
export const RELAY_NO_MAILBOX = "no relay on this account";
/**
 * The member has no checked sending address, so nothing they forward can be
 * matched to them (ADR-0017 decision 3, slice 4). Said plainly rather than
 * shown as a working relay that quietly swallows mail: relay usability now
 * depends on a verified address, which depends on Orbit being able to send
 * mail at all.
 */
export const RELAY_NOT_USABLE = "no checked sending address";

export type RelayListening =
  | typeof RELAY_LISTENING
  | typeof RELAY_NOT_LISTENING
  | typeof RELAY_NO_MAILBOX
  | typeof RELAY_NOT_USABLE;

/**
 * Whether this member is collecting or holding. Since ADR-0017 slice 5
 * (#746) it follows the MEMBER'S OWN row, not the instance flag it used to
 * stand in for: one member pausing changes nothing for anybody else.
 */
export type RelayIngest = "enabled" | "paused";

export interface RelaySettings {
  /** Derived per request, never persisted. `null` whenever there is no relay to hand out. */
  address: string | null;
  listening: RelayListening;
  /** The newest arrival's timestamp, or null. No document name — that is #467. */
  lastReceived: string | null;
  ingest: RelayIngest;
  /**
   * How much mail arrived that matched nobody and was deleted (ADR-0017
   * decision 3). A count, never a sender or a subject: the member can see that
   * something is going wrong without being shown mail that was never theirs.
   */
  unattributed: number;
}

/**
 * A configuration that cannot be resolved is a bounded "not listening", not a
 * 500: the thrown message names environment variables, and the reader of this
 * screen can do nothing with it either way. Misconfiguration belongs on the
 * operator's surface (#411), where it is already reported.
 */
async function resolvedConfig(): Promise<ImapIngestionConfig | undefined> {
  try {
    return await getImapIngestionConfig();
  } catch {
    // A locked credential (ADR-0017) is bounded the same way as any other
    // unresolvable configuration here: this screen has nothing a member can
    // act on either way, and the operator surface (#411) is where it is
    // reported in full.
    return undefined;
  }
}

/** The session's own relay. Never takes an id from the request. */
export async function readRelaySettings(
  user: { id: string; isInstanceAdmin: boolean },
): Promise<RelaySettings> {
  const config = await resolvedConfig();
  const ingest: RelayIngest = config?.enabled ? "enabled" : "paused";
  if (user.isInstanceAdmin) {
    return { address: null, listening: RELAY_NO_MAILBOX, lastReceived: null, ingest, unattributed: 0 };
  }
  // `enabled` already folds in `configured`, so this one test covers both an
  // instance that was never wired up and one whose operator switched mail-in off.
  if (!config?.enabled) {
    return { address: null, listening: RELAY_NOT_LISTENING, lastReceived: null, ingest, unattributed: 0 };
  }
  /* Seeding here, on the member's own read, is what puts the account address
     in front of them without anybody typing it — still unverified, because
     Orbit knowing an address is not the member proving they send from it. */
  await seedSenderAddress(user.id);
  const usable = await hasVerifiedSenderAddress(user.id);
  const relay = await ensureRelayAliases(user.id, config);
  const ownIngest: RelayIngest = relay.ingestPausedAt ? "paused" : ingest;
  const [latest] = await getDb()
    .select({ receivedAt: imapIngestionMessages.receivedAt })
    .from(imapIngestionMessages)
    .where(eq(imapIngestionMessages.userId, user.id))
    .orderBy(desc(imapIngestionMessages.receivedAt))
    .limit(1);
  /* Enrolling on read is what makes the address on this screen the same
     address the receipt path will attribute: the member's row and their
     `active` alias row both exist before the address is ever shown. */
  const [unattributed] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(imapIngestionMessages)
    .where(and(
      eq(imapIngestionMessages.userId, user.id),
      eq(imapIngestionMessages.status, "unattributed"),
    ));
  return {
    address: relayAddressFor(user.id, relay.currentGeneration, config),
    /* The address is still shown when there is no checked sending address:
       the member needs it to set the forward up, and the word beside it says
       plainly that nothing will be matched until they check an address. */
    listening: usable ? RELAY_LISTENING : RELAY_NOT_USABLE,
    lastReceived: latest?.receivedAt ? latest.receivedAt.toISOString() : null,
    ingest: ownIngest,
    unattributed: unattributed?.count ?? 0,
  };
}

/**
 * Rotates the signed-in member's own relay address (ADR-0017 decision 2).
 *
 * `rotate` keeps the outgoing address working for fourteen days so mail
 * already in flight still arrives; `cut_off` stops it now, which is the
 * mitigation for an address that has leaked. Both are the member's own: like
 * `readRelaySettings` this takes the session's user rather than an id from the
 * request, so there is nothing to name and no way to rotate anyone else.
 *
 * The new address is returned because the member needs to save it, and it is
 * derived here for that one response — never written, never logged.
 */
export async function rotateRelayAddress(
  user: { id: string; isInstanceAdmin: boolean },
  mode: RelayRotationMode,
): Promise<RelaySettings> {
  const config = await resolvedConfig();
  if (user.isInstanceAdmin || !config?.enabled) {
    // An account with no relay has nothing to rotate. Answering with the same
    // bounded reading as a GET keeps the refusal in this screen's vocabulary
    // rather than inventing an error the reader cannot act on.
    return readRelaySettings(user);
  }
  await rotateRelay(user.id, mode, config);
  return readRelaySettings(user);
}

/**
 * Pauses or resumes the signed-in member's own collection (ADR-0017 decision
 * 2, slice 5, #746), replacing the read-only instance flag this screen used to
 * report.
 *
 * Paused, mail addressed to them is HELD: the receipt says it arrived and
 * nothing else, no attachment is fetched, nothing is staged and nobody is
 * told. Resuming stages every held message exactly once. Like rotation, this
 * takes the session's own user rather than an id from the request.
 */
export async function setRelayIngest(
  user: { id: string; isInstanceAdmin: boolean },
  paused: boolean,
): Promise<RelaySettings> {
  const config = await resolvedConfig();
  if (user.isInstanceAdmin || !config?.enabled) return readRelaySettings(user);
  await setRelayIngestPaused(user.id, paused);
  return readRelaySettings(user);
}

/** The member's own relay row, or `undefined` before they are enrolled. */
export async function readOwnRelayRow(user: { id: string }) {
  return readRelayRow(user.id);
}
