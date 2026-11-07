/**
 * mail-in/core boundary: pure logic only. This module imports `node:crypto`
 * and the mail-in intake limit — no DNS, no database, no IMAP client. The key a signature
 * is checked against is handed in by the caller (`../dkim-lookup.ts` fetches
 * it), so everything here is a function of its arguments.
 *
 * DKIM verification (RFC 6376), for one purpose: proving a forward's `From`.
 * Since #1681 the message's own signature, checked against the signing
 * domain's published key, is the ONLY evidence mail-in accepts; no provider
 * `Authentication-Results` verdict is read (orbit#1655 introduced this check
 * for same-server forwards, which get no such verdict at all).
 *
 * A verified signature proves only that a holder of the domain's private key
 * signed these headers and this body. Callers must therefore read the signing
 * domain, not any header the message claims for itself, and must align it with
 * the `From` domain (RFC 7489 §3.1.1; `dkimDomainAligns`).
 *
 * Everything here FAILS CLOSED and never throws on hostile input: a signature
 * that cannot be parsed is skipped, and a check that cannot be completed
 * answers `ok: false`.
 */
import { createHash, createPublicKey, verify, type Hash, type KeyObject } from "node:crypto";
import { MAIL_MESSAGE_CEILING_BYTES } from "./imap-attachment-validation";

export type DkimCanon = "simple" | "relaxed";

export type DkimSignature = {
  /** `d=`, case-folded. */
  domain: string;
  /** `s=`. */
  selector: string;
  algorithm: "rsa-sha256" | "ed25519-sha256";
  /** First half of `c=`; simple when absent. */
  headerCanon: DkimCanon;
  /** Second half of `c=`; simple when absent. */
  bodyCanon: DkimCanon;
  /** `h=`, case-folded, in order, duplicates kept. */
  signedHeaders: string[];
  /** `bh=`, base64. */
  bodyHash: string;
  /** `b=`, base64, whitespace removed. */
  signature: string;
  /** `l=`. */
  bodyLength?: number;
  /** `t=`. */
  timestamp?: number;
  /** `x=`. */
  expires?: number;
  /** Which DKIM-Signature header this is in the message, 0-based, top first. */
  headerIndex: number;
};

/** A message with a thousand signatures is hostile; ten is generous. */
const MAX_SIGNATURES = 10;
/** Bounds on what one split and one verification will chew through; past them: "unsupported". */
const MAX_HEADER_LINES = 1_000;
const MAX_SIGNED_HEADER_NAMES = 50;

/**
 * Larger messages are not self-verified. The default is the mail limit's
 * ceiling; ingestion passes the limit it read for the cycle (#1388), so every
 * message mail-in accepts can be attributed. Canonicalisation is a single
 * streaming pass, so the work stays linear in the message size.
 */
export const MAX_DKIM_MESSAGE_BYTES = MAIL_MESSAGE_CEILING_BYTES;

type RawHeader = { name: string; raw: string };

/** `bodyHashes`: the base64 SHA-256 of the canonical body, computed at most once per mode. */
type SplitMessage = { headers: RawHeader[]; body: string; headerLines: number; bodyHashes: Partial<Record<DkimCanon, string>> };

/*
 * Everything below works on latin1 strings: one character per byte, so `l=`
 * counts bytes, hashes see the original bytes, and no UTF-8 decoding can
 * change what was signed.
 */

/**
 * Bare LF becomes CRLF. IMAP hands us CRLF; fixtures and other sources may not.
 * A byte scan, not a regex replace: a replace over millions of line breaks
 * costs seconds, and a message here can be 25 MiB.
 */
function normaliseLineEndings(rawMessage: Buffer): string {
  let bareLineFeeds = 0;
  for (let i = 0; i < rawMessage.length; i += 1) {
    if (rawMessage[i] === 10 && (i === 0 || rawMessage[i - 1] !== 13)) bareLineFeeds += 1;
  }
  if (bareLineFeeds === 0) return rawMessage.toString("latin1");
  const normalised = Buffer.allocUnsafe(rawMessage.length + bareLineFeeds);
  let at = 0;
  for (let i = 0; i < rawMessage.length; i += 1) {
    const byte = rawMessage[i];
    if (byte === 10 && (i === 0 || rawMessage[i - 1] !== 13)) normalised[at++] = 13;
    normalised[at++] = byte;
  }
  return normalised.toString("latin1");
}

// A message is decoded and split once, however many signatures it carries.
const splitCache = new WeakMap<Buffer, SplitMessage>();

function splitMessage(rawMessage: Buffer): SplitMessage {
  const cached = splitCache.get(rawMessage);
  if (cached) return cached;
  const split = splitMessageUncached(rawMessage);
  splitCache.set(rawMessage, split);
  return split;
}

function splitMessageUncached(rawMessage: Buffer): SplitMessage {
  const text = normaliseLineEndings(rawMessage);
  let headerText: string;
  let body: string;
  if (text.startsWith("\r\n")) {
    headerText = "";
    body = text.slice(2);
  } else {
    const end = text.indexOf("\r\n\r\n");
    if (end === -1) {
      headerText = text;
      body = "";
    } else {
      headerText = text.slice(0, end);
      body = text.slice(end + 4);
    }
  }
  const headers: RawHeader[] = [];
  let headerLines = 0;
  /* Scan line by line and stop at the cap. `headerText.split("\r\n")` would
     first build an array of every line, and the header section can be the
     whole 25 MiB message (A-R2). Past the cap `headerLines` is left over it
     and the headers collected so far are returned; verifyDkimSignature refuses. */
  let start = 0;
  while (start <= headerText.length) {
    let lineEnd = headerText.indexOf("\r\n", start);
    if (lineEnd === -1) lineEnd = headerText.length;
    const line = headerText.slice(start, lineEnd);
    start = lineEnd + 2;
    if (line.length === 0) continue;
    headerLines += 1;
    if (headerLines > MAX_HEADER_LINES) break;
    if (/^[ \t]/u.test(line)) {
      const previous = headers[headers.length - 1];
      if (previous) previous.raw += `\r\n${line}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.push({ name: line.slice(0, colon).trim().toLowerCase(), raw: line });
  }
  return { headers, body, headerLines, bodyHashes: {} };
}

/** RFC 6376 §3.2 tag-list. `undefined` for a repeated tag or a malformed one. */
function parseTagList(value: string): Map<string, string> | undefined {
  const tags = new Map<string, string>();
  const parts = value.split(";");
  // A trailing ";" is allowed, so the last piece may be blank.
  if (parts[parts.length - 1].trim() === "") parts.pop();
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals === -1) return undefined;
    const name = part.slice(0, equals).trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(name)) return undefined;
    if (tags.has(name)) return undefined;
    tags.set(name, part.slice(equals + 1).trim());
  }
  return tags;
}

function parseCanonicalization(value: string | undefined): [DkimCanon, DkimCanon] | undefined {
  if (value === undefined) return ["simple", "simple"];
  const [header, body, extra] = value.trim().toLowerCase().split("/");
  if (extra !== undefined) return undefined;
  const canon = (name: string | undefined): DkimCanon | undefined =>
    name === undefined ? "simple" : name === "simple" || name === "relaxed" ? name : undefined;
  const headerCanon = canon(header);
  const bodyCanon = canon(body);
  return headerCanon && bodyCanon ? [headerCanon, bodyCanon] : undefined;
}

function parseCount(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  if (!/^[0-9]{1,15}$/u.test(value)) return null;
  return Number(value);
}

function parseOneSignature(header: RawHeader, headerIndex: number): DkimSignature | undefined {
  const tags = parseTagList(header.raw.slice(header.raw.indexOf(":") + 1));
  if (!tags || tags.get("v") !== "1") return undefined;
  const algorithm = tags.get("a")?.toLowerCase();
  if (algorithm !== "rsa-sha256" && algorithm !== "ed25519-sha256") return undefined;
  const canon = parseCanonicalization(tags.get("c"));
  if (!canon) return undefined;
  const query = tags.get("q");
  if (query !== undefined && !query.toLowerCase().split(":").some((method) => method.trim() === "dns/txt")) return undefined;
  const domain = tags.get("d")?.toLowerCase();
  const selector = tags.get("s");
  const signedHeaders = tags.get("h")?.replace(/\s+/gu, "").toLowerCase().split(":").filter(Boolean);
  const bodyHash = tags.get("bh")?.replace(/\s+/gu, "");
  const signature = tags.get("b")?.replace(/\s+/gu, "");
  if (!domain || !selector || !signedHeaders?.length || !bodyHash || !signature) return undefined;
  const bodyLength = parseCount(tags.get("l"));
  const timestamp = parseCount(tags.get("t"));
  const expires = parseCount(tags.get("x"));
  if (bodyLength === null || timestamp === null || expires === null) return undefined;
  return {
    domain,
    selector,
    algorithm,
    headerCanon: canon[0],
    bodyCanon: canon[1],
    signedHeaders,
    bodyHash,
    signature,
    bodyLength,
    timestamp,
    expires,
    headerIndex,
  };
}

/**
 * Every `DKIM-Signature` header, top first. Unparsable ones, and ones with an
 * unsupported `v=`, `a=`, `c=` or `q=`, are skipped, never thrown. At most ten
 * are returned.
 */
export function parseDkimSignatures(rawMessage: Buffer): DkimSignature[] {
  const { headers } = splitMessage(rawMessage);
  const signatures: DkimSignature[] = [];
  let index = 0;
  for (const header of headers) {
    if (header.name !== "dkim-signature") continue;
    const parsed = parseOneSignature(header, index);
    index += 1;
    if (parsed) signatures.push(parsed);
    if (signatures.length >= MAX_SIGNATURES) break;
  }
  return signatures;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function colonList(value: string): string[] {
  return value.toLowerCase().split(":").map((item) => item.trim());
}

/**
 * The public key a key record (`v=DKIM1; k=rsa; p=<base64>`) publishes, or
 * `undefined`. Revoked (empty `p=`), malformed, an unknown key type, a record
 * that excludes sha256 or one restricted to a service other than email all
 * answer `undefined`. `t=y` (testing) still returns the key.
 */
export function dkimPublicKeyFromRecord(record: string): KeyObject | undefined {
  const tags = parseTagList(record);
  if (!tags) return undefined;
  const version = tags.get("v");
  if (version !== undefined && version !== "DKIM1") return undefined;
  const hashes = tags.get("h");
  if (hashes !== undefined && !colonList(hashes).includes("sha256")) return undefined;
  const services = tags.get("s");
  if (services !== undefined) {
    const list = colonList(services);
    if (!list.includes("*") && !list.includes("email")) return undefined;
  }
  const type = (tags.get("k") ?? "rsa").toLowerCase();
  const encoded = tags.get("p")?.replace(/\s+/gu, "");
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  try {
    if (type === "rsa") {
      const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
      return key.asymmetricKeyType === "rsa" ? key : undefined;
    }
    if (type === "ed25519") {
      if (bytes.length !== 32) return undefined;
      return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]), format: "der", type: "spki" });
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export type DkimVerifyResult =
  | { ok: true; domain: string }
  | {
      ok: false;
      reason:
        | "key_missing"
        | "unsupported"
        | "from_not_signed"
        | "expired"
        | "body_hash_mismatch"
        | "signature_invalid";
    };

/**
 * The end of `text` without its trailing CRLFs. A backwards scan: a regex such
 * as `(\r\n)+$` retries from every CRLF in a long run and is quadratic, and the
 * body here can be tens of megabytes.
 */
function endWithoutTrailingCrlf(text: string): number {
  let end = text.length;
  while (end >= 2 && text.charCodeAt(end - 1) === 10 && text.charCodeAt(end - 2) === 13) end -= 2;
  return end;
}

/** Feeds a hash in bounded latin1 chunks, so no full-size copy of the body is made. */
const HASH_CHUNK_CHARS = 64 * 1024;

function hashLatin1Range(hash: Hash, text: string, start: number, end: number): void {
  for (let at = start; at < end; at += HASH_CHUNK_CHARS) {
    hash.update(text.slice(at, Math.min(end, at + HASH_CHUNK_CHARS)), "latin1");
  }
}

const SPACE = 32;
const TAB = 9;

/**
 * RFC 6376 §3.4.4 relaxed body canonicalisation, streamed into `hash` in one
 * pass over a CRLF-normalised body: whitespace runs inside a line become one
 * space, whitespace at a line's end goes, and empty lines at the end of the
 * body go (an all-empty body hashes as nothing). Blank lines are held as a
 * count until a non-empty line shows they are not trailing.
 */
function hashRelaxedBody(hash: Hash, body: string): void {
  let out = "";
  const flushIfFull = () => {
    if (out.length >= HASH_CHUNK_CHARS) {
      hash.update(out, "latin1");
      out = "";
    }
  };
  let pendingBlankLines = 0;
  let pos = 0;
  const length = body.length;
  while (pos <= length) {
    let lineEnd = body.indexOf("\r\n", pos);
    const next = lineEnd === -1 ? length + 1 : lineEnd + 2;
    if (lineEnd === -1) lineEnd = length;
    let end = lineEnd;
    while (end > pos) {
      const c = body.charCodeAt(end - 1);
      if (c !== SPACE && c !== TAB) break;
      end -= 1;
    }
    if (end === pos) {
      pendingBlankLines += 1;
    } else {
      for (; pendingBlankLines > 0; pendingBlankLines -= 1) {
        out += "\r\n";
        flushIfFull();
      }
      let runStart = pos;
      let i = pos;
      while (i < end) {
        const c = body.charCodeAt(i);
        if (c !== SPACE && c !== TAB) {
          i += 1;
          continue;
        }
        // A lone space is already canonical; a tab or a longer run is not.
        // The line's trailing whitespace is gone, so a run always ends before `end`.
        const following = body.charCodeAt(i + 1);
        if (c === SPACE && following !== SPACE && following !== TAB) {
          i += 1;
          continue;
        }
        out += body.slice(runStart, i);
        out += " ";
        i += 1;
        while (i < end && (body.charCodeAt(i) === SPACE || body.charCodeAt(i) === TAB)) i += 1;
        runStart = i;
        flushIfFull();
      }
      if (end - runStart >= HASH_CHUNK_CHARS) {
        if (out.length > 0) hash.update(out, "latin1");
        out = "";
        hashLatin1Range(hash, body, runStart, end);
      } else {
        out += body.slice(runStart, end);
      }
      out += "\r\n";
      flushIfFull();
    }
    pos = next;
  }
  if (out.length > 0) hash.update(out, "latin1");
}

/** The base64 SHA-256 of the body under RFC 6376 §3.4.3 or §3.4.4, CRLF-normalised input. */
function canonicalBodyHash(body: string, canon: DkimCanon): string {
  const hash = createHash("sha256");
  if (canon === "simple") {
    hashLatin1Range(hash, body, 0, endWithoutTrailingCrlf(body));
    hash.update("\r\n", "latin1");
  } else {
    hashRelaxedBody(hash, body);
  }
  return hash.digest("base64");
}

/** RFC 6376 §3.4.1 and §3.4.2, without the trailing CRLF. */
function canonicalHeader(header: RawHeader, canon: DkimCanon): string {
  if (canon === "simple") return header.raw;
  const colon = header.raw.indexOf(":");
  const value = header.raw
    .slice(colon + 1)
    .replace(/\r\n(?=[ \t])/gu, "")
    .replace(/[ \t]+/gu, " ")
    .trim();
  return `${header.name}:${value}`;
}

/** The signature header with the value of `b=` emptied, as §3.7 hashes it. */
function withEmptySignatureValue(header: RawHeader): RawHeader {
  const colon = header.raw.indexOf(":");
  const emptied = header.raw.slice(colon + 1).replace(/(^|;)(\s*b\s*=)[^;]*/u, "$1$2");
  return { name: header.name, raw: `${header.raw.slice(0, colon + 1)}${emptied}` };
}

/**
 * Checks one parsed signature against the key for its selector and domain.
 *
 * Order: size bounds, the `From` header is signed, the signature has not
 * expired, there is a key of the right type, no `l=`, the body hash matches,
 * and only then the signature over the headers. `now` is injectable so tests need no clock.
 */
export function verifyDkimSignature(
  rawMessage: Buffer,
  signature: DkimSignature,
  key: KeyObject | undefined,
  now: Date = new Date(),
  maxMessageBytes: number = MAX_DKIM_MESSAGE_BYTES,
): DkimVerifyResult {
  if (rawMessage.length > maxMessageBytes) return { ok: false, reason: "unsupported" };
  const split = splitMessage(rawMessage);
  const { headers, headerLines } = split;
  /* Work is bounded: the split above stops at MAX_HEADER_LINES, and below by
     the names in h= and the number of signatures, because the message can be
     tens of megabytes of attacker text. */
  const byName = new Map<string, RawHeader[]>();
  for (const header of headers) {
    const instances = byName.get(header.name);
    if (instances) instances.push(header);
    else byName.set(header.name, [header]);
  }
  const signatureHeaders = byName.get("dkim-signature") ?? [];
  if (
    headerLines > MAX_HEADER_LINES ||
    signature.signedHeaders.length > MAX_SIGNED_HEADER_NAMES ||
    signatureHeaders.length > MAX_SIGNATURES
  ) {
    return { ok: false, reason: "unsupported" };
  }
  // RFC 6376 §5.4.2 takes repeated names bottom-up, so a signature that lists
  // `from` once covers only the LOWEST From header. The sender check reads the
  // topmost one, so an unsigned From added above a signed one would otherwise
  // be believed. Require every From header in the message to be covered
  // (listing `from` twice is how a signer over-signs against exactly this).
  const signedFromCount = signature.signedHeaders.filter((name) => name === "from").length;
  const messageFromCount = byName.get("from")?.length ?? 0;
  if (signedFromCount === 0 || messageFromCount > signedFromCount) return { ok: false, reason: "from_not_signed" };
  if (signature.expires !== undefined && signature.expires * 1000 < now.getTime()) return { ok: false, reason: "expired" };
  if (!key) return { ok: false, reason: "key_missing" };
  const keyType = key.asymmetricKeyType;
  if (
    (signature.algorithm === "rsa-sha256" && keyType !== "rsa") ||
    (signature.algorithm === "ed25519-sha256" && keyType !== "ed25519")
  ) {
    return { ok: false, reason: "unsupported" };
  }
  /* `l=` is refused, not honoured. A signature over only the first N body
     bytes leaves everything after them unsigned, and in a document relay that
     is the attachments: anyone could append or swap them under a valid
     signature. Gmail and Yahoo ignore `l=` for the same reason. */
  if (signature.bodyLength !== undefined) return { ok: false, reason: "unsupported" };

  const bodyHash = (split.bodyHashes[signature.bodyCanon] ??= canonicalBodyHash(split.body, signature.bodyCanon));
  if (bodyHash !== signature.bodyHash) {
    return { ok: false, reason: "body_hash_mismatch" };
  }
  // RFC 8301 §3.2: a signature made with an RSA key under 1024 bits is never
  // valid, whatever it verifies against; such keys are factorable. Checked
  // after the body hash so a short-key message still reports a tampered body.
  if (keyType === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 1024) {
    return { ok: false, reason: "unsupported" };
  }

  const own = signatureHeaders[signature.headerIndex];
  if (!own) return { ok: false, reason: "signature_invalid" };
  const used = new Map<string, number>();
  let data = "";
  for (const name of signature.signedHeaders) {
    const instances = byName.get(name) ?? [];
    const taken = used.get(name) ?? 0;
    const instance = instances[instances.length - 1 - taken];
    used.set(name, taken + 1);
    if (instance) data += `${canonicalHeader(instance, signature.headerCanon)}\r\n`;
  }
  data += canonicalHeader(withEmptySignatureValue(own), signature.headerCanon);

  const payload = Buffer.from(data, "latin1");
  try {
    const signatureBytes = Buffer.from(signature.signature, "base64");
    // RFC 8463: Ed25519 signs the SHA-256 digest of the canonical headers, not
    // the headers themselves.
    const valid = signature.algorithm === "rsa-sha256"
      ? verify("sha256", payload, key, signatureBytes)
      : verify(null, createHash("sha256").update(payload).digest(), key, signatureBytes);
    return valid ? { ok: true, domain: signature.domain } : { ok: false, reason: "signature_invalid" };
  } catch {
    return { ok: false, reason: "signature_invalid" };
  }
}
