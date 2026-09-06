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
import { getDb } from "@/db";
import { mailInSenderAddresses } from "@/db/schema";

/** The provider identity every fixture in the suite claims to trust. */
export const TRUSTED_AUTHSERV_ID = "mx.provider.test";

/** Marks an address as one this member has verified, ready to attribute. */
export async function verifiedSenderFor(userId: string, address: string): Promise<string> {
  const normalized = address.trim().toLowerCase();
  await getDb().insert(mailInSenderAddresses).values({
    userId,
    address: normalized,
    source: "manual",
    verifiedAt: new Date(),
  }).onConflictDoNothing();
  return normalized;
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
