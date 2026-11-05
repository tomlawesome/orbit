import { Resolver, lookup, resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
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
 * A resolver over `queryTxt`: the first TXT record that looks like a key
 * record, its string chunks joined (a 2048-bit key does not fit one 255-byte
 * string).
 */
function keyResolverOver(queryTxt: (name: string) => Promise<string[][]>): DkimKeyResolver {
  return async (selector, domain) => {
    const guard = timeout();
    try {
      const records = await Promise.race([queryTxt(`${selector}._domainkey.${domain}`), guard.promise]);
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
}

/** The lookup through the process-default resolver: today's path, and the one used when no DKIM resolver is named. */
export const dnsDkimKeyResolver: DkimKeyResolver = keyResolverOver((name) => resolveTxt(name));

/** A setting entry that cannot be turned into a server; every lookup is then a TEMPFAIL. */
function badServers(): never {
  throw new DkimTemporaryFailure("EBADSERVERS");
}

/** A port as `setServers` must be given it: 1 to 65535. Port 0 aborts the process inside node's resolver, and a larger one is silently wrapped. */
function validPort(port: string): number {
  const value = /^\d{1,5}$/u.test(port) ? Number(port) : Number.NaN;
  return value >= 1 && value <= 65_535 ? value : badServers();
}

/** A host name the system lookup may be asked for: letters, digits, `-`, `_` and dots, nothing `setServers` would read as an address. */
const HOSTNAME = /^[a-z0-9_](?:[a-z0-9_-]{0,62})(?:\.[a-z0-9_](?:[a-z0-9_-]{0,62}))*\.?$/iu;

/** One parsed setting entry: a checked address to pass on, or a hostname (with optional port) still to be resolved. */
type ServerEntry = { address: string } | { host: string; port?: number };

/**
 * One `MAIL_IN_DKIM_DNS_SERVERS` entry, parsed by syntax alone (no lookups).
 * Every entry is parsed and rebuilt, because `setServers` quietly drops or
 * rewrites what it does not understand (`[ipv6]:abc` becomes port 53, port
 * 99999 wraps, port 0 aborts the process): an address (`ip`, `ipv4:port`,
 * `[ipv6]`, `[ipv6]:port`) is checked; a hostname (`host`, `host:port`) is
 * returned for resolution. Anything else throws.
 */
function parseServerEntry(entry: string): ServerEntry {
  if (entry === "") badServers();
  if (isIP(entry)) return { address: entry };
  const bracketed = /^\[([^\]]*)\](?::(.*))?$/u.exec(entry);
  if (bracketed) {
    if (isIP(bracketed[1]) !== 6) badServers();
    return { address: bracketed[2] === undefined ? bracketed[1] : `[${bracketed[1]}]:${validPort(bracketed[2])}` };
  }
  const colon = entry.lastIndexOf(":");
  const host = colon === -1 ? entry : entry.slice(0, colon);
  const port = colon === -1 ? undefined : validPort(entry.slice(colon + 1));
  if (isIP(host) === 4) return { address: `${host}:${port}` };
  if (!HOSTNAME.test(host)) badServers();
  return { host, port };
}

/** The entries of a non-blank setting, parsed; throws on any malformed one. */
function parseServerEntries(servers: string): ServerEntry[] {
  return servers.split(",").map((entry) => parseServerEntry(entry.trim()));
}

/**
 * @returns whether `servers` is a non-blank setting that cannot be turned into
 * servers by syntax alone (#1681). Synchronous, no lookups: a resolver that is
 * merely down is not malformed. Unset or blank is not malformed.
 */
export function dkimDnsServersMalformed(servers: string | undefined): boolean {
  if ((servers ?? "").trim() === "") return false;
  try {
    parseServerEntries(servers!);
    return false;
  } catch {
    return true;
  }
}

/** A parsed entry as `setServers` takes it; a hostname is resolved through the system lookup now, within the lookup time limit. */
async function serverAddress(parsed: ServerEntry): Promise<string> {
  if ("address" in parsed) return parsed.address;
  const guard = timeout();
  let resolved: { address: string; family: number };
  try {
    resolved = await Promise.race([lookup(parsed.host), guard.promise]);
  } finally {
    guard.cancel();
  }
  if (parsed.port === undefined) return resolved.address;
  return `${resolved.family === 6 ? `[${resolved.address}]` : resolved.address}:${parsed.port}`;
}

/**
 * The DKIM key resolver for one ingestion cycle (#1681). `servers` is the raw
 * `MAIL_IN_DKIM_DNS_SERVERS` setting: comma-separated `host[:port]` or
 * `ip[:port]`, the DKIM-only resolver knob rspamd (`options.dns.nameserver`)
 * and OpenDKIM (`Nameservers`) also offer. Unset or blank, it is
 * `dnsDkimKeyResolver` itself. Set, only the DKIM key lookup asks those
 * servers; nothing else in Orbit changes resolver. Hostnames are looked up on
 * every call, so a restarted server's new address is used by the next cycle.
 *
 * A setting that cannot be turned into servers (a name that does not resolve
 * or does not answer within the lookup time limit, a malformed or empty
 * entry) never means "no key": every lookup through the result is
 * a TEMPFAIL, so mail waits rather than being judged unauthenticated.
 */
export async function dkimKeyResolverFor(servers: string | undefined): Promise<DkimKeyResolver> {
  /* Unset or blank as a whole is the default path; an empty entry inside a
     list (`a,,b`, `a,`, `a, ,b`) is a malformed setting, not "fewer servers". */
  if ((servers ?? "").trim() === "") return dnsDkimKeyResolver;
  try {
    const addresses = await Promise.all(parseServerEntries(servers!).map(serverAddress));
    const resolver = new Resolver();
    resolver.setServers(addresses);
    return keyResolverOver((name) => resolver.resolveTxt(name));
  } catch (error) {
    const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    const failure = new DkimTemporaryFailure(typeof code === "string" ? code.toUpperCase() : "EBADSERVERS");
    return () => Promise.reject(failure);
  }
}

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
