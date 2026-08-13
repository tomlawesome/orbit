import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

// The backup-bundle and recovery-bundle *format* core (issue #296 slice 1),
// ported from:
//   - scripts/recovery-crypto.mjs (the ORBKEK01 passphrase envelope, HMAC
//     bundle authentication, and document-KEK fingerprint — the single place
//     the Bash flows touch raw key material)
//   - scripts/backup.sh's validate_bundle / validate_document_archive (the
//     inner "orbit-*.tar" backup bundle's manifest, member allow-list, and
//     document-archive path allow-list)
//   - scripts/export-recovery-bundle.sh / scripts/import-recovery-bundle.sh
//     (the outer "orbit-recovery-*.tar" envelope around an already-verified
//     backup bundle plus a passphrase-wrapped document KEK)
//
// This module is pure filesystem/crypto logic: no Docker, no network, no
// Postgres, except where a thin adapter (BackupDockerAdapter, below) is
// injected at the call site for the handful of operations that genuinely
// need a live deployment — `pg_restore --list`, `pg_dump`, and the
// document-tar collection. Every guarantee number cited below is from
// docs/installer-guarantees.md, Part 2, and is re-asserted by name in the
// *.test.ts files alongside this module.
//
// Slice 2 (issue #296) adds the AES-256-CBC/PBKDF2-SHA256 document-archive
// encryption (byte-compatible with `openssl enc -pbkdf2`, backup.sh
// #19-20,27-28), completes backup.sh's validate_bundle end-to-end via the
// `pg_restore --list` liveness check (#18), and ports create_bundle's
// packaging orchestration (#21-34) — both using BackupDockerAdapter to keep
// the Docker/Postgres edge thin and injectable, mirroring how
// src/lib/config-contract.ts keeps filesystem facts injected rather than
// probed inline. See docs/adr-notes/296-backup-port-plan.md.

// ---------------------------------------------------------------------------
// Permission semantics (mirrors src/lib/install-transaction.ts's discipline)
// ---------------------------------------------------------------------------

/** Mode private backup/recovery work directories must be created at (backup.sh #21, export-recovery-bundle.sh #9). */
export const SECURE_DIRECTORY_MODE = 0o700;

/** Mode secret-bearing bundle members (document-kek, document-kek.enc, manifest.hmac) must never exceed (import-recovery-bundle.sh #11, #16). */
export const SECURE_FILE_MODE = 0o600;

/**
 * Writes content with its final permission mode forced before any byte is
 * written — never briefly world/group-readable — mirroring
 * InstallTransaction.writeStagedFile's mktemp+chmod-before-write discipline
 * and configure.sh's own secret-writing pattern (guarantee #16 in Part 1).
 */
export function writeSecretFile(path: string, content: string | Buffer, mode: number = SECURE_FILE_MODE): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, mode);
  try {
    fchmodSync(descriptor, mode);
    writeSync(descriptor, typeof content === "string" ? Buffer.from(content, "utf8") : content);
  } finally {
    closeSync(descriptor);
  }
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type RecoveryBundleRefusalCode =
  | "not-regular-file"
  | "archive-invalid"
  | "unexpected-members"
  | "link-or-special-entry"
  | "misplaced-object"
  | "unsupported-format-version"
  | "checksum-mismatch"
  | "hmac-mismatch"
  | "wrong-key"
  | "invalid-envelope"
  | "wrong-passphrase"
  | "invalid-recovered-key"
  | "passphrase-too-short"
  | "passphrase-mismatch"
  | "invalid-key-file"
  | "document-archive-invalid"
  | "database-archive-invalid"
  | "empty-database-dump"
  | "database-dump-failed"
  | "document-archive-collection-failed"
  | "app-stop-failed"
  | "app-start-failed"
  | "bundle-already-exists";

/**
 * Thrown for every fail-closed refusal this module makes. Never carries
 * secret material, digests of secret material, or attacker-controlled
 * member/path names in its message — mirroring the Bash scripts' own stable,
 * category-only diagnostic strings (`preflight/archive failed`, etc.; see
 * test_recovery_bundle_diagnostics in scripts/test-backup-restore.sh, which
 * asserts raw tar/sha256sum output and member names are never exposed).
 */
export class RecoveryBundleRefusal extends Error {
  readonly code: RecoveryBundleRefusalCode;

  constructor(message: string, code: RecoveryBundleRefusalCode) {
    super(message);
    this.name = "RecoveryBundleRefusal";
    this.code = code;
  }
}

function refuse(code: RecoveryBundleRefusalCode, message: string): never {
  throw new RecoveryBundleRefusal(message, code);
}

// ---------------------------------------------------------------------------
// Crypto primitives — 1:1 port of scripts/recovery-crypto.mjs
// ---------------------------------------------------------------------------

const ORBKEK_MAGIC = Buffer.from("ORBKEK01", "ascii");
const ORBKEK_SALT_BYTES = 16;
const ORBKEK_IV_BYTES = 12;
const ORBKEK_TAG_BYTES = 16;
const ORBKEK_KEY_BYTES = 32;
const ORBKEK_SCRYPT = { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

/** recovery-crypto.mjs guarantee #1: enforced independently of every caller's own check. */
export const MIN_RECOVERY_PASSPHRASE_LENGTH = 12;

/** The exact algorithm identifier the recovery-bundle manifest records (export-recovery-bundle.sh #14). */
export const RECOVERY_KEY_ENCRYPTION_ALGORITHM = "aes-256-gcm-scrypt-n131072-r8-p1";

const DOCUMENT_KEK_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;
const DOCUMENT_KEK_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const BUNDLE_HMAC_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export function isValidDocumentKekHex(value: string): boolean {
  return DOCUMENT_KEK_HEX_PATTERN.test(value.trim());
}

/** recovery-crypto.mjs guarantee #1 / export-recovery-bundle.sh #6. */
export function isValidPassphrase(value: string): boolean {
  return value.length >= MIN_RECOVERY_PASSPHRASE_LENGTH;
}

function deriveRecoveryKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, ORBKEK_KEY_BYTES, ORBKEK_SCRYPT);
}

/**
 * encrypt (recovery-crypto.mjs:39-56): wraps a 32-byte-hex document KEK in a
 * fresh-salt, fresh-IV AES-256-GCM envelope keyed by scrypt(passphrase, salt)
 * (guarantee #3), AAD-bound to the ORBKEK01 magic (#4), zeroing the derived
 * key and plaintext after use (#5).
 */
export function encryptDocumentKek(hexKey: string, passphrase: string): Buffer {
  if (!isValidPassphrase(passphrase)) {
    refuse("passphrase-too-short", `Use a recovery passphrase of at least ${MIN_RECOVERY_PASSPHRASE_LENGTH} characters.`);
  }
  const trimmed = hexKey.replace(/[\r\n]+$/, "");
  if (!isValidDocumentKekHex(trimmed)) {
    refuse("invalid-key-file", "The input is not a 32-byte hexadecimal document key.");
  }
  const plaintext = Buffer.from(trimmed, "ascii");
  const salt = randomBytes(ORBKEK_SALT_BYTES);
  const iv = randomBytes(ORBKEK_IV_BYTES);
  const key = deriveRecoveryKey(passphrase, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: ORBKEK_TAG_BYTES });
    cipher.setAAD(ORBKEK_MAGIC);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([ORBKEK_MAGIC, salt, iv, cipher.getAuthTag(), ciphertext]);
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

/**
 * decrypt (recovery-crypto.mjs:58-84): rejects a too-short or bad-magic
 * envelope before any cryptographic operation (#6); a wrong passphrase or
 * tampered ciphertext fails the GCM auth-tag check and is reported only as
 * "wrong-passphrase", never a detailed crypto error (#7); the recovered
 * plaintext is format-checked as a 64-hex-char key, zeroed before the
 * failure path if not (#8); the derived key is always zeroed (#9).
 */
export function decryptDocumentKek(envelope: Buffer, passphrase: string): Buffer {
  const headerBytes = ORBKEK_MAGIC.length + ORBKEK_SALT_BYTES + ORBKEK_IV_BYTES + ORBKEK_TAG_BYTES;
  if (envelope.length <= headerBytes || !envelope.subarray(0, ORBKEK_MAGIC.length).equals(ORBKEK_MAGIC)) {
    refuse("invalid-envelope", "Unsupported or corrupt recovery-key envelope.");
  }
  let offset = ORBKEK_MAGIC.length;
  const salt = envelope.subarray(offset, (offset += ORBKEK_SALT_BYTES));
  const iv = envelope.subarray(offset, (offset += ORBKEK_IV_BYTES));
  const tag = envelope.subarray(offset, (offset += ORBKEK_TAG_BYTES));
  const ciphertext = envelope.subarray(offset);
  const key = deriveRecoveryKey(passphrase, salt);
  try {
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: ORBKEK_TAG_BYTES });
      decipher.setAAD(ORBKEK_MAGIC);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      refuse("wrong-passphrase", "Passphrase verification failed.");
    }
    if (!DOCUMENT_KEK_HEX_PATTERN.test(plaintext.toString("ascii"))) {
      plaintext.fill(0);
      refuse("invalid-recovered-key", "Decrypted content is not a valid document key.");
    }
    return plaintext;
  } finally {
    key.fill(0);
  }
}

/**
 * hmac (recovery-crypto.mjs:96-105): authenticates bundle manifest+checksums
 * content with a key-separated sub-key,
 * `HMAC-SHA256(document_kek, "orbit-backup-authentication-v1")` — never the
 * raw document KEK itself (#12) — zeroing the sub-key immediately after use
 * (#13). Output is base64 (backup.sh #5 / #16 format check applies at the
 * call site via verifyBundleHmac's caller).
 */
export function computeBundleHmac(documentKekHex: string, content: Buffer): string {
  const key = Buffer.from(documentKekHex, "hex");
  const authenticationKey = createHmac("sha256", key).update("orbit-backup-authentication-v1", "utf8").digest();
  try {
    return createHmac("sha256", authenticationKey).update(content).digest("base64");
  } finally {
    authenticationKey.fill(0);
  }
}

/** Format-checks an HMAC the way backup.sh/restore.sh do before ever comparing it (#5). */
export function isValidBundleHmac(value: string): boolean {
  return BUNDLE_HMAC_PATTERN.test(value.trim());
}

/**
 * verify_hmac (backup.sh:69-75 / restore.sh:81-87): recomputes the HMAC over
 * `content` and compares byte-for-byte against `expectedBase64` (guarantee
 * #7), refusing rather than doing a variable-time string compare.
 */
export function verifyBundleHmac(documentKekHex: string, content: Buffer, expectedBase64: string): void {
  const expected = expectedBase64.trim();
  if (!isValidBundleHmac(expected)) {
    refuse("hmac-mismatch", "Bundle manifest authentication failed.");
  }
  const actual = computeBundleHmac(documentKekHex, content);
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    refuse("hmac-mismatch", "Bundle manifest authentication failed.");
  }
}

/**
 * fingerprint (recovery-crypto.mjs:107): `sha256(key)` hex only — lets
 * callers verify key identity without ever exposing the key itself (#15).
 * Zeroes the raw key buffer after use (#14).
 */
export function documentKekFingerprint(documentKekHex: string): string {
  const key = Buffer.from(documentKekHex, "hex");
  try {
    return createHash("sha256").update(key).digest("hex");
  } finally {
    key.fill(0);
  }
}

export function isValidDocumentKekFingerprint(value: string): boolean {
  return DOCUMENT_KEK_FINGERPRINT_PATTERN.test(value);
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// Regular-file / non-symlink preflight (shared by both bundle types)
// ---------------------------------------------------------------------------

/** Mirrors `[[ -f "$path" && ! -L "$path" ]]`, used throughout both scripts for every bundle/key path. */
export function isRegularNonSymlinkFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export function requireRegularNonSymlinkFile(path: string, message: string): void {
  if (!isRegularNonSymlinkFile(path)) {
    refuse("not-regular-file", message);
  }
}

// ---------------------------------------------------------------------------
// Tar helpers — thin wrappers around the external `tar` binary, mirroring
// the Bash scripts' own dependency on it (no new npm dependency).
// ---------------------------------------------------------------------------

interface TarEntry {
  typeChar: string;
  name: string;
}

function runTar(args: string[]): { status: number; stdout: string } {
  const result = spawnSync("tar", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  if (result.error) return { status: 1, stdout: "" };
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

/** `tar -tf <path>` — the plain member-name listing used to check the exact expected member set. */
export function listTarMembers(tarPath: string): string[] {
  const { status, stdout } = runTar(["-tf", tarPath]);
  if (status !== 0) refuse("archive-invalid", "Bundle archive is invalid.");
  return stdout.split("\n").filter((line) => line.length > 0);
}

/** `tar -tvf <path>` parsed into (type-char, name) pairs — the verbose listing used for link/special-file rejection. */
export function listTarEntriesVerbose(tarPath: string): TarEntry[] {
  const { status, stdout } = runTar(["-tvf", tarPath]);
  if (status !== 0) refuse("archive-invalid", "Bundle archive is invalid.");
  const entries: TarEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const firstField = line.trimStart().split(/\s+/, 1)[0];
    const nameField = line.slice(line.lastIndexOf(" ") + 1);
    entries.push({ typeChar: firstField.charAt(0), name: nameField });
  }
  return entries;
}

export function extractTar(tarPath: string, destinationDir: string): void {
  const { status } = runTar(["-xf", tarPath, "-C", destinationDir]);
  if (status !== 0) refuse("archive-invalid", "Bundle archive could not be extracted.");
}

/** `tar -C workDir -cf outputPath <members...>`, in the exact member order given — matches the Bash scripts' own fixed argument order. */
export function createTar(workDir: string, outputPath: string, members: readonly string[]): void {
  const result = spawnSync("tar", ["-C", workDir, "-cf", outputPath, ...members], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`tar failed to package the bundle: ${result.stderr ?? ""}`);
  }
}

// ---------------------------------------------------------------------------
// Manifest text — plain `key=value` lines, in a fixed field order, matching
// the Bash scripts' own `cat > manifest <<EOF ... EOF` / `printf` output
// byte-for-byte (so an HMAC computed over the same field values matches).
// ---------------------------------------------------------------------------

export function buildManifest(fields: readonly (readonly [string, string])[]): string {
  return fields.map(([key, value]) => `${key}=${value}\n`).join("");
}

/** Mirrors `grep --quiet "^key=value$"` — an exact single-line match, not a substring/regex search over the value. */
export function manifestDeclares(content: string, key: string, value: string): boolean {
  const target = `${key}=${value}`;
  return content.split("\n").some((line) => line === target);
}

export function readManifestField(content: string, key: string): string | undefined {
  const prefix = `${key}=`;
  for (const line of content.split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Backup bundle ("orbit-<timestamp>.tar") — scripts/backup.sh
// ---------------------------------------------------------------------------

export const BACKUP_BUNDLE_FORMAT_VERSION = "1";

/** backup.sh #13: exactly these five members, no more, no fewer. */
export const BACKUP_BUNDLE_MEMBERS = ["checksums.sha256", "database.dump", "documents.tar.enc", "manifest", "manifest.hmac"] as const;

/** The algorithm identifier backup.sh's manifest records for the document archive (guarantee #27). */
export const DOCUMENT_ARCHIVE_ENCRYPTION_ALGORITHM = "aes-256-cbc-pbkdf2-sha256-iter-600000";

// ---------------------------------------------------------------------------
// Document-archive payload crypto (backup.sh #19-20,27-28) — byte-compatible
// with `openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -salt -pass
// file:<document-kek-file>` (backup.sh:128-130,156-157 / restore.sh:145-147).
// OpenSSL's `-pass file:PATH` reads PATH's first line (delimited by `\n`,
// not trimmed of trailing `\r`) verbatim as the passphrase; the document-KEK
// file is a 64-hex-char line with a trailing `\n` on every real deployment,
// so the already-validated `documentKekHex` string (see isValidDocumentKekHex)
// is exactly that passphrase. With `-pbkdf2`, OpenSSL derives key||iv (48
// bytes for aes-256-cbc: 32 key + 16 IV) in one PBKDF2-HMAC-SHA256 call
// keyed by the passphrase and the envelope's own 8-byte salt, then splits
// the output — verified byte-for-byte both directions against the real
// `openssl` binary in recovery-bundle.parity.test.ts.
// ---------------------------------------------------------------------------

const DOCUMENT_ARCHIVE_MAGIC = Buffer.from("Salted__", "ascii");
const DOCUMENT_ARCHIVE_SALT_BYTES = 8;
const DOCUMENT_ARCHIVE_PBKDF2_ITERATIONS = 600_000;
const DOCUMENT_ARCHIVE_KEY_BYTES = 32;
const DOCUMENT_ARCHIVE_IV_BYTES = 16;

function deriveDocumentArchiveKeyIv(documentKekHex: string, salt: Buffer): { key: Buffer; iv: Buffer } {
  const derived = pbkdf2Sync(
    documentKekHex,
    salt,
    DOCUMENT_ARCHIVE_PBKDF2_ITERATIONS,
    DOCUMENT_ARCHIVE_KEY_BYTES + DOCUMENT_ARCHIVE_IV_BYTES,
    "sha256",
  );
  return { key: derived.subarray(0, DOCUMENT_ARCHIVE_KEY_BYTES), iv: derived.subarray(DOCUMENT_ARCHIVE_KEY_BYTES) };
}

/**
 * encrypt (backup.sh:156-157): AES-256-CBC-encrypts `plaintext` (the
 * document tar) under a key/IV pair PBKDF2-derived from `documentKekHex` and
 * a fresh random 8-byte salt, prefixed with OpenSSL's own `Salted__` +
 * salt header so the output is byte-identical to what `openssl enc
 * -pbkdf2 -salt` would produce for the same salt (guarantee #27).
 */
export function encryptDocumentArchive(plaintext: Buffer, documentKekHex: string): Buffer {
  const salt = randomBytes(DOCUMENT_ARCHIVE_SALT_BYTES);
  const { key, iv } = deriveDocumentArchiveKeyIv(documentKekHex, salt);
  try {
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([DOCUMENT_ARCHIVE_MAGIC, salt, ciphertext]);
  } finally {
    key.fill(0);
    iv.fill(0);
  }
}

/**
 * decrypt (backup.sh:128-130 / restore.sh:145-147): rejects an envelope
 * that is too short or missing the `Salted__` header before any
 * cryptographic operation, and reports any decryption failure (wrong key,
 * truncated/tampered ciphertext — AES-CBC has no built-in authentication,
 * so this surfaces as a PKCS#7 padding error) with the same generic
 * refusal the Bash scripts give, never a raw OpenSSL diagnostic
 * (guarantees #19-20).
 */
export function decryptDocumentArchive(envelope: Buffer, documentKekHex: string): Buffer {
  const headerBytes = DOCUMENT_ARCHIVE_MAGIC.length + DOCUMENT_ARCHIVE_SALT_BYTES;
  if (envelope.length < headerBytes || !envelope.subarray(0, DOCUMENT_ARCHIVE_MAGIC.length).equals(DOCUMENT_ARCHIVE_MAGIC)) {
    refuse("document-archive-invalid", "Document archive decryption failed.");
  }
  const salt = envelope.subarray(DOCUMENT_ARCHIVE_MAGIC.length, headerBytes);
  const ciphertext = envelope.subarray(headerBytes);
  const { key, iv } = deriveDocumentArchiveKeyIv(documentKekHex, salt);
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    refuse("document-archive-invalid", "Document archive decryption failed.");
  } finally {
    key.fill(0);
    iv.fill(0);
  }
}

export interface BackupManifestFields {
  createdAt: string;
  databaseDump: string;
  documentsArchive: string;
  documentsEncryption: string;
  documentKekSha256: string;
}

/** Mirrors backup.sh:160-167's `cat > manifest <<EOF` block field-for-field and in the same order. */
export function buildBackupManifest(fields: BackupManifestFields): string {
  return buildManifest([
    ["format_version", BACKUP_BUNDLE_FORMAT_VERSION],
    ["created_at", fields.createdAt],
    ["database_dump", fields.databaseDump],
    ["documents_archive", fields.documentsArchive],
    ["documents_encryption", fields.documentsEncryption],
    ["document_kek_sha256", fields.documentKekSha256],
  ]);
}

/**
 * The member-set and link/special-file checks from backup.sh's validate_bundle
 * (:109-115) and restore.sh's validate_bundle_layout (:116-128). Throws
 * before any extraction is attempted.
 */
export function validateBackupBundleLayout(tarPath: string): void {
  const members = [...listTarMembers(tarPath)].sort();
  const expected = [...BACKUP_BUNDLE_MEMBERS].sort();
  if (members.length !== expected.length || !members.every((name, index) => name === expected[index])) {
    refuse("unexpected-members", "Bundle does not contain the expected recovery files.");
  }
  const entries = listTarEntriesVerbose(tarPath);
  if (entries.some((entry) => entry.typeChar !== "-")) {
    refuse("link-or-special-entry", "Bundle contains a link or special file.");
  }
}

const OBJECT_PATH_PATTERN = /^\.\/objects\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-f0-9]{64})\.bin$/;
const STAGING_PATH_PATTERN = /^\.\/staging\/[a-f0-9]{64}\.bin$/;
const SCAFFOLD_PATHS = new Set(["." , "./", "./objects", "./objects/", "./staging", "./staging/"]);
const OBJECT_PREFIX_DIR_PATTERN = /^\.\/objects\/[a-f0-9]{2}\/?$/;
const OBJECT_PREFIX_SUBDIR_PATTERN = /^\.\/objects\/[a-f0-9]{2}\/[a-f0-9]{2}\/?$/;

/**
 * validate_document_archive (backup.sh:77-100 / restore.sh:89-114): every
 * entry must be exactly the directory scaffolding, `objects/xx/yy/<hash>.bin`
 * with the first four hash characters matching its own `xx/yy` directory
 * (#9), or `staging/<hash>.bin` (#8); anything else — including a link or
 * special file (#10) — is refused.
 */
export function validateDocumentArchiveEntries(entries: readonly TarEntry[]): void {
  for (const entry of entries) {
    const name = entry.name;
    if (SCAFFOLD_PATHS.has(name) || OBJECT_PREFIX_DIR_PATTERN.test(name) || OBJECT_PREFIX_SUBDIR_PATTERN.test(name)) {
      continue;
    }
    if (STAGING_PATH_PATTERN.test(name)) continue;
    const objectMatch = OBJECT_PATH_PATTERN.exec(name);
    if (objectMatch) {
      const [, dirA, dirB, hash] = objectMatch;
      if (`${dirA}${dirB}` !== hash.slice(0, 4)) {
        refuse("misplaced-object", "Document archive contains a misplaced object.");
      }
      continue;
    }
    refuse("link-or-special-entry", "Document archive contains an unexpected path.");
  }
  if (entries.some((entry) => entry.typeChar !== "-" && entry.typeChar !== "d")) {
    refuse("link-or-special-entry", "Document archive contains a link or special file.");
  }
}

/**
 * Verifies a backup bundle's manifest, HMAC, and checksums against an
 * already-extracted directory (caller has run validateBackupBundleLayout and
 * extractTar first). Mirrors backup.sh:118-125 / restore.sh:140-148, minus
 * the pg_restore --list and document-archive-decrypt steps (see module
 * comment) — those remain the caller's responsibility until a later slice.
 */
export function validateBackupManifestAndAuth(extractedDir: string, documentKekHex: string): BackupManifestFields {
  const manifestPath = `${extractedDir}/manifest`;
  const checksumsPath = `${extractedDir}/checksums.sha256`;
  const hmacPath = `${extractedDir}/manifest.hmac`;
  const manifest = readFileSync(manifestPath, "utf8");

  if (!manifestDeclares(manifest, "format_version", BACKUP_BUNDLE_FORMAT_VERSION)) {
    refuse("unsupported-format-version", "Unsupported bundle format.");
  }
  const fingerprint = documentKekFingerprint(documentKekHex);
  if (!manifestDeclares(manifest, "document_kek_sha256", fingerprint)) {
    refuse("wrong-key", "Bundle was encrypted with a different document KEK.");
  }

  const checksumsContent = readFileSync(checksumsPath);
  const manifestAndChecksums = Buffer.concat([readFileSync(manifestPath), checksumsContent]);
  const hmac = readFileSync(hmacPath, "utf8");
  verifyBundleHmac(documentKekHex, manifestAndChecksums, hmac);

  verifyChecksumsFile(extractedDir, checksumsPath);

  return {
    createdAt: readManifestField(manifest, "created_at") ?? "",
    databaseDump: readManifestField(manifest, "database_dump") ?? "",
    documentsArchive: readManifestField(manifest, "documents_archive") ?? "",
    documentsEncryption: readManifestField(manifest, "documents_encryption") ?? "",
    documentKekSha256: fingerprint,
  };
}

/**
 * `sha256sum --check --status`-equivalent: every `<digest>  <name>` line in
 * checksumsPath must match the actual file's digest under extractedDir, or
 * the bundle is refused (backup.sh #17 / restore.sh preflight/checksum).
 */
export function verifyChecksumsFile(extractedDir: string, checksumsPath: string): void {
  const content = readFileSync(checksumsPath, "utf8");
  const lines = content.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) refuse("checksum-mismatch", "A bundle member is corrupt.");
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) refuse("checksum-mismatch", "A bundle member is corrupt.");
    const [, expectedDigest, memberName] = match;
    let actualDigest: string;
    try {
      actualDigest = sha256File(`${extractedDir}/${memberName}`);
    } catch {
      refuse("checksum-mismatch", "A bundle member is corrupt.");
    }
    if (actualDigest !== expectedDigest) {
      refuse("checksum-mismatch", "A bundle member is corrupt.");
    }
  }
}

// ---------------------------------------------------------------------------
// BackupDockerAdapter — the thin, injectable edge over the handful of
// operations that genuinely need a live Docker/Postgres deployment
// (`pg_restore --list`, `pg_dump`, the document-tar collection, and
// stopping/starting `orbit-app` around a point-in-time backup). Mirrors the
// plan's "thin injected adapter" shape (docs/adr-notes/296-backup-port-plan.md):
// the orchestration functions below (validateBackupBundleContents,
// createBackupBundle) depend only on this interface, never on `docker`
// directly, so they are fully testable with an in-memory fake and require no
// live daemon. createDockerComposeBackupAdapter is the real implementation,
// spawning the exact `docker compose ...` argument lists backup.sh uses
// (:30-32,126-127,147,149-157) — its own shape is exercised in
// recovery-bundle.docker-adapter.test.ts via a PATH-shim fake `docker`
// executable, never a real daemon.
// ---------------------------------------------------------------------------

export interface BackupDockerAdapter {
  /** compose.sh:147/176-177 — `compose stop/start orbit-app`, for a cross-resource point-in-time backup. */
  stopApp(): void;
  startApp(): void;
  /** backup.sh:149-152 — `pg_dump` piped to `outputPath`; refuses on a nonzero exit or an empty result (#24). */
  dumpDatabase(outputPath: string): void;
  /** backup.sh:126-127,153 — `pg_restore --list` against `dumpPath`; a boolean predicate, matching Bash's non-distinguishing "invalid" refusal on any nonzero exit (#18,#25). */
  pgRestoreListOk(dumpPath: string): boolean;
  /** backup.sh:154 — `tar -C /var/lib/orbit/documents -cf -` collected via a one-off `orbit-app` container, written to `outputPath`. */
  collectDocumentsArchive(outputPath: string): void;
}

export interface DockerComposeAdapterOptions {
  /** The `--env-file` path passed to every `docker compose` invocation, mirroring backup.sh's `compose()` helper. */
  envFile: string;
  /** Working directory for the `docker` subprocess (defaults to the current process's cwd, matching backup.sh's own `cd "$repo_dir"`). */
  cwd?: string;
  /** Overrides the `docker` executable name/path. Defaults to `"docker"`. */
  dockerBinary?: string;
  /**
   * Environment for the `docker` subprocess (defaults to `process.env`). The
   * PATH-shim test seam: tests prepend a directory holding a fake `docker`
   * executable to `PATH` here instead of mutating `process.env` globally —
   * see recovery-bundle.docker-adapter.test.ts, following the same technique
   * as scripts/configure.test.mjs's `fakeDockerScript`.
   */
  env?: NodeJS.ProcessEnv;
}

function openWriteSecretDescriptor(path: string, mode: number = SECURE_FILE_MODE): number {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode);
  fchmodSync(descriptor, mode);
  return descriptor;
}

/**
 * Opens `path` for reading with a single `O_NOFOLLOW` descriptor and returns
 * its contents — deliberately not a separate `lstat`-then-`open`/`readFile`
 * pair, so there is no window between checking the path is not a symlink and
 * reading its content (CodeQL js/file-system-race). A dangling/symlink path
 * surfaces as `ELOOP`/`ENOENT` from the single `open` call itself.
 */
function readRegularFileNoFollow(path: string): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error("not a regular file");
    const buffer = Buffer.alloc(stats.size);
    let readTotal = 0;
    while (readTotal < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, readTotal, buffer.length - readTotal, readTotal);
      if (bytesRead === 0) break;
      readTotal += bytesRead;
    }
    return buffer.subarray(0, readTotal);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * The real BackupDockerAdapter: spawns the literal `docker compose` argument
 * lists backup.sh uses, over the exact fixed command shape (no shell
 * interpolation of caller-controlled data beyond the two path/envFile
 * arguments Node's `spawnSync` array form passes as discrete argv entries,
 * never through a shell).
 */
export function createDockerComposeBackupAdapter(options: DockerComposeAdapterOptions): BackupDockerAdapter {
  const dockerBinary = options.dockerBinary ?? "docker";
  const cwd = options.cwd;
  const env = options.env ?? process.env;
  const composeArgs = (...args: string[]): string[] => ["compose", "--env-file", options.envFile, ...args];

  return {
    stopApp(): void {
      const result = spawnSync(dockerBinary, composeArgs("stop", "orbit-app"), { cwd, env, stdio: ["ignore", "ignore", "inherit"] });
      if (result.status !== 0) refuse("app-stop-failed", "The Orbit application could not be stopped for the backup.");
    },
    startApp(): void {
      const result = spawnSync(dockerBinary, composeArgs("start", "orbit-app"), { cwd, env, stdio: ["ignore", "ignore", "inherit"] });
      if (result.status !== 0) refuse("app-start-failed", "The Orbit application could not be restarted after the backup.");
    },
    dumpDatabase(outputPath: string): void {
      const descriptor = openWriteSecretDescriptor(outputPath);
      try {
        const result = spawnSync(
          dockerBinary,
          composeArgs(
            "exec",
            "-T",
            "orbit-db",
            "sh",
            "-c",
            'exec pg_dump --format=custom --compress=6 --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"',
          ),
          { cwd, env, stdio: ["ignore", descriptor, "inherit"] },
        );
        if (result.status !== 0) refuse("database-dump-failed", "PostgreSQL could not be dumped.");
        if (fstatSync(descriptor).size === 0) refuse("empty-database-dump", "PostgreSQL produced an empty backup.");
      } finally {
        closeSync(descriptor);
      }
    },
    pgRestoreListOk(dumpPath: string): boolean {
      const descriptor = openSync(dumpPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const result = spawnSync(dockerBinary, composeArgs("exec", "-T", "orbit-db", "pg_restore", "--list"), {
          cwd,
          env,
          stdio: [descriptor, "ignore", "ignore"],
        });
        return result.status === 0;
      } finally {
        closeSync(descriptor);
      }
    },
    collectDocumentsArchive(outputPath: string): void {
      const descriptor = openWriteSecretDescriptor(outputPath);
      try {
        const result = spawnSync(
          dockerBinary,
          composeArgs("run", "--rm", "--no-deps", "--entrypoint", "tar", "orbit-app", "-C", "/var/lib/orbit/documents", "-cf", "-", "."),
          { cwd, env, stdio: ["ignore", descriptor, "inherit"] },
        );
        if (result.status !== 0) refuse("document-archive-collection-failed", "The document archive could not be collected.");
      } finally {
        closeSync(descriptor);
      }
    },
  };
}

/**
 * Completes backup.sh's validate_bundle end-to-end (:118-131): everything
 * validateBackupManifestAndAuth already covers (manifest/HMAC/checksums),
 * plus the `pg_restore --list` liveness check on the embedded database dump
 * (#18) and decrypting + re-validating the document archive against the
 * same path allow-list (#19-20). `extractedDir` is caller-managed scratch
 * space (already produced by extractTar), matching
 * validateBackupManifestAndAuth's own convention.
 */
export function validateBackupBundleContents(
  extractedDir: string,
  documentKekHex: string,
  adapter: Pick<BackupDockerAdapter, "pgRestoreListOk">,
): BackupManifestFields {
  const fields = validateBackupManifestAndAuth(extractedDir, documentKekHex);

  if (!adapter.pgRestoreListOk(join(extractedDir, "database.dump"))) {
    refuse("database-archive-invalid", "The bundle database dump is invalid.");
  }

  const encrypted = readRegularFileNoFollow(join(extractedDir, "documents.tar.enc"));
  const plaintext = decryptDocumentArchive(encrypted, documentKekHex);
  const documentsTarPath = join(extractedDir, "documents.tar");
  const descriptor = openWriteSecretDescriptor(documentsTarPath);
  try {
    writeSync(descriptor, plaintext);
  } finally {
    closeSync(descriptor);
  }
  validateDocumentArchiveEntries(listTarEntriesVerbose(documentsTarPath));

  return fields;
}

/**
 * `mv --no-clobber`-equivalent publish, but race-free: `link` succeeds
 * atomically only if `finalPath` does not already exist (POSIX `EEXIST`),
 * unlike a `stat`-then-`rename` check, which has a window an attacker could
 * win. `temporaryPath` and `finalPath` must be on the same filesystem
 * (both under the backup directory, matching backup.sh:139-140,173-175's own
 * same-directory `.installing` convention). Divergence from backup.sh flagged
 * in docs/adr-notes/296-backup-port-plan.md: `mv --no-clobber`'s own
 * existence check is not itself race-free; this is a race-free mechanism for
 * the same never-overwrite-an-existing-backup behavior (guarantee #32).
 */
export function publishBundleAtomically(temporaryPath: string, finalPath: string): void {
  try {
    linkSync(temporaryPath, finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      refuse("bundle-already-exists", "A backup with this name already exists.");
    }
    throw error;
  }
  unlinkSync(temporaryPath);
}

export interface CreateBackupBundleResult {
  finalTarPath: string;
  manifestFields: BackupManifestFields;
}

/**
 * Ports backup.sh's create_bundle (:135-179) end-to-end: stop the app for a
 * cross-resource point-in-time backup (#22), dump the database and collect
 * the document archive via the injected adapter, encrypt the documents
 * (#27) and delete the plaintext immediately (#28), build and HMAC-sign the
 * manifest+checksums (#29-30), package the five-member tar, validate it
 * (#31), and publish it atomically without clobbering an existing
 * same-named backup (#32-33) — always restarting the app on the way out
 * (#23,#34), success or failure, matching the EXIT-trap discipline of the
 * Bash original via `finally`.
 *
 * `backupDirectory` must already exist as the private (0700) work directory
 * (backup.sh:136-138) — creating it is the caller's responsibility, same
 * convention as extractedDir elsewhere in this module. `createdAt` is
 * injected (not read from `Date.now()` internally) to keep this function
 * deterministic and testable, matching the module's existing philosophy of
 * injected facts over inline probing.
 */
export function createBackupBundle(
  backupDirectory: string,
  finalTarPath: string,
  documentKekHex: string,
  adapter: BackupDockerAdapter,
  createdAt: string,
): CreateBackupBundleResult {
  const workDir = mkdtempSync(join(backupDirectory, ".orbit-backup."));
  const temporaryPath = `${finalTarPath}.installing`;
  let published = false;

  adapter.stopApp();
  try {
    const dbDumpPath = join(workDir, "database.dump");
    const documentsTarPath = join(workDir, "documents.tar");
    const encryptedDocumentsPath = join(workDir, "documents.tar.enc");
    const manifestPath = join(workDir, "manifest");
    const checksumsPath = join(workDir, "checksums.sha256");
    const hmacPath = join(workDir, "manifest.hmac");

    adapter.dumpDatabase(dbDumpPath);
    if (!adapter.pgRestoreListOk(dbDumpPath)) {
      refuse("database-archive-invalid", "The bundle database dump is invalid.");
    }

    adapter.collectDocumentsArchive(documentsTarPath);
    validateDocumentArchiveEntries(listTarEntriesVerbose(documentsTarPath));

    const plaintext = readRegularFileNoFollow(documentsTarPath);
    const encrypted = encryptDocumentArchive(plaintext, documentKekHex);
    writeSecretFile(encryptedDocumentsPath, encrypted);
    unlinkSync(documentsTarPath);

    const fingerprint = documentKekFingerprint(documentKekHex);
    const manifestFields: BackupManifestFields = {
      createdAt,
      databaseDump: "database.dump",
      documentsArchive: "documents.tar.enc",
      documentsEncryption: DOCUMENT_ARCHIVE_ENCRYPTION_ALGORITHM,
      documentKekSha256: fingerprint,
    };
    const manifest = buildBackupManifest(manifestFields);
    const checksums =
      `${sha256File(dbDumpPath)}  database.dump\n` + `${sha256File(encryptedDocumentsPath)}  documents.tar.enc\n`;
    writeSecretFile(checksumsPath, checksums);
    const manifestAndChecksums = Buffer.concat([Buffer.from(manifest), Buffer.from(checksums)]);
    const hmac = computeBundleHmac(documentKekHex, manifestAndChecksums);
    writeSecretFile(hmacPath, hmac);
    writeSecretFile(manifestPath, manifest);

    createTar(workDir, temporaryPath, [...BACKUP_BUNDLE_MEMBERS]);
    listTarMembers(temporaryPath); // backup.sh #31: validate the completed bundle before treating it as the deliverable.

    publishBundleAtomically(temporaryPath, finalTarPath);
    published = true;

    return { finalTarPath, manifestFields };
  } finally {
    if (!published) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Nothing to clean up if the tar was never produced.
      }
    }
    rmSync(workDir, { recursive: true, force: true });
    adapter.startApp();
  }
}

// ---------------------------------------------------------------------------
// Recovery bundle ("orbit-recovery-<timestamp>.tar") — export/import-recovery-bundle.sh
// ---------------------------------------------------------------------------

export const RECOVERY_BUNDLE_FORMAT_VERSION = "1";

/** import-recovery-bundle.sh #7: exactly these four members, no more, no fewer. */
export const RECOVERY_BUNDLE_MEMBERS = ["checksums.sha256", "document-kek.enc", "manifest", "orbit-backup.tar"] as const;

/** Mirrors export-recovery-bundle.sh:64's `printf` manifest exactly. */
export function buildRecoveryManifest(): string {
  return buildManifest([
    ["format_version", RECOVERY_BUNDLE_FORMAT_VERSION],
    ["key_encryption", RECOVERY_KEY_ENCRYPTION_ALGORITHM],
  ]);
}

/**
 * The member-set and link/special-file checks from
 * import-recovery-bundle.sh:55-63 (guarantees #5-7). Throws before any
 * extraction is attempted, with the same stable "preflight/archive failed"-
 * class refusal the Bash script gives (test_recovery_bundle_diagnostics
 * asserts no raw tar diagnostics or member names ever leak through this
 * layer).
 */
export function validateRecoveryBundleLayout(tarPath: string): void {
  const members = [...listTarMembers(tarPath)].sort();
  const expected = [...RECOVERY_BUNDLE_MEMBERS].sort();
  if (members.length !== expected.length || !members.every((name, index) => name === expected[index])) {
    refuse("unexpected-members", "The recovery bundle does not contain the expected files.");
  }
  const entries = listTarEntriesVerbose(tarPath);
  if (entries.some((entry) => entry.typeChar !== "-")) {
    refuse("link-or-special-entry", "The recovery bundle contains a link or special file.");
  }
}

/**
 * checksums.sha256 verification for the recovery bundle
 * (import-recovery-bundle.sh #9). Note: unlike the inner backup bundle, the
 * recovery bundle's own checksums.sha256 is *not* HMAC-signed — see Flags in
 * docs/adr-notes/296-backup-port-plan.md. It only detects accidental
 * corruption at this layer; real tamper-evidence for the payload comes from
 * the inner bundle's own HMAC (verified downstream) and for the wrapped KEK
 * from the ORBKEK envelope's own AES-GCM authentication tag.
 */
export function verifyRecoveryBundleChecksums(extractedDir: string): void {
  verifyChecksumsFile(extractedDir, `${extractedDir}/checksums.sha256`);
}

export function validateRecoveryManifestFormatVersion(extractedDir: string): void {
  const manifest = readFileSync(`${extractedDir}/manifest`, "utf8");
  if (!manifestDeclares(manifest, "format_version", RECOVERY_BUNDLE_FORMAT_VERSION)) {
    refuse("unsupported-format-version", "The recovery bundle format is unsupported.");
  }
}

/** export-recovery-bundle.sh #7: passphrase and its confirmation entry must match exactly. */
export function passphrasesMatch(passphrase: string, confirmation: string): boolean {
  return passphrase === confirmation;
}

export function requireMatchingPassphrase(passphrase: string, confirmation: string): void {
  if (!passphrasesMatch(passphrase, confirmation)) {
    refuse("passphrase-mismatch", "Recovery passphrases do not match.");
  }
}

export function requireValidPassphrase(passphrase: string): void {
  if (!isValidPassphrase(passphrase)) {
    refuse("passphrase-too-short", `Use a recovery passphrase of at least ${MIN_RECOVERY_PASSPHRASE_LENGTH} characters.`);
  }
}

// Re-exported for tests that need to assert on raw predicates without
// duplicating the logic above.
export const internal = {
  runTar,
  deriveRecoveryKey,
};
