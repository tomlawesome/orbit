import { resolveTxt } from "node:dns/promises";
import { dkimDomainAligns } from "./core/sender-authentication";
import { MAX_DKIM_MESSAGE_BYTES, dkimPublicKeyFromRecord, parseDkimSignatures, verifyDkimSignature } from "./core/dkim";

/**
 * Fetching DKIM keys is DNS, so it lives here and not in `core/`: the pure
 * verifier in `core/dkim.ts` is handed whatever this returns.
 *
 * RFC 6376 §6.1.2 tells two failures apart (#1670): a domain that publishes no
 * key (NXDOMAIN, no data) is PERMFAIL, "no key", a signature that did not
 * verify. A lookup that could not be answered right now (SERVFAIL, a timeout,
 * a refused query) is TEMPFAIL: it rejects with `DkimTemporaryFailure`, so the
 * caller can try the message again later instead of filing it as
 * unauthenticated. Any other failure is "no key", never a pass.
 */

/** The key record text for `selector._domainkey.domain`, or nothing. */
export type DkimKeyResolver = (selector: string, domain: string) => Promise<string | undefined>;

const LOOKUP_TIMEOUT_MS = 5_000;

/** The DNS answers that mean "ask again later", as node:dns names them. */
const TEMPORARY_DNS_CODES = new Set(["ESERVFAIL", "ETIMEOUT", "ECONNREFUSED", "EREFUSED", "EAI_AGAIN", "ECANCELLED"]);

/** A key lookup that could not be answered right now (TEMPFAIL). Carries the DNS code only. */
export class DkimTemporaryFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`DKIM key lookup failed temporarily (${code})`);
    this.name = "DkimTemporaryFailure";
    this.code = code;
  }
}

/** @returns the TEMPFAIL to raise for a failed lookup, or nothing when the failure means "no key". */
function temporaryFailureOf(error: unknown): DkimTemporaryFailure | undefined {
  if (error instanceof DkimTemporaryFailure) return error;
  const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && TEMPORARY_DNS_CODES.has(code.toUpperCase()) ? new DkimTemporaryFailure(code.toUpperCase()) : undefined;
}

/** @returns whether `error` is a TEMPFAIL from a key lookup. */
export function isDkimTemporaryFailure(error: unknown): error is DkimTemporaryFailure {
  return error instanceof DkimTemporaryFailure;
}
/** A hostile message may carry ten signatures; five lookups is the most one costs. */
const MAX_SIGNATURES_CHECKED = 5;

function timeout(): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DkimTemporaryFailure("ETIMEOUT")), LOOKUP_TIMEOUT_MS);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * The first TXT record that looks like a key record, its string chunks joined
 * (a 2048-bit key does not fit one 255-byte string).
 */
export const dnsDkimKeyResolver: DkimKeyResolver = async (selector, domain) => {
  const guard = timeout();
  try {
    const records = await Promise.race([resolveTxt(`${selector}._domainkey.${domain}`), guard.promise]);
    if (!records) return undefined;
    const texts = records.map((chunks) => chunks.join(""));
    return texts.find((text) => text.trimStart().startsWith("v=DKIM1")) ?? texts.find((text) => text.includes("p="));
  } catch (error) {
    const temporary = temporaryFailureOf(error);
    if (temporary) throw temporary;
    return undefined;
  } finally {
    guard.cancel();
  }
};

/**
 * The signing domains, aligned with `sendingDomain`, whose DKIM signature on
 * this message verifies against the key the domain publishes. Deduplicated, in signature order.
 *
 * Rejects with `DkimTemporaryFailure` only when nothing verified and at least
 * one key lookup failed temporarily: a signature that does verify settles the
 * question, whatever happened to the others.
 */
export async function selfVerifiedDkimDomains(
  rawMessage: Buffer,
  sendingDomain: string,
  resolver: DkimKeyResolver = dnsDkimKeyResolver,
  now?: Date,
): Promise<string[]> {
  if (rawMessage.length > MAX_DKIM_MESSAGE_BYTES) return [];
  let temporary: DkimTemporaryFailure | undefined;
  const domains: string[] = [];
  try {
    // Only signatures that could vouch for this sender are worth a DNS query:
    // a hostile message can sign as any domain it likes, and each distinct
    // domain would otherwise cost a lookup.
    const sender = sendingDomain.toLowerCase();
    const signatures = parseDkimSignatures(rawMessage)
      .filter((signature) => dkimDomainAligns(signature.domain, sender))
      .slice(0, MAX_SIGNATURES_CHECKED);
    // Start every distinct lookup before waiting on any, so a slow resolver
    // costs one timeout, not one per signature. Each settles to a key, "no
    // key", or the temporary failure it met; none rejects unobserved.
    type Lookup = { key: ReturnType<typeof dkimPublicKeyFromRecord> | undefined; temporary?: DkimTemporaryFailure };
    const lookups = new Map<string, Promise<Lookup>>();
    for (const signature of signatures) {
      const lookupKey = `${signature.selector}\0${signature.domain}`;
      if (lookups.has(lookupKey)) continue;
      lookups.set(lookupKey, Promise.resolve()
        .then(() => resolver(signature.selector, signature.domain))
        .then((record): Lookup => ({ key: record === undefined ? undefined : dkimPublicKeyFromRecord(record) }))
        .catch((error: unknown): Lookup => ({ key: undefined, temporary: temporaryFailureOf(error) })));
    }
    for (const signature of signatures) {
      const lookup = await lookups.get(`${signature.selector}\0${signature.domain}`);
      temporary ??= lookup?.temporary;
      const result = verifyDkimSignature(rawMessage, signature, lookup?.key, now);
      if (result.ok && !domains.includes(result.domain)) domains.push(result.domain);
    }
  } catch {
    return [];
  }
  if (domains.length === 0 && temporary) throw temporary;
  return domains;
}
