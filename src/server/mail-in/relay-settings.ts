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
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { imapIngestionMessages } from "@/db/schema";
import { getImapIngestionConfig, type ImapIngestionConfig } from "./core/config";
import { deriveImapRecipientAlias } from "./core/imap-recipient";

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

export type RelayListening =
  | typeof RELAY_LISTENING
  | typeof RELAY_NOT_LISTENING
  | typeof RELAY_NO_MAILBOX;

/** The instance-level ingest flag, reported read-only; a per-user pause does not exist yet. */
export type RelayIngest = "enabled" | "paused";

export interface RelaySettings {
  /** Derived per request, never persisted. `null` whenever there is no relay to hand out. */
  address: string | null;
  listening: RelayListening;
  /** The newest arrival's timestamp, or null. No document name — that is #467. */
  lastReceived: string | null;
  ingest: RelayIngest;
}

/**
 * A configuration that cannot be resolved is a bounded "not listening", not a
 * 500: the thrown message names environment variables, and the reader of this
 * screen can do nothing with it either way. Misconfiguration belongs on the
 * operator's surface (#411), where it is already reported.
 */
function resolvedConfig(): ImapIngestionConfig | undefined {
  try {
    return getImapIngestionConfig();
  } catch {
    return undefined;
  }
}

/** The session's own relay. Never takes an id from the request. */
export async function readRelaySettings(
  user: { id: string; isInstanceAdmin: boolean },
): Promise<RelaySettings> {
  const config = resolvedConfig();
  const ingest: RelayIngest = config?.enabled ? "enabled" : "paused";
  if (user.isInstanceAdmin) {
    return { address: null, listening: RELAY_NO_MAILBOX, lastReceived: null, ingest };
  }
  // `enabled` already folds in `configured`, so this one test covers both an
  // instance that was never wired up and one whose operator switched mail-in off.
  if (!config?.enabled) {
    return { address: null, listening: RELAY_NOT_LISTENING, lastReceived: null, ingest };
  }
  const [latest] = await getDb()
    .select({ receivedAt: imapIngestionMessages.receivedAt })
    .from(imapIngestionMessages)
    .where(eq(imapIngestionMessages.userId, user.id))
    .orderBy(desc(imapIngestionMessages.receivedAt))
    .limit(1);
  return {
    address: deriveImapRecipientAlias(user.id, config.recipientDomain, config.aliasCurrent),
    listening: RELAY_LISTENING,
    lastReceived: latest?.receivedAt ? latest.receivedAt.toISOString() : null,
    ingest,
  };
}
