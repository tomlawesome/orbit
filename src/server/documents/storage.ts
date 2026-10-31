import { createHash, randomBytes } from "node:crypto";
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppError } from "@/lib/app-error";
import { validUuid } from "@/lib/uuid";
import { getDocumentConfig, type DocumentConfig } from "@/server/documents/config";
import type { CryptoEnvelope, DocumentSealer, DocumentUnsealer } from "@/server/documents/crypto";

/** A storage key's own shape: 32 bytes of hex. Exported so any caller that
 * must validate a storage key outside this module (purge-jobs.ts's claim
 * query, A2-Q4) checks the one pattern rather than restating it. */
export const STORAGE_KEY_PATTERN = /^[a-f0-9]{64}$/;

// The quarantine is a fixed-size tmpfs shared by every upload in flight, so a
// full one is a passing condition: tell the member to retry, not a bare 500.
function quarantineFullError(error: unknown): unknown {
  if ((error as NodeJS.ErrnoException | null)?.code !== "ENOSPC") return error;
  return new AppError("document_upload_space_busy", "Document upload space is busy; try again shortly", 503);
}

export interface ReceivedDocument {
  quarantinePath: string;
  sizeBytes: number;
  contentSha256: string;
  leadingBytes: Buffer;
}

/** What `sealQuarantine` was told the quarantine file holds: the size and digest `receive` measured. */
export interface ExpectedQuarantineContent {
  sizeBytes: number;
  contentSha256: string;
}

/** Where a sealed copy goes: `objects/aa/bb/<key>.bin` or `staging/<key>.bin`. */
export interface SealDestination {
  kind: "object" | "staging";
  storageKey: string;
}

/** The size of the one reusable buffer a sealing or unsealing pass reads its source file through. */
const PASS_READ_BYTES = 1_048_576;

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written);
    written += result.bytesWritten;
  }
}

export interface StoredCiphertextObject {
  storageKey: string;
  modifiedAt: Date;
}

function requireDocumentId(documentId: string): void {
  if (!validUuid(documentId)) throw new Error("Invalid document identifier");
}

function requireStorageKey(storageKey: string): void {
  if (!STORAGE_KEY_PATTERN.test(storageKey)) throw new Error("Invalid document storage key");
}

/**
 * Zeroes the structure check's copy of a file and frees its memory now, not at
 * the next garbage collection, so the seal that follows never runs on top of
 * it (#1571). Only a buffer that owns its whole allocation is freed: a slice of
 * Node's shared pool is zeroed and left.
 */
export function releaseCheckCopy(bytes: Buffer): void {
  bytes.fill(0);
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) bytes.buffer.transfer(0);
}

export class LocalDocumentStorage {
  constructor(
    private readonly storageRoot: string,
    private readonly quarantineRoot: string,
  ) {}

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(join(this.storageRoot, "objects"), { recursive: true, mode: 0o700 }),
      mkdir(join(this.storageRoot, "staging"), { recursive: true, mode: 0o700 }),
      mkdir(this.quarantineRoot, { recursive: true, mode: 0o700 }),
    ]);
  }

  async receive(
    body: ReadableStream<Uint8Array> | null,
    documentId: string,
    maximumBytes: number,
    declaredBytes?: number,
  ): Promise<ReceivedDocument> {
    requireDocumentId(documentId);
    if (!body) throw new AppError("document_empty", "Choose a non-empty document", 422);
    if (declaredBytes !== undefined && declaredBytes > maximumBytes) {
      throw new AppError("document_too_large", "That document exceeds the configured size limit", 413);
    }

    await this.initialize();
    // A request can crash after opening quarantine but before its finally
    // block. An attempt-specific opaque name lets the same idempotency UUID be
    // retried without deleting another concurrent upload's bytes.
    const quarantinePath = join(this.quarantineRoot, `${documentId}.${randomBytes(16).toString("hex")}.upload`);
    const handle = await open(quarantinePath, "wx", 0o600).catch((error: unknown) => {
      throw quarantineFullError(error);
    });
    const digest = createHash("sha256");
    const leadingChunks: Buffer[] = [];
    let leadingLength = 0;
    let sizeBytes = 0;
    const reader = body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // A view, not a copy: the chunk is hashed and written in this iteration and never kept.
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        sizeBytes += chunk.length;
        if (sizeBytes > maximumBytes) {
          throw new AppError("document_too_large", "That document exceeds the configured size limit", 413);
        }
        digest.update(chunk);
        if (leadingLength < 512) {
          const prefix = chunk.subarray(0, 512 - leadingLength);
          // The only bytes retained past the iteration, so this one is a copy.
          leadingChunks.push(Buffer.from(prefix));
          leadingLength += prefix.length;
        }
        await handle.write(chunk);
      }
      if (sizeBytes === 0) throw new AppError("document_empty", "Choose a non-empty document", 422);
      if (declaredBytes !== undefined && sizeBytes !== declaredBytes) {
        throw new AppError("document_size_mismatch", "The document transfer was incomplete", 422);
      }
      await handle.sync();
      return {
        quarantinePath,
        sizeBytes,
        contentSha256: digest.digest("hex"),
        leadingBytes: Buffer.concat(leadingChunks),
      };
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      await rm(quarantinePath, { force: true }).catch(() => undefined);
      throw quarantineFullError(error);
    } finally {
      await handle.close();
    }
  }

  async readQuarantine(path: string, maximumBytes: number): Promise<Buffer> {
    const handle = await open(path, "r");
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.size < 1 || details.size > maximumBytes) {
        throw new AppError("document_quarantine_invalid", "The quarantined document is invalid", 422);
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  /**
   * Encrypts the quarantine file into `destination` in pieces: one reusable
   * 1 MiB buffer, each piece hashed, fed to the sealer and appended to a
   * temporary file that is fsynced and renamed into place (stage, then
   * switch). The digest must equal what `receive` measured, else the document
   * is refused as `readQuarantine` refuses an invalid file, so the bytes that
   * were encrypted are the bytes the scanner and the open check saw. Nothing is
   * left behind on a refusal or failure, and the read buffer is zeroed when the
   * pass ends either way (#1151 F13). The caller discards the quarantine file.
   */
  async sealQuarantine(
    path: string,
    expected: ExpectedQuarantineContent,
    sealer: DocumentSealer,
    destination: SealDestination,
  ): Promise<{ ciphertextSize: number; envelope: CryptoEnvelope }> {
    const finalPath = destination.kind === "object"
      ? this.objectPath(destination.storageKey)
      : this.stagingPath(destination.storageKey);
    const invalid = () => new AppError("document_quarantine_invalid", "The quarantined document is invalid", 422);

    const source = await open(path, "r");
    const buffer = Buffer.alloc(PASS_READ_BYTES);
    let temporary: string | undefined;
    let output: FileHandle | undefined;
    try {
      const details = await source.stat();
      if (!details.isFile() || details.size !== expected.sizeBytes) throw invalid();

      await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
      temporary = `${finalPath}.${randomBytes(8).toString("hex")}.tmp`;
      output = await open(temporary, "wx", 0o600);

      const digest = createHash("sha256");
      let position = 0;
      let ciphertextSize = 0;
      while (position < expected.sizeBytes) {
        const wanted = Math.min(buffer.length, expected.sizeBytes - position);
        const { bytesRead } = await source.read(buffer, 0, wanted, position);
        if (bytesRead === 0) throw invalid();
        const piece = buffer.subarray(0, bytesRead);
        position += bytesRead;
        digest.update(piece);
        const sealed = sealer.update(piece);
        await writeAll(output, sealed);
        ciphertextSize += sealed.length;
      }
      if (digest.digest("hex") !== expected.contentSha256) throw invalid();

      const { tail, envelope } = sealer.final();
      await writeAll(output, tail);
      ciphertextSize += tail.length;
      await output.sync();
      await output.close();
      output = undefined;
      await rename(temporary, finalPath);
      temporary = undefined;
      return { ciphertextSize, envelope };
    } catch (error) {
      await output?.close().catch(() => undefined);
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      buffer.fill(0);
      await source.close().catch(() => undefined);
    }
  }

  /**
   * Reads `source` through `buffer` in pieces, feeds each to `unsealer` and
   * hands the plaintext piece to `sink`, then calls `final()`. The sink gets
   * pieces BEFORE the tag is checked, so every public caller's sink is
   * private to this class: a file it opened, or a buffer it owns.
   */
  private async unsealPass(
    source: FileHandle,
    ciphertextSize: number,
    unsealer: DocumentUnsealer,
    buffer: Buffer,
    sink: (plaintextPiece: Buffer) => Promise<void> | void,
  ): Promise<void> {
    let position = 0;
    while (position < ciphertextSize) {
      const wanted = Math.min(buffer.length, ciphertextSize - position);
      const { bytesRead } = await source.read(buffer, 0, wanted, position);
      if (bytesRead === 0) throw new Error("Encrypted document storage object is invalid");
      position += bytesRead;
      await sink(unsealer.update(buffer.subarray(0, bytesRead)));
    }
    unsealer.final();
  }

  /**
   * Decrypts a stored object into a new `.recovery` quarantine file in pieces,
   * hashing as it goes. The path is returned only once `final()` has passed,
   * so nothing downstream can read unauthenticated plaintext; on any failure
   * the file is removed. The read buffer is zeroed when the pass ends.
   */
  async unsealToQuarantine(
    source: { kind: "object" | "staging"; storageKey: string },
    documentId: string,
    expected: { ciphertextSize: number; plaintextSize: number },
    unsealer: DocumentUnsealer,
  ): Promise<{ quarantinePath: string; contentSha256: string }> {
    requireDocumentId(documentId);
    const sourcePath = source.kind === "object" ? this.objectPath(source.storageKey) : this.stagingPath(source.storageKey);
    const input = await open(sourcePath, "r");
    const buffer = Buffer.alloc(PASS_READ_BYTES);
    let quarantinePath: string | undefined;
    let output: FileHandle | undefined;
    try {
      const details = await input.stat();
      if (!details.isFile() || details.size !== expected.ciphertextSize) throw new Error("Encrypted staging object is invalid");
      await this.initialize();
      quarantinePath = join(this.quarantineRoot, `${documentId}.${randomBytes(16).toString("hex")}.recovery`);
      const target = await open(quarantinePath, "wx", 0o600).catch((error: unknown) => {
        throw quarantineFullError(error);
      });
      output = target;
      const digest = createHash("sha256");
      await this.unsealPass(input, expected.ciphertextSize, unsealer, buffer, async (piece) => {
        digest.update(piece);
        await writeAll(target, piece);
      });
      await target.sync();
      await target.close();
      output = undefined;
      return { quarantinePath, contentSha256: digest.digest("hex") };
    } catch (error) {
      await output?.close().catch(() => undefined);
      if (quarantinePath) await rm(quarantinePath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      buffer.fill(0);
      await input.close().catch(() => undefined);
    }
  }

  /**
   * Decrypts a stored object straight into one buffer of `plaintextSize`
   * bytes: no ciphertext copy, no second plaintext copy. The buffer is
   * returned only once `final()` has passed and is zeroed on any failure.
   */
  async unsealIntoBuffer(
    storageKey: string,
    expected: { ciphertextSize: number; plaintextSize: number },
    unsealer: DocumentUnsealer,
  ): Promise<Buffer> {
    const source = await open(this.objectPath(storageKey), "r");
    const buffer = Buffer.alloc(PASS_READ_BYTES);
    const plaintext = Buffer.alloc(expected.plaintextSize);
    try {
      let offset = 0;
      await this.unsealPass(source, expected.ciphertextSize, unsealer, buffer, (piece) => {
        if (offset + piece.length > plaintext.length) throw new Error("Decrypted document size does not match metadata");
        piece.copy(plaintext, offset);
        offset += piece.length;
      });
      return plaintext;
    } catch (error) {
      plaintext.fill(0);
      throw error;
    } finally {
      buffer.fill(0);
      await source.close().catch(() => undefined);
    }
  }

  async discardQuarantine(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  async listQuarantineFiles(): Promise<Array<{ path: string; modifiedAt: Date }>> {
    await this.initialize();
    const entries = await readdir(this.quarantineRoot, { withFileTypes: true });
    const files: Array<{ path: string; modifiedAt: Date }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}(?:\.[a-f0-9]{32})?\.(?:upload|recovery)$/u.test(entry.name)) continue;
      const path = join(this.quarantineRoot, entry.name);
      files.push({ path, modifiedAt: (await stat(path)).mtime });
    }
    return files;
  }

  createStorageKey(): string {
    return randomBytes(32).toString("hex");
  }

  private objectPath(storageKey: string): string {
    requireStorageKey(storageKey);
    return join(this.storageRoot, "objects", storageKey.slice(0, 2), storageKey.slice(2, 4), `${storageKey}.bin`);
  }

  private stagingPath(storageKey: string): string {
    requireStorageKey(storageKey);
    return join(this.storageRoot, "staging", `${storageKey}.bin`);
  }

  async writeCiphertext(storageKey: string, ciphertext: Buffer): Promise<void> {
    await this.writeAtomic(this.objectPath(storageKey), ciphertext);
  }

  private async writeAtomic(destination: string, ciphertext: Buffer): Promise<void> {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(ciphertext);
      await handle.sync();
      await handle.close();
      await rename(temporary, destination);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async writeStagingCiphertext(storageKey: string, ciphertext: Buffer): Promise<void> {
    await this.writeAtomic(this.stagingPath(storageKey), ciphertext);
  }

  async readCiphertext(storageKey: string, maximumBytes: number): Promise<Buffer> {
    return this.readOpaque(this.objectPath(storageKey), maximumBytes, "Encrypted document storage object is invalid");
  }

  private async readOpaque(path: string, maximumBytes: number, message: string): Promise<Buffer> {
    const handle = await open(path, "r");
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.size < 1 || details.size > maximumBytes) {
        throw new Error(message);
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async ciphertextExists(storageKey: string): Promise<boolean> {
    try {
      const details = await stat(this.objectPath(storageKey));
      return details.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async stagingExists(storageKey: string): Promise<boolean> {
    try {
      const details = await stat(this.stagingPath(storageKey));
      return details.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async listCiphertextObjects(): Promise<StoredCiphertextObject[]> {
    return this.listObjects(join(this.storageRoot, "objects"));
  }

  async listStagingObjects(): Promise<StoredCiphertextObject[]> {
    return this.listObjects(join(this.storageRoot, "staging"));
  }

  private async listObjects(objectsRoot: string): Promise<StoredCiphertextObject[]> {
    const objects: StoredCiphertextObject[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
        } else if (entry.isFile() && /^[a-f0-9]{64}\.bin$/.test(entry.name)) {
          objects.push({
            storageKey: entry.name.slice(0, -4),
            modifiedAt: (await stat(path)).mtime,
          });
        }
      }
    };
    await walk(objectsRoot);
    return objects;
  }

  /**
   * Removes `*.tmp` files left in objects/, staging/ and the quarantine root
   * by a process killed between a temporary write and its rename: nothing
   * else ever names them. A younger one may be a write still in flight.
   */
  async sweepTemporaryFiles(olderThanMs: number): Promise<void> {
    const boundary = Date.now() - olderThanMs;
    const sweep = async (directory: string, recurse: boolean): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (recurse) await sweep(path, true);
        } else if (entry.isFile() && entry.name.endsWith(".tmp")) {
          const details = await stat(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (details && details.mtimeMs < boundary) await rm(path, { force: true });
        }
      }
    };
    await sweep(join(this.storageRoot, "objects"), true);
    await sweep(join(this.storageRoot, "staging"), false);
    await sweep(this.quarantineRoot, false);
  }

  async deleteCiphertext(storageKey: string): Promise<void> {
    await rm(this.objectPath(storageKey), { force: true });
  }

  async deleteStagingCiphertext(storageKey: string): Promise<void> {
    await rm(this.stagingPath(storageKey), { force: true });
  }
}

/**
 * The document store for this instance's configuration. The one place the
 * roots are read from the config, so a caller does not restate the pairing
 * and a test has one function to replace (#1349, engine-27).
 */
export function openDocumentStorage(
  config: Pick<DocumentConfig, "storageRoot" | "quarantineRoot"> = getDocumentConfig(),
): LocalDocumentStorage {
  return new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
}
