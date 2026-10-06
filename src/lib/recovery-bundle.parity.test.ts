import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../../scripts/process-budget.mjs";
import {
  computeBundleHmac,
  decryptDocumentArchive,
  documentKekFingerprint,
  encryptDocumentArchive,
  encryptDocumentKek,
  decryptDocumentKek,
} from "./recovery-bundle";

// Cross-implementation parity for issue #296 slice 1, following the pattern
// established by src/lib/config-contract.parity.test.ts and
// src/lib/install-transaction.parity.test.ts:
//
//   1. recovery-crypto.mjs has a standalone `node` entrypoint (no Docker,
//      no container hop needed to invoke it) — the strongest parity
//      available, so the ORBKEK envelope and HMAC/fingerprint primitives are
//      compared byte-for-byte against the real script via literal subprocess
//      spawns, not extracted or hand-copied.
//   2./3. import-recovery-bundle.sh's archive/checksum preflight and
//      backup.sh --verify's layout/format checks are thin shells around the
//      engine since #1211; what they printed was captured once into
//      src/lib/__fixtures__/ and src/cli/orbit.backup-restore.test.ts
//      compares the engine with it.
//
//   4. (slice 2) The AES-256-CBC/PBKDF2-SHA256 document-archive envelope
//      (backup.sh:128-130,156-157) is not a Bash script at all — it is a
//      direct `openssl enc` invocation, so the strongest parity available is
//      spawning the real, unmodified `openssl` binary with the exact
//      argument list backup.sh uses, both directions: an envelope produced
//      by `encryptDocumentArchive` decrypted by real `openssl`, and one
//      produced by real `openssl` decrypted by `decryptDocumentArchive`.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const nodeCryptoScript = join(repoRoot, "scripts", "recovery-crypto.mjs");

const sandboxes: string[] = [];

afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
});

function newSandbox(prefix: string): string {
  const sandbox = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(sandbox);
  return sandbox;
}

const KEK_A = "a".repeat(64);
const KEK_B = "b".repeat(64);

// Every case here spawns a real subprocess — node, openssl, bash — and the
// first backup.sh run additionally pays for `docker compose version` inside
// require_tools; a spawn that takes 0.7s quiet took 4.3s on a starved core
// (#698, and the same shape #513 caught here first). Budget and reasoning:
// scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

// --- (1) recovery-crypto.mjs subprocess parity -----------------------------

describe("recovery-crypto.mjs subprocess parity", () => {
  it("hmac: matches computeBundleHmac byte-for-byte for the same key and content", () => {
    const sandbox = newSandbox("orbit-recovery-parity-hmac-");
    const keyFile = join(sandbox, "document-kek");
    writeFileSync(keyFile, `${KEK_A}\n`);
    const content = Buffer.from("manifest-and-checksums-fixture-content");

    // recovery-crypto.mjs's hmac op reads the content to sign from stdin.
    const result = failOnProcessDeadline(spawnSync("node", [nodeCryptoScript, "hmac", keyFile], {
      input: content,
      encoding: "buffer",
      ...processGuard(),
    }), { label: "recovery-crypto.mjs hmac" });
    expect(result.status).toBe(0);
    expect(result.stdout.toString("utf8")).toBe(computeBundleHmac(KEK_A, content));
  });

  it("fingerprint: matches documentKekFingerprint byte-for-byte", () => {
    const sandbox = newSandbox("orbit-recovery-parity-fingerprint-");
    const keyFile = join(sandbox, "document-kek");
    writeFileSync(keyFile, `${KEK_A}\n`);
    const result = failOnProcessDeadline(spawnSync("node", [nodeCryptoScript, "fingerprint", keyFile], { encoding: "utf8", ...processGuard() }), { label: "recovery-crypto.mjs fingerprint" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(documentKekFingerprint(KEK_A));
  });

  it("encrypt then bash-decrypt: an envelope produced by recovery-bundle.ts is decryptable by the real script", () => {
    const passphrase = "correct-horse-battery-staple";
    const envelope = encryptDocumentKek(KEK_A, passphrase);
    // decrypt reads the passphrase from stdin and the envelope from a path
    // argument, so the envelope is staged to a temp file first.
    const sandbox = newSandbox("orbit-recovery-parity-decrypt-");
    const envelopePath = join(sandbox, "document-kek.enc");
    writeFileSync(envelopePath, envelope);
    const decrypted = failOnProcessDeadline(spawnSync("node", [nodeCryptoScript, "decrypt", envelopePath], {
      input: Buffer.from(passphrase),
      encoding: "buffer",
      ...processGuard(),
    }), { label: "recovery-crypto.mjs decrypt" });
    expect(decrypted.status).toBe(0);
    expect(decrypted.stdout.toString("ascii")).toBe(KEK_A);
  });

  it("bash-encrypt then TS-decrypt: an envelope produced by the real script is decryptable by recovery-bundle.ts", () => {
    const passphrase = "correct-horse-battery-staple";
    const sandbox = newSandbox("orbit-recovery-parity-encrypt-");
    const keyFile = join(sandbox, "document-kek");
    writeFileSync(keyFile, `${KEK_A}\n`);
    const encrypted = failOnProcessDeadline(spawnSync("node", [nodeCryptoScript, "encrypt", keyFile], {
      input: Buffer.from(passphrase),
      encoding: "buffer",
      ...processGuard(),
    }), { label: "recovery-crypto.mjs encrypt" });
    expect(encrypted.status).toBe(0);
    const recovered = decryptDocumentKek(encrypted.stdout, passphrase);
    expect(recovered.toString("ascii")).toBe(KEK_A);
  });

  it("decrypt: a wrong passphrase is refused identically by both implementations", () => {
    const passphrase = "correct-horse-battery-staple";
    const envelope = encryptDocumentKek(KEK_A, passphrase);
    const sandbox = newSandbox("orbit-recovery-parity-wrong-pass-");
    const envelopePath = join(sandbox, "document-kek.enc");
    writeFileSync(envelopePath, envelope);
    const bashResult = failOnProcessDeadline(spawnSync("node", [nodeCryptoScript, "decrypt", envelopePath], {
      input: Buffer.from("a-completely-wrong-passphrase-value"),
      encoding: "utf8",
      ...processGuard(),
    }), { label: "recovery-crypto.mjs decrypt" });
    expect(bashResult.status).not.toBe(0);
    expect(bashResult.stderr).toContain("passphrase verification failed");
    expect(() => decryptDocumentKek(envelope, "a-completely-wrong-passphrase-value")).toThrow();
  });
});

// --- (4) AES-256-CBC document-archive crypto parity against real `openssl` -

function opensslEncrypt(plaintextPath: string, keyFilePath: string, outputPath: string): { status: number; stderr: string } {
  // backup.sh:156-157's exact argument list.
  const result = failOnProcessDeadline(spawnSync(
    "openssl",
    [
      "enc",
      "-aes-256-cbc",
      "-pbkdf2",
      "-iter",
      "600000",
      "-md",
      "sha256",
      "-salt",
      "-pass",
      `file:${keyFilePath}`,
      "-in",
      plaintextPath,
      "-out",
      outputPath,
    ],
    { encoding: "utf8", ...processGuard() },
  ), { label: "opensslEncrypt" });
  return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

function opensslDecrypt(encryptedPath: string, keyFilePath: string, outputPath: string): { status: number; stderr: string } {
  // backup.sh:128-130's exact argument list.
  const result = failOnProcessDeadline(spawnSync(
    "openssl",
    [
      "enc",
      "-d",
      "-aes-256-cbc",
      "-pbkdf2",
      "-iter",
      "600000",
      "-md",
      "sha256",
      "-pass",
      `file:${keyFilePath}`,
      "-in",
      encryptedPath,
      "-out",
      outputPath,
    ],
    { encoding: "utf8", ...processGuard() },
  ), { label: "opensslDecrypt" });
  return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

describe("AES-256-CBC document-archive crypto parity (openssl enc -pbkdf2, no Docker)", () => {
  it("TS-encrypt then openssl-decrypt: a plaintext round-trips through both implementations", () => {
    const sandbox = newSandbox("orbit-document-archive-parity-encrypt-");
    const keyFilePath = join(sandbox, "document-kek");
    writeFileSync(keyFilePath, `${KEK_A}\n`);
    const plaintext = Buffer.from("fake document tar bytes, byte-for-byte round trip fixture\n");

    const envelope = encryptDocumentArchive(plaintext, KEK_A);
    const envelopePath = join(sandbox, "documents.tar.enc");
    writeFileSync(envelopePath, envelope);

    const decryptedPath = join(sandbox, "documents.tar");
    const result = opensslDecrypt(envelopePath, keyFilePath, decryptedPath);
    expect(result.status).toBe(0);
    expect(readFileSync(decryptedPath)).toEqual(plaintext);
  });

  it("openssl-encrypt then TS-decrypt: an envelope produced by the real binary is decryptable by recovery-bundle.ts", () => {
    const sandbox = newSandbox("orbit-document-archive-parity-decrypt-");
    const keyFilePath = join(sandbox, "document-kek");
    writeFileSync(keyFilePath, `${KEK_A}\n`);
    const plaintextPath = join(sandbox, "documents.tar");
    const plaintext = Buffer.from("another fixture, produced by openssl this time\n");
    writeFileSync(plaintextPath, plaintext);

    const envelopePath = join(sandbox, "documents.tar.enc");
    const result = opensslEncrypt(plaintextPath, keyFilePath, envelopePath);
    expect(result.status).toBe(0);

    const decrypted = decryptDocumentArchive(readFileSync(envelopePath), KEK_A);
    expect(decrypted).toEqual(plaintext);
  });

  it("a wrong document KEK is refused by both implementations (openssl: nonzero exit; TS: RecoveryBundleRefusal)", () => {
    const sandbox = newSandbox("orbit-document-archive-parity-wrong-key-");
    const keyFilePath = join(sandbox, "document-kek");
    writeFileSync(keyFilePath, `${KEK_A}\n`);
    const wrongKeyFilePath = join(sandbox, "document-kek-wrong");
    writeFileSync(wrongKeyFilePath, `${KEK_B}\n`);
    const plaintextPath = join(sandbox, "documents.tar");
    writeFileSync(plaintextPath, "fixture content for the wrong-key case\n");

    const envelopePath = join(sandbox, "documents.tar.enc");
    expect(opensslEncrypt(plaintextPath, keyFilePath, envelopePath).status).toBe(0);

    const decryptedPath = join(sandbox, "documents.tar.decrypted-with-wrong-key");
    const opensslResult = opensslDecrypt(envelopePath, wrongKeyFilePath, decryptedPath);
    expect(opensslResult.status).not.toBe(0);
    expect(() => decryptDocumentArchive(readFileSync(envelopePath), KEK_B)).toThrow(/Document archive decryption failed/);
  });
});
