/**
 * Portable archive format v2 (#1390, ADR-0045), written and read by hand from
 * the byte layout in the design note, so the tests never agree with the
 * product's own writer by construction. The product's SegmentWriter is
 * checked against `openV2` here, and the product's SegmentReader is fed
 * files from `sealV2`.
 *
 * Layout: a 64-byte plaintext header (authenticated as the AAD of every
 * segment), then n = ceil(T / S) segments, each `ciphertext || 16-byte GCM
 * tag`, nonce = prefix(7) || i as u32 BE || final flag (0x01 on the last).
 * Key = scrypt(passphrase, salt, 32, { N, r, p }).
 *
 * No product import here: unit and integration tests and a memory child use it.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

export const V2_MAGIC = Buffer.from("ORBITARC", "ascii");
export const V2_HEADER_BYTES = 64;
export const V2_SEGMENT_BYTES = 1_048_576;
export const V2_TAG_BYTES = 16;
/** MAX_MANIFEST_BYTES in the note (§2.1): today's MAX_PAYLOAD_OTHER_BYTES. */
export const V2_MAX_MANIFEST_BYTES = 64 * 1_048_576;

export interface V2HeaderFields {
  magic: Buffer;
  version: number;
  kdf: number;
  log2N: number;
  r: number;
  p: number;
  salt: Buffer;
  noncePrefix: Buffer;
  segmentBytes: number;
  manifestBytes: number;
  plaintextBytes: number;
  reserved: Buffer;
}

/** The header bytes for `fields`; anything not given takes the value Orbit writes, with a fresh salt and prefix. */
export function v2Header(fields: Partial<V2HeaderFields> & { manifestBytes: number; plaintextBytes: number }): Buffer {
  const header = Buffer.alloc(V2_HEADER_BYTES);
  (fields.magic ?? V2_MAGIC).copy(header, 0, 0, 8);
  header[8] = fields.version ?? 2;
  header[9] = fields.kdf ?? 1;
  header[10] = fields.log2N ?? 14;
  header[11] = fields.r ?? 8;
  header[12] = fields.p ?? 1;
  (fields.salt ?? randomBytes(16)).copy(header, 13, 0, 16);
  (fields.noncePrefix ?? randomBytes(7)).copy(header, 29, 0, 7);
  header.writeUInt32BE(fields.segmentBytes ?? V2_SEGMENT_BYTES, 36);
  header.writeBigUInt64BE(BigInt(fields.manifestBytes), 40);
  header.writeBigUInt64BE(BigInt(fields.plaintextBytes), 48);
  (fields.reserved ?? Buffer.alloc(8)).copy(header, 56, 0, 8);
  return header;
}

export function readV2Header(file: Buffer): V2HeaderFields {
  return {
    magic: file.subarray(0, 8),
    version: file[8],
    kdf: file[9],
    log2N: file[10],
    r: file[11],
    p: file[12],
    salt: file.subarray(13, 29),
    noncePrefix: file.subarray(29, 36),
    segmentBytes: file.readUInt32BE(36),
    manifestBytes: Number(file.readBigUInt64BE(40)),
    plaintextBytes: Number(file.readBigUInt64BE(48)),
    reserved: file.subarray(56, 64),
  };
}

export function v2Nonce(prefix: Buffer, index: number, final: boolean): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0, 0, 7);
  nonce.writeUInt32BE(index, 7);
  nonce[11] = final ? 0x01 : 0x00;
  return nonce;
}

export function v2Key(passphrase: string, salt: Buffer, log2N = 14, r = 8, p = 1): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 2 ** log2N, r, p, maxmem: 64 * 1_048_576 });
}

export const segmentCount = (plaintextBytes: number, segmentBytes = V2_SEGMENT_BYTES) => Math.ceil(plaintextBytes / segmentBytes);

/** The size of a v2 file holding `plaintextBytes`: 64 + T + 16 n. */
export const v2FileBytes = (plaintextBytes: number) => V2_HEADER_BYTES + plaintextBytes + V2_TAG_BYTES * segmentCount(plaintextBytes);

/** Where segment `index` starts and ends in a file (tag included). */
export function segmentRange(plaintextBytes: number, index: number): { start: number; end: number } {
  const n = segmentCount(plaintextBytes);
  const start = V2_HEADER_BYTES + index * (V2_SEGMENT_BYTES + V2_TAG_BYTES);
  const length = index === n - 1 ? plaintextBytes - index * V2_SEGMENT_BYTES + V2_TAG_BYTES : V2_SEGMENT_BYTES + V2_TAG_BYTES;
  return { start, end: start + length };
}

/**
 * A v2 file sealed by hand. `manifestBytes` defaults to the whole plaintext.
 * `header` overrides header fields (the overridden header is still the AAD,
 * so a file with a tampered-but-consistent header still authenticates).
 */
export function sealV2(
  plaintext: Buffer,
  passphrase: string,
  options: { manifestBytes?: number; header?: Partial<V2HeaderFields> } = {},
): Buffer {
  const salt = options.header?.salt ?? randomBytes(16);
  const noncePrefix = options.header?.noncePrefix ?? randomBytes(7);
  const header = v2Header({
    ...options.header,
    salt,
    noncePrefix,
    manifestBytes: options.manifestBytes ?? plaintext.length,
    plaintextBytes: options.header?.plaintextBytes ?? plaintext.length,
  });
  const key = v2Key(passphrase, salt, options.header?.log2N ?? 14, options.header?.r ?? 8, options.header?.p ?? 1);
  const n = segmentCount(plaintext.length);
  const parts: Buffer[] = [header];
  for (let index = 0; index < n; index += 1) {
    const cipher = createCipheriv("aes-256-gcm", key, v2Nonce(noncePrefix, index, index === n - 1));
    cipher.setAAD(header);
    parts.push(cipher.update(plaintext.subarray(index * V2_SEGMENT_BYTES, (index + 1) * V2_SEGMENT_BYTES)), cipher.final(), cipher.getAuthTag());
  }
  key.fill(0);
  return Buffer.concat(parts);
}

/** The whole plaintext of a v2 file, opened by hand; throws on any fault. */
export function openV2(file: Buffer, passphrase: string): Buffer {
  const header = readV2Header(file);
  const key = v2Key(passphrase, header.salt, header.log2N, header.r, header.p);
  const n = segmentCount(header.plaintextBytes, header.segmentBytes);
  const parts: Buffer[] = [];
  for (let index = 0; index < n; index += 1) {
    const { start, end } = segmentRange(header.plaintextBytes, index);
    const decipher = createDecipheriv("aes-256-gcm", key, v2Nonce(header.noncePrefix, index, index === n - 1), { authTagLength: V2_TAG_BYTES });
    decipher.setAAD(file.subarray(0, V2_HEADER_BYTES));
    decipher.setAuthTag(file.subarray(end - V2_TAG_BYTES, end));
    parts.push(decipher.update(file.subarray(start, end - V2_TAG_BYTES)), decipher.final());
  }
  if (V2_HEADER_BYTES + header.plaintextBytes + V2_TAG_BYTES * n !== file.length) throw new Error("trailing or missing bytes");
  return Buffer.concat(parts);
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface V2Body { id: string; bytes: Buffer }

/**
 * A v2 archive file for a manifest (the v1 payload fields, version 2) and the
 * documents whose bytes follow. `body[]` is derived from `bodies` unless the
 * manifest already carries one; the plaintext is the manifest's JSON
 * followed by each body's raw bytes, unframed.
 */
export function v2Archive(
  manifest: Record<string, unknown>,
  bodies: V2Body[],
  passphrase: string,
  options: { plaintextBytes?: number; trailing?: Buffer } = {},
): { file: Buffer; manifestBytes: number; plaintextBytes: number } {
  const withBody = "body" in manifest
    ? manifest
    : { ...manifest, body: bodies.map((body) => ({ id: body.id, sizeBytes: body.bytes.length, contentSha256: sha256(body.bytes) })) };
  const manifestText = Buffer.from(JSON.stringify(withBody), "utf8");
  const plaintext = Buffer.concat([manifestText, ...bodies.map((body) => body.bytes), options.trailing ?? Buffer.alloc(0)]);
  const plaintextBytes = options.plaintextBytes ?? plaintext.length;
  return {
    file: sealV2(plaintext, passphrase, { manifestBytes: manifestText.length, header: { plaintextBytes } }),
    manifestBytes: manifestText.length,
    plaintextBytes,
  };
}

/** The bytes a preview posts for a v2 file (§2.3): the header and the segments holding the manifest, capped at the file. */
export function v2HeadSliceBytes(file: Buffer): number {
  const header = readV2Header(file);
  return Math.min(file.length, V2_HEADER_BYTES + Math.ceil(header.manifestBytes / V2_SEGMENT_BYTES) * (V2_SEGMENT_BYTES + V2_TAG_BYTES));
}

// ---------------------------------------------------------------------------
// The engine API the design note's §3 names, typed here so the tests compile
// before it exists. Loaded at run time, so a test fails on the missing module
// or export rather than the type check failing the whole suite.

export interface SegmentReaderApi {
  readonly header: unknown;
  take(bytes: number): ReadableStream<Uint8Array>;
  finish(): Promise<void>;
}

export interface ContainerApi {
  SegmentReader: { open(source: ReadableStream<Uint8Array>, passphrase: string, ceiling: number): Promise<SegmentReaderApi> };
  SegmentWriter: new (header: Buffer, key: Buffer, write: (chunk: Uint8Array) => Promise<void>) => {
    push(plaintext: Uint8Array): Promise<void>;
    finish(): Promise<void>;
  };
  deriveArchiveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer>;
}

/** src/server/portable-archive-container.ts (§3), or a clear error naming it while it is not built. */
export async function loadContainer(): Promise<ContainerApi> {
  const path = new URL("../../src/server/portable-archive-container.ts", import.meta.url).href;
  try {
    return (await import(/* @vite-ignore */ path)) as ContainerApi;
  } catch (error) {
    throw new Error(`src/server/portable-archive-container.ts is not built yet (#1390): ${String(error)}`);
  }
}

/** The additions §3 makes to src/server/portable-archive-limits.ts. */
export interface LimitsV2 {
  MAX_MANIFEST_BYTES: number;
  SEGMENT_BYTES: number;
  maxArchiveFileBytes(config: { householdQuotaBytes: number }): number;
  V1_MAX_ARCHIVE_FILE_BYTES: number;
  V1_MAX_ARCHIVE_BYTES: number;
}

/**
 * A v2 export opened by hand into the shape the v1 tests read (#1390): the
 * manifest's fields, plus `documentBytes` rebuilt from the bodies that follow
 * it, so a test written against v1's payload checks the same content.
 */
export function v2PayloadOf(file: Buffer, passphrase: string): Record<string, unknown> & { documentBytes: Array<{ id: string; contentBase64: string }> } {
  const header = readV2Header(file);
  const plaintext = openV2(file, passphrase);
  const manifest = JSON.parse(plaintext.subarray(0, header.manifestBytes).toString("utf8")) as Record<string, unknown> & { body?: Array<{ id: string; sizeBytes: number }> };
  const documentBytes: Array<{ id: string; contentBase64: string }> = [];
  let offset = header.manifestBytes;
  for (const entry of manifest.body ?? []) {
    documentBytes.push({ id: entry.id, contentBase64: plaintext.subarray(offset, offset + entry.sizeBytes).toString("base64") });
    offset += entry.sizeBytes;
  }
  return { ...manifest, documentBytes };
}
