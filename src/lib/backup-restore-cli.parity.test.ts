import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../../scripts/process-budget.mjs";
import { runBackup, runExportRecoveryBundle } from "./backup-restore-cli";
import { type BackupDockerAdapter, createTar } from "./recovery-bundle";
import { type CorrespondenceReports, type RestoreDockerAdapter } from "./restore-engine";

// Cross-implementation evidence for issue #296 slice 4
// (docs/adr-notes/296-backup-port-plan.md), extending slice 1's own
// recovery-crypto.mjs subprocess parity from the bare crypto primitive to
// this slice's *orchestration output*: a whole recovery bundle produced by
// runExportRecoveryBundle (the same function `orbit export-recovery-bundle`
// itself calls), not a hand-built envelope.
//
// Full live-Docker whole-script round-trip (a Bash-created bundle restored
// by the CLI, and vice versa, per the issue's own test plan) is out of
// reach in this sandbox for the same reason slice 2/3 flagged: create_bundle
// and export-recovery-bundle.sh's own source-bundle verification both
// require a live Postgres/orbit-app deployment before their first Docker
// call ever completes successfully — see docs/adr-notes/296-backup-port-plan.md,
// Slice 4 Flags. What *is* reachable Docker-free is characterized here:
// recovery-crypto.mjs's standalone `node` entrypoint (no container hop,
// exactly like slice 1), and import-recovery-bundle.sh's own archive/
// checksum/manifest preflight, which — like slice 1's own whole-script
// spawns — runs entirely before the script's first `docker compose` call.

// This file spawns real tar, node and bash (import-recovery-bundle.sh); a
// spawn that takes 0.7s quiet took 4.3s on a starved core (#698). Budget
// and reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const nodeCryptoScript = join(repoRoot, "scripts", "recovery-crypto.mjs");
const importScript = join(repoRoot, "scripts", "import-recovery-bundle.sh");

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

describe("import-recovery-bundle.sh's own archive/checksum/manifest preflight accepts our orchestration's bundle (:44-71, runs before any Docker call)", () => {
  it("the real, unmodified script gets past every structural preflight check for a bundle runExportRecoveryBundle produced", () => {
    const passphrase = "correct horse battery staple";
    const recoveryBundlePath = buildRecoveryBundleViaOrchestration(passphrase);

    const sandbox = newSandbox("orbit-slice4-parity-import-sh-");
    // Enough of a deployment shape for the script's own early preflight
    // (env-file/secrets-directory presence, tool checks) to get past —
    // never enough for its later Docker calls to succeed, which is exactly
    // the boundary this test characterizes.
    writeFileSync(join(sandbox, ".env-orbit"), "COMPOSE_PROJECT_NAME=orbit-slice4-parity-nonexistent\n");
    mkdirSync(join(sandbox, ".orbit-secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(join(sandbox, ".orbit-secrets", "document-kek"), `${LIVE_KEK}\n`, { mode: 0o600 });

    const result = spawnSync("bash", [importScript, recoveryBundlePath], {
      cwd: sandbox,
      encoding: "utf8",
      env: {
        ...process.env,
        ORBIT_ENV_FILE: join(sandbox, ".env-orbit"),
        ORBIT_SECRETS_DIR: join(sandbox, ".orbit-secrets"),
        ORBIT_BACKUP_DIR: join(sandbox, "backups"),
        ORBIT_RECOVERY_TEST_MODE: "true",
      },
      // A real docker daemon may or may not be reachable in this
      // environment; either way it must fail (no matching compose project
      // exists here), and quickly — bounded so a hung daemon call can never
      // stall the suite.
      input: `${passphrase}\n`,
      timeout: 20_000,
    });

    expect(result.status).not.toBe(0);
    // The refusal must come from *past* the structural preflight this slice
    // characterizes (archive/manifest/checksum), never from it — proving
    // our bundle's shape, member set, and checksums are exactly what the
    // real script expects.
    expect(result.stderr).not.toMatch(/preflight\/archive failed/);
    expect(result.stderr).not.toMatch(/preflight\/manifest failed/);
    expect(result.stderr).not.toMatch(/preflight\/checksum failed/);
  });
});
