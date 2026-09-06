/**
 * mail-in/core boundary: pure parsing logic only. No `getDb`/`db`/schema
 * imports and no `imapflow` import — see src/server/mail-in/README.md.
 * Moved as-is from src/server/imap-recipient.ts as part of the #298 module
 * split.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type ImapAliasGeneration = {
  generation: number;
  secret: string;
  expiresAt?: Date;
};

/**
 * The plus-addressed base every relay address is built on:
 * `<localPart>+<token>@<domain>`.
 *
 * Both halves are derived from the mailbox account address, never configured
 * separately (ADR-0017 decision 1, owner ruling 2026-09-02 on #336). The
 * literal `orbit` local part this module used to hard-code is not a
 * sub-address of the mailbox, so Gmail and Outlook would never deliver it —
 * which also made the setup probe (the ratified ladder's rung 1) impossible
 * to pass.
 */
export interface ImapAliasBase {
  localPart: string;
  domain: string;
}

export type TrustedRecipientHeaderResult =
  | { kind: "value"; value: string }
  | { kind: "missing" | "duplicate" | "folded" | "malformed" };

// The token shape alone. The base local part in front of it is compared
// separately, as a plain case-folded string rather than spliced into this
// pattern: it comes from the operator's account address, so building a
// regular expression out of it would need escaping to stay safe, and a
// mis-escaped character class is exactly the trap the repository's
// instructions warn about. Case-folding both sides matches how the token and
// domain are folded below — Gmail, Outlook and Mailcow all treat the local
// part case-insensitively, so a sender or relay that upcases the address must
// still attribute instead of silently landing in the unattributed path (#336
// decision, characterization oddity #9 from #298). Folding does not widen
// what counts as a valid token.
const ALIAS_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const HEADER_NAME = /^[A-Za-z0-9-]{1,80}$/u;
const MAX_TRUSTED_HEADER_VALUE_BYTES = 512;
/** Only used when an account address carries no usable local part at all. */
const FALLBACK_ALIAS_LOCAL_PART = "orbit";

function normalizedDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

/**
 * Derives the alias base from the mailbox account address.
 *
 * Any sub-address the operator already put on the account (`orbit+intake@…`)
 * is dropped, so aliases are always one `+` deep and the provider's own
 * sub-addressing rules apply to a single tag. An account with no local part
 * falls back to `orbit`, which keeps the shape valid for a not-yet-configured
 * mailbox rather than producing an address with an empty local part.
 */
export function imapAliasBaseFromAccount(accountUser: string): ImapAliasBase {
  const trimmed = accountUser.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  const localPart = at <= 0 ? "" : trimmed.slice(0, at);
  const domain = at === -1 ? "" : trimmed.slice(at + 1);
  const plus = localPart.indexOf("+");
  const base = plus === -1 ? localPart : localPart.slice(0, plus);
  return { localPart: base || FALLBACK_ALIAS_LOCAL_PART, domain: normalizedDomain(domain) };
}

function normalizedBase(base: ImapAliasBase): ImapAliasBase {
  return {
    localPart: (base.localPart || FALLBACK_ALIAS_LOCAL_PART).trim().toLowerCase(),
    domain: normalizedDomain(base.domain),
  };
}

function assertGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error("IMAP alias generation must be a positive integer");
  }
}

/**
 * Derives an opaque address from a domain-separated, versioned HMAC input.
 *
 * The base local part is part of the HMAC input as well as the printed
 * address, so re-pointing the instance at a different mailbox account
 * produces a different token rather than the same token under a new local
 * part.
 */
export function deriveImapRecipientAlias(userId: string, base: ImapAliasBase, key: ImapAliasGeneration): string {
  assertGeneration(key.generation);
  const { localPart, domain } = normalizedBase(base);
  const input = `orbit:imap-recipient-alias:v2\0${localPart}\0${domain}\0${key.generation}\0${userId}`;
  const token = createHmac("sha256", key.secret).update(input, "utf8").digest("base64url");
  return `${localPart}+${token}@${domain}`;
}

/** Returns only a normalized, opaque alias digest; the alias itself is never persisted. */
export function digestImapRecipientAlias(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex");
}

/** Non-secret binding persisted with rotation authority; raw key/domain/header data never leave runtime configuration. */
export function digestImapAliasConfiguration(base: ImapAliasBase, trustedHeader: string, key: ImapAliasGeneration): string {
  const normalized = normalizedBase(base);
  return createHash("sha256")
    .update("orbit:imap-recipient-alias-commitment:v2\0")
    .update(normalized.localPart)
    .update("\0")
    .update(normalized.domain)
    .update("\0")
    .update(trustedHeader.trim().toLowerCase())
    .update("\0")
    .update(String(key.generation))
    .update("\0")
    .update(key.secret)
    .digest("hex");
}

/** Parses the generated address shape and enforces the configured alias base. */
export function normalizeImapRecipientAlias(value: string, base: ImapAliasBase): string | undefined {
  const trimmed = value.trim();
  const withoutBrackets = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  if (withoutBrackets.length === 0 || /\s/u.test(withoutBrackets) || withoutBrackets.includes(",")) return undefined;
  const at = withoutBrackets.lastIndexOf("@");
  if (at <= 0 || at === withoutBrackets.length - 1) return undefined;
  const localPart = withoutBrackets.slice(0, at).toLowerCase();
  const receivedDomain = withoutBrackets.slice(at + 1).toLowerCase();
  const expected = normalizedBase(base);
  if (receivedDomain !== expected.domain) return undefined;
  const plus = localPart.indexOf("+");
  if (plus === -1 || localPart.slice(0, plus) !== expected.localPart) return undefined;
  if (!ALIAS_TOKEN.test(localPart.slice(plus + 1))) return undefined;
  return `${localPart}@${expected.domain}`;
}

/** Constant-time matching for one configured alias generation. */
export function matchImapRecipientAliasGeneration(
  value: string,
  userId: string,
  base: ImapAliasBase,
  key: ImapAliasGeneration,
  now = new Date(),
): boolean {
  if (key.expiresAt && now.getTime() >= key.expiresAt.getTime()) return false;
  const normalized = normalizeImapRecipientAlias(value, base);
  if (!normalized) return false;
  const expected = deriveImapRecipientAlias(userId, base, key).toLowerCase();
  const receivedBytes = Buffer.from(normalized, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

/** Reads only the configured header from a bounded header block. */
export function parseTrustedRecipientHeader(headers: Buffer | undefined, headerName: string): TrustedRecipientHeaderResult {
  if (!headers || headers.length === 0 || !HEADER_NAME.test(headerName)) return { kind: "missing" };
  if (headers.length > 64 * 1024) return { kind: "malformed" };
  const text = headers.toString("utf8");
  if (text.includes("\uFFFD") || /\r(?!\n)/u.test(text)) return { kind: "malformed" };

  const values: string[] = [];
  let trustedHeaderContinues = false;
  const expectedName = headerName.toLowerCase();
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) break;
    if (/^[ \t]/u.test(line)) {
      if (trustedHeaderContinues) return { kind: "folded" };
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) return { kind: "malformed" };
    const name = line.slice(0, separator);
    if (!HEADER_NAME.test(name)) return { kind: "malformed" };
    trustedHeaderContinues = name.toLowerCase() === expectedName;
    if (trustedHeaderContinues) values.push(line.slice(separator + 1).trim());
  }

  if (values.length === 0) return { kind: "missing" };
  if (values.length > 1) return { kind: "duplicate" };
  const value = values[0];
  if (!value || Buffer.byteLength(value, "utf8") > MAX_TRUSTED_HEADER_VALUE_BYTES) return { kind: "malformed" };
  return { kind: "value", value };
}
