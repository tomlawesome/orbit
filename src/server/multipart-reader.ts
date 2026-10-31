import { AppError } from "@/lib/errors";

/**
 * A strict streaming `multipart/form-data` reader (RFC 7578) for the archive
 * upload (#1566), written here because Node has none that streams
 * (`request.formData()` holds the whole body) and a third-party one needs the
 * owner's approval first. In the style of `PayloadReader`: it accepts only
 * what Orbit's own client sends, and refuses everything else as
 * `request_malformed`.
 *
 * What it accepts: the opening delimiter first (no preamble), then text
 * fields, each named once, together within `maxFieldBytes` (headers
 * included), then exactly one file part (one with a `filename`), then the
 * closing delimiter and at most a CRLF. The fields are read without pulling
 * a byte of the file's content, so a route can refuse on them before any of
 * the file is read; the file part then flows as a stream, and ends only once
 * the closing delimiter has been seen. A text field or a second file after
 * the file, no file, a body with no closing delimiter, a header other than
 * Content-Disposition and Content-Type, or a body that is not multipart at
 * all is refused.
 *
 * `dispose()` reads the rest of the body away, whatever state the reader is
 * in, so a refusal leaves the connection able to answer the next request
 * (hooks.server.js's `drainUnread` skips a body that is locked, as this one
 * is from the start).
 */

const CRLF = Buffer.from("\r\n");
const DASHES = Buffer.from("--");
const HEADER_END = Buffer.from("\r\n\r\n");
/** One part's header block; a browser writes about a hundred bytes. */
const MAX_HEADER_BYTES = 16 * 1024;
/** RFC 2046 section 5.1.1: 1 to 70 of these characters, not ending in a space. */
const BOUNDARY_PATTERN = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/u;
const DISPOSITION_PATTERN = /^form-data; name="([^"]+)"(?:; filename="([^"]*)")?$/u;

export function requestMalformed(): AppError {
  return new AppError("request_malformed", "That request is not well-formed", 400);
}

/** The boundary of a `multipart/form-data` content type, or null for any other type. */
export function multipartBoundary(contentType: string | null): string | null {
  if (contentType === null) return null;
  const [type, ...parameters] = contentType.split(";");
  if (type.trim().toLowerCase() !== "multipart/form-data") return null;
  for (const parameter of parameters) {
    const separator = parameter.indexOf("=");
    if (separator < 0 || parameter.slice(0, separator).trim().toLowerCase() !== "boundary") continue;
    const value = parameter.slice(separator + 1).trim();
    return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  }
  return null;
}

interface PartHeader {
  name: string;
  filename?: string;
}

function parseHeader(block: Buffer): PartHeader {
  let disposition: string | null = null;
  let contentType = false;
  for (const line of block.toString("utf8").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw requestMalformed();
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "content-disposition" && disposition === null) disposition = value;
    else if (name === "content-type" && !contentType) contentType = true;
    else throw requestMalformed();
  }
  const match = disposition === null ? null : DISPOSITION_PATTERN.exec(disposition);
  if (!match) throw requestMalformed();
  return match[2] === undefined ? { name: match[1] } : { name: match[1], filename: match[2] };
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeField(bytes: Buffer): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw requestMalformed();
  }
}

export class MultipartReader {
  private readonly source: ReadableStreamDefaultReader<Uint8Array>;
  private readonly boundary: string | null;
  /** CRLF, two dashes and the boundary: what ends every part. */
  private readonly delimiter: Buffer;
  private readonly maxFieldBytes: number;
  /** Bytes pulled and not yet consumed sit at [start, end). Never written over once handed out. */
  private store = Buffer.alloc(0);
  private start = 0;
  private end = 0;
  private ended = false;
  /** Every pull from the source goes through this chain, so dispose never reads alongside a pull. */
  private chain: Promise<unknown> = Promise.resolve();
  private fieldsRead: Promise<Record<string, string>> | null = null;
  private filePart: PartHeader | null = null;
  private fileTaken = false;
  private disposal: Promise<void> | null = null;

  constructor(body: ReadableStream<Uint8Array> | null, boundary: string, options: { maxFieldBytes: number }) {
    const stream = body ?? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
    this.source = stream.getReader();
    this.boundary = BOUNDARY_PATTERN.test(boundary) ? boundary : null;
    this.delimiter = Buffer.from(`\r\n--${boundary}`, "latin1");
    this.maxFieldBytes = options.maxFieldBytes;
  }

  /** The text fields, in the order sent. Reads up to the file part's content and no further. */
  fields(): Promise<Record<string, string>> {
    this.fieldsRead ??= this.run(() => this.readFields());
    return this.fieldsRead;
  }

  /** The file part's field name, known once the fields are read, before any of its content is. */
  async fileName(): Promise<string> {
    await this.fields();
    if (this.filePart === null) throw requestMalformed();
    return this.filePart.name;
  }

  /** The one file part: its field name, and its content as a stream that ends at the closing delimiter. */
  async file(): Promise<{ name: string; stream: ReadableStream<Uint8Array> }> {
    await this.fields();
    if (this.fileTaken || this.filePart === null) throw new Error("The file part has already been taken");
    this.fileTaken = true;
    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => this.run(async () => {
        const bytes = await this.nextFileBytes();
        if (bytes === null) controller.close();
        else controller.enqueue(bytes);
      }),
    }, { highWaterMark: 0 });
    return { name: this.filePart.name, stream };
  }

  /** Reads whatever is left of the body and throws it away. Never rejects. */
  dispose(): Promise<void> {
    this.disposal ??= this.run(async () => {
      try {
        while (!this.ended) {
          const { done } = await this.source.read();
          if (done) this.ended = true;
        }
      } catch {
        // The source failed (the client went away, the watchdog cut it): nothing more to read.
        this.ended = true;
      }
      this.store = Buffer.alloc(0);
      this.start = 0;
      this.end = 0;
    }).then(() => undefined, () => undefined);
    return this.disposal;
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private get disposed(): boolean {
    return this.disposal !== null;
  }

  private get length(): number {
    return this.end - this.start;
  }

  private view(): Buffer {
    return this.store.subarray(this.start, this.end);
  }

  private consume(count: number): Buffer {
    const taken = this.store.subarray(this.start, this.start + count);
    this.start += count;
    return taken;
  }

  /** One more chunk from the source; false at its end. */
  private async pull(): Promise<boolean> {
    if (this.ended) return false;
    const { done, value } = await this.source.read();
    if (done) {
      this.ended = true;
      return false;
    }
    if (value.length > 0) this.append(value);
    return true;
  }

  private append(chunk: Uint8Array): void {
    if (this.end + chunk.length > this.store.length) {
      // A new store, never the old one reused: file bytes already handed out are views of it.
      const length = this.length;
      const next = Buffer.alloc(Math.max(length + chunk.length, length * 2));
      this.store.copy(next, 0, this.start, this.end);
      this.store = next;
      this.start = 0;
      this.end = length;
    }
    this.store.set(chunk, this.end);
    this.end += chunk.length;
  }

  /** Pulls until `count` bytes are waiting; false if the body ends first. */
  private async need(count: number): Promise<boolean> {
    while (this.length < count) {
      if (!(await this.pull())) return false;
    }
    return true;
  }

  /** The bytes before the next `pattern`, which is consumed too; refused if more than `limit` come first. */
  private async readUntil(pattern: Buffer, limit: number): Promise<Buffer> {
    let from = 0;
    for (;;) {
      const at = this.view().indexOf(pattern, from);
      if (at >= 0) {
        if (at > limit) throw requestMalformed();
        const before = Buffer.from(this.consume(at));
        this.consume(pattern.length);
        return before;
      }
      if (this.length > limit + pattern.length) throw requestMalformed();
      from = Math.max(0, this.length - pattern.length + 1);
      if (!(await this.pull())) throw requestMalformed();
    }
  }

  /** After a delimiter: true for another part (CRLF), false for the close (two dashes). */
  private async anotherPart(): Promise<boolean> {
    if (!(await this.need(2))) throw requestMalformed();
    const tail = this.consume(2);
    if (tail.equals(CRLF)) return true;
    if (tail.equals(DASHES)) return false;
    throw requestMalformed();
  }

  private async readFields(): Promise<Record<string, string>> {
    if (this.boundary === null) throw requestMalformed();
    const opening = Buffer.from(`--${this.boundary}\r\n`, "latin1");
    if (!(await this.need(opening.length)) || !this.view().subarray(0, opening.length).equals(opening)) throw requestMalformed();
    this.consume(opening.length);
    const fields = new Map<string, string>();
    let budget = this.maxFieldBytes;
    for (;;) {
      const block = await this.readUntil(HEADER_END, Math.min(budget, MAX_HEADER_BYTES));
      budget -= block.length;
      const header = parseHeader(block);
      if (header.filename !== undefined) {
        this.filePart = header;
        return Object.fromEntries(fields);
      }
      const value = await this.readUntil(this.delimiter, budget);
      budget -= value.length;
      if (fields.has(header.name)) throw requestMalformed();
      fields.set(header.name, decodeField(value));
      // The close straight after a text field: there is no file part.
      if (!(await this.anotherPart())) throw requestMalformed();
    }
  }

  /** The next piece of the file's content, or null once the closing delimiter and the end of the body are seen. */
  private async nextFileBytes(): Promise<Buffer | null> {
    if (this.disposed) throw requestMalformed();
    for (;;) {
      const at = this.view().indexOf(this.delimiter);
      if (at > 0) return this.consume(at);
      if (at === 0) {
        this.consume(this.delimiter.length);
        // A text field or a second file after the file part.
        if (await this.anotherPart()) throw requestMalformed();
        await this.closed();
        return null;
      }
      // Hold back what could be the start of a delimiter split across chunks.
      const safe = this.length - (this.delimiter.length - 1);
      if (safe > 0) return this.consume(safe);
      if (!(await this.pull())) throw requestMalformed();
    }
  }

  /** After the closing delimiter: at most a CRLF, then the end of the body. */
  private async closed(): Promise<void> {
    while (!this.ended && this.length <= CRLF.length) await this.pull();
    const rest = this.view();
    if (!this.ended || (rest.length > 0 && !rest.equals(CRLF))) throw requestMalformed();
    this.consume(rest.length);
  }
}
