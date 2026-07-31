#!/usr/bin/env node

import { readFileSync } from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
} from "node:crypto";

const MAGIC = Buffer.from("ORBKEK01", "ascii");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT = { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function fail(message) {
  process.stderr.write(`Orbit recovery crypto: ${message}\n`);
  process.exit(1);
}

function readStandardInput() {
  return readFileSync(0);
}

function readPassphrase() {
  const passphrase = readStandardInput().toString("utf8").replace(/[\r\n]+$/, "");
  if (passphrase.length < 12) fail("use a passphrase of at least 12 characters");
  return passphrase;
}

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, KEY_BYTES, SCRYPT);
}

function encrypt(input, passphrase) {
  if (!/^[0-9a-fA-F]{64}\r?\n?$/.test(input.toString("utf8"))) {
    fail("the input is not a 32-byte hexadecimal document key");
  }
  const plaintext = Buffer.from(input.toString("utf8").trim(), "ascii");
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(MAGIC);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ciphertext]);
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

function decrypt(input, passphrase) {
  const headerBytes = MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES;
  if (input.length <= headerBytes || !input.subarray(0, MAGIC.length).equals(MAGIC)) {
    fail("unsupported or corrupt recovery-key envelope");
  }
  let offset = MAGIC.length;
  const salt = input.subarray(offset, offset += SALT_BYTES);
  const iv = input.subarray(offset, offset += IV_BYTES);
  const tag = input.subarray(offset, offset += TAG_BYTES);
  const ciphertext = input.subarray(offset);
  const key = deriveKey(passphrase, salt);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (!/^[0-9a-fA-F]{64}$/.test(plaintext.toString("ascii"))) {
      plaintext.fill(0);
      fail("decrypted content is not a valid document key");
    }
    return plaintext;
  } catch {
    fail("passphrase verification failed");
  } finally {
    key.fill(0);
  }
}

const [operation, inputPath] = process.argv.slice(2);
if (!["encrypt", "decrypt", "hmac", "fingerprint"].includes(operation) || !inputPath) {
  fail("usage: recovery-crypto.mjs <encrypt|decrypt|hmac|fingerprint> <key-or-input-file>");
}

if (operation === "hmac" || operation === "fingerprint") {
  const keyText = readFileSync(inputPath, "utf8").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(keyText)) fail("the key file is invalid");
  const key = Buffer.from(keyText, "hex");
  try {
    let output;
    if (operation === "hmac") {
      const authenticationKey = createHmac("sha256", key)
        .update("orbit-backup-authentication-v1", "utf8")
        .digest();
      try {
        output = createHmac("sha256", authenticationKey).update(readStandardInput()).digest("base64");
      } finally {
        authenticationKey.fill(0);
      }
    } else {
      output = createHash("sha256").update(key).digest("hex");
    }
    process.stdout.write(output);
  } finally {
    key.fill(0);
  }
  process.exit(0);
}

const passphrase = readPassphrase();
const input = readFileSync(inputPath);
const output = operation === "encrypt" ? encrypt(input, passphrase) : decrypt(input, passphrase);
process.stdout.write(output);
output.fill(0);
