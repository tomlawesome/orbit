import { resolveTxt } from "node:dns/promises";
import { dkimDomainAligns } from "./core/sender-authentication";
import { MAX_DKIM_MESSAGE_BYTES, dkimPublicKeyFromRecord, parseDkimSignatures, verifyDkimSignature } from "./core/dkim";

/**
 * Fetching DKIM keys is DNS, so it lives here and not in `core/`: the pure
 * verifier in `core/dkim.ts` is handed whatever this returns.
 *
 * Nothing in this file throws. A lookup that fails for any reason is "no key",
 * and "no key" is a signature that did not verify, never one that did.
 */

/** The key record text for `selector._domainkey.domain`, or nothing. */
export type DkimKeyResolver = (selector: string, domain: string) => Promise<string | undefined>;

const LOOKUP_TIMEOUT_MS = 5_000;
/** A hostile message may carry ten signatures; five lookups is the most one costs. */
const MAX_SIGNATURES_CHECKED = 5;

function timeout(): { promise: Promise<undefined>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS);
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
  } catch {
    return undefined;
  } finally {
    guard.cancel();
  }
};

/**
 * The signing domains, aligned with `sendingDomain`, whose DKIM signature on
 * this message verifies against the key the domain publishes. Deduplicated, in signature order.
 */
export async function selfVerifiedDkimDomains(
  rawMessage: Buffer,
  sendingDomain: string,
  resolver: DkimKeyResolver = dnsDkimKeyResolver,
  now?: Date,
): Promise<string[]> {
  if (rawMessage.length > MAX_DKIM_MESSAGE_BYTES) return [];
  try {
    // Only signatures that could vouch for this sender are worth a DNS query:
    // a hostile message can sign as any domain it likes, and each distinct
    // domain would otherwise cost a lookup.
    const sender = sendingDomain.toLowerCase();
    const signatures = parseDkimSignatures(rawMessage)
      .filter((signature) => dkimDomainAligns(signature.domain, sender))
      .slice(0, MAX_SIGNATURES_CHECKED);
    // Start every distinct lookup before waiting on any, so a slow resolver
    // costs one timeout, not one per signature.
    const lookups = new Map<string, Promise<ReturnType<typeof dkimPublicKeyFromRecord>>>();
    for (const signature of signatures) {
      const lookupKey = `${signature.selector}\0${signature.domain}`;
      if (lookups.has(lookupKey)) continue;
      lookups.set(lookupKey, Promise.resolve()
        .then(() => resolver(signature.selector, signature.domain))
        .then((record) => (record === undefined ? undefined : dkimPublicKeyFromRecord(record)))
        .catch(() => undefined));
    }
    const domains: string[] = [];
    for (const signature of signatures) {
      const key = await lookups.get(`${signature.selector}\0${signature.domain}`);
      const result = verifyDkimSignature(rawMessage, signature, key, now);
      if (result.ok && !domains.includes(result.domain)) domains.push(result.domain);
    }
    return domains;
  } catch {
    return [];
  }
}
