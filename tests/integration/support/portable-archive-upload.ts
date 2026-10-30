/**
 * The portable-archive upload as Orbit's own client sends it (#1566).
 *
 * Preview and import take `multipart/form-data`: the small fields first, in
 * the order `householdId`, `passphrase`, `currentPassword` (optional),
 * `conflictItemIds` (import only, one field holding a JSON array), and the
 * archive file last, as the part named `archive`. The body is built by the
 * platform's own `FormData` and `Request` -- the same serialisation the
 * browser performs -- so a test never agrees with a hand-written encoder that
 * the browser does not share. `rawMultipart` is for the malformed bodies the
 * client never sends.
 *
 * No engine import here: unit tests under `src/` use it too.
 */

export const ARCHIVE_FILE_NAME = "household.orbit-archive.json";
const KIB = 1024;

export interface ArchiveUploadFields {
  householdId: string;
  passphrase: string;
  currentPassword?: string;
  /** An array is sent as its JSON text; a string is sent as it is. */
  conflictItemIds?: string[] | string;
}

type Bytes = Uint8Array | string;

const asBytes = (value: Bytes): Uint8Array => (typeof value === "string" ? Buffer.from(value, "utf8") : value);

/** The archive file's bytes: a serialised archive object, or the file as written. */
export function archiveFileBytes(archive: Bytes | object): Buffer {
  if (typeof archive === "string") return Buffer.from(archive, "utf8");
  if (archive instanceof Uint8Array) return Buffer.from(archive);
  return Buffer.from(JSON.stringify(archive), "utf8");
}

/** The upload as the client builds it: fields in the wire order, the file appended last. */
export function archiveForm(fields: ArchiveUploadFields, file: Bytes | object): FormData {
  const form = new FormData();
  form.append("householdId", fields.householdId);
  form.append("passphrase", fields.passphrase);
  if (fields.currentPassword !== undefined) form.append("currentPassword", fields.currentPassword);
  if (fields.conflictItemIds !== undefined) {
    form.append("conflictItemIds", typeof fields.conflictItemIds === "string" ? fields.conflictItemIds : JSON.stringify(fields.conflictItemIds));
  }
  form.append("archive", new File([new Uint8Array(archiveFileBytes(file))], ARCHIVE_FILE_NAME, { type: "application/json" }));
  return form;
}

export interface EncodedUpload {
  /** `multipart/form-data; boundary=...`, as the platform set it. */
  contentType: string;
  boundary: string;
  bytes: Buffer;
}

/** The exact bytes and content type the platform puts on the wire for `form`. */
export async function encodeForm(form: FormData): Promise<EncodedUpload> {
  const request = new Request("http://orbit.invalid/upload", { method: "POST", body: form });
  const contentType = request.headers.get("content-type") ?? "";
  return { contentType, boundary: boundaryOf(contentType), bytes: Buffer.from(await request.arrayBuffer()) };
}

export function boundaryOf(contentType: string): string {
  const match = /boundary=("?)([^";]+)\1/u.exec(contentType);
  if (!match) throw new Error(`no boundary in ${contentType}`);
  return match[2];
}

export interface RawPart {
  name: string;
  /** Present for a file part, as a browser writes one. */
  filename?: string;
  value: Bytes;
}

/**
 * A multipart body written by hand, in the layout a browser uses, for the
 * shapes Orbit's client never sends. `closing: false` leaves the closing
 * delimiter off; `opening` replaces the first delimiter line.
 */
export function rawMultipart(boundary: string, parts: RawPart[], options: { closing?: boolean; opening?: string } = {}): Buffer {
  const pieces: Buffer[] = [];
  parts.forEach((part, index) => {
    const delimiter = index === 0 && options.opening !== undefined ? options.opening : `--${boundary}`;
    const disposition = part.filename === undefined
      ? `Content-Disposition: form-data; name="${part.name}"\r\n`
      : `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: application/json\r\n`;
    pieces.push(Buffer.from(`${index === 0 ? "" : "\r\n"}${delimiter}\r\n${disposition}\r\n`, "utf8"), Buffer.from(asBytes(part.value)));
  });
  if (options.closing !== false) pieces.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return Buffer.concat(pieces);
}

/** Where the `archive` part's content starts in an encoded body (just past its blank line). */
export function fileContentOffset(bytes: Buffer, name = "archive"): number {
  const header = bytes.indexOf(`name="${name}"; filename=`);
  if (header < 0) throw new Error(`no file part named ${name}`);
  const blank = bytes.indexOf("\r\n\r\n", header);
  if (blank < 0) throw new Error("file part has no header end");
  return blank + 4;
}

export interface TrackedBody {
  body: ReadableStream<Uint8Array>;
  /** How many bytes the consumer has pulled, and whether it pulled the end. */
  stats: { pulledBytes: number; done: boolean };
}

/**
 * `bytes` handed over in chunks, pulled only on demand (highWaterMark 0), so
 * `stats.pulledBytes` is exactly what the consumer asked for. `cuts` are
 * offsets where a chunk must end; between and after them the chunks are
 * `chunkSize` long.
 */
export function trackedBody(bytes: Uint8Array, options: { cuts?: number[]; chunkSize?: number } = {}): TrackedBody {
  const chunkSize = options.chunkSize ?? 64 * KIB;
  const cuts = [...(options.cuts ?? [])].filter((cut) => cut > 0 && cut < bytes.length).sort((a, b) => a - b);
  const stats = { pulledBytes: 0, done: false };
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        stats.done = true;
        controller.close();
        return;
      }
      const nextCut = cuts.find((cut) => cut > offset) ?? bytes.length;
      const end = Math.min(offset + chunkSize, nextCut, bytes.length);
      const chunk = bytes.slice(offset, end);
      offset = end;
      stats.pulledBytes = offset;
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  return { body, stats };
}

/** `bytes` as a stream of chunks whose sizes come from `sizes` in turn (repeating). */
export function chunkedStream(bytes: Uint8Array, sizes: number[]): ReadableStream<Uint8Array> {
  let offset = 0;
  let turn = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const size = Math.max(1, sizes[turn % sizes.length]);
      turn += 1;
      const end = Math.min(offset + size, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  }, { highWaterMark: 0 });
}

/**
 * The archive file as the stream the repository's preview and import take
 * (#1566), in 64 KiB chunks unless told otherwise. A fresh stream each call:
 * a stream is read once.
 */
export function archiveStream(archive: Bytes | object, chunkSize = 64 * KIB): ReadableStream<Uint8Array> {
  return chunkedStream(archiveFileBytes(archive), [chunkSize]);
}

/** Every byte of a stream, joined. */
export async function readStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const parts: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}
