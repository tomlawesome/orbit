import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type ImapAliasGeneration = {
  generation: number;
  secret: string;
  expiresAt?: Date;
};

export type TrustedRecipientHeaderResult =
  | { kind: "value"; value: string }
  | { kind: "missing" | "duplicate" | "folded" | "malformed" };

const ALIAS_LOCAL_PART = /^orbit\+([A-Za-z0-9_-]{43})$/u;
const HEADER_NAME = /^[A-Za-z0-9-]{1,80}$/u;
const MAX_TRUSTED_HEADER_VALUE_BYTES = 512;

function normalizedDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

function assertGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error("IMAP alias generation must be a positive integer");
  }
}

/** Derives an opaque address from a domain-separated, versioned HMAC input. */
export function deriveImapRecipientAlias(userId: string, domain: string, key: ImapAliasGeneration): string {
  assertGeneration(key.generation);
  const normalizedRecipientDomain = normalizedDomain(domain);
  const input = `orbit:imap-recipient-alias:v1\0${normalizedRecipientDomain}\0${key.generation}\0${userId}`;
  const token = createHmac("sha256", key.secret).update(input, "utf8").digest("base64url");
  return `orbit+${token}@${normalizedRecipientDomain}`;
}

/** Returns only a normalized, opaque alias digest; the alias itself is never persisted. */
export function digestImapRecipientAlias(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex");
}

/** Non-secret binding persisted with rotation authority; raw key/domain/header data never leave runtime configuration. */
export function digestImapAliasConfiguration(domain: string, trustedHeader: string, key: ImapAliasGeneration): string {
  return createHash("sha256")
    .update("orbit:imap-recipient-alias-commitment:v1\0")
    .update(normalizedDomain(domain))
    .update("\0")
    .update(trustedHeader.trim().toLowerCase())
    .update("\0")
    .update(String(key.generation))
    .update("\0")
    .update(key.secret)
    .digest("hex");
}

/** Parses the generated address shape and enforces the configured recipient domain. */
export function normalizeImapRecipientAlias(value: string, domain: string): string | undefined {
  const trimmed = value.trim();
  const withoutBrackets = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  if (withoutBrackets.length === 0 || /\s/u.test(withoutBrackets) || withoutBrackets.includes(",")) return undefined;
  const at = withoutBrackets.lastIndexOf("@");
  if (at <= 0 || at === withoutBrackets.length - 1) return undefined;
  const localPart = withoutBrackets.slice(0, at);
  const receivedDomain = withoutBrackets.slice(at + 1).toLowerCase();
  const expectedDomain = normalizedDomain(domain);
  const localMatch = ALIAS_LOCAL_PART.exec(localPart);
  if (!localMatch || receivedDomain !== expectedDomain) return undefined;
  return `${localPart.toLowerCase()}@${expectedDomain}`;
}

/** Constant-time matching for one configured alias generation. */
export function matchImapRecipientAliasGeneration(
  value: string,
  userId: string,
  domain: string,
  key: ImapAliasGeneration,
  now = new Date(),
): boolean {
  if (key.expiresAt && now.getTime() >= key.expiresAt.getTime()) return false;
  const normalized = normalizeImapRecipientAlias(value, domain);
  if (!normalized) return false;
  const expected = deriveImapRecipientAlias(userId, domain, key).toLowerCase();
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
