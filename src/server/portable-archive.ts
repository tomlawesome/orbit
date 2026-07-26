import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ARCHIVE_VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;

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
  if (passphrase.length < 12) throw new Error("Export passphrase must contain at least 12 characters");
  return scryptSync(passphrase, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

/** Encrypts a portable archive with a user-supplied passphrase that is never persisted. */
export function encryptPortableArchive(plaintext: Buffer, passphrase: string): EncryptedPortableArchive {
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

export function decryptPortableArchive(archive: EncryptedPortableArchive, passphrase: string): Buffer {
  if (archive.version !== ARCHIVE_VERSION || archive.algorithm !== "aes-256-gcm" || archive.kdf !== "scrypt") throw new Error("Unsupported portable archive");
  const key = keyFor(passphrase, Buffer.from(archive.salt, "base64url"));
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(archive.iv, "base64url"));
    decipher.setAAD(Buffer.from(`orbit-portable-archive:${ARCHIVE_VERSION}`));
    decipher.setAuthTag(Buffer.from(archive.authTag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(archive.ciphertext, "base64url")), decipher.final()]);
  } finally { key.fill(0); }
}

/** Validates the outer wire shape before deriving a passphrase key. */
export function isEncryptedPortableArchive(value: unknown): value is EncryptedPortableArchive {
  if (!value || typeof value !== "object") return false;
  const archive = value as Record<string, unknown>;
  return archive.version === 1 && archive.algorithm === "aes-256-gcm" && archive.kdf === "scrypt"
    && ["salt", "iv", "authTag", "ciphertext"].every((field) => typeof archive[field] === "string" && archive[field].length > 0);
}
