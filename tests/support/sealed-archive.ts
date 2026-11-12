/**
 * The format v1 archive writer (#1506), kept for tests only since #1390:
 * Orbit no longer writes v1, but must keep opening it, so the v1 tests make
 * their archives here. The bytes are exactly what released Orbit wrote.
 */
import { createCipheriv, randomBytes, scryptSync, type CipherGCM } from "node:crypto";
import { requireExportPassphrase, type EncryptedPortableArchive } from "@/server/portable-archive";

const ARCHIVE_VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/**
 * Streaming v1 encryption: AES-256-GCM under scrypt, the ciphertext written
 * as base64url in 3-byte groups and the authentication tag last.
 */
export class PortableArchiveSealer {
  private readonly cipher: CipherGCM;
  private header: string | null;
  private carry: Buffer = Buffer.alloc(0);

  constructor(passphrase: string, private readonly write: (chunk: Buffer) => Promise<void>) {
    requireExportPassphrase(passphrase);
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const key = scryptSync(passphrase, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    try {
      this.cipher = createCipheriv("aes-256-gcm", key, iv);
    } finally { key.fill(0); }
    this.cipher.setAAD(Buffer.from(`orbit-portable-archive:${ARCHIVE_VERSION}`));
    this.header = `{"version":${ARCHIVE_VERSION},"algorithm":"aes-256-gcm","kdf":"scrypt","salt":${JSON.stringify(salt.toString("base64url"))},"iv":${JSON.stringify(iv.toString("base64url"))},"ciphertext":"`;
  }

  private async emit(ciphertext: Buffer, last: boolean): Promise<void> {
    if (this.header !== null) {
      const header = this.header;
      this.header = null;
      await this.write(Buffer.from(header));
    }
    const joined = this.carry.length === 0 ? ciphertext : Buffer.concat([this.carry, ciphertext]);
    const aligned = last ? joined.length : joined.length - (joined.length % 3);
    this.carry = Buffer.from(joined.subarray(aligned));
    if (aligned > 0) await this.write(Buffer.from(joined.subarray(0, aligned).toString("base64url"), "ascii"));
  }

  async push(plaintext: Buffer): Promise<void> {
    if (plaintext.length === 0) return;
    await this.emit(this.cipher.update(plaintext), false);
  }

  async finish(): Promise<void> {
    await this.emit(this.cipher.final(), true);
    await this.write(Buffer.from(`","authTag":${JSON.stringify(this.cipher.getAuthTag().toString("base64url"))}}`));
  }
}

/** A v1 archive file as released Orbit's export wrote it: authTag after ciphertext. */
export async function sealedArchiveFile(plaintext: Buffer, passphrase: string, pieceBytes = 65_536): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sealer = new PortableArchiveSealer(passphrase, async (chunk) => { chunks.push(Buffer.from(chunk)); });
  for (let offset = 0; offset < plaintext.length; offset += pieceBytes) await sealer.push(plaintext.subarray(offset, offset + pieceBytes));
  await sealer.finish();
  return Buffer.concat(chunks);
}

/** The same archive as the parsed object (fields in the file's order). */
export async function sealedArchive(plaintext: Buffer, passphrase: string): Promise<EncryptedPortableArchive> {
  return JSON.parse((await sealedArchiveFile(plaintext, passphrase)).toString("utf8")) as EncryptedPortableArchive;
}
