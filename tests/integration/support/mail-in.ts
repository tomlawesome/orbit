/**
 * Shared mail-in test scaffolding for ADR-0017 slice 4 (orbit#745).
 *
 * Since attribution moved to the verified sender, a fake message needs three
 * things before it belongs to anybody: a `From` naming an address the member
 * has verified, an `Authentication-Results` header written by the authserv-id
 * the instance trusts, and a configuration that names that authserv-id. Any
 * of the three missing means unattributed, which is the correct answer and
 * also the one that makes an old alias-only fixture stop attributing.
 *
 * These helpers exist so a suite says what it means — "this message is from a
 * verified member" — rather than restating the header rules in every case.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailInSenderAddresses } from "@/db/schema";
import { listSenderAddresses, seedSenderAddress } from "@/server/mail-in/sender-addresses";

/** The provider identity every fixture in the suite claims to trust. */
export const TRUSTED_AUTHSERV_ID = "mx.provider.test";

/**
 * Verifies the member's REGISTERED address and returns it (decision 7c): a
 * member's only sending address is their account email, and any other stored
 * address is removed on the next relay read. Seeding goes through the
 * product's own `seedSenderAddress`; the row is then marked verified the way
 * `verifySenderAddress` leaves it (verifiedAt set, no outstanding link).
 */
export async function verifiedSenderFor(userId: string): Promise<string> {
  await seedSenderAddress(userId);
  const [row] = await getDb().update(mailInSenderAddresses).set({
    verifiedAt: new Date(),
    verificationTokenDigest: null,
    verificationExpiresAt: null,
  }).where(eq(mailInSenderAddresses.userId, userId)).returning({ id: mailInSenderAddresses.id });
  if (!row) throw new Error(`No registered sender address could be seeded for ${userId}`);
  const [view] = await listSenderAddresses(userId);
  if (!view?.address) throw new Error(`The registered sender address for ${userId} is unreadable`);
  return view.address;
}

export interface FixtureHeaderOptions {
  /** The relay address, when the message carries one. Corroboration only. */
  alias?: string;
  /** What the message says it is from. */
  from?: string;
  /** The name of the provider-injected recipient header. */
  trustedRecipientHeader?: string;
  /** The authserv-id the topmost verdict claims to be written by. */
  authservId?: string;
  /** `undefined` writes no Authentication-Results header at all. */
  verdict?: string;
  /** Extra raw header lines, for the automated-mail and hostile cases. */
  extra?: string[];
}

/** One header block, in the shape a provider puts on the wire. */
export function fixtureHeaders(options: FixtureHeaderOptions): Buffer {
  const lines: string[] = [];
  if (options.verdict !== undefined) {
    lines.push(`Authentication-Results: ${options.authservId ?? TRUSTED_AUTHSERV_ID}; ${options.verdict}`);
  }
  if (options.alias) lines.push(`${options.trustedRecipientHeader ?? "X-Original-To"}: ${options.alias}`);
  if (options.from) lines.push(`From: ${options.from}`);
  lines.push(...(options.extra ?? []));
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`);
}

/** A header block for mail Orbit should attribute to `from`'s owner. */
export function attributedHeaders(from: string, alias?: string, trustedRecipientHeader?: string): Buffer {
  return fixtureHeaders({
    from,
    alias,
    trustedRecipientHeader,
    verdict: `dmarc=pass header.from=${from.slice(from.lastIndexOf("@") + 1)}`,
  });
}

/** One message a fake mailbox holds. `headers` may be a function when it has to be read at fetch time. */
export interface FakeImapMessage {
  uid: number;
  headers?: Buffer | (() => Buffer);
  source?: Buffer;
  size?: number;
  bodyStructure?: unknown;
  /** Makes `download` for this message throw an error with this text. */
  downloadError?: string;
}

export interface FakeImapMailboxOptions {
  uidValidity: bigint | number;
  /** Comfortably above every UID a fake mailbox uses, so the range-collapse guard (#383) never skips a search. */
  uidNext?: number;
  messages: FakeImapMessage[];
  /**
   * What `search` answers. "range" returns the UIDs at or above the start of
   * the requested range; "all" ignores the range and answers every UID, so a
   * repeated poll proves the receipt's own idempotency rather than a
   * client-side filter.
   */
  search?: "range" | "all";
  /** Present only when given: `messageDelete` records each range here and succeeds. */
  deleted?: string[];
  /** Present only when given: `download` records `uid:part` and answers with these bytes. */
  download?: (uid: number, part: string) => Buffer;
  /** Where `download` records; a suite that asserts on its own list passes it in. */
  downloads?: string[];
  /** Where `search` records the ranges it was asked for; likewise. */
  searches?: string[];
}

/**
 * A fake IMAP client for `setImapClientFactoryForTests`, built on the fullest
 * of the hand-written ones. Every UID `runImapIngestionCycle` asks for is its
 * own command (#460): a retry or a post-search fetch is a `fetchOne(uid)`,
 * and the new-mail sweep is a `search({ uid: range })` that returns UIDs, not
 * bodies. `searches`, `fetchedUids` and `downloads` track each half of that
 * surface.
 *
 * Every fetch hands out a fresh copy of the headers, as a real server does:
 * the cycle zeroes the buffers it was given, and a message may be fetched
 * again.
 */
export function fakeImapMailbox(options: FakeImapMailboxOptions) {
  const { messages } = options;
  const searches = options.searches ?? [];
  const fetchedUids: string[] = [];
  const downloads = options.downloads ?? [];
  const client = {
    mailbox: { uidValidity: options.uidValidity, uidNext: options.uidNext ?? 1_000_000 },
    async connect() {},
    async logout() {},
    async getMailboxLock() { return { release() {} }; },
    async search(query: { uid: string }) {
      searches.push(query.uid);
      if (options.search === "all") return messages.map((message) => message.uid);
      const start = Number(/^\d+/u.exec(query.uid)?.[0] ?? 0);
      return messages.filter((message) => message.uid >= start).map((message) => message.uid);
    },
    async fetchOne(uid: string) {
      fetchedUids.push(uid);
      const message = messages.find((candidate) => candidate.uid === Number(uid));
      if (!message) return undefined;
      const headers = typeof message.headers === "function" ? message.headers() : message.headers;
      return { ...message, headers: headers ? Buffer.from(headers) : undefined, internalDate: new Date() };
    },
    ...(options.deleted ? { async messageDelete(range: string) { options.deleted!.push(range); return true; } } : {}),
    ...(options.download ? {
      async download(uid: number, part: string) {
        downloads.push(`${uid}:${part}`);
        const message = messages.find((candidate) => candidate.uid === uid);
        if (message?.downloadError) throw new Error(message.downloadError);
        return { content: options.download!(uid, part) };
      },
    } : {}),
  };
  return { client: client as unknown as import("imapflow").ImapFlow, searches, fetchedUids, downloads };
}
