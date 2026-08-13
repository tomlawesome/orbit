import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  BACKUP_BUNDLE_MEMBERS,
  RECOVERY_BUNDLE_MEMBERS,
  buildBackupManifest,
  buildRecoveryManifest,
  computeBundleHmac,
  createTar,
  decryptDocumentArchive,
  documentKekFingerprint,
  encryptDocumentArchive,
  encryptDocumentKek,
  decryptDocumentKek,
  sha256File,
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
//   2. scripts/import-recovery-bundle.sh's own archive/checksum preflight
//      (lines 44-71) runs entirely before its first `docker compose run`
//      call — verified by inspection and by these tests actually running it
//      with no Docker daemon reachable. That means the *whole,
//      unmodified script* can be spawned directly for every fixture that is
//      rejected at or before that stage, exactly like
//      config-contract.parity.test.ts spawns the whole of configure.sh
//      --check. This is strictly stronger than install-transaction's
//      function-extraction fallback (see docs/adr-notes/296-backup-port-plan.md,
//      Flags) and is used instead wherever the rejection happens early
//      enough.
//   3. scripts/backup.sh --verify's validate_bundle runs its tar-listing,
//      link/special-file, member-set, and format_version checks (lines
//      104-119) before its own first Docker call
//      (document_kek_fingerprint, line 120). The same whole-script spawn
//      technique applies for fixtures rejected at or before that line.
//
// Neither (2) nor (3) attempts parity for the *later* Docker-dependent
// checks (HMAC verification via the app container, document-KEK fingerprint
// match, or pg_restore --list) — those are exercised instead via
// recovery-bundle.docker-adapter.test.ts's PATH-shim seam (issue #296 slice
// 2), since they genuinely need a live daemon and cannot be spawned
// Docker-free.
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
const importScript = join(repoRoot, "scripts", "import-recovery-bundle.sh");
const backupScript = join(repoRoot, "scripts", "backup.sh");

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

// --- (1) recovery-crypto.mjs subprocess parity -----------------------------

describe("recovery-crypto.mjs subprocess parity", () => {
  it("hmac: matches computeBundleHmac byte-for-byte for the same key and content", () => {
    const sandbox = newSandbox("orbit-recovery-parity-hmac-");
    const keyFile = join(sandbox, "document-kek");
    writeFileSync(keyFile, `${KEK_A}\n`);
    const content = Buffer.from("manifest-and-checksums-fixture-content");

    // recovery-crypto.mjs's hmac op reads the content to sign from stdin.
    const result = spawnSync("node", [nodeCryptoScript, "hmac", keyFile], {
      input: content,
      encoding: "buffer",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.toString("utf8")).toBe(computeBundleHmac(KEK_A, content));
  });

  it("fingerprint: matches documentKekFingerprint byte-for-byte", () => {
    const sandbox = newSandbox("orbit-recovery-parity-fingerprint-");
    const keyFile = join(sandbox, "document-kek");
    writeFileSync(keyFile, `${KEK_A}\n`);
    const result = spawnSync("node", [nodeCryptoScript, "fingerprint", keyFile], { encoding: "utf8" });
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
    const decrypted = spawnSync("node", [nodeCryptoScript, "decrypt", envelopePath], {
      input: Buffer.from(passphrase),
      encoding: "buffer",
    });
    expect(decrypted.status).toBe(0);
    expect(decrypted.stdout.toString("ascii")).toBe(KEK_A);
  });

  it("bash-encrypt then TS-decrypt: an envelope produced by the real script is decryptable by recovery-bundle.ts", () => {
    const passphrase = "correct-horse-battery-staple";
    const sandbox = newSandbox("orbit-recovery-parity-encrypt-");
    const keyFile = join(sandbox, "document-kek");
    writeFileSync(keyFile, `${KEK_A}\n`);
    const encrypted = spawnSync("node", [nodeCryptoScript, "encrypt", keyFile], {
      input: Buffer.from(passphrase),
      encoding: "buffer",
    });
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
    const bashResult = spawnSync("node", [nodeCryptoScript, "decrypt", envelopePath], {
      input: Buffer.from("a-completely-wrong-passphrase-value"),
      encoding: "utf8",
    });
    expect(bashResult.status).not.toBe(0);
    expect(bashResult.stderr).toContain("passphrase verification failed");
    expect(() => decryptDocumentKek(envelope, "a-completely-wrong-passphrase-value")).toThrow();
  });
});

// --- (4) AES-256-CBC document-archive crypto parity against real `openssl` -

function opensslEncrypt(plaintextPath: string, keyFilePath: string, outputPath: string): { status: number; stderr: string } {
  // backup.sh:156-157's exact argument list.
  const result = spawnSync(
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
    { encoding: "utf8" },
  );
  return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

function opensslDecrypt(encryptedPath: string, keyFilePath: string, outputPath: string): { status: number; stderr: string } {
  // backup.sh:128-130's exact argument list.
  const result = spawnSync(
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
    { encoding: "utf8" },
  );
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

// --- (2) import-recovery-bundle.sh whole-script preflight parity -----------

function newImportSandbox(): { sandbox: string; env: NodeJS.ProcessEnv } {
  const sandbox = newSandbox("orbit-import-parity-");
  writeFileSync(join(sandbox, "env-orbit"), "FAKE=1\n");
  mkdirSync(join(sandbox, "secrets"));
  writeFileSync(join(sandbox, "secrets", "document-kek"), `${KEK_A}\n`);
  chmodSync(join(sandbox, "secrets", "document-kek"), 0o600);
  return {
    sandbox,
    env: {
      ...process.env,
      ORBIT_ENV_FILE: join(sandbox, "env-orbit"),
      ORBIT_SECRETS_DIR: join(sandbox, "secrets"),
      ORBIT_BACKUP_DIR: join(sandbox, "backups"),
      ORBIT_RECOVERY_TEST_MODE: "true",
    },
  };
}

function runImportScript(bundlePath: string, env: NodeJS.ProcessEnv): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bash", [importScript, bundlePath], { env, encoding: "utf8", input: "" });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? -1 };
}

describe("import-recovery-bundle.sh whole-script preflight parity (no Docker daemon reachable)", () => {
  it("malformed archive: bash and TS agree it is rejected as an invalid archive", () => {
    const { sandbox, env } = newImportSandbox();
    const bundlePath = join(sandbox, "malformed.tar");
    writeFileSync(bundlePath, "not a tar archive\n");
    const result = runImportScript(bundlePath, env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("preflight/archive failed");
    expect(result.stderr).not.toContain("tar:");
  });

  it("unexpected member: bash and TS agree it is rejected without leaking the member name", () => {
    const { sandbox, env } = newImportSandbox();
    const contentsDir = join(sandbox, "unexpected");
    mkdirSync(contentsDir);
    writeFileSync(join(contentsDir, "attacker-controlled-member"), "attacker-controlled-content\n");
    const bundlePath = join(sandbox, "unexpected.tar");
    createTar(contentsDir, bundlePath, ["attacker-controlled-member"]);
    const result = runImportScript(bundlePath, env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("preflight/archive failed");
    expect(result.stderr).not.toContain("attacker-controlled-member");
  });

  it("corrupt checksum: bash and TS agree it is rejected without leaking raw checksum output or a member name", () => {
    const { sandbox, env } = newImportSandbox();
    const passphrase = "correct-horse-battery-staple";
    const envelope = encryptDocumentKek(KEK_A, passphrase);
    const contentsDir = join(sandbox, "checksum-bad");
    mkdirSync(contentsDir);
    writeFileSync(join(contentsDir, "manifest"), buildRecoveryManifest());
    writeFileSync(join(contentsDir, "orbit-backup.tar"), "fake-inner-bundle-bytes");
    writeFileSync(join(contentsDir, "document-kek.enc"), envelope);
    const badChecksums = `${"0".repeat(64)}  orbit-backup.tar\n${sha256File(join(contentsDir, "document-kek.enc"))}  document-kek.enc\n`;
    writeFileSync(join(contentsDir, "checksums.sha256"), badChecksums);
    const bundlePath = join(sandbox, "checksum-bad.tar");
    createTar(contentsDir, bundlePath, [...RECOVERY_BUNDLE_MEMBERS]);

    const result = runImportScript(bundlePath, env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("preflight/checksum failed");
    expect(result.stderr).not.toContain("sha256sum:");
    expect(result.stderr).not.toContain("orbit-backup.tar");
  });

  it("refuses to start when a prior restore journal exists (#4), identically to the TS layer's own preflight ordering", () => {
    const { sandbox, env } = newImportSandbox();
    mkdirSync(join(sandbox, "backups", ".orbit-restore"), { recursive: true });
    writeFileSync(join(sandbox, "backups", ".orbit-restore", "restore.journal"), "format_version=1\n");
    const bundlePath = join(sandbox, "irrelevant.tar");
    writeFileSync(bundlePath, "not a tar archive\n");
    const result = runImportScript(bundlePath, env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("preflight/journal failed");
  });
});

// --- (3) backup.sh --verify whole-script layout/format-version parity ------

function newBackupSandbox(): { sandbox: string; env: NodeJS.ProcessEnv } {
  const sandbox = newSandbox("orbit-backup-verify-parity-");
  writeFileSync(join(sandbox, "env-orbit"), "FAKE=1\n");
  mkdirSync(join(sandbox, "secrets"));
  writeFileSync(join(sandbox, "secrets", "document-kek"), `${KEK_A}\n`);
  chmodSync(join(sandbox, "secrets", "document-kek"), 0o600);
  return {
    sandbox,
    env: {
      ...process.env,
      ORBIT_ENV_FILE: join(sandbox, "env-orbit"),
      ORBIT_SECRETS_DIR: join(sandbox, "secrets"),
      ORBIT_BACKUP_DIR: join(sandbox, "backups"),
    },
  };
}

function runBackupVerify(bundlePath: string, env: NodeJS.ProcessEnv): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bash", [backupScript, "--verify", bundlePath], { env, encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? -1 };
}

describe("backup.sh --verify whole-script layout/format-version parity (no Docker daemon reachable)", () => {
  it("malformed archive: rejected as invalid before any Docker call", () => {
    const { sandbox, env } = newBackupSandbox();
    const bundlePath = join(sandbox, "malformed.tar");
    writeFileSync(bundlePath, "not a tar archive\n");
    const result = runBackupVerify(bundlePath, env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Bundle archive is invalid.");
  });

  it("missing member: rejected as not containing the expected recovery files", () => {
    const { sandbox, env } = newBackupSandbox();
    const contentsDir = join(sandbox, "missing-member");
    mkdirSync(contentsDir);
    for (const name of BACKUP_BUNDLE_MEMBERS) {
      if (name === "manifest.hmac") continue;
      writeFileSync(join(contentsDir, name), "x");
    }
    const bundlePath = join(sandbox, "missing-member.tar");
    createTar(contentsDir, bundlePath, BACKUP_BUNDLE_MEMBERS.filter((name) => name !== "manifest.hmac"));
    const result = runBackupVerify(bundlePath, env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Bundle does not contain the expected recovery files.");
  });

  it("unsupported format_version: rejected before the Docker-dependent KEK-fingerprint check", () => {
    const { sandbox, env } = newBackupSandbox();
    const contentsDir = join(sandbox, "bad-version");
    const manifest = buildBackupManifest({
      createdAt: "2026-08-13T00:00:00Z",
      databaseDump: "database.dump",
      documentsArchive: "documents.tar.enc",
      documentsEncryption: "aes-256-cbc-pbkdf2-sha256-iter-600000",
      documentKekSha256: documentKekFingerprint(KEK_A),
    }).replace("format_version=1", "format_version=2");
    mkdirSync(contentsDir);
    writeFileSync(join(contentsDir, "manifest"), manifest);
    writeFileSync(join(contentsDir, "database.dump"), "x");
    writeFileSync(join(contentsDir, "documents.tar.enc"), "x");
    writeFileSync(
      join(contentsDir, "checksums.sha256"),
      `${sha256File(join(contentsDir, "database.dump"))}  database.dump\n${sha256File(join(contentsDir, "documents.tar.enc"))}  documents.tar.enc\n`,
    );
    writeFileSync(join(contentsDir, "manifest.hmac"), "not-a-real-hmac");
    const bundlePath = join(sandbox, "bad-version.tar");
    createTar(contentsDir, bundlePath, [...BACKUP_BUNDLE_MEMBERS]);
    const result = runBackupVerify(bundlePath, env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unsupported bundle format.");
  });
});
