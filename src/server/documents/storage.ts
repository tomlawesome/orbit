import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppError } from "@/lib/app-error";

const STORAGE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const DOCUMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface ReceivedDocument {
  quarantinePath: string;
  sizeBytes: number;
  contentSha256: string;
  leadingBytes: Buffer;
}

export interface StoredCiphertextObject {
  storageKey: string;
  modifiedAt: Date;
}

function requireDocumentId(documentId: string): void {
  if (!DOCUMENT_ID_PATTERN.test(documentId)) throw new Error("Invalid document identifier");
}

function requireStorageKey(storageKey: string): void {
  if (!STORAGE_KEY_PATTERN.test(storageKey)) throw new Error("Invalid document storage key");
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
    const handle = await open(quarantinePath, "wx", 0o600);
    const digest = createHash("sha256");
    const leadingChunks: Buffer[] = [];
    let leadingLength = 0;
    let sizeBytes = 0;
    const reader = body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        sizeBytes += chunk.length;
        if (sizeBytes > maximumBytes) {
          throw new AppError("document_too_large", "That document exceeds the configured size limit", 413);
        }
        digest.update(chunk);
        if (leadingLength < 512) {
          const prefix = chunk.subarray(0, 512 - leadingLength);
          leadingChunks.push(prefix);
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
      throw error;
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

  async discardQuarantine(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  async writeQuarantineBytes(documentId: string, bytes: Buffer): Promise<string> {
    requireDocumentId(documentId);
    await this.initialize();
    const path = join(this.quarantineRoot, `${documentId}.${randomBytes(16).toString("hex")}.recovery`);
    await this.writeAtomic(path, bytes);
    return path;
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

  async readStagingCiphertext(storageKey: string, maximumBytes: number): Promise<Buffer> {
    return this.readOpaque(this.stagingPath(storageKey), maximumBytes + 1_024, "Encrypted staging object is invalid");
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

  async deleteCiphertext(storageKey: string): Promise<void> {
    await rm(this.objectPath(storageKey), { force: true });
  }

  async deleteStagingCiphertext(storageKey: string): Promise<void> {
    await rm(this.stagingPath(storageKey), { force: true });
  }
}
