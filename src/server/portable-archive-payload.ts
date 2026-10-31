import { randomUUID } from "node:crypto";
import { open, readdir, rm, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log, operationalDetail } from "@/lib/logger";

/**
 * Reading an archive's decrypted payload from a file rather than from memory
 * (#1521), as the export writes it (#1506). The payload is decrypted into a
 * private temporary file, its authentication tag is verified, and only then
 * is the file read here: piece by piece, every value but a document's base64
 * materialised as `JSON.parse` would, and each document's base64 left in the
 * file, located by a `Base64Text`, to be streamed into document storage.
 *
 * The same reader reads the archive file's envelope as it is uploaded
 * (#1566): every field but `ciphertext` materialised, and the ciphertext's
 * base64 checked and handed on in pieces as it arrives (`readEnvelope`), to
 * be decoded, decrypted and written to the scratch file, never held.
 */

const SCRATCH_PREFIX = "orbit-archive-import-";

/**
 * Where payload files go. docker-compose.yml points ORBIT_ARCHIVE_SCRATCH_DIR
 * at a small tmpfs, so a decrypted archive never lands on the host's disk and
 * cannot fill it; outside a container it is the process temporary directory.
 */
function scratchDirectory(): string {
  return process.env.ORBIT_ARCHIVE_SCRATCH_DIR || tmpdir();
}
/** Bytes read from the file per piece while reading the payload's JSON. */
const READ_PIECE_BYTES = 64 * 1024;
/** Base64 characters decoded per piece of a document: a multiple of 4, so each piece decodes on its own. */
const BASE64_PIECE_CHARACTERS = 4 * 65_536;
/** Far deeper than any archive Orbit writes (4); bounds the reader's recursion. */
const MAX_DEPTH = 64;

/** Where a document's base64 sits in the payload file, and how many bytes it decodes to. */
export class Base64Text {
  constructor(readonly offset: number, readonly length: number, readonly decodedBytes: number) {}
}

/** The payload is not well-formed JSON, or a document's base64 is not base64. */
export class PayloadSyntaxError extends Error {
  constructor() { super("The archive payload is not well-formed"); }
}

/** Bytes read in order: `read` fills `buffer` from its start as far as it can, and returns 0 at the end. */
export interface ByteSource {
  read(buffer: Buffer): Promise<number>;
}

/** A stream as a sequential source; a chunk longer than the buffer is handed out over several reads. */
export function streamSource(reader: ReadableStreamDefaultReader<Uint8Array>): ByteSource {
  let pending: Uint8Array = new Uint8Array(0);
  return {
    async read(buffer) {
      while (pending.length === 0) {
        const { done, value } = await reader.read();
        if (done) return 0;
        pending = value;
      }
      const count = Math.min(buffer.length, pending.length);
      buffer.set(pending.subarray(0, count));
      pending = pending.subarray(count);
      return count;
    },
  };
}

/**
 * Base64 characters decoded as they arrive, in pieces of any length: whole
 * 4-character groups are decoded at once and the rest carried to the next
 * piece, so the pieces decode to exactly the bytes decoding the whole would.
 * Both alphabets are accepted, as `Buffer.from(text, "base64")` accepts them.
 */
export class Base64Decoder {
  private carry: Buffer = Buffer.alloc(0);

  push(characters: Buffer): Buffer {
    const joined = this.carry.length === 0 ? characters : Buffer.concat([this.carry, characters]);
    const aligned = joined.length - (joined.length % 4);
    this.carry = Buffer.from(joined.subarray(aligned));
    return Buffer.from(joined.toString("latin1", 0, aligned), "base64");
  }

  /** The bytes of whatever was carried, at the end of the text. */
  end(): Buffer {
    const rest = this.carry;
    this.carry = Buffer.alloc(0);
    return Buffer.from(rest.toString("latin1"), "base64");
  }
}

/**
 * The private temporary file (0600) one archive's decrypted payload goes to.
 * The caller removes it with `dispose` on every path; a file left by a
 * process killed before that is removed by `sweepPayloadScratch`.
 */
export class PayloadScratch {
  private written = 0;

  private constructor(private readonly path: string, private readonly handle: FileHandle) {}

  static async create(): Promise<PayloadScratch> {
    const path = join(scratchDirectory(), `${SCRATCH_PREFIX}${randomUUID()}.tmp`);
    return new PayloadScratch(path, await open(path, "wx+", 0o600));
  }

  get sizeBytes(): number {
    return this.written;
  }

  async append(chunk: Buffer): Promise<void> {
    let offset = 0;
    while (offset < chunk.length) {
      const { bytesWritten } = await this.handle.write(chunk, offset, chunk.length - offset, this.written + offset);
      offset += bytesWritten;
    }
    this.written += chunk.length;
  }

  /** Fills `buffer` from `position` as far as the file allows; returns the bytes read. */
  async readAt(buffer: Buffer, position: number): Promise<number> {
    let filled = 0;
    while (filled < buffer.length && position + filled < this.written) {
      const { bytesRead } = await this.handle.read(buffer, filled, buffer.length - filled, position + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return filled;
  }

  /** The file from its start, as the sequential source the payload reader reads. */
  source(): ByteSource {
    let position = 0;
    return {
      read: async (buffer) => {
        const read = await this.readAt(buffer, position);
        position += read;
        return read;
      },
    };
  }

  /** One document's bytes, decoded from its base64 in the file a piece at a time. */
  documentBody(text: Base64Text): ReadableStream<Uint8Array> {
    let position = text.offset;
    const end = text.offset + text.length;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (position < end) {
          const encoded = Buffer.alloc(Math.min(BASE64_PIECE_CHARACTERS, end - position));
          if (await this.readAt(encoded, position) !== encoded.length) throw new Error("The archive payload file ended early");
          position += encoded.length;
          const bytes = Buffer.from(encoded.toString("latin1"), "base64");
          if (bytes.length > 0) {
            controller.enqueue(bytes);
            return;
          }
        }
        controller.close();
      },
    });
  }

  /** Closes and removes the file. Never throws, so it cannot hide the error that brought the caller here. */
  async dispose(): Promise<void> {
    await this.handle.close().catch(() => undefined);
    try {
      await rm(this.path, { force: true });
    } catch (error) {
      log.error({
        event: "portable_archive.import",
        state: "degraded",
        reason: "unexpected_failure",
        action: "inspect_admin_diagnostics",
        impact: "application_degraded",
        detail: operationalDetail`payload_scratch_cleanup.${error instanceof Error ? error.name : "unknown"}`,
      });
    }
  }
}

/** Removes payload files a killed process left in the scratch directory. A younger one may be in use. */
export async function sweepPayloadScratch(olderThanMs: number): Promise<void> {
  const directory = scratchDirectory();
  const boundary = Date.now() - olderThanMs;
  let names: string[];
  try { names = await readdir(directory); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(SCRATCH_PREFIX) || !name.endsWith(".tmp")) continue;
    const path = join(directory, name);
    const details = await stat(path).catch(() => null);
    if (details?.isFile() && details.mtimeMs < boundary) await rm(path, { force: true }).catch(() => undefined);
  }
}

const BASE64_ALPHABET = new Uint8Array(256);
for (const character of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_") BASE64_ALPHABET[character.charCodeAt(0)] = 1;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const EQUALS = 0x3d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

/**
 * Base64 text handed on in pieces as it is read, rather than kept: `write`
 * gets the characters (a view of the reader's window, valid only until it
 * returns), and what `end` returns stands in the string's place.
 */
export interface Base64Sink {
  write(characters: Buffer): Promise<void>;
  end(): Promise<unknown>;
}

/**
 * Where a value sits, and what that means for a string there: located and
 * left in the source (`locate`), handed to a sink as it is read (`sink`), or,
 * for every other place, materialised.
 */
interface ReadPolicy {
  readonly root: string;
  member(parent: string, key: string): string;
  element(parent: string): string;
  locates(place: string): boolean;
  /** A sink for a string at `place`, given the object it is a member of as read so far; null to keep the string. */
  sink(place: string, holder: Record<string, unknown> | null): Promise<Base64Sink> | null;
  /** The most bytes read outside sunk strings, or Infinity. */
  readonly maxOtherBytes: number;
}

/**
 * The decrypted payload: only `documentBytes[].contentBase64` at the top
 * level is left in the file; every other value is materialised.
 */
const PAYLOAD_POLICY: ReadPolicy = {
  root: "root",
  member: (parent, key) => (parent === "root" && key === "documentBytes" ? "documentBytes"
    : parent === "documentEntry" && key === "contentBase64" ? "contentBase64" : "other"),
  element: (parent) => (parent === "documentBytes" ? "documentEntry" : "other"),
  locates: (place) => place === "contentBase64",
  sink: () => null,
  maxOtherBytes: Infinity,
};

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function isNumberByte(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x2b || byte === 0x2e || byte === 0x65 || byte === 0x45;
}

/**
 * A small reader for this one format's JSON, purpose-built so no dependency
 * is added. Strings, numbers and literals are handed to `JSON.parse` once
 * their extent is known, so they mean exactly what they always did.
 */
class PayloadReader {
  private readonly buffer = Buffer.alloc(READ_PIECE_BYTES);
  /** The source offset of `buffer[0]`. */
  private start = 0;
  private end = 0;
  private index = 0;
  /** Characters handed to sinks so far, which `maxOtherBytes` does not count. */
  private sunk = 0;

  constructor(private readonly source: ByteSource, private readonly policy: ReadPolicy) {}

  async document(): Promise<unknown> {
    const value = await this.value(0, this.policy.root, null);
    if (await this.skipSpace() !== -1) throw new PayloadSyntaxError();
    return value;
  }

  /** Moves the window on once it is used up; false at the end of the source. */
  private async refill(): Promise<boolean> {
    this.start += this.end;
    if (this.start - this.sunk > this.policy.maxOtherBytes) throw new PayloadSyntaxError();
    this.index = 0;
    this.end = await this.source.read(this.buffer);
    return this.end > 0;
  }

  /** The next byte that is not whitespace, left unconsumed, or -1 at the end of the file. */
  private async skipSpace(): Promise<number> {
    for (;;) {
      if (this.index >= this.end && !(await this.refill())) return -1;
      const byte = this.buffer[this.index];
      if (!isSpace(byte)) return byte;
      this.index++;
    }
  }

  private async value(depth: number, place: string, holder: Record<string, unknown> | null): Promise<unknown> {
    const byte = await this.skipSpace();
    if (byte === OPEN_BRACE) return this.object(depth + 1, place);
    if (byte === OPEN_BRACKET) return this.array(depth + 1, place);
    if (byte === QUOTE) {
      if (this.policy.locates(place)) return this.base64Text(null);
      const sink = this.policy.sink(place, holder);
      return sink ? this.base64Text(await sink) : this.scalar(true);
    }
    if (byte === 0x74 || byte === 0x66 || byte === 0x6e || isNumberByte(byte)) return this.scalar(false);
    throw new PayloadSyntaxError();
  }

  private async object(depth: number, place: string): Promise<Record<string, unknown>> {
    if (depth > MAX_DEPTH) throw new PayloadSyntaxError();
    this.index++;
    const result: Record<string, unknown> = {};
    let byte = await this.skipSpace();
    if (byte === CLOSE_BRACE) {
      this.index++;
      return result;
    }
    for (;;) {
      if (byte !== QUOTE) throw new PayloadSyntaxError();
      const key = await this.scalar(true);
      if (typeof key !== "string" || await this.skipSpace() !== COLON) throw new PayloadSyntaxError();
      this.index++;
      // Defined, not assigned, so a key such as "__proto__" is an own property, as JSON.parse makes it.
      Object.defineProperty(result, key, { value: await this.value(depth, this.policy.member(place, key), result), writable: true, enumerable: true, configurable: true });
      byte = await this.skipSpace();
      this.index++;
      if (byte === CLOSE_BRACE) return result;
      if (byte !== COMMA) throw new PayloadSyntaxError();
      byte = await this.skipSpace();
    }
  }

  private async array(depth: number, place: string): Promise<unknown[]> {
    if (depth > MAX_DEPTH) throw new PayloadSyntaxError();
    this.index++;
    const result: unknown[] = [];
    if (await this.skipSpace() === CLOSE_BRACKET) {
      this.index++;
      return result;
    }
    const childPlace = this.policy.element(place);
    for (;;) {
      result.push(await this.value(depth, childPlace, null));
      const byte = await this.skipSpace();
      this.index++;
      if (byte === CLOSE_BRACKET) return result;
      if (byte !== COMMA) throw new PayloadSyntaxError();
    }
  }

  /**
   * A string (from its opening quote to its closing one) or a number or
   * literal (up to the next byte that cannot be part of one), parsed by
   * `JSON.parse`.
   */
  private async scalar(quoted: boolean): Promise<unknown> {
    const parts: Buffer[] = [];
    let begin = this.index;
    if (quoted) this.index++;
    let escaped = false;
    for (;;) {
      if (this.index >= this.end) {
        parts.push(Buffer.from(this.buffer.subarray(begin, this.end)));
        begin = 0;
        if (!(await this.refill())) {
          if (quoted) throw new PayloadSyntaxError();
          break;
        }
      }
      const byte = this.buffer[this.index];
      if (quoted) {
        this.index++;
        if (escaped) escaped = false;
        else if (byte === BACKSLASH) escaped = true;
        else if (byte === QUOTE) break;
      } else {
        if (!isNumberByte(byte) && !(byte >= 0x61 && byte <= 0x7a)) break;
        this.index++;
      }
    }
    if (this.end > 0) parts.push(this.buffer.subarray(begin, this.index));
    try {
      return JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      throw new PayloadSyntaxError();
    }
  }

  /**
   * Base64 text, checked as it is read. Only the base64 alphabets (standard
   * and URL-safe) are accepted, with up to two `=` at the end, so decoding it
   * in pieces gives the bytes decoding it whole would. With no sink it is
   * located and left in the source (a document in the payload file); with
   * one, its characters are handed on a window at a time, and nothing of it
   * is kept.
   */
  private async base64Text(sink: Base64Sink | null): Promise<unknown> {
    this.index++;
    const offset = this.start + this.index;
    let segment = this.index;
    let padding = 0;
    for (;;) {
      if (this.index >= this.end) {
        if (sink && this.index > segment) await this.handOn(sink, segment, this.index);
        if (!(await this.refill())) throw new PayloadSyntaxError();
        segment = 0;
      }
      const byte = this.buffer[this.index++];
      if (byte === QUOTE) break;
      if (byte === EQUALS) {
        if (++padding > 2) throw new PayloadSyntaxError();
      } else if (padding > 0 || BASE64_ALPHABET[byte] !== 1) {
        throw new PayloadSyntaxError();
      }
    }
    if (sink) {
      if (this.index - 1 > segment) await this.handOn(sink, segment, this.index - 1);
      return sink.end();
    }
    const length = this.start + this.index - 1 - offset;
    return new Base64Text(offset, length, Math.floor(((length - padding) * 3) / 4));
  }

  private async handOn(sink: Base64Sink, from: number, to: number): Promise<void> {
    this.sunk += to - from;
    await sink.write(this.buffer.subarray(from, to));
  }
}

/** Reads the verified payload in `scratch`; call only once its authentication tag has verified. */
export function readPayload(scratch: PayloadScratch): Promise<unknown> {
  return new PayloadReader(scratch.source(), PAYLOAD_POLICY).document();
}

/**
 * Reads an archive file's envelope from `source` to its end (#1566): every
 * top-level field but `ciphertext` materialised, the ciphertext's base64
 * handed to the sink `ciphertext` makes, given the envelope as read so far,
 * when the ciphertext begins. Everything outside the ciphertext together is
 * held to `maxOtherBytes`, so a file stuffed with something else is refused
 * rather than held. Throws `PayloadSyntaxError` for anything that is not one
 * JSON object.
 */
export async function readEnvelope(
  source: ByteSource,
  ciphertext: (envelope: Record<string, unknown>) => Promise<Base64Sink>,
  maxOtherBytes: number,
): Promise<Record<string, unknown>> {
  const policy: ReadPolicy = {
    root: "root",
    member: (parent, key) => (parent === "root" && key === "ciphertext" ? "ciphertext" : "other"),
    element: () => "other",
    locates: () => false,
    sink: (place, holder) => (place === "ciphertext" && holder ? ciphertext(holder) : null),
    maxOtherBytes,
  };
  const envelope = await new PayloadReader(source, policy).document();
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new PayloadSyntaxError();
  return envelope as Record<string, unknown>;
}
