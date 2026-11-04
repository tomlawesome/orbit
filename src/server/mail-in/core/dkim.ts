/**
 * mail-in/core boundary: pure logic only. This module imports `node:crypto`
 * and nothing else — no DNS, no database, no IMAP client. The key a signature
 * is checked against is handed in by the caller (`../dkim-lookup.ts` fetches
 * it), so everything here is a function of its arguments.
 *
 * DKIM verification (RFC 6376), for one purpose: a member forwarding from the
 * same server that hosts the relay mailbox is SUBMITTING, not delivering, so
 * that server writes no `Authentication-Results` verdict about it. The
 * message's own signature, checked against the sending domain's published
 * key, is the proof that is left (orbit#1655).
 *
 * A verified signature proves only that a holder of the domain's private key
 * signed these headers and this body. Callers must therefore read the signing
 * domain, not any header the message claims for itself, and must align it with
 * the `From` domain exactly as they would a provider's `dkim=pass`.
 *
 * Everything here FAILS CLOSED and never throws on hostile input: a signature
 * that cannot be parsed is skipped, and a check that cannot be completed
 * answers `ok: false`.
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

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
/** Bounds on what one verification will chew through; past them: "unsupported". */
const MAX_HEADER_LINES = 1_000;
const MAX_SIGNED_HEADER_NAMES = 50;

type RawHeader = { name: string; raw: string };

type SplitMessage = { headers: RawHeader[]; body: string; headerLines: number };

/*
 * Everything below works on latin1 strings: one character per byte, so `l=`
 * counts bytes, hashes see the original bytes, and no UTF-8 decoding can
 * change what was signed.
 */

/** Bare LF becomes CRLF. IMAP hands us CRLF; fixtures and other sources may not. */
function normaliseLineEndings(rawMessage: Buffer): string {
  return rawMessage.toString("latin1").replace(/\r?\n/gu, "\r\n");
}

function splitMessage(rawMessage: Buffer): SplitMessage {
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
  for (const line of headerText.split("\r\n")) {
    if (line.length === 0) continue;
    headerLines += 1;
    if (/^[ \t]/u.test(line)) {
      const previous = headers[headers.length - 1];
      if (previous) previous.raw += `\r\n${line}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.push({ name: line.slice(0, colon).trim().toLowerCase(), raw: line });
  }
  return { headers, body, headerLines };
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
 * `text` without its trailing CRLFs. A backwards scan: a regex such as
 * `(\r\n)+$` retries from every CRLF in a long run and is quadratic, and the
 * body here can be tens of megabytes.
 */
function withoutTrailingCrlf(text: string): string {
  let end = text.length;
  while (end >= 2 && text.charCodeAt(end - 1) === 10 && text.charCodeAt(end - 2) === 13) end -= 2;
  return text.slice(0, end);
}

/** RFC 6376 §3.4.3 and §3.4.4, on a CRLF-normalised body. */
function canonicalBody(body: string, canon: DkimCanon): string {
  if (canon === "simple") return `${withoutTrailingCrlf(body)}\r\n`;
  const lines = body.split("\r\n").map((line) => {
    const collapsed = line.replace(/[ \t]+/gu, " ");
    return collapsed.endsWith(" ") ? collapsed.slice(0, -1) : collapsed;
  });
  const trimmed = withoutTrailingCrlf(lines.join("\r\n"));
  return trimmed.length === 0 ? "" : `${trimmed}\r\n`;
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
 * Body hashes already computed for one message, keyed by body
 * canonicalization (#1670 G-A2). `l=` is refused and sha256 is the only body
 * hash, so the canonicalization is the whole of what makes two signatures'
 * body hashes differ. Hand one fresh cache per message, never across messages.
 */
export type DkimBodyHashCache = Map<DkimCanon, string>;

/**
 * Checks one parsed signature against the key for its selector and domain.
 *
 * Order: size bounds, the `From` header is signed, the signature has not
 * expired, there is a key of the right type, no `l=`, the body hash matches,
 * and only then the signature over the headers. `now` is injectable so tests need no clock.
 * `bodyHashes`, when given, keeps each body hash so the next signature on the
 * same message with the same canonicalization does not hash the body again.
 */
export function verifyDkimSignature(
  rawMessage: Buffer,
  signature: DkimSignature,
  key: KeyObject | undefined,
  now: Date = new Date(),
  bodyHashes?: DkimBodyHashCache,
): DkimVerifyResult {
  const { headers, body, headerLines } = splitMessage(rawMessage);
  /* Work is bounded by the header count, the names in h= and the number of
     signatures, because the message can be tens of megabytes of attacker text. */
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

  let computedBodyHash = bodyHashes?.get(signature.bodyCanon);
  if (computedBodyHash === undefined) {
    computedBodyHash = createHash("sha256").update(Buffer.from(canonicalBody(body, signature.bodyCanon), "latin1")).digest("base64");
    bodyHashes?.set(signature.bodyCanon, computedBodyHash);
  }
  if (computedBodyHash !== signature.bodyHash) {
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
