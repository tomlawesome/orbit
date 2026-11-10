import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { validUuid } from "@/lib/uuid";

export interface StoredPortableArchive { storageKey: string; modifiedAt: Date }
export interface OpenedPortableArchive { handle: FileHandle; sizeBytes: number }
/**
 * An uploaded archive taken in whole to a file (#1792): its length, a
 * reading of it (once), and the removal the caller owes however it ends.
 */
export interface SpooledUpload { sizeBytes: number; stream(): ReadableStream<Uint8Array>; dispose(): Promise<void> }

/** Private local storage for encrypted portability exports. */
export class PortableArchiveStorage {
  constructor(private readonly root: string) {}

  createStorageKey(): string {
    return randomUUID();
  }

  private pathFor(storageKey: string): string {
    if (!validUuid(storageKey)) throw new Error("Invalid portable archive storage key");
    return join(this.root, `${storageKey}.archive`);
  }

  /**
   * Writes a file as it is produced, never holding it whole (#1506): write-
   * then-rename, so the final name only ever holds a finished file. `produce`
   * is handed a `write` that resolves once the bytes are in the file, so a
   * slow disk slows the producer (backpressure). Returns the SHA-256 and
   * length of exactly the bytes written. On any failure the temporary file is
   * removed and the error rethrown.
   */
  async writeStream(
    storageKey: string,
    produce: (write: (chunk: Buffer) => Promise<void>) => Promise<void>,
  ): Promise<{ sha256: string; sizeBytes: number }> {
    const destination = this.pathFor(storageKey);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await produce(async (chunk) => {
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
            offset += bytesWritten;
          }
          hash.update(chunk);
          sizeBytes += chunk.length;
        });
      } finally {
        await handle.close();
      }
      await rename(temporary, destination);
      return { sha256: hash.digest("hex"), sizeBytes };
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Takes an uploaded archive in whole before anything processes it (#1792):
   * each chunk is written to `<root>/<uuid>.upload.tmp` as it arrives, never
   * held whole, and the promise resolves once the source ends. The `.tmp`
   * suffix keeps a file left by a killed process under
   * `sweepTemporaryFiles`; a live spool's mtime moves with every write, so it
   * is never swept while bytes arrive. `list()` never names it. On any
   * failure (the source erroring, a full disk) the file is removed and the
   * error rethrown; otherwise the caller calls `dispose()` (idempotent).
   */
  async spool(source: ReadableStream<Uint8Array>): Promise<SpooledUpload> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, `${randomUUID()}.upload.tmp`);
    let disposal: Promise<void> | null = null;
    const dispose = () => (disposal ??= rm(path, { force: true }).then(() => undefined));
    const reader = source.getReader();
    let sizeBytes = 0;
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          let offset = 0;
          while (offset < value.length) {
            const { bytesWritten } = await handle.write(value, offset, value.length - offset);
            offset += bytesWritten;
          }
          sizeBytes += value.length;
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      await dispose().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    let streamed = false;
    return {
      sizeBytes,
      stream: () => {
        if (streamed) throw new Error("The spooled upload has already been read");
        streamed = true;
        return spoolReader(path);
      },
      dispose,
    };
  }

  async read(storageKey: string, maximumBytes: number): Promise<Buffer> {
    const contents = await readFile(this.pathFor(storageKey));
    if (contents.length > maximumBytes) {
      contents.fill(0);
      throw new Error("Portable archive exceeds its expected size");
    }
    return contents;
  }

  /**
   * The stored file as an open handle and its size, for reading in chunks
   * rather than whole (#1428). The caller owns the handle and closes it. An
   * open handle keeps reading the same file even if a purge unlinks it.
   */
  async open(storageKey: string, maximumBytes: number): Promise<OpenedPortableArchive> {
    const handle = await open(this.pathFor(storageKey), "r");
    try {
      const { size } = await handle.stat();
      if (size > maximumBytes) throw new Error("Portable archive exceeds its expected size");
      return { handle, sizeBytes: size };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async delete(storageKey: string): Promise<void> {
    await rm(this.pathFor(storageKey), { force: true });
  }

  /**
   * Removes `*.tmp` files left by a process killed between a temporary write
   * and its rename: nothing else ever names them. A younger one may be a
   * write still in flight.
   */
  async sweepTemporaryFiles(olderThanMs: number): Promise<void> {
    const boundary = Date.now() - olderThanMs;
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".tmp")) continue;
      const path = join(this.root, entry.name);
      const details = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (details && details.mtimeMs < boundary) await rm(path, { force: true });
    }
  }

  async list(): Promise<StoredPortableArchive[]> {
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const result: StoredPortableArchive[] = [];
    for (const entry of entries) {
      const match = entry.isFile() && entry.name.match(/^(.{36})\.archive$/s);
      if (!match || !validUuid(match[1])) continue;
      result.push({ storageKey: match[1], modifiedAt: (await stat(join(this.root, entry.name))).mtime });
    }
    return result;
  }
}

const SPOOL_READ_BYTES = 64 * 1024;

/** The spool file as a stream, read a piece at a time; the handle closes however the reading ends. */
function spoolReader(path: string): ReadableStream<Uint8Array> {
  let handle: FileHandle | null = null;
  const close = async () => {
    const open_ = handle;
    handle = null;
    await open_?.close().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        handle ??= await open(path, "r");
        const buffer = Buffer.alloc(SPOOL_READ_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) {
          await close();
          controller.close();
          return;
        }
        controller.enqueue(buffer.subarray(0, bytesRead));
      } catch (error) {
        await close();
        controller.error(error);
      }
    },
    cancel: close,
  }, { highWaterMark: 0 });
}
