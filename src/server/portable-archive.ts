import { createDecipheriv, scrypt, type DecipherGCM } from "node:crypto";
import { MIN_PASSWORD_LENGTH, passwordLength } from "@/lib/password-length";

const ARCHIVE_VERSION = 1;
/** The full GCM tag. Node accepts a shorter one unless told otherwise, and a short tag is easier to forge (#1524). */
const TAG_BYTES = 16;

export interface EncryptedPortableArchive {
  version: 1;
  algorithm: "aes-256-gcm";
  kdf: "scrypt";
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

/**
 * The archive key, derived on the libuv threadpool (#1605 SEC-D3/1): a slow
 * scrypt no longer stalls every other request while it runs. Opening an
 * archive needs no passphrase floor: one sealed under a shorter passphrase
 * than today's floor must still open (#1333); the floor is held where a
 * passphrase is made (the export).
 */
function keyFor(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/**
 * The passphrase floor, held where a passphrase is made (the export) and not
 * where an archive is opened: an archive sealed under a shorter passphrase
 * than today's floor must still open (#1333).
 */
export function requireExportPassphrase(passphrase: string): void {
  if (passwordLength(passphrase) < MIN_PASSWORD_LENGTH) {
    throw new Error(`Export passphrase must contain at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

/**
 * The archive's authentication tag, refused unless it is the full 16 bytes
 * (#1524), and its decipher, made to accept only a 16-byte tag as well.
 */
async function openDecipher(archive: EncryptedPortableArchive, passphrase: string): Promise<DecipherGCM> {
  if (archive.version !== ARCHIVE_VERSION || archive.algorithm !== "aes-256-gcm" || archive.kdf !== "scrypt") throw new Error("Unsupported portable archive");
  const tag = Buffer.from(archive.authTag, "base64url");
  if (tag.length !== TAG_BYTES) throw new Error("Portable archive authentication tag is not 16 bytes");
  const key = await keyFor(passphrase, Buffer.from(archive.salt, "base64url"));
  let decipher: DecipherGCM;
  try {
    decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(archive.iv, "base64url"), { authTagLength: TAG_BYTES });
  } finally { key.fill(0); }
  decipher.setAAD(Buffer.from(`orbit-portable-archive:${ARCHIVE_VERSION}`));
  decipher.setAuthTag(tag);
  return decipher;
}

/** A whole v1 archive, decrypted at once; used only by tests (the import streams). */
export async function decryptPortableArchive(archive: EncryptedPortableArchive, passphrase: string): Promise<Buffer> {
  const decipher = await openDecipher(archive, passphrase);
  return Buffer.concat([decipher.update(Buffer.from(archive.ciphertext, "base64url")), decipher.final()]);
}

/**
 * Streaming authenticated decryption of a format v1 archive for preview and
 * import (#1521), push-style since #1566: the archive's
 * ciphertext is handed in a piece at a time as it is read from the upload,
 * so neither it nor the plaintext is ever held whole. Nothing `push` returns
 * may be used until `finish` has verified the authentication tag; a caller
 * writes the pieces somewhere private and reads them back only after. The
 * tag is needed only at `finish` (GCM's `setAuthTag` need only precede
 * `final`), so it may come before or after the ciphertext in the file. A
 * short tag, a wrong passphrase, a changed ciphertext or a changed tag all
 * throw at `finish`.
 */
export class PortableArchiveOpener {
  private constructor(private readonly decipher: DecipherGCM) {
    this.decipher.setAAD(Buffer.from(`orbit-portable-archive:${ARCHIVE_VERSION}`));
  }

  /** Derives the key (asynchronously, #1605 SEC-D3/1) and readies the decipher. */
  static async open(salt: string, iv: string, passphrase: string): Promise<PortableArchiveOpener> {
    const key = await keyFor(passphrase, Buffer.from(salt, "base64url"));
    try {
      return new PortableArchiveOpener(createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: TAG_BYTES }));
    } finally { key.fill(0); }
  }

  /** Decrypts the next piece of ciphertext; the plaintext is unverified until `finish`. */
  push(ciphertext: Buffer): Buffer {
    return this.decipher.update(ciphertext);
  }

  /** Verifies the authentication tag over everything `push` returned; throws if it is short or does not match. */
  finish(authTag: string): void {
    const tag = Buffer.from(authTag, "base64url");
    if (tag.length !== TAG_BYTES) throw new Error("Portable archive authentication tag is not 16 bytes");
    this.decipher.setAuthTag(tag);
    // GCM is a stream mode: `final` returns no further plaintext, only the verdict.
    this.decipher.final();
  }
}

/** Validates the outer wire shape before deriving a passphrase key. */
export function isEncryptedPortableArchive(value: unknown): value is EncryptedPortableArchive {
  if (!value || typeof value !== "object") return false;
  const archive = value as Record<string, unknown>;
  return archive.version === 1 && archive.algorithm === "aes-256-gcm" && archive.kdf === "scrypt"
    && ["salt", "iv", "authTag", "ciphertext"].every((field) => typeof archive[field] === "string" && archive[field].length > 0);
}
