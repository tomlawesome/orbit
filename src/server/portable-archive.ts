import { createCipheriv, createDecipheriv, randomBytes, scryptSync, type CipherGCM, type DecipherGCM } from "node:crypto";
import { MIN_PASSWORD_LENGTH, passwordLength } from "@/lib/password-length";

const ARCHIVE_VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
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

function keyFor(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function requireExportPassphrase(passphrase: string): void {
  // The floor is held here, where a passphrase is made, and not in `keyFor`,
  // which opening an archive shares: an archive sealed under a shorter
  // passphrase than today's floor must still open (#1333).
  if (passwordLength(passphrase) < MIN_PASSWORD_LENGTH) {
    throw new Error(`Export passphrase must contain at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

/** Encrypts a portable archive with a user-supplied passphrase that is never persisted. */
export function encryptPortableArchive(plaintext: Buffer, passphrase: string): EncryptedPortableArchive {
  requireExportPassphrase(passphrase);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = keyFor(passphrase, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`orbit-portable-archive:${ARCHIVE_VERSION}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { version: ARCHIVE_VERSION, algorithm: "aes-256-gcm", kdf: "scrypt", salt: salt.toString("base64url"), iv: iv.toString("base64url"), authTag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  } finally { key.fill(0); }
}

/**
 * Streaming authenticated encryption for the export (#1506): the same
 * AES-256-GCM, scrypt key, salt, IV, AAD and JSON fields as
 * `encryptPortableArchive`, but the plaintext goes in piece by piece and the
 * archive file comes out piece by piece, with the authentication tag written
 * last (GCM only knows it after the final block). Neither side is ever held
 * whole. Base64url is written in 3-byte groups so the pieces concatenate to
 * exactly what one `toString("base64url")` of the whole ciphertext gives.
 */
export class PortableArchiveSealer {
  private readonly cipher: CipherGCM;
  private header: string | null;
  private carry: Buffer = Buffer.alloc(0);

  constructor(passphrase: string, private readonly write: (chunk: Buffer) => Promise<void>) {
    requireExportPassphrase(passphrase);
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const key = keyFor(passphrase, salt);
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

  /** Encrypts one piece of the plaintext and writes its ciphertext. */
  async push(plaintext: Buffer): Promise<void> {
    if (plaintext.length === 0) return;
    await this.emit(this.cipher.update(plaintext), false);
  }

  /** Ends the ciphertext and writes the authentication tag after it. */
  async finish(): Promise<void> {
    await this.emit(this.cipher.final(), true);
    await this.write(Buffer.from(`","authTag":${JSON.stringify(this.cipher.getAuthTag().toString("base64url"))}}`));
  }
}

/**
 * The archive's authentication tag, refused unless it is the full 16 bytes
 * (#1524), and its decipher, made to accept only a 16-byte tag as well.
 */
function openDecipher(archive: EncryptedPortableArchive, passphrase: string): DecipherGCM {
  if (archive.version !== ARCHIVE_VERSION || archive.algorithm !== "aes-256-gcm" || archive.kdf !== "scrypt") throw new Error("Unsupported portable archive");
  const tag = Buffer.from(archive.authTag, "base64url");
  if (tag.length !== TAG_BYTES) throw new Error("Portable archive authentication tag is not 16 bytes");
  const key = keyFor(passphrase, Buffer.from(archive.salt, "base64url"));
  let decipher: DecipherGCM;
  try {
    decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(archive.iv, "base64url"), { authTagLength: TAG_BYTES });
  } finally { key.fill(0); }
  decipher.setAAD(Buffer.from(`orbit-portable-archive:${ARCHIVE_VERSION}`));
  decipher.setAuthTag(tag);
  return decipher;
}

export function decryptPortableArchive(archive: EncryptedPortableArchive, passphrase: string): Buffer {
  const decipher = openDecipher(archive, passphrase);
  return Buffer.concat([decipher.update(Buffer.from(archive.ciphertext, "base64url")), decipher.final()]);
}

/**
 * Streaming authenticated decryption for preview and import (#1521), the
 * reverse of `PortableArchiveSealer`, push-style since #1566: the archive's
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
  private readonly decipher: DecipherGCM;

  constructor(salt: string, iv: string, passphrase: string) {
    const key = keyFor(passphrase, Buffer.from(salt, "base64url"));
    try {
      this.decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: TAG_BYTES });
    } finally { key.fill(0); }
    this.decipher.setAAD(Buffer.from(`orbit-portable-archive:${ARCHIVE_VERSION}`));
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
