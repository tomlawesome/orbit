import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../../scripts/process-budget.mjs";
import { runBackup, runExportRecoveryBundle, runImportRecoveryBundle } from "./backup-restore-cli";
import { type BackupDockerAdapter, createTar } from "./recovery-bundle";
import { type CorrespondenceReports, type RestoreDockerAdapter } from "./restore-engine";

// Cross-implementation evidence for issue #296 slice 4
// (docs/adr-notes/296-backup-port-plan.md), extending slice 1's own
// recovery-crypto.mjs subprocess parity from the bare crypto primitive to
// this slice's *orchestration output*: a whole recovery bundle produced by
// runExportRecoveryBundle (the same function `orbit export-recovery-bundle`
// itself calls), not a hand-built envelope.
//
// A bash-era bundle restored by the engine is the real-stack drill's job
// (scripts/test-backup-restore.sh). What is reachable without a deployment
// is characterized here: recovery-crypto.mjs's standalone `node` entrypoint
// (no container hop, exactly like slice 1) against our own output, and the
// engine's import preflight accepting it.

// This file spawns real tar and node; a spawn that takes 0.7s quiet took
// 4.3s on a starved core (#698). Budget and reasoning:
// scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const nodeCryptoScript = join(repoRoot, "scripts", "recovery-crypto.mjs");

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function newSandbox(prefix: string): string {
  const sandbox = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(sandbox);
  return sandbox;
}

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const LIVE_KEK = "e".repeat(64);

function reportsFor(storageKey: string, contentLength: number): CorrespondenceReports {
  return {
    crypto: `${DOCUMENT_ID}|${storageKey}|${contentLength}|available\n`,
    visible: `${DOCUMENT_ID}|available|${storageKey}|${contentLength}\n`,
    attachments: "",
    staging: "",
    documentStaging: "",
    transientCount: "0",
  };
}

/** Just enough of BackupDockerAdapter for runBackup to package a bundle from a real document tree + fake JSON "dump". */
function fakeBackupAdapter(documentsRoot: string, storageKey: string, contentLength: number): BackupDockerAdapter & Pick<RestoreDockerAdapter, never> {
  return {
    stopApp(): void {},
    startApp(): void {},
    dumpDatabase(outputPath: string): void {
      writeFileSync(outputPath, JSON.stringify(reportsFor(storageKey, contentLength)));
    },
    pgRestoreListOk(dumpPath: string): boolean {
      try {
        JSON.parse(readFileSync(dumpPath, "utf8"));
        return true;
      } catch {
        return false;
      }
    },
    collectDocumentsArchive(outputPath: string): void {
      createTar(documentsRoot, outputPath, ["."]);
    },
    recordRecoveryBundleExported(): void {},
  };
}

function buildDocumentTree(root: string, storageKey: string, contentLength: number): void {
  const objectDir = join(root, "objects", storageKey.slice(0, 2), storageKey.slice(2, 4));
  mkdirSync(objectDir, { recursive: true });
  mkdirSync(join(root, "staging"), { recursive: true });
  writeFileSync(join(objectDir, `${storageKey}.bin`), Buffer.alloc(contentLength, 7));
}

function buildRecoveryBundleViaOrchestration(passphrase: string): string {
  const sandbox = newSandbox("orbit-slice4-parity-export-");
  const documentsRoot = join(sandbox, "docs");
  const storageKey = "9".repeat(64);
  buildDocumentTree(documentsRoot, storageKey, 12);
  const sourceBundlePath = runBackup({
    backupDirectory: join(sandbox, "source-backups"),
    documentKekHex: LIVE_KEK,
    adapter: fakeBackupAdapter(documentsRoot, storageKey, 12),
    now: new Date("2026-01-01T00:00:00Z"),
  }).finalTarPath;

  const result = runExportRecoveryBundle({
    sourceBundlePath,
    documentKekHex: LIVE_KEK,
    passphrase,
    passphraseConfirmation: passphrase,
    backupDirectory: join(sandbox, "recovery-backups"),
    adapter: fakeBackupAdapter(documentsRoot, storageKey, 12),
    now: new Date("2026-01-01T00:00:00Z"),
  });
  return result.finalPath;
}

describe("recovery-crypto.mjs cross-implementation parity against runExportRecoveryBundle's own output", () => {
  it("the document-kek.enc a real orchestration-produced recovery bundle carries is decryptable by the real, unmodified recovery-crypto.mjs", () => {
    const passphrase = "correct horse battery staple";
    const recoveryBundlePath = buildRecoveryBundleViaOrchestration(passphrase);

    const extractDir = newSandbox("orbit-slice4-parity-extract-");
    const listing = failOnProcessDeadline(spawnSync("tar", ["-xf", recoveryBundlePath, "-C", extractDir], { encoding: "utf8", ...processGuard() }), { label: "tar -xf" });
    expect(listing.status).toBe(0);

    const decrypted = failOnProcessDeadline(spawnSync("node", [nodeCryptoScript, "decrypt", join(extractDir, "document-kek.enc")], {
      input: Buffer.from(passphrase),
      encoding: "buffer",
      ...processGuard(),
    }), { label: "recovery-crypto.mjs decrypt" });
    expect(decrypted.status).toBe(0);
    expect(decrypted.stdout.toString("ascii")).toBe(LIVE_KEK);
  });

  it("a wrong passphrase is refused identically by the real recovery-crypto.mjs against our own output", () => {
    const passphrase = "correct horse battery staple";
    const recoveryBundlePath = buildRecoveryBundleViaOrchestration(passphrase);
    const extractDir = newSandbox("orbit-slice4-parity-extract-wrong-");
    failOnProcessDeadline(spawnSync("tar", ["-xf", recoveryBundlePath, "-C", extractDir], { ...processGuard() }), { label: "tar -xf" });

    const decrypted = failOnProcessDeadline(spawnSync("node", [nodeCryptoScript, "decrypt", join(extractDir, "document-kek.enc")], {
      input: Buffer.from("a-completely-different-passphrase-value"),
      encoding: "utf8",
      ...processGuard(),
    }), { label: "recovery-crypto.mjs decrypt" });
    expect(decrypted.status).not.toBe(0);
  });
});

// import-recovery-bundle.sh became a thin shell around the engine (#1211):
// its archive/manifest/checksum preflight is the engine's own, and what the
// script printed for each refusal is compared with the engine in
// src/cli/orbit.backup-restore.test.ts. What stays here is that a bundle
// this orchestration exports gets past every one of those checks.
describe("the import preflight accepts our orchestration's bundle", () => {
  it("gets past the archive, manifest and checksum checks to the passphrase for a bundle runExportRecoveryBundle produced", () => {
    const passphrase = "correct horse battery staple";
    const recoveryBundlePath = buildRecoveryBundleViaOrchestration(passphrase);
    const sandbox = newSandbox("orbit-slice4-parity-import-");
    const liveDocumentKekFile = join(sandbox, "document-kek");
    writeFileSync(liveDocumentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
    let reachedPassphrase = false;
    expect(() =>
      runImportRecoveryBundle({
        recoveryBundlePath,
        passphrase: () => {
          reachedPassphrase = true;
          throw new Error("stop at the passphrase");
        },
        liveDocumentKekFile,
        backupDirectory: join(sandbox, "backups"),
        adapter: {} as RestoreDockerAdapter,
        importConfirmed: true,
        confirmRestore: () => true,
      }),
    ).toThrow("stop at the passphrase");
    expect(reachedPassphrase).toBe(true);
  });
});
