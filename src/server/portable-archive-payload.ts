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
 * Where a value sits: only `documentBytes[].contentBase64` at the top level
 * of the payload is left in the file; every other value is materialised.
 */
type Place = "root" | "documentBytes" | "documentEntry" | "contentBase64" | "other";

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
  /** The file offset of `buffer[0]`. */
  private start = 0;
  private end = 0;
  private index = 0;

  constructor(private readonly scratch: PayloadScratch) {}

  async document(): Promise<unknown> {
    const value = await this.value(0, "root");
    if (await this.skipSpace() !== -1) throw new PayloadSyntaxError();
    return value;
  }

  /** Moves the window on once it is used up; false at the end of the file. */
  private async refill(): Promise<boolean> {
    this.start += this.end;
    this.index = 0;
    this.end = await this.scratch.readAt(this.buffer, this.start);
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

  private async value(depth: number, place: Place): Promise<unknown> {
    const byte = await this.skipSpace();
    if (byte === OPEN_BRACE) return this.object(depth + 1, place);
    if (byte === OPEN_BRACKET) return this.array(depth + 1, place);
    if (byte === QUOTE) return place === "contentBase64" ? this.base64Text() : this.scalar(true);
    if (byte === 0x74 || byte === 0x66 || byte === 0x6e || isNumberByte(byte)) return this.scalar(false);
    throw new PayloadSyntaxError();
  }

  private async object(depth: number, place: Place): Promise<Record<string, unknown>> {
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
      const childPlace: Place = place === "root" && key === "documentBytes" ? "documentBytes"
        : place === "documentEntry" && key === "contentBase64" ? "contentBase64" : "other";
      // Defined, not assigned, so a key such as "__proto__" is an own property, as JSON.parse makes it.
      Object.defineProperty(result, key, { value: await this.value(depth, childPlace), writable: true, enumerable: true, configurable: true });
      byte = await this.skipSpace();
      this.index++;
      if (byte === CLOSE_BRACE) return result;
      if (byte !== COMMA) throw new PayloadSyntaxError();
      byte = await this.skipSpace();
    }
  }

  private async array(depth: number, place: Place): Promise<unknown[]> {
    if (depth > MAX_DEPTH) throw new PayloadSyntaxError();
    this.index++;
    const result: unknown[] = [];
    if (await this.skipSpace() === CLOSE_BRACKET) {
      this.index++;
      return result;
    }
    const childPlace: Place = place === "documentBytes" ? "documentEntry" : "other";
    for (;;) {
      result.push(await this.value(depth, childPlace));
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
   * A document's base64, checked and located but left in the file. Only the
   * base64 alphabets (standard and URL-safe) are accepted, with up to two
   * `=` at the end, so decoding it in pieces gives the bytes decoding it
   * whole would.
   */
  private async base64Text(): Promise<Base64Text> {
    this.index++;
    const offset = this.start + this.index;
    let padding = 0;
    for (;;) {
      if (this.index >= this.end && !(await this.refill())) throw new PayloadSyntaxError();
      const byte = this.buffer[this.index++];
      if (byte === QUOTE) break;
      if (byte === EQUALS) {
        if (++padding > 2) throw new PayloadSyntaxError();
      } else if (padding > 0 || BASE64_ALPHABET[byte] !== 1) {
        throw new PayloadSyntaxError();
      }
    }
    const length = this.start + this.index - 1 - offset;
    return new Base64Text(offset, length, Math.floor(((length - padding) * 3) / 4));
  }
}

/** Reads the verified payload in `scratch`; call only once its authentication tag has verified. */
export function readPayload(scratch: PayloadScratch): Promise<unknown> {
  return new PayloadReader(scratch).document();
}
