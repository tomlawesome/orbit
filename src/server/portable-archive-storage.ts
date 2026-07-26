import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const STORAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StoredPortableArchive { storageKey: string; modifiedAt: Date }

/** Private local storage for encrypted portability exports. */
export class PortableArchiveStorage {
  constructor(private readonly root: string) {}

  createStorageKey(): string {
    return randomUUID();
  }

  private pathFor(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) throw new Error("Invalid portable archive storage key");
    return join(this.root, `${storageKey}.archive`);
  }

  async write(storageKey: string, contents: Buffer): Promise<void> {
    const destination = this.pathFor(storageKey);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async read(storageKey: string, maximumBytes: number): Promise<Buffer> {
    const contents = await readFile(this.pathFor(storageKey));
    if (contents.length > maximumBytes) {
      contents.fill(0);
      throw new Error("Portable archive exceeds its expected size");
    }
    return contents;
  }

  async delete(storageKey: string): Promise<void> {
    await rm(this.pathFor(storageKey), { force: true });
  }

  async list(): Promise<StoredPortableArchive[]> {
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const result: StoredPortableArchive[] = [];
    for (const entry of entries) {
      const match = entry.isFile() && entry.name.match(/^([0-9a-f-]{36})\.archive$/i);
      if (!match || !STORAGE_KEY_PATTERN.test(match[1])) continue;
      result.push({ storageKey: match[1], modifiedAt: (await stat(join(this.root, entry.name))).mtime });
    }
    return result;
  }
}
