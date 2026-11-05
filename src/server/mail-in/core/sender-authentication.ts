/**
 * mail-in/core boundary: pure parsing logic only. No `getDb`/`db`/schema
 * imports and no `imapflow` import — see src/server/mail-in/README.md.
 *
 * Deciding whether a `From` address may be believed (ADR-0017 decision 3,
 * slice 4, orbit#745).
 *
 * THE RULE THIS FILE EXISTS FOR: a sender address is a claim, not a
 * credential. Anyone can write anything in `From`, so attributing mail by
 * sender alone would let whoever knows a member's email address post into
 * that member's private queue, and would let a forged `From` make Orbit email
 * a stranger. What makes the claim believable is a DKIM signature Orbit
 * verified itself against the signer's published key (RFC 6376, `core/dkim.ts`),
 * whose signing domain aligns with the `From` domain (RFC 7489 §3.1.1, strict
 * or subdomain). Nothing else (#1681, owner decision 86a).
 *
 * NO HEADER IS EVIDENCE. Before #1681 the topmost `Authentication-Results`
 * written by the mailbox provider counted. RFC 8601 §7.1 names why it cannot:
 * an MTA only strips forged copies arriving from outside its trust boundary,
 * and an authenticated sibling mailbox on a self-hosted server (Mailcow's
 * rspamd skips authenticated submissions) is inside it, so its forged
 * `dmarc=pass` reached Orbit on top. A signature is something the sender
 * cannot write without the domain's private key; a header is not.
 *
 * Everything here FAILS CLOSED. No verified signature, a signature for the
 * wrong domain, an unreadable header block: all of them answer "not
 * authenticated". There is no path through this module that treats "we could
 * not tell" as "yes".
 */

/** Bounds every input here, so a hostile header block cannot cost real work. */
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_HEADER_LINES = 2_000;
const MAX_ADDRESS_LENGTH = 320;

export type ParsedHeader = { name: string; value: string };

/**
 * Splits a bounded header block into unfolded name/value pairs, in order.
 *
 * Unfolding matters here in a way it did not for the trusted recipient header
 * (`parseTrustedRecipientHeader`, which rejects folding outright): providers
 * fold long headers across several lines, so a reader that stopped at the
 * first line would judge a message on half a value.
 */
export function parseMailHeaders(headers: Buffer | undefined): ParsedHeader[] | undefined {
  if (!headers || headers.length === 0 || headers.length > MAX_HEADER_BYTES) return undefined;
  const text = headers.toString("utf8");
  if (text.includes("�") || /\r(?!\n)/u.test(text)) return undefined;
  const parsed: ParsedHeader[] = [];
  let lines = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) break;
    if (++lines > MAX_HEADER_LINES) return undefined;
    if (/^[ \t]/u.test(line)) {
      const previous = parsed[parsed.length - 1];
      if (!previous) return undefined;
      previous.value = `${previous.value} ${line.trim()}`;
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) return undefined;
    const name = line.slice(0, separator);
    if (!/^[A-Za-z0-9-]{1,80}$/u.test(name)) return undefined;
    parsed.push({ name: name.toLowerCase(), value: line.slice(separator + 1).trim() });
  }
  return parsed;
}

function firstHeader(headers: ParsedHeader[], name: string): string | undefined {
  return headers.find((header) => header.name === name)?.value;
}

/**
 * Normalises a sending address to the one spelling the database stores.
 *
 * Trim, drop any display name and angle brackets, case-fold. One address is
 * one row, instance-wide, because an address attributes to exactly one member
 * — two members claiming the same address would make attribution a guess.
 *
 * The local part is case-folded along with the domain. Strictly, RFC 5321
 * leaves local-part case to the receiving provider, but every provider Orbit
 * supports folds it, and NOT folding it would let `Tom@example.com` and
 * `tom@example.com` be verified by two different members — which is the
 * confusion this normalisation exists to prevent.
 */
export function normalizeSenderAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let candidate = value.trim();
  if (candidate.length === 0 || candidate.length > MAX_ADDRESS_LENGTH * 2) return undefined;
  const open = candidate.lastIndexOf("<");
  const close = candidate.lastIndexOf(">");
  if (open !== -1 && close > open) candidate = candidate.slice(open + 1, close).trim();
  candidate = candidate.toLowerCase();
  if (candidate.length === 0 || candidate.length > MAX_ADDRESS_LENGTH) return undefined;
  if (/[\s,<>"()[\]\\;:]/u.test(candidate)) return undefined;
  const at = candidate.lastIndexOf("@");
  if (at <= 0 || at === candidate.length - 1) return undefined;
  const domain = candidate.slice(at + 1);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u.test(domain)) return undefined;
  return candidate;
}

/** The domain half of a normalised address. */
export function senderDomainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

/** The `From` address a message claims, normalised, or nothing usable. */
export function senderAddressFromHeaders(headers: ParsedHeader[]): string | undefined {
  const from = firstHeader(headers, "from");
  if (!from) return undefined;
  // A `From` naming more than one address is not a member forwarding their own
  // mail; it is not something this rule can attribute, so it attributes
  // nothing rather than picking one.
  if (from.split(",").length > 1) return undefined;
  return normalizeSenderAddress(from);
}

/** Strips RFC 5322 comments, which a hostile sender may put anywhere. */
function withoutComments(value: string): string {
  let depth = 0;
  let quoted = false;
  let plain = "";
  for (const character of value) {
    if (character === '"' && depth === 0) quoted = !quoted;
    if (!quoted && character === "(") { depth += 1; continue; }
    if (!quoted && character === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) plain += character;
  }
  return plain;
}

/**
 * Whether a signing domain covers a sending domain.
 *
 * Exact match, or the sender is a subdomain of the signer. Anything looser
 * would need the organisational-domain rules, and those need a public-suffix
 * list — a lookup dataset this project will not vendor. Being stricter than
 * DMARC's relaxed alignment costs a member nothing: their own provider signs
 * with their own domain.
 */
export function dkimDomainAligns(signingDomain: string, sendingDomain: string): boolean {
  return signingDomain === sendingDomain || sendingDomain.endsWith(`.${signingDomain}`);
}

/**
 * The whole believe-or-not decision for one message.
 *
 * `selfVerifiedDomains` are the signing domains of DKIM signatures Orbit
 * checked itself against the signer's published key (`core/dkim.ts`). The
 * sender is authenticated only when one of them aligns with `sendingDomain`.
 * `headers` is accepted so callers keep one shape, and is deliberately not
 * read: no `Authentication-Results`, `dmarc=`, `dkim=` or `auth=pass` claim in
 * it counts, whoever it says wrote it (#1681).
 */
export function senderIsAuthenticated(
  _headers: ParsedHeader[],
  sendingDomain: string,
  selfVerifiedDomains: readonly string[] = [],
): boolean {
  if (!sendingDomain) return false;
  return selfVerifiedDomains.some((domain) => dkimDomainAligns(domain.toLowerCase(), sendingDomain));
}

/**
 * Whether a message is automated, and therefore must never be replied to.
 *
 * The reply Orbit sends for unattributed mail is the one place mail-in speaks
 * outward, and answering a mailing list, an autoresponder or a bounce is how a
 * household mailbox gets itself into a loop or onto a blocklist. Anything that
 * looks automated counts, and an unreadable header block counts too.
 */
export function isAutomatedMail(headers: ParsedHeader[]): boolean {
  const autoSubmitted = firstHeader(headers, "auto-submitted");
  if (autoSubmitted !== undefined) {
    const value = withoutComments(autoSubmitted).split(";")[0].trim().toLowerCase();
    if (value !== "no") return true;
  }
  const precedence = firstHeader(headers, "precedence");
  if (precedence !== undefined && ["bulk", "list", "junk"].includes(precedence.trim().toLowerCase())) return true;
  if (firstHeader(headers, "list-id") !== undefined) return true;
  const returnPath = firstHeader(headers, "return-path");
  if (returnPath !== undefined && ["<>", ""].includes(returnPath.trim())) return true;
  return false;
}

export type AttributionInputs = {
  /** The member the verified `From` address names, if any. */
  senderUserId?: string;
  /** Whether a self-verified aligned DKIM signature backs that `From`. */
  senderAuthenticated: boolean;
  /** The member the plus-address alias names, if it resolved to one. */
  aliasUserId?: string;
};

export type AttributionFailure = "sender_unverified" | "sender_unauthenticated" | "sender_alias_mismatch";

export type AttributionOutcome =
  | { userId: string; attributedBy: "sender" | "sender_and_alias"; failureCode?: undefined }
  | { userId?: undefined; attributedBy?: undefined; failureCode: AttributionFailure };

/**
 * Who owns a message (ADR-0017 decision 3).
 *
 * THE SENDER ATTRIBUTES; THE ALIAS CORROBORATES. A verified sending address
 * backed by a self-verified aligned signature names the owner. The alias, absent, expired or
 * malformed, changes nothing — the message still belongs to that sender. An
 * alias naming a DIFFERENT member is the one case where it does change
 * something: two identities disagree about whose mail this is, and the honest
 * answer is neither, so the message is unattributed.
 *
 * There is no path here that attributes on the alias alone. That is the
 * replaced rung of the 2026-08-13 ladder: the alias is guessable-if-typed and
 * whoever holds it can post into a queue, so it corroborates an identity that
 * was proved elsewhere rather than establishing one.
 */
export function decideAttribution(inputs: AttributionInputs): AttributionOutcome {
  if (!inputs.senderUserId) return { failureCode: "sender_unverified" };
  if (!inputs.senderAuthenticated) return { failureCode: "sender_unauthenticated" };
  if (inputs.aliasUserId && inputs.aliasUserId !== inputs.senderUserId) return { failureCode: "sender_alias_mismatch" };
  return {
    userId: inputs.senderUserId,
    attributedBy: inputs.aliasUserId === inputs.senderUserId ? "sender_and_alias" : "sender",
  };
}

/**
 * The header names the poll cycle has to fetch for any of this to be
 * decidable. Kept beside the rules that read them so the two cannot drift: a
 * header nobody fetched reads exactly like a header nobody sent, and that
 * difference is the whole of this module's security value.
 */
export const SENDER_AUTHENTICATION_HEADERS = [
  "From",
  "Auto-Submitted",
  "Precedence",
  "List-Id",
  "Return-Path",
] as const;
