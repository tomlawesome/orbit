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
 * a stranger. What makes the claim believable is the receiving provider's own
 * verdict, and only that.
 *
 * Everything here FAILS CLOSED. Absent header, unparseable header, a header
 * written by somebody other than the provider we trust, a `dkim=pass` for the
 * wrong domain, a size or line-count past the bounds: all of them answer "not
 * authenticated", which means the message is unattributed, is not replied to,
 * and is deleted. There is no path through this module that treats "we could
 * not tell" as "yes".
 *
 * ONLY THE TOPMOST `Authentication-Results` COUNTS. Each hop prepends its own
 * header, so the topmost is the one our own provider wrote; every header below
 * it arrived with the message and is the sender's to forge. A reader looking
 * for "an Authentication-Results that passes" anywhere in the block would be
 * reading the attacker's copy.
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
 * routinely fold `Authentication-Results` across several lines, so a reader
 * that stopped at the first line would judge a passing message on half a
 * verdict.
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

type AuthenticationVerdict = {
  /** The authserv-id the topmost header claims, case-folded. */
  authservId: string;
  dmarcPass: boolean;
  /** Signing domains of every `dkim=pass` result in that header, case-folded. */
  dkimPassDomains: string[];
};

function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const character of value) {
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === "(") depth += 1;
    else if (!quoted && character === ")") depth = Math.max(0, depth - 1);
    if (!quoted && depth === 0 && character === separator) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
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
 * Reads the TOPMOST `Authentication-Results` header, and only that one.
 *
 * Anything below it travelled with the message. A parse failure, a missing
 * header or an unreadable authserv-id all answer `undefined`, which the caller
 * reads as "not authenticated".
 */
export function parseTopmostAuthenticationResults(headers: ParsedHeader[]): AuthenticationVerdict | undefined {
  const header = firstHeader(headers, "authentication-results");
  if (header === undefined) return undefined;
  const parts = splitTopLevel(withoutComments(header), ";").map((part) => part.trim()).filter(Boolean);
  const authservId = parts[0]?.split(/\s+/u)[0]?.toLowerCase();
  if (!authservId) return undefined;
  let dmarcPass = false;
  const dkimPassDomains: string[] = [];
  for (const part of parts.slice(1)) {
    const tokens = splitTopLevel(part, " ").map((token) => token.trim()).filter(Boolean);
    const [method, ...properties] = tokens;
    if (!method) continue;
    const [name, result] = method.split("=").map((piece) => piece.trim().toLowerCase());
    if (name === "dmarc" && result === "pass") dmarcPass = true;
    if (name === "dkim" && result === "pass") {
      for (const property of properties) {
        const [key, value] = property.split("=");
        if (key?.trim().toLowerCase() === "header.d" && value) {
          dkimPassDomains.push(value.trim().toLowerCase().replace(/^@/u, ""));
        }
      }
    }
  }
  return { authservId, dmarcPass, dkimPassDomains };
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
 * `trustedAuthservId` is the provider's own identity, which comes from the
 * mailbox's provider profile. Empty means the instance has not said whose
 * verdict it trusts, and the honest answer to "is this sender authenticated"
 * is then no — never "probably".
 */
export function senderIsAuthenticated(
  headers: ParsedHeader[],
  sendingDomain: string,
  trustedAuthservId: string,
): boolean {
  const trusted = trustedAuthservId.trim().toLowerCase();
  if (!trusted || !sendingDomain) return false;
  const verdict = parseTopmostAuthenticationResults(headers);
  if (!verdict || verdict.authservId !== trusted) return false;
  if (verdict.dmarcPass) return true;
  return verdict.dkimPassDomains.some((domain) => dkimDomainAligns(domain, sendingDomain));
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
  /** Whether the provider's own verdict backs that `From`. */
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
 * whose provider vouches for it names the owner. The alias, absent, expired or
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
  "Authentication-Results",
  "Auto-Submitted",
  "Precedence",
  "List-Id",
  "Return-Path",
] as const;
