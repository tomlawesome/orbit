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
 * else's relay. The relay follows the user id alone: an instance administrator
 * gets an address and a review queue exactly like any member (#1632).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { imapIngestionMessages } from "@/db/schema";
import { RateLimitedError } from "@/lib/app-error";
import { getImapIngestionConfig } from "./mailbox-config";
import type { ImapIngestionConfig } from "./core/config";
import { ensureRelayAliases, relayAddressFor, rotateRelay, setRelayIngestPaused, type RelayRotationMode } from "./relays";
import { hasVerifiedSenderAddress, listSenderAddresses, seedSenderAddress, type SenderAddressSource, type SenderAddressView } from "./sender-addresses";

/** Mail-in is configured, switched on, and this account has a mailbox. */
export const RELAY_LISTENING = "connected · listening";
/** Mail-in is off for this instance — unconfigured, disabled, or unresolvable. */
export const RELAY_NOT_LISTENING = "not listening";
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
   * The administrator has paused ingest for the whole instance (#1654). The
   * member still has their address and mail sent to it waits, so the screen
   * keeps the address and says whose pause it is. False for an instance that
   * was never set up, where there is no address to keep.
   */
  adminPaused: boolean;
  /**
   * How much mail arrived that matched nobody and was deleted (ADR-0017
   * decision 3). A count, never a sender or a subject: the member can see that
   * something is going wrong without being shown mail that was never theirs.
   */
  unattributed: number;
  /**
   * The member's sign-in sending-address row (ADR-0017 decision 7c), so the
   * screen can say "check your mail" or "checked". `null` when there is no
   * row to report, or an address Orbit cannot read. Only the member's own
   * address, never host, port or mailbox.
   */
  sender: RelaySignInSender | null;
  /**
   * Every sending address of the member's own (#1650): the seeded sign-in row
   * first, then the extra ones in the order added. `sender` is the seeded
   * entry in its pre-#1650 shape, for the screens that read only that row.
   */
  senders: RelaySender[];
}

/** The sign-in row as `sender` has always carried it: no id, source or countdown. */
export interface RelaySignInSender {
  address: string;
  verified: boolean;
  verificationPending: boolean;
  /** When the outstanding link lapses (ISO); null once checked or with no live link. */
  expiresAt: string | null;
  /** #1681, note 52496: false while the last forward was unsigned, so not kept; null when nothing says otherwise. */
  lastForwardSigned: boolean | null;
}

/** One row of `senders` (#1650). */
export interface RelaySender extends RelaySignInSender {
  /** The row's id, which `send check` and `remove` name. Never an address. */
  id: string;
  /** `account` or `sso` for the seeded sign-in row, `manual` for an extra one. */
  source: SenderAddressSource;
  /** #1650: whole days before an unchecked extra row is removed; null for the sign-in row and checked rows. */
  daysLeft: number | null;
}

/** The seeded sign-in row of a member's list, or null when there is none to show. */
function signInRowOf(senders: readonly RelaySender[]): RelaySignInSender | null {
  const row = senders.find((candidate) => candidate.source !== "manual");
  if (!row) return null;
  const { address, verified, verificationPending, expiresAt, lastForwardSigned } = row;
  return { address, verified, verificationPending, expiresAt, lastForwardSigned };
}

/** The screen's view of the member's rows: an address Orbit cannot read is not shown. */
export function relaySendersOf(views: readonly SenderAddressView[]): RelaySender[] {
  return views.flatMap((view) => view.address
    ? [{
      id: view.id,
      source: view.source,
      address: view.address,
      verified: view.verified,
      verificationPending: view.verificationPending,
      expiresAt: view.expiresAt,
      lastForwardSigned: view.lastForwardSigned,
      daysLeft: view.daysLeft,
    }]
    : []);
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
  // `enabled` already folds in `configured`, so this one test covers both an
  // instance that was never wired up and one whose operator switched mail-in off.
  if (!config?.configured) {
    /* No relay to hand out, but the member's own addresses are still theirs
       to see (#1650): they can add and remove them whatever the instance's
       mail-in state, so the list rides here too, read as it stands (no
       seeding: there is nothing to forward to yet). */
    const listed = relaySendersOf(await listSenderAddresses(user.id));
    return { address: null, listening: RELAY_NOT_LISTENING, lastReceived: null, ingest, adminPaused: false, unattributed: 0, sender: signInRowOf(listed), senders: listed };
  }
  /* Configured but switched off: the administrator's pause (#1654). The
     address is derived exactly as when running, so it stays unchanged. */
  const adminPaused = !config.enabled;
  /* Seeding here, on the member's own read, is what puts the account address
     in front of them without anybody typing it — still unverified, because
     Orbit knowing an address is not the member proving they send from it.
     Seeding takes the member's sender lock; when a check holds it, this read
     skips seeding rather than waiting (the next read seeds), and reads the
     rows without the lock. */
  try {
    await seedSenderAddress(user.id);
  } catch (error) {
    if (!(error instanceof RateLimitedError && error.code === "sender_check_too_soon")) throw error;
  }
  const usable = await hasVerifiedSenderAddress(user.id);
  /* `sender` is the seeded sign-in row as before, only when it is readable
     (never an extra row standing in for it); the full list rides beside it
     (#1650). */
  const senders = relaySendersOf(await listSenderAddresses(user.id));
  const sender = signInRowOf(senders);
  const relay = await ensureRelayAliases(user.id, config);
  const ownIngest: RelayIngest = adminPaused || relay.ingestPausedAt ? "paused" : "enabled";
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
    listening: adminPaused ? RELAY_NOT_LISTENING : usable ? RELAY_LISTENING : RELAY_NOT_USABLE,
    lastReceived: latest?.receivedAt ? latest.receivedAt.toISOString() : null,
    ingest: ownIngest,
    adminPaused,
    unattributed: unattributed?.count ?? 0,
    sender,
    senders,
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
  /* `configured`, not `enabled`: the administrator's pause (#1654) stops
     collection, not the member's own controls. An address that leaked while
     ingest is paused must still be cut off now (#1670 A-F3). */
  if (!config?.configured) {
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
  // As for rotation: the member's own pause is recorded while the
  // administrator's holds, so it is still in force when theirs lifts (#1670 A-F3).
  if (!config?.configured) return readRelaySettings(user);
  await setRelayIngestPaused(user.id, paused);
  return readRelaySettings(user);
}
