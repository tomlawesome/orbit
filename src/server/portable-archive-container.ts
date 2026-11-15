import { createCipheriv, createDecipheriv, scrypt } from "node:crypto";
import { AppError } from "@/lib/app-error";
import type { ByteSource } from "@/server/portable-archive-payload";
import { MAX_MANIFEST_BYTES, SEGMENT_BYTES } from "@/server/portable-archive-limits";

/**
 * Portable archive format v2 (#1390, ADR-0045): the STREAM online
 * authenticated-encryption construction over AES-256-GCM, as Google Tink's
 * AES-GCM-HKDF-STREAMING and `age` instantiate it. Crypto only; no database.
 *
 * A 64-byte plaintext header, authenticated as the associated data of every
 * segment, then n = ceil(T / S) segments, each `ciphertext || 16-byte tag`,
 * an independent AES-256-GCM message under
 * nonce = prefix(7) || segment index (u32 BE) || final flag (0x01 on the last).
 *
 *   0   8  magic "ORBITARC"        36  4  segment bytes S (u32 BE)
 *   8   1  version 2               40  8  manifest bytes M (u64 BE)
 *   9   1  kdf 1 (scrypt)          48  8  plaintext bytes T (u64 BE)
 *   10  3  scrypt log2 N, r, p     56  8  reserved (zero; ignored on read)
 *   13 16  salt
 *   29  7  nonce prefix
 *
 * The counter in the nonce refuses reordering and substitution, the final
 * flag refuses truncation, and T lets the reader know which segment is final
 * without look-ahead. Nothing from a segment leaves the reader until its own
 * tag has verified.
 */

export const ARCHIVE_MAGIC = Buffer.from("ORBITARC", "ascii");
export const ARCHIVE_VERSION = 2;
export const HEADER_BYTES = 64;
export { SEGMENT_BYTES };
const TAG_BYTES = 16;
const KDF_SCRYPT = 1;
const SALT_BYTES = 16;
const PREFIX_BYTES = 7;
const MAX_LOG2_N = 20;
const MAX_R = 8;
/**
 * The cap on scrypt's p (#1390 review, ruling 5). Orbit's export writes p=5
 * (N=2^14, r=8: OWASP's listed equivalent of N=2^17, r=8, p=1, at 16 MiB of
 * memory); earlier v2 exports wrote p=1. Every value up to the one Orbit
 * writes is accepted, nothing above it: p multiplies the work, so a crafted
 * header can ask for at most what Orbit's own files cost, times the memory
 * bound's headroom on N·r.
 */
const MAX_P = 5;
/** The segment counter is a u32; index 2^32 - 1 is refused rather than reached. */
const MAX_SEGMENTS = 0xffff_ffff;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export interface ScryptParams { N: number; r: number; p: number }

export interface ArchiveHeader {
  log2N: number;
  r: number;
  p: number;
  salt: Buffer;
  noncePrefix: Buffer;
  segmentBytes: number;
  manifestBytes: number;
  plaintextBytes: number;
}

/**
 * An archive whose documents would take the household past its storage limit
 * (#1799): the header's own size check and the restore's quota check give the
 * same answer, which names the way out.
 */
export function householdOverQuotaError(): AppError {
  return new AppError("archive_over_quota", "This archive's documents would take the household past its storage limit. An administrator can raise the household storage limit, or remove some documents where the archive was made and export it again.", 413);
}

export function archiveInvalid(): AppError {
  return new AppError("archive_invalid", "That export is not a supported Orbit archive", 422);
}

/**
 * A header whose scrypt cost the key derivation would refuse or that would
 * run far past Orbit's own (#1390 review, ruling 5): the client's file, not
 * the server, is at fault, so it is a 400, never a 500 from inside scrypt.
 */
function archiveCostInvalid(): AppError {
  return new AppError("archive_invalid", "That export is not a supported Orbit archive", 400);
}

export function archivePassphraseInvalid(): AppError {
  return new AppError("archive_passphrase_invalid", "The passphrase or archive is invalid", 422);
}

/** The 64 header bytes for `header`, reserved bytes zero. */
export function encodeHeader(header: ArchiveHeader): Buffer {
  if (header.salt.length !== SALT_BYTES || header.noncePrefix.length !== PREFIX_BYTES) throw new Error("Portable archive salt or nonce prefix has the wrong length");
  const bytes = Buffer.alloc(HEADER_BYTES);
  ARCHIVE_MAGIC.copy(bytes, 0);
  bytes[8] = ARCHIVE_VERSION;
  bytes[9] = KDF_SCRYPT;
  bytes[10] = header.log2N;
  bytes[11] = header.r;
  bytes[12] = header.p;
  header.salt.copy(bytes, 13);
  header.noncePrefix.copy(bytes, 29);
  bytes.writeUInt32BE(header.segmentBytes, 36);
  bytes.writeBigUInt64BE(BigInt(header.manifestBytes), 40);
  bytes.writeBigUInt64BE(BigInt(header.plaintextBytes), 48);
  return bytes;
}

/**
 * The header, bounds-checked before any key derivation (#1605 W-Q1 for v2):
 * anything but this release's values, or lengths out of bounds, is
 * `archive_invalid`. `ceiling` bounds T; over it is `archive_over_quota`.
 */
export function decodeHeader(bytes: Uint8Array, ceiling: number): ArchiveHeader {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.length !== HEADER_BYTES || !view.subarray(0, 8).equals(ARCHIVE_MAGIC)) throw archiveInvalid();
  if (view[8] !== ARCHIVE_VERSION || view[9] !== KDF_SCRYPT) throw archiveInvalid();
  const log2N = view[10];
  const r = view[11];
  const p = view[12];
  if (log2N < 1 || log2N > MAX_LOG2_N || r < 1 || r > MAX_R || p < 1) throw archiveInvalid();
  // What scrypt itself would refuse, or what would run for minutes (p over
  // its cap), refused from the header. The memory is OpenSSL's own count,
  // 128·r·(N + 2) for V plus 128·r·p for B (#1390 second review, F2).
  if (scryptMemoryBytes(2 ** log2N, r, p) > SCRYPT_MAXMEM || p > MAX_P) throw archiveCostInvalid();
  const segmentBytes = view.readUInt32BE(36);
  if (segmentBytes !== SEGMENT_BYTES) throw archiveInvalid();
  const manifest = view.readBigUInt64BE(40);
  const plaintext = view.readBigUInt64BE(48);
  if (plaintext === 0n || manifest > plaintext || manifest > BigInt(MAX_MANIFEST_BYTES)) throw archiveInvalid();
  if (plaintext > BigInt(Number.MAX_SAFE_INTEGER)) throw archiveInvalid();
  // Over the install's ceiling is a size answer, not a format one (#1799): an
  // honest archive made where the limit is higher meets it here first.
  if (Number(plaintext) > ceiling) throw householdOverQuotaError();
  const plaintextBytes = Number(plaintext);
  if (Math.ceil(plaintextBytes / segmentBytes) > MAX_SEGMENTS) throw archiveInvalid();
  return {
    log2N, r, p,
    salt: Buffer.from(view.subarray(13, 29)),
    noncePrefix: Buffer.from(view.subarray(29, 36)),
    segmentBytes,
    manifestBytes: Number(manifest),
    plaintextBytes,
  };
}

/** The number of segments a plaintext of `plaintextBytes` takes. */
export function segmentCount(plaintextBytes: number, segmentBytes = SEGMENT_BYTES): number {
  return Math.ceil(plaintextBytes / segmentBytes);
}

/**
 * The archive key, scrypt of the passphrase, on the libuv threadpool so the
 * event loop keeps running while it is derived (#1605 SEC-D3/1). The caller
 * zeroes it once done.
 */
export function deriveArchiveKey(passphrase: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Parameters scrypt will not take are the file's fault, not Orbit's: a
    // 400, whether Node says so at once (it throws) or in the callback.
    const refused = (error: unknown) => (error as { code?: unknown } | null)?.code === "ERR_CRYPTO_INVALID_SCRYPT_PARAMS" ? archiveCostInvalid() : error;
    try {
      scrypt(passphrase, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM }, (error, key) => {
        if (error) reject(refused(error));
        else resolve(key);
      });
    } catch (error) {
      reject(refused(error));
    }
  });
}

/** The memory OpenSSL's scrypt counts against maxmem: V, 128·r·(N + 2), and B, 128·r·p. */
function scryptMemoryBytes(N: number, r: number, p: number): number {
  return 128 * r * (N + 2 + p);
}

function nonceFor(prefix: Buffer, index: number, final: boolean): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0, 0, PREFIX_BYTES);
  nonce.writeUInt32BE(index, PREFIX_BYTES);
  nonce[11] = final ? 0x01 : 0x00;
  return nonce;
}

/**
 * Seals the plaintext stream under `key` into segments, written through
 * `write` (which resolves once they are stored: backpressure). It does not
 * write the header; the caller writes `header` first. The header fixes T, so
 * the writer knows its final segment and refuses more or fewer bytes.
 */
export class SegmentWriter {
  private readonly header: Buffer;
  private readonly prefix: Buffer;
  private readonly segmentBytes: number;
  private readonly plaintextBytes: number;
  private readonly pending: Buffer;
  private filled = 0;
  /** Plaintext bytes already sealed into written segments. */
  private sealed = 0;
  private index = 0;
  private finished = false;

  constructor(header: Uint8Array, private readonly key: Buffer, private readonly write: (chunk: Buffer) => Promise<void>) {
    const decoded = decodeHeader(header, Number.MAX_SAFE_INTEGER);
    this.header = Buffer.from(header);
    this.prefix = decoded.noncePrefix;
    this.segmentBytes = decoded.segmentBytes;
    this.plaintextBytes = decoded.plaintextBytes;
    this.pending = Buffer.alloc(this.segmentBytes);
  }

  /**
   * Takes the next piece of the plaintext; writes every segment it completes.
   * If it throws (a failed write, too many bytes), the parked plaintext is
   * zeroed first (#1390 review, ruling 7) and the writer is of no further use.
   */
  async push(plaintext: Uint8Array): Promise<void> {
    try {
      let offset = 0;
      while (offset < plaintext.length) {
        if (this.finished || this.sealed + this.filled >= this.plaintextBytes) throw new Error("Portable archive plaintext is longer than its header says");
        const room = Math.min(this.segmentBytes - this.filled, this.plaintextBytes - this.sealed - this.filled);
        const count = Math.min(room, plaintext.length - offset);
        this.pending.set(plaintext.subarray(offset, offset + count), this.filled);
        this.filled += count;
        offset += count;
        if (this.filled === this.segmentBytes || this.sealed + this.filled === this.plaintextBytes) await this.seal();
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /**
   * Zeroes the parked plaintext. For a caller that stops before `finish`
   * (a document that failed its check): the writer is of no further use.
   * Safe to call more than once.
   */
  dispose(): void {
    this.pending.fill(0);
    this.filled = 0;
    this.finished = true;
  }

  private async seal(): Promise<void> {
    const final = this.sealed + this.filled === this.plaintextBytes;
    const cipher = createCipheriv("aes-256-gcm", this.key, nonceFor(this.prefix, this.index, final), { authTagLength: TAG_BYTES });
    cipher.setAAD(this.header);
    // Written as the ciphertext and then its 16-byte ending, not joined: a
    // joined copy would be another megabyte of garbage per segment, and V8
    // frees such buffers only when a collection finds them dead, so
    // per-segment copies are what peak memory is.
    const ciphertext = cipher.update(this.pending.subarray(0, this.filled));
    const ending = Buffer.concat([cipher.final(), cipher.getAuthTag()]);
    const count = this.filled;
    this.sealed += count;
    this.filled = 0;
    this.index += 1;
    if (final) this.finished = true;
    await this.write(ciphertext);
    await this.write(ending);
    // Sealed and stored: the plaintext is not needed again, so it does not
    // wait in `pending` for the next segment to overwrite it. A write that
    // throws leaves it to push, which zeroes it all.
    this.pending.fill(0, 0, count);
  }

  /** Throws unless exactly T bytes were pushed (the final segment is then already written). */
  async finish(): Promise<void> {
    if (!this.finished || this.sealed !== this.plaintextBytes) {
      this.pending.fill(0);
      throw new Error("Portable archive plaintext is shorter than its header says");
    }
  }
}

/**
 * Opens a v2 archive as it is uploaded and hands on its plaintext a verified
 * segment at a time (#1390). `take(n)` streams the next n plaintext bytes (a
 * document body); `source()` reads them as a ByteSource (the manifest). The
 * consumer's reads pull the upload (backpressure). A segment whose tag fails
 * is `archive_passphrase_invalid`; a missing, short or surplus byte is
 * `archive_invalid`; nothing of a failing segment, or after it, is handed on.
 * An error of the upload itself (a 408 cut, a client gone) passes through as
 * it is.
 */
export class SegmentReader {
  private input: Uint8Array = new Uint8Array(0);
  private inputEnded = false;
  /** The current segment's verified plaintext, and how much of it is handed on. */
  private plain: Buffer = Buffer.alloc(0);
  private plainOffset = 0;
  private index = 0;
  /** Plaintext bytes handed on. */
  private delivered = 0;
  private failure: unknown = null;
  private released = false;
  private readonly segments: number;
  /** One sealed segment, reused: the upload's pieces are gathered here when a segment spans them. */
  private readonly gather: Buffer;

  private constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    readonly header: ArchiveHeader,
    private readonly headerBytes: Buffer,
    private readonly key: Buffer,
    leftover: Uint8Array,
  ) {
    this.input = leftover;
    this.segments = segmentCount(header.plaintextBytes, header.segmentBytes);
    this.gather = Buffer.alloc(header.segmentBytes + TAG_BYTES);
  }

  /**
   * Reads and checks the header (before any key derivation), then derives the
   * key. `ceiling` bounds T. The stream is held until `close`.
   */
  static async open(source: ReadableStream<Uint8Array>, passphrase: string, ceiling: number): Promise<SegmentReader> {
    const reader = source.getReader();
    try {
      const parts: Uint8Array[] = [];
      let have = 0;
      while (have < HEADER_BYTES) {
        const { done, value } = await reader.read();
        if (done) throw archiveInvalid();
        parts.push(value);
        have += value.length;
      }
      const joined = Buffer.concat(parts);
      const headerBytes = Buffer.from(joined.subarray(0, HEADER_BYTES));
      const header = decodeHeader(headerBytes, ceiling);
      const key = await deriveArchiveKey(passphrase, header.salt, { N: 2 ** header.log2N, r: header.r, p: header.p });
      return new SegmentReader(reader, header, headerBytes, key, joined.subarray(HEADER_BYTES));
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
  }

  /** Plaintext bytes handed on so far. */
  get position(): number {
    return this.delivered;
  }

  /** Whether every plaintext byte has been handed on. */
  get complete(): boolean {
    return this.delivered === this.header.plaintextBytes;
  }

  /**
   * Exactly `count` (at most one sealed segment) more bytes of the upload, or
   * `archive_invalid` if it ends first. The bytes are valid until the next
   * pull: a view of the upload's own piece when one holds them all, else the
   * reused gather buffer, so no segment-sized copy is made per segment.
   */
  private async pull(count: number): Promise<Buffer> {
    let have = 0;
    while (have < count) {
      if (this.input.length === 0) {
        if (this.inputEnded) throw archiveInvalid();
        const { done, value } = await this.reader.read();
        if (done) { this.inputEnded = true; throw archiveInvalid(); }
        this.input = value;
        continue;
      }
      const take = Math.min(this.input.length, count - have);
      if (have === 0 && take === count) {
        const whole = Buffer.from(this.input.buffer, this.input.byteOffset, count);
        this.input = this.input.subarray(count);
        return whole;
      }
      this.gather.set(this.input.subarray(0, take), have);
      this.input = this.input.subarray(take);
      have += take;
    }
    return this.gather.subarray(0, count);
  }

  /** Whether the upload has no byte after the final segment. */
  private async atEnd(): Promise<boolean> {
    for (;;) {
      if (this.input.length > 0) return false;
      if (this.inputEnded) return true;
      const { done, value } = await this.reader.read();
      if (done) { this.inputEnded = true; return true; }
      this.input = value;
    }
  }

  /** Reads, verifies and holds the next segment; checks the file ends after the final one. */
  private async nextSegment(): Promise<void> {
    if (this.index >= this.segments) throw archiveInvalid();
    const final = this.index === this.segments - 1;
    const length = final ? this.header.plaintextBytes - this.index * this.header.segmentBytes : this.header.segmentBytes;
    const sealed = await this.pull(length + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonceFor(this.header.noncePrefix, this.index, final), { authTagLength: TAG_BYTES });
    decipher.setAAD(this.headerBytes);
    decipher.setAuthTag(sealed.subarray(length));
    let plain: Buffer;
    try {
      const head = decipher.update(sealed.subarray(0, length));
      // The verdict: nothing of this segment is handed on unless it passes.
      const tail = decipher.final();
      plain = tail.length === 0 ? head : Buffer.concat([head, tail]);
    } catch {
      throw archivePassphraseInvalid();
    }
    // Any byte after the final segment refuses the archive before the final segment is used.
    if (final && !(await this.atEnd())) {
      plain.fill(0);
      throw archiveInvalid();
    }
    // The pieces handed on are views of the segment, valid until the
    // consumer's next pull (take's contract); takes are sequential and
    // pull-based, so every piece of the old segment has been consumed by now.
    this.plain.fill(0);
    this.plain = plain;
    this.plainOffset = 0;
    this.index += 1;
  }

  /**
   * Up to `max` verified bytes, at least one unless the plaintext is used up
   * (then null). A view of the verified segment, valid until the next read.
   */
  private async readPlain(max: number): Promise<Buffer | null> {
    if (this.failure !== null) throw this.failure;
    if (this.delivered >= this.header.plaintextBytes || max <= 0) return null;
    try {
      if (this.plainOffset >= this.plain.length) await this.nextSegment();
    } catch (error) {
      this.failure = error;
      this.plain.fill(0);
      throw error;
    }
    const count = Math.min(max, this.plain.length - this.plainOffset);
    const piece = this.plain.subarray(this.plainOffset, this.plainOffset + count);
    this.plainOffset += count;
    this.delivered += count;
    return piece;
  }

  /**
   * The next `count` plaintext bytes as a stream, pulled on demand. Takes run
   * one after another: start the next only once this one has ended. A take
   * past T is `archive_invalid`. Each piece is a view of the verified segment,
   * valid only until the consumer's next pull: the segment is zeroed when the
   * next one replaces it, on failure and at `finish`/`close`. A consumer that
   * keeps bytes past its next pull copies them.
   */
  take(count: number): ReadableStream<Uint8Array> {
    let remaining = count;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (remaining === 0) { controller.close(); return; }
        try {
          const piece = await this.readPlain(Math.min(remaining, 65_536));
          if (piece === null) throw archiveInvalid();
          remaining -= piece.length;
          controller.enqueue(new Uint8Array(piece.buffer, piece.byteOffset, piece.byteLength));
          if (remaining === 0) controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    }, { highWaterMark: 0 });
  }

  /** The plaintext from here on as a ByteSource; the caller bounds how far it reads. */
  source(): ByteSource {
    return {
      read: async (buffer) => {
        const piece = await this.readPlain(buffer.length);
        if (piece === null) return 0;
        piece.copy(buffer);
        return piece.length;
      },
    };
  }

  /**
   * Throws unless every plaintext byte was handed on (and so the final
   * segment verified and nothing followed it); then lets go of the upload.
   */
  async finish(): Promise<void> {
    if (this.failure !== null) throw this.failure;
    if (!this.complete || !(await this.atEnd())) {
      await this.close();
      throw archiveInvalid();
    }
    await this.close();
  }

  /**
   * Zeroes the key and the held segment, and lets go of the upload: released when it was read to
   * its end, else cancelled (the caller reads the rest of the body away).
   * Safe to call more than once.
   */
  async close(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.key.fill(0);
    this.gather.fill(0);
    this.plain.fill(0);
    if (this.inputEnded) this.reader.releaseLock();
    else await this.reader.cancel().catch(() => undefined);
  }
}
