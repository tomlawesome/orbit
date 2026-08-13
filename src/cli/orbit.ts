import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  BackupRestoreCliRefusal,
  runBackup,
  runExportRecoveryBundle,
  runImportRecoveryBundle,
  runRestore,
  verifyBackupBundle,
} from "../lib/backup-restore-cli";
import { evaluateReadiness, type OidcSecretFileFacts } from "../lib/config-contract";
import { parseEnvOrbitContent } from "../lib/env-orbit-file";
import { InstallTransaction, type ManagedPath } from "../lib/install-transaction";
import {
  type BackupDockerAdapter,
  RecoveryBundleRefusal,
  createDockerComposeBackupAdapter,
  createTar,
  extractTar,
  isValidDocumentKekHex,
  requireMatchingPassphrase,
  requireValidPassphrase,
} from "../lib/recovery-bundle";
import {
  IMPORT_CONFIRMATION_PHRASE,
  type MachinePromptDriver,
  RESTORE_CONFIRMATION_PHRASE,
  RecoveryPromptAbortedError,
  collectMachineImportConfirmation,
  collectMachineRecoveryPassphrase,
  collectMachineRecoveryPassphraseNoConfirm,
  collectMachineRestoreConfirmation,
} from "../lib/recovery-prompts";
import {
  CORRESPONDENCE_QUERIES,
  RestoreEngineRefusal,
  type CorrespondenceReports,
  type RestoreDockerAdapter,
  createDockerComposeRestoreAdapter,
  deriveRestorePaths,
  recoverRestore,
} from "../lib/restore-engine";
import { formatEngineEventLine } from "../lib/engine-event";
import { type InstallOrchestratorAdapters, type InstallOrchestratorContext, runInstall } from "../lib/install-orchestrator";
import { createInstallDockerAdapter } from "../lib/install-docker-adapter";
import { checkCurlAvailable, createInstallAssetFetchAdapter, createInstallOidcFetchAdapter } from "../lib/install-curl-adapter";
import { createInstallConfigurationScriptAdapter, createInstallGuidedConfigurationAdapter } from "../lib/install-script-adapters";
import { ComposeProjectNameRefusal, deriveComposeProjectName } from "../lib/target-identity";
import type { MachinePromptAnswerProvider } from "../lib/guided-configuration";
import {
  ConfigureEngineRefusal,
  ConfigureMachinePromptAbortedError,
  applyGuidedInit,
  applySetOidcSecret,
  collectMachineGuidedInit,
  collectMachineOidcSecret,
  runConfigureApply,
  setDeploymentProfile,
  type ConfigureMachinePromptDriver,
} from "../lib/configure-engine";

// The orbit engine CLI (ADR-0011, issue #294). Flows: `check` — the
// value-free readiness report, output-identical to `configure.sh --check`
// (proven by src/lib/config-contract.parity.test.ts); `install`/`update` —
// issue #295 slice 5's orchestrated install/update flow
// (src/lib/install-orchestrator.ts), driven with the shipped subprocess
// adapters below. Non-interactive by design; interactive presentation
// belongs to orbit-launcher.

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// In-container fail-closed guard (engine-delivery slice, owner decision
// 2026-08-13 recorded on issue #295: "the engine can never manage the Docker
// socket. Ever." / "host scripts remain the only Docker-touching layer").
//
// This exact bundle (dist/cli/orbit.js, built by scripts/bundle-orbit-cli.mjs)
// ships inside the app image at /opt/orbit/cli/orbit.js and is invoked by
// host scripts as a disposable `docker compose run --rm --no-deps` one-off
// (docs/engine-events.md, "In-container engine invocation") — never handed
// the Docker socket, never running with Node on a bare host. `ORBIT_ENGINE_
// CONTEXT=container` is baked into the image with a Dockerfile `ENV`
// instruction, which — unlike CMD/ENTRYPOINT — is part of the image's own
// config and is therefore present in every container started from it
// regardless of `--entrypoint`/`--user` overrides; a container run any other
// way (a plain host checkout driven by `pnpm run orbit`/`tsx`) never has it
// set. This is the single fact this guard trusts.
//
// Every command whose adapters spawn `docker` (install/update via
// install-docker-adapter.ts; backup/restore/export-recovery-bundle/
// import-recovery-bundle via recovery-bundle.ts's/restore-engine.ts's
// createDockerCompose*Adapter) calls refuseDockerInContainer as the FIRST
// statement in its command function below — before any adapter is
// constructed, so the code path that would spawn `docker` is never reached,
// not merely made to fail once reached. `check` (and any other pure-logic
// command) never calls this guard and is unaffected.
const ENGINE_CONTAINER_ENV_VAR = "ORBIT_ENGINE_CONTEXT";
const ENGINE_CONTAINER_CONTEXT_VALUE = "container";

/** Reason enum for the refusal below — stable, machine-parseable, no free text. */
type DockerForbiddenReason = "docker-command-forbidden-in-container";
const DOCKER_FORBIDDEN_REASON: DockerForbiddenReason = "docker-command-forbidden-in-container";

/** Exit code reserved for this refusal class; distinct from the generic `fail()` exit(1) and the Ctrl-C exit(130) already in use elsewhere in this file. */
const DOCKER_FORBIDDEN_EXIT_CODE = 9;

function isRunningAsEngineContainer(): boolean {
  return process.env[ENGINE_CONTAINER_ENV_VAR] === ENGINE_CONTAINER_CONTEXT_VALUE;
}

function refuseDockerInContainer(command: string): void {
  if (!isRunningAsEngineContainer()) return;
  process.stderr.write(`orbit: refused command=${command} reason=${DOCKER_FORBIDDEN_REASON}\n`);
  process.exit(DOCKER_FORBIDDEN_EXIT_CODE);
}

function gatherOidcSecretFacts(deployDir: string): OidcSecretFileFacts {
  const secretsDirectory = join(deployDir, ".orbit-secrets");
  const secretFile = join(secretsDirectory, "oidc-client-secret");
  const directoryStat = statSync(secretsDirectory, { throwIfNoEntry: false });
  const directoryLstat = lstatSync(secretsDirectory, { throwIfNoEntry: false });
  const fileLstat = lstatSync(secretFile, { throwIfNoEntry: false });
  return {
    secretsDirectoryExists: directoryStat?.isDirectory() ?? false,
    secretsDirectoryIsSymlink: directoryLstat?.isSymbolicLink() ?? false,
    secretsDirectoryMode: directoryStat ? directoryStat.mode & 0o777 : null,
    secretFileExists: fileLstat !== undefined,
    secretFileIsRegular: fileLstat?.isFile() ?? false,
    secretFileIsSymlink: fileLstat?.isSymbolicLink() ?? false,
    secretFileMode: fileLstat ? fileLstat.mode & 0o777 : null,
    secretFileSize: fileLstat?.size ?? 0,
  };
}

function commandCheck(deployDir: string): never {
  const environmentFile = join(deployDir, ".env-orbit");
  // Open first with O_NOFOLLOW, then verify and read through the same
  // descriptor: the safety check and the content read cannot be split by a
  // file swap (CodeQL js/file-system-race).
  let descriptor: number;
  try {
    descriptor = openSync(environmentFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail("configuration_syntax");
  }
  let content: string;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      fail("configuration_syntax");
    }
    content = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }

  const parsed = parseEnvOrbitContent(content);
  if (!parsed.ok) fail(parsed.code);

  const facts = gatherOidcSecretFacts(deployDir);
  const report = evaluateReadiness(parsed.record, facts);
  process.stdout.write(report.lines.join("\n") + "\n");
  process.exit(report.ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// orbit backup / orbit restore / orbit export-recovery-bundle /
// orbit import-recovery-bundle (issue #296 slice 4): real, explicit-
// invocation-only CLI entry points wired onto src/lib/recovery-bundle.ts
// (slices 1-2) and src/lib/restore-engine.ts (slice 3) via the orchestration
// in src/lib/backup-restore-cli.ts. None of these is reachable except by
// typing the command name — no default/implied execution from `main()`'s
// dispatch, no bootstrap wiring, and scripts/backup.sh / scripts/restore.sh
// / scripts/export-recovery-bundle.sh / scripts/import-recovery-bundle.sh
// remain entirely unmodified and are not invoked by anything here (see
// docs/adr-notes/296-backup-port-plan.md, Slice 4, "Non-goals").
// ---------------------------------------------------------------------------

interface BackupRestorePaths {
  envFile: string;
  backupDirectory: string;
  documentKekFile: string;
}

// The TS CLI's own path convention: everything is derived from `--dir`
// (matching `check`'s existing convention above), not from the Bash
// scripts' ORBIT_ENV_FILE/ORBIT_BACKUP_DIR/ORBIT_SECRETS_DIR environment
// variables — a deliberate, flagged simplification (see docs/adr-notes/
// 296-backup-port-plan.md, Slice 4 Flags), not a behavioral gap in what's
// characterized.
function resolveBackupRestorePaths(deployDir: string): BackupRestorePaths {
  return {
    envFile: join(deployDir, ".env-orbit"),
    backupDirectory: join(deployDir, "backups"),
    documentKekFile: join(deployDir, ".orbit-secrets", "document-kek"),
  };
}

/**
 * Reads the document KEK straight off the host filesystem (the slice 1
 * divergence docs/adr-notes/296-backup-port-plan.md's Flags already
 * flagged: every Bash script reads it the same way for its own format
 * checks). Single O_NOFOLLOW descriptor, mirroring commandCheck's own
 * discipline above and recovery-bundle.ts's readRegularFileNoFollow.
 */
function readDocumentKekHex(path: string): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail(`orbit: missing regular document KEK file at ${path}`);
  }
  let content: string;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) fail(`orbit: missing regular document KEK file at ${path}`);
    content = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  const trimmed = content.replace(/[\r\n]+$/, "");
  if (!isValidDocumentKekHex(trimmed)) fail("orbit: the document KEK must be a 32-byte hexadecimal value");
  return trimmed;
}

// --- synchronous line I/O ---------------------------------------------------
//
// Everything else in this CLI is synchronous (no Promises anywhere in this
// file); prompt collection follows the same style rather than introducing
// async purely for stdin. fs.readSync on fd 0 performs a real blocking read
// syscall regardless of whether fd 0 is a TTY or a pipe — the same technique
// widely-used synchronous-stdin CLI libraries use — so this works both for a
// real terminal and for a spawned test harness's piped stdin.

function readSyncLine(fd: number): string | undefined {
  const bytes: number[] = [];
  const buffer = Buffer.alloc(1);
  for (;;) {
    const bytesRead = readSync(fd, buffer, 0, 1, null);
    if (bytesRead === 0) return bytes.length > 0 ? Buffer.from(bytes).toString("utf8") : undefined;
    const byte = buffer[0];
    if (byte === 10) return Buffer.from(bytes).toString("utf8");
    if (byte !== 13) bytes.push(byte);
  }
}

/**
 * A masked (no-echo) synchronous line read directly off fd 0 in raw mode —
 * the Node equivalent of `read -s`. Requires a real controlling terminal on
 * both stdin and stdout, matching export-recovery-bundle.sh/import-recovery-
 * bundle.sh's own `</dev/tty` requirement ("An interactive terminal is
 * required."), simplified to require stdin itself be that terminal (this
 * CLI never pipes a secret to a subprocess's stdin the way the Bash scripts
 * pipe the passphrase into `recovery-crypto.mjs`'s container invocation, so
 * — unlike Bash — nothing here needs stdin kept free for that; flagged in
 * docs/adr-notes/296-backup-port-plan.md).
 */
function readTtyMaskedLine(promptText: string): string {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("orbit: an interactive terminal is required.");
  }
  process.stdout.write(promptText);
  process.stdin.setRawMode(true);
  const bytes: number[] = [];
  const buffer = Buffer.alloc(1);
  try {
    for (;;) {
      const bytesRead = readSync(0, buffer, 0, 1, null);
      if (bytesRead === 0) break;
      const byte = buffer[0];
      if (byte === 3) {
        // Ctrl-C: restore the terminal before exiting so the shell isn't left echo-less.
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        process.exit(130);
      }
      if (byte === 13 || byte === 10) break;
      if (byte === 127 || byte === 8) {
        if (bytes.length > 0) bytes.pop();
        continue;
      }
      bytes.push(byte);
    }
  } finally {
    process.stdin.setRawMode(false);
  }
  process.stdout.write("\n");
  return Buffer.from(bytes).toString("utf8");
}

function readTtyLine(promptText: string): string {
  if (!process.stdin.isTTY) fail("orbit: an interactive terminal is required.");
  process.stdout.write(promptText);
  const line = readSyncLine(0);
  if (line === undefined) fail("orbit: an interactive terminal is required.");
  return line;
}

function isMachinePromptMode(): boolean {
  return process.env.ORBIT_RECOVERY_PROMPTS === "machine";
}

function stdoutMachineDriver(): MachinePromptDriver {
  return {
    write(line: string): void {
      process.stdout.write(`${line}\n`);
    },
    readLine(): string | undefined {
      return readSyncLine(0);
    },
  };
}

/** export-recovery-bundle.sh:37-45 (guarantees #6-7): passphrase, then its confirmation, entered twice with no retry loop in TTY mode (matching the Bash original's single-attempt fail-closed behavior exactly); machine mode gets the bounded-3-attempt retry protocol docs/engine-events.md now documents. */
function collectRecoveryPassphraseWithConfirmation(): string {
  if (isMachinePromptMode()) return collectMachineRecoveryPassphrase(stdoutMachineDriver());
  const passphrase = readTtyMaskedLine("Recovery passphrase: ");
  requireValidPassphrase(passphrase);
  const confirmation = readTtyMaskedLine("Confirm recovery passphrase: ");
  requireMatchingPassphrase(passphrase, confirmation);
  return passphrase;
}

/** import-recovery-bundle.sh:73-74: a single passphrase entry, no confirmation (only IMPORT_CONFIRMATION below is a typed phrase). */
function collectImportPassphrase(): string {
  if (isMachinePromptMode()) return collectMachineRecoveryPassphraseNoConfirm(stdoutMachineDriver());
  return readTtyMaskedLine("Recovery passphrase: ");
}

/** import-recovery-bundle.sh:88-94 (guarantee #19): the literal "IMPORT RECOVERY" phrase, single attempt in TTY mode. */
function collectImportConfirmation(bundlePath: string): boolean {
  if (isMachinePromptMode()) {
    try {
      collectMachineImportConfirmation(stdoutMachineDriver());
      return true;
    } catch (error) {
      if (error instanceof RecoveryPromptAbortedError) return false;
      throw error;
    }
  }
  process.stdout.write(`This will replace the local document KEK and restore:\n  ${bundlePath}\n`);
  const answer = readTtyLine("Type IMPORT RECOVERY to continue: ");
  return answer === IMPORT_CONFIRMATION_PHRASE;
}

/** restore.sh guarantee #46: either `--yes` with `ORBIT_NONINTERACTIVE_RESTORE=true` (unattended automation — a single flag alone is never sufficient), or the literal "RESTORE" phrase (interactive/machine). Returns a callback: runRestore() calls it exactly once, at restore.sh's own confirmation point (after preflight/capacity, before the checkpoint), never eagerly. */
function makeRestoreConfirmer(useYesFlag: boolean): () => boolean {
  if (useYesFlag) {
    return () => process.env.ORBIT_NONINTERACTIVE_RESTORE === "true";
  }
  return () => {
    if (isMachinePromptMode()) {
      try {
        collectMachineRestoreConfirmation(stdoutMachineDriver());
        return true;
      } catch (error) {
        if (error instanceof RecoveryPromptAbortedError) return false;
        throw error;
      }
    }
    process.stdout.write("This will replace Orbit database contents and encrypted document bytes after a verified recovery checkpoint.\n");
    const answer = readTtyLine("Type RESTORE to continue: ");
    return answer === RESTORE_CONFIRMATION_PHRASE;
  };
}

// ---------------------------------------------------------------------------
// orbit configure / orbit configure --init / orbit configure --set-oidc-
// secret / orbit configure --set-deployment-profile (issue #294): the write
// side of scripts/configure.sh, ported onto src/lib/configure-engine.ts.
// File work only (no `docker`; VAPID key generation is permanently
// bash-only — see that module's header comment), so unlike install/backup/
// restore/etc. above this never calls refuseDockerInContainer: it is exactly
// as safe to run inside the disposable engine container as `check` is.
// scripts/configure.sh delegates to this command as a
// `docker compose run --rm --no-deps` one-off (docs/adr-notes/
// 294-configure-write-port-plan.md) when ORBIT_CONFIGURE_ENGINE=container
// and the image is available, falling back to its own bash logic otherwise.
//
// Machine prompts: this CLI has no controlling terminal of its own
// (mirroring install-orchestrator.ts's `hasControllingTerminal: false`), so
// `--init` and `--set-oidc-secret` only ever collect an answer two ways: the
// complete ORBIT_CONFIGURE_APP_URL/_OIDC_ISSUER/_OIDC_CLIENT_ID environment
// triad (fully scripted, no exchange needed), or the #297
// `ORBIT_CONFIGURE_PROMPTS=machine` line grammar this engine now speaks
// itself (src/lib/configure-engine.ts's collectMachineGuidedInit/
// collectMachineOidcSecret). A real human TTY session is never delegated —
// scripts/configure.sh keeps that path bash-only (see the delegation plan
// doc's Flags section).
// ---------------------------------------------------------------------------

function isConfigureMachinePromptMode(): boolean {
  return process.env.ORBIT_CONFIGURE_PROMPTS === "machine";
}

function stdoutConfigureMachineDriver(): ConfigureMachinePromptDriver {
  return {
    write(line: string): void {
      process.stdout.write(`${line}\n`);
    },
    readLine(): string | undefined {
      return readSyncLine(0);
    },
  };
}

function usageExit(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function commandConfigureApply(deployDir: string): never {
  try {
    const result = runConfigureApply(deployDir, process.env.ORBIT_IMAGE);
    for (const message of result.messages) {
      process.stdout.write(`${message}\n`);
    }
    process.exit(0);
  } catch (error) {
    if (error instanceof ConfigureEngineRefusal) fail(`orbit: ${error.message}`);
    throw error;
  }
}

function commandConfigureInit(deployDir: string): never {
  const envAppUrl = process.env.ORBIT_CONFIGURE_APP_URL;
  const envIssuer = process.env.ORBIT_CONFIGURE_OIDC_ISSUER;
  const envClientId = process.env.ORBIT_CONFIGURE_OIDC_CLIENT_ID;
  const providedCount = [envAppUrl, envIssuer, envClientId].filter((value) => !!value).length;

  let appUrl: string;
  let issuer: string;
  let clientId: string;

  if (providedCount === 3) {
    appUrl = envAppUrl as string;
    issuer = envIssuer as string;
    clientId = envClientId as string;
  } else if (providedCount > 0) {
    fail(
      "orbit: guided configuration requires all of ORBIT_CONFIGURE_APP_URL, ORBIT_CONFIGURE_OIDC_ISSUER and ORBIT_CONFIGURE_OIDC_CLIENT_ID together, not a partial set.",
    );
  } else if (isConfigureMachinePromptMode()) {
    try {
      const collected = collectMachineGuidedInit(stdoutConfigureMachineDriver());
      appUrl = collected.appUrl;
      issuer = collected.issuer;
      clientId = collected.clientId;
    } catch (error) {
      if (error instanceof ConfigureMachinePromptAbortedError) fail("orbit: guided configuration was cancelled.");
      throw error;
    }
  } else {
    fail(
      "orbit: guided configuration requires ORBIT_CONFIGURE_PROMPTS=machine or the complete ORBIT_CONFIGURE_APP_URL, ORBIT_CONFIGURE_OIDC_ISSUER and ORBIT_CONFIGURE_OIDC_CLIENT_ID environment set — this engine has no controlling terminal of its own.",
    );
  }

  try {
    const message = applyGuidedInit(deployDir, { appUrl, issuer, clientId });
    process.stdout.write(`${message}\n`);
    process.exit(0);
  } catch (error) {
    if (error instanceof ConfigureEngineRefusal) fail(`orbit: ${error.message}`);
    throw error;
  }
}

function commandConfigureSetOidcSecret(deployDir: string): never {
  let secret: string;
  if (isConfigureMachinePromptMode()) {
    try {
      secret = collectMachineOidcSecret(stdoutConfigureMachineDriver());
    } catch (error) {
      if (error instanceof ConfigureMachinePromptAbortedError) {
        fail("orbit: could not read a complete OIDC client secret from standard input.");
      }
      throw error;
    }
  } else {
    // Mirrors configure.sh's own non-machine, non-TTY fallback
    // (`elif ! IFS= read -r -p '' secret`): a single raw line piped in, no
    // hidden-terminal handling — this engine has no controlling terminal to
    // offer that on (see this section's own header comment).
    const line = readSyncLine(0);
    if (line === undefined) fail("orbit: could not read a complete OIDC client secret from standard input.");
    secret = line;
  }

  try {
    const message = applySetOidcSecret(deployDir, secret);
    process.stdout.write(`${message}\n`);
    process.exit(0);
  } catch (error) {
    if (error instanceof ConfigureEngineRefusal) fail(`orbit: ${error.message}`);
    throw error;
  }
}

function commandConfigureSetDeploymentProfile(deployDir: string, preset: string, model: string | undefined): never {
  try {
    const message = setDeploymentProfile(deployDir, preset, model);
    process.stdout.write(`${message}\n`);
    process.exit(0);
  } catch (error) {
    if (error instanceof ConfigureEngineRefusal) {
      // Mirrors configure.sh's own `return 2` (usage error) for an invalid
      // preset/model shape, distinct from every other refusal's exit 1.
      if (error.code === "deployment-profile-invalid") {
        usageExit("orbit: usage: orbit configure --set-deployment-profile <standard|processing|ai|full> [MODEL]");
      }
      fail(`orbit: ${error.message}`);
    }
    throw error;
  }
}

function commandConfigure(deployDir: string, args: string[]): never {
  if (args.length === 0) {
    commandConfigureApply(deployDir);
  }
  const [first, ...rest] = args;
  switch (first) {
    case "--init":
      if (rest.length > 0) usageExit("orbit: usage: orbit configure --init");
      commandConfigureInit(deployDir);
      break;
    case "--set-oidc-secret":
      if (rest.length > 0) usageExit("orbit: usage: orbit configure --set-oidc-secret");
      commandConfigureSetOidcSecret(deployDir);
      break;
    case "--set-deployment-profile": {
      if (rest.length < 1 || rest.length > 2) {
        usageExit("orbit: usage: orbit configure --set-deployment-profile <standard|processing|ai|full> [MODEL]");
      }
      const [preset, model] = rest;
      commandConfigureSetDeploymentProfile(deployDir, preset, model);
      break;
    }
    default:
      usageExit(`orbit: unknown option ${first} (usage: orbit configure [--init|--set-oidc-secret|--set-deployment-profile PRESET [MODEL]])`);
  }
}

function commandBackup(deployDir: string, args: string[]): never {
  refuseDockerInContainer("backup");
  const paths = resolveBackupRestorePaths(deployDir);
  const documentKekHex = readDocumentKekHex(paths.documentKekFile);
  const adapter: BackupDockerAdapter = createDockerComposeBackupAdapter({ envFile: paths.envFile, cwd: deployDir });

  if (args[0] === "--verify") {
    if (args.length !== 2 || !args[1]) fail("orbit: usage: orbit backup --verify <backup.tar>");
    const target = resolve(args[1]);
    const workDir = mkdtempSync(join(tmpdir(), "orbit-backup-verify-"));
    try {
      verifyBackupBundle(target, documentKekHex, workDir, adapter);
      process.stdout.write(`Orbit backup is valid: ${args[1]}\n`);
      process.exit(0);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  if (args.length !== 0) fail("orbit: usage: orbit backup [--verify <backup.tar>]");
  const result = runBackup({ backupDirectory: paths.backupDirectory, documentKekHex, adapter, now: new Date() });
  process.stdout.write(`Orbit backup created: ${result.finalTarPath}\n`);
  process.exit(0);
}

function commandRestore(deployDir: string, args: string[]): never {
  refuseDockerInContainer("restore");
  const paths = resolveBackupRestorePaths(deployDir);
  const restorePaths = deriveRestorePaths(paths.backupDirectory, paths.documentKekFile);
  const adapter = createDockerComposeRestoreAdapter({ envFile: paths.envFile, cwd: deployDir });

  let yesFlag = false;
  let recoverMode = false;
  let backupFile: string | undefined;
  for (const arg of args) {
    if (arg === "--yes") {
      yesFlag = true;
      continue;
    }
    if (arg === "--recover") {
      recoverMode = true;
      continue;
    }
    if (backupFile === undefined) {
      backupFile = arg;
      continue;
    }
    fail("orbit: usage: orbit restore [--yes] <backup.tar> | orbit restore --recover");
  }

  if (recoverMode) {
    if (backupFile !== undefined || yesFlag) fail("orbit: usage: --recover accepts no other arguments");
    const workDir = mkdtempSync(join(tmpdir(), "orbit-restore-recover-"));
    try {
      recoverRestore({ adapter, paths: restorePaths, workDir });
      process.stdout.write("Orbit recovery completed; the prior database, document tree, and key state were restored.\n");
      process.exit(0);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  if (backupFile === undefined) fail("orbit: usage: orbit restore [--yes] <backup.tar> | orbit restore --recover");
  const documentKekHex = readDocumentKekHex(paths.documentKekFile);
  const workDir = mkdtempSync(join(tmpdir(), "orbit-restore-"));
  try {
    runRestore({
      backupTarPath: resolve(backupFile),
      documentKekHex,
      paths: restorePaths,
      adapter,
      workDir,
      confirm: makeRestoreConfirmer(yesFlag),
    });
    process.stdout.write("Orbit restore completed successfully.\n");
    process.exit(0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function commandExportRecoveryBundle(deployDir: string, args: string[]): never {
  refuseDockerInContainer("export-recovery-bundle");
  if (args.length !== 1 || !args[0]) fail("orbit: usage: orbit export-recovery-bundle <backup.tar>");
  const paths = resolveBackupRestorePaths(deployDir);
  const documentKekHex = readDocumentKekHex(paths.documentKekFile);
  const adapter = createDockerComposeBackupAdapter({ envFile: paths.envFile, cwd: deployDir });
  const passphrase = collectRecoveryPassphraseWithConfirmation();
  const result = runExportRecoveryBundle({
    sourceBundlePath: resolve(args[0]),
    documentKekHex,
    passphrase,
    passphraseConfirmation: passphrase,
    backupDirectory: paths.backupDirectory,
    adapter,
    now: new Date(),
  });
  process.stdout.write(`Orbit recovery bundle created: ${result.finalPath}\n`);
  process.exit(0);
}

function commandImportRecoveryBundle(deployDir: string, args: string[]): never {
  refuseDockerInContainer("import-recovery-bundle");
  if (args.length !== 1 || !args[0]) fail("orbit: usage: orbit import-recovery-bundle <recovery.tar>");
  const recoveryBundlePath = resolve(args[0]);
  const paths = resolveBackupRestorePaths(deployDir);
  const adapter = createDockerComposeRestoreAdapter({ envFile: paths.envFile, cwd: deployDir });
  const passphrase = collectImportPassphrase();
  const importConfirmed = collectImportConfirmation(recoveryBundlePath);
  runImportRecoveryBundle({
    recoveryBundlePath,
    passphrase,
    liveDocumentKekFile: paths.documentKekFile,
    backupDirectory: paths.backupDirectory,
    adapter,
    importConfirmed,
    confirmRestore: makeRestoreConfirmer(false),
  });
  process.stdout.write("Orbit recovery import completed successfully.\n");
  process.exit(0);
}

// Scenario shape for the hidden __install-transaction-rehearse subcommand
// below: JSON-serialisable so it can be handed to a child process for the
// SIGKILL interruption characterization test in
// src/lib/install-transaction.test.ts. Not a documented interface.
interface RehearsalScenario {
  targetDir: string;
  managedPaths: ManagedPath[];
  steps: RehearsalStep[];
}

type RehearsalStep =
  | { kind: "write"; path: string; contentBase64: string; mode?: number }
  | { kind: "commitMove"; path: string; type: "file" | "directory" }
  | { kind: "mkdir"; path: string }
  | { kind: "pause"; resumeSignalPath: string }
  | { kind: "commit" };

// Blocks the event loop synchronously (Node has no sync sleep primitive
// otherwise) so a test harness has a stable window to SIGKILL this process
// mid-transaction, mirroring how scripts/test-install-acceptance.sh waits
// for a known installer log line before its own kill -9.
function blockUntil(predicate: () => boolean, pollMs = 25): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (!predicate()) {
    Atomics.wait(signal, 0, 0, pollMs);
  }
}

// Hidden/experimental: exercises InstallTransaction end-to-end for issue
// #295 slice 1's interruption characterization test. Never invoked by any
// shipped install/update/check flow, and deliberately undocumented in the
// usage message below.
function commandInstallTransactionRehearse(scenarioPath: string): never {
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as RehearsalScenario;
  const transaction = InstallTransaction.begin(scenario.targetDir, scenario.managedPaths);
  try {
    for (const step of scenario.steps) {
      switch (step.kind) {
        case "write":
          transaction.writeStagedFile(step.path, Buffer.from(step.contentBase64, "base64"), step.mode);
          break;
        case "commitMove":
          transaction.commitMove(step.path, step.type);
          break;
        case "mkdir":
          transaction.ensureManagedDirectory(step.path);
          break;
        case "pause":
          process.stdout.write("phase=paused\n");
          blockUntil(() => existsSync(step.resumeSignalPath));
          break;
        case "commit":
          transaction.commit();
          break;
      }
    }
  } finally {
    transaction.dispose();
  }
  process.exit(0);
}

// Scenario shape and fake adapter for the hidden __restore-engine-rehearse
// subcommand below: exercises RestoreRun/recoverRestore (issue #296 slice 3)
// end-to-end, including a real, self-delivered SIGKILL at a chosen mutating
// step, for the interruption characterization test in
// src/lib/restore-engine.interruption.test.ts. Not a documented interface,
// and — unlike the install-transaction rehearsal, which pauses for an
// external kill — this mirrors restore.sh's own test harness
// (ORBIT_RESTORE_TEST_HARD_INTERRUPT_STAGE) by having the process signal
// itself once the target step completes: deterministic, no race window.
// The "Docker/Postgres" this fake adapter stands in for are a real
// on-disk document tree and a JSON file (never a live daemon) — restore.sh
// itself is not invoked or modified.
interface RestoreRehearsalDocumentSpec {
  storageKey: string;
  contentLength: number;
  fillByte: number;
}

interface RestoreRehearsalScenario {
  backupDirectory: string;
  documentKekFile: string;
  liveDocumentsRoot: string;
  liveDatabaseFile: string;
  original: RestoreRehearsalDocumentSpec;
  updated: RestoreRehearsalDocumentSpec;
  mode: "forward" | "recover";
  hardKillAfter?: "checkpoint" | "documents-replaced" | "database-restored";
}

const REHEARSAL_DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";

function buildCorrespondenceReports(spec: RestoreRehearsalDocumentSpec): CorrespondenceReports {
  return {
    crypto: `${REHEARSAL_DOCUMENT_ID}|${spec.storageKey}|${spec.contentLength}|available\n`,
    visible: `${REHEARSAL_DOCUMENT_ID}|available|${spec.storageKey}|${spec.contentLength}\n`,
    attachments: "",
    staging: "",
    documentStaging: "",
    transientCount: "0",
  };
}

function buildDocumentTree(root: string, spec: RestoreRehearsalDocumentSpec): void {
  rmSync(root, { recursive: true, force: true });
  const objectDir = join(root, "objects", spec.storageKey.slice(0, 2), spec.storageKey.slice(2, 4));
  mkdirSync(objectDir, { recursive: true });
  mkdirSync(join(root, "staging"), { recursive: true });
  writeFileSync(join(objectDir, `${spec.storageKey}.bin`), Buffer.alloc(spec.contentLength, spec.fillByte));
}

function writeFakeDatabaseBlob(path: string, spec: RestoreRehearsalDocumentSpec): void {
  writeFileSync(path, JSON.stringify({ reports: buildCorrespondenceReports(spec) }), { mode: 0o600 });
}

function lookupReportField(reports: CorrespondenceReports, query: string): string {
  const entry = (Object.entries(CORRESPONDENCE_QUERIES) as Array<[keyof CorrespondenceReports, string]>).find(([, text]) => text === query);
  if (!entry) throw new Error("orbit: rehearsal fake adapter received an unrecognised correspondence query");
  return reports[entry[0]];
}

class RestoreRehearsalFakeAdapter implements RestoreDockerAdapter {
  private readonly stageContents = new Map<string, CorrespondenceReports>();
  private appRunning = true;

  constructor(
    private readonly liveDocumentsRoot: string,
    private readonly liveDatabaseFile: string,
  ) {}

  dumpDatabase(outputPath: string): void {
    copyFileSync(this.liveDatabaseFile, outputPath);
  }
  pgRestoreListOk(dumpPath: string): boolean {
    try {
      JSON.parse(readFileSync(dumpPath, "utf8"));
      return true;
    } catch {
      return false;
    }
  }
  collectDocumentsArchive(outputPath: string): void {
    createTar(this.liveDocumentsRoot, outputPath, ["."]);
  }
  stopApp(): boolean {
    this.appRunning = false;
    return true;
  }
  startApp(): boolean {
    this.appRunning = true;
    return true;
  }
  createStageDatabase(): void {
    // No real database in this fake: restoreDumpToDatabase records content
    // keyed by name, which is all queryReport needs.
  }
  dropStageDatabase(name: string): void {
    this.stageContents.delete(name);
  }
  restoreDumpToDatabase(name: string, dumpPath: string): boolean {
    const blob = JSON.parse(readFileSync(dumpPath, "utf8")) as { reports: CorrespondenceReports };
    this.stageContents.set(name, blob.reports);
    return true;
  }
  restoreActiveDatabase(dumpPath: string): boolean {
    copyFileSync(dumpPath, this.liveDatabaseFile);
    return true;
  }
  replaceDocumentsFromArchive(archivePath: string): boolean {
    rmSync(this.liveDocumentsRoot, { recursive: true, force: true });
    mkdirSync(this.liveDocumentsRoot, { recursive: true });
    extractTar(archivePath, this.liveDocumentsRoot);
    return true;
  }
  resetScanRecoveryLeases(): boolean {
    return true;
  }
  queryReport(name: string, query: string): string {
    const reports = this.stageContents.get(name);
    if (!reports) throw new Error("orbit: rehearsal fake adapter has no staged content for this database name");
    return lookupReportField(reports, query);
  }
  queryActiveReport(query: string): string {
    const blob = JSON.parse(readFileSync(this.liveDatabaseFile, "utf8")) as { reports: CorrespondenceReports };
    return lookupReportField(blob.reports, query);
  }
  waitForHealth(): boolean {
    return this.appRunning;
  }
  measureLiveDatabaseSizeBytes(): number {
    return 1024;
  }
  measureLiveDocumentTreeKib(): number {
    return 1;
  }
  measureDocumentVolumeAvailableKib(): number {
    return 1_000_000;
  }
}

/**
 * Builds a real, fully-valid backup bundle (five members, HMAC-signed,
 * encrypted document archive — everything verifyBackupBundle/runRestore
 * themselves require) from a document tree + fake database JSON blob, using
 * a throwaway BackupDockerAdapter pointed at that content — not the
 * scenario's own "live" adapter/state, which must stay untouched until
 * runRestore's real cutover mutates it. This is what makes the rehearsal
 * below exercise the true orchestrated flow (issue #296 slice 4): the
 * "updated" bundle runRestore() consumes is produced exactly the way
 * `orbit backup` would produce one, via the same createBackupBundle
 * (slice 2) the real command calls.
 */
function buildRehearsalUpdateBundle(spec: RestoreRehearsalDocumentSpec, documentKekHex: string, scratchRoot: string): string {
  const sourceRoot = join(scratchRoot, "source");
  const documentsRoot = join(sourceRoot, "documents");
  mkdirSync(documentsRoot, { recursive: true });
  buildDocumentTree(documentsRoot, spec);
  const databaseFile = join(sourceRoot, "database.json");
  writeFakeDatabaseBlob(databaseFile, spec);

  const sourceAdapter: BackupDockerAdapter = {
    stopApp(): void {},
    startApp(): void {},
    dumpDatabase(outputPath: string): void {
      copyFileSync(databaseFile, outputPath);
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

  const bundleDirectory = join(scratchRoot, "bundle-source");
  const result = runBackup({ backupDirectory: bundleDirectory, documentKekHex, adapter: sourceAdapter, now: new Date() });
  return result.finalTarPath;
}

function commandRestoreEngineRehearse(scenarioPath: string): never {
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as RestoreRehearsalScenario;
  const adapter = new RestoreRehearsalFakeAdapter(scenario.liveDocumentsRoot, scenario.liveDatabaseFile);
  const paths = deriveRestorePaths(scenario.backupDirectory, scenario.documentKekFile);

  if (scenario.mode === "recover") {
    const workDir = mkdtempSync(join(scenario.backupDirectory, ".rehearsal-recover-work."));
    try {
      recoverRestore({ adapter, paths, workDir });
      process.stdout.write("outcome=recovered\n");
      process.exit(0);
    } catch (error) {
      process.stdout.write(`outcome=failed message=${(error as Error).message}\n`);
      process.exit(1);
    }
  }

  buildDocumentTree(scenario.liveDocumentsRoot, scenario.original);
  writeFakeDatabaseBlob(scenario.liveDatabaseFile, scenario.original);

  const documentKekHex = readFileSync(scenario.documentKekFile, "utf8").replace(/[\r\n]+$/, "");
  const bundleScratchDir = mkdtempSync(join(scenario.backupDirectory, ".rehearsal-updated-bundle."));
  const updatedBundlePath = buildRehearsalUpdateBundle(scenario.updated, documentKekHex, bundleScratchDir);

  // Drives the real orchestrated flow (src/lib/backup-restore-cli.ts's
  // runRestore — the same function `orbit restore` itself calls), not a
  // hand-assembled sequence of RestoreRun calls: this is what "extends the
  // SIGKILL rehearsal matrix to cover the orchestrated flow" means in
  // practice — the staged-bundle preflight and check_capacity (#11-12) now
  // run for real ahead of the checkpoint, and the SIGKILL points below are
  // the same testHooks the orchestration itself exposes, not steps
  // duplicated here.
  const workDir = mkdtempSync(join(scenario.backupDirectory, ".rehearsal-work."));
  try {
    const result = runRestore({
      backupTarPath: updatedBundlePath,
      documentKekHex,
      paths,
      adapter,
      workDir,
      confirm: () => true,
      testHooks: {
        afterCheckpoint: () => {
          if (scenario.hardKillAfter === "checkpoint") process.kill(process.pid, "SIGKILL");
        },
        afterDocumentsReplaced: () => {
          if (scenario.hardKillAfter === "documents-replaced") process.kill(process.pid, "SIGKILL");
        },
        afterDatabaseRestored: () => {
          if (scenario.hardKillAfter === "database-restored") process.kill(process.pid, "SIGKILL");
        },
      },
    });
    process.stdout.write(`outcome=${result.outcome}\n`);
    process.exit(0);
  } catch (error) {
    process.stdout.write(`outcome=failed message=${(error as Error).message}\n`);
    process.exit(1);
  }
}

// `orbit install --dir <deployment>` / `orbit update --dir <deployment>`
// (issue #295 slice 5): drives install-orchestrator.ts's runInstall with the
// real subprocess adapters (install-docker-adapter.ts, install-curl-
// adapter.ts, install-script-adapters.ts). Explicit invocation only — unlike
// `check`, which defaults an omitted --dir to the current directory,
// install/update refuse outright without one: these flows mutate a real
// deployment target, so silently defaulting to cwd is a materially higher-
// stakes mistake than for a read-only readiness report.

/** install.sh:134-138 (ORBIT_CHANNEL). */
const CHANNEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** install.sh:138-141 (ORBIT_REPOSITORY). */
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** install.sh:142-145 (ORBIT_REGISTRY). */
const REGISTRY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?$/;
/** install.sh:125-126 (ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: 1-999 by pattern, further bounded to <=900). */
const READINESS_TIMEOUT_PATTERN = /^[1-9][0-9]{0,2}$/;
/** install.sh:130 (ORBIT_INSTALLER_POLL_INTERVAL_SECONDS: a single digit, 1-9). */
const READINESS_POLL_PATTERN = /^[1-9]$/;

interface InstallEnvironmentConfig {
  repository: string;
  registry: string;
  channel: string;
  readinessTimeoutSeconds: number;
  readinessPollSeconds: number;
}

/**
 * Reads and validates ORBIT_REPOSITORY/ORBIT_REGISTRY/ORBIT_CHANNEL/
 * ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS/ORBIT_INSTALLER_POLL_INTERVAL_SECONDS
 * exactly the way install.sh does at its own top-of-script argument/env
 * validation (install.sh:13-15,123-145) — install-orchestrator.ts itself
 * has no reason to own environment-variable parsing (it takes an already-
 * validated context), so this is this CLI's own responsibility, the same
 * way it already owns `--dir` parsing for `check`. Fails closed with
 * install.sh's own messages on anything invalid.
 */
function resolveInstallEnvironmentConfig(env: NodeJS.ProcessEnv): InstallEnvironmentConfig {
  const repository = env.ORBIT_REPOSITORY ?? "tomlawesome/orbit";
  const registry = env.ORBIT_REGISTRY ?? "ghcr.io";
  const channel = env.ORBIT_CHANNEL ?? "latest";
  const readinessTimeoutRaw = env.ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS ?? "180";
  const readinessPollRaw = env.ORBIT_INSTALLER_POLL_INTERVAL_SECONDS ?? "2";

  if (!READINESS_TIMEOUT_PATTERN.test(readinessTimeoutRaw) || Number(readinessTimeoutRaw) > 900) {
    fail("orbit: ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS must be between 1 and 900.");
  }
  if (!READINESS_POLL_PATTERN.test(readinessPollRaw)) {
    fail("orbit: ORBIT_INSTALLER_POLL_INTERVAL_SECONDS must be between 1 and 9.");
  }
  if (!CHANNEL_PATTERN.test(channel)) {
    fail("orbit: ORBIT_CHANNEL is invalid.");
  }
  if (!REPOSITORY_PATTERN.test(repository)) {
    fail("orbit: ORBIT_REPOSITORY is invalid.");
  }
  if (!REGISTRY_PATTERN.test(registry)) {
    fail("orbit: ORBIT_REGISTRY is invalid.");
  }

  return {
    repository,
    registry,
    channel,
    readinessTimeoutSeconds: Number(readinessTimeoutRaw),
    readinessPollSeconds: Number(readinessPollRaw),
  };
}

/** install.sh's own `basename -- "$(pwd -P)"` fallback (install.sh:453) — `pwd -P` resolves symlinks in the cwd; realpathSync mirrors that for an arbitrary --dir target. */
function deriveFallbackBasename(targetDir: string): string {
  let resolved = targetDir;
  try {
    resolved = realpathSync(targetDir);
  } catch {
    // targetDir was just created if it didn't already exist (see
    // commandInstallOrUpdate below), so this only matters if realpath
    // itself fails for some other reason — fall back to the literal path.
  }
  return basename(resolved);
}

// stageGuidedInstallConfiguration/prepareConfiguration only ever call
// `answers.answer` when hasControllingTerminal is true
// (guided-configuration.ts), and this CLI always passes false below (see
// InstallOrchestratorContext.hasControllingTerminal's own doc in
// install-orchestrator.ts and docs/adr-notes/295-install-port-plan.md's
// Flags section) — collecting real answer values from CLI flags/environment
// for an interactive-equivalent surface is explicitly deferred to a future
// slice. This provider exists only so the type is satisfied; reaching it is
// a programming error, not an expected runtime path.
const UNREACHABLE_ANSWERS: MachinePromptAnswerProvider = {
  answer(): never {
    throw new Error("orbit: interactive guided configuration is not available from this CLI yet");
  },
};

function commandInstallOrUpdate(action: "install" | "update", deployDirArg: string | undefined): void {
  refuseDockerInContainer(action);
  if (!deployDirArg) {
    fail(`orbit: ${action} requires --dir <deployment>`);
  }
  const targetDir = resolve(deployDirArg);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  } else if (!statSync(targetDir).isDirectory()) {
    fail(`orbit: ${targetDir} is not a directory.`);
  }

  const config = resolveInstallEnvironmentConfig(process.env);
  const fallbackBasename = deriveFallbackBasename(targetDir);
  const requestedComposeProjectName = process.env.COMPOSE_PROJECT_NAME;

  // Best-effort initial value only: createInstallDockerAdapter needs some
  // starting --project-name at construction time, before
  // verify_database_volume_safety's own resolution (possibly a proven
  // pre-existing volume's own label) has run. install-orchestrator.ts calls
  // adapters.docker.setComposeProjectName with the final resolved value
  // immediately once that resolution completes and before any `compose`-
  // wrapped call — see that module's own comment at the call site. A
  // ComposeProjectNameRefusal here is deliberately swallowed: runInstall's
  // own internal call raises the identical refusal as a graceful
  // {status:"failed"} outcome, printed below like every other failure.
  let initialComposeProjectName = fallbackBasename;
  try {
    initialComposeProjectName = deriveComposeProjectName(targetDir, requestedComposeProjectName, fallbackBasename).composeProjectName;
  } catch (error) {
    if (!(error instanceof ComposeProjectNameRefusal)) throw error;
  }

  const docker = createInstallDockerAdapter({
    cwd: targetDir,
    envFile: ".env-orbit",
    composeProjectName: initialComposeProjectName,
  });
  const assetFetchAdapter = createInstallAssetFetchAdapter({ cwd: targetDir });

  const adapters: InstallOrchestratorAdapters = {
    docker,
    fetchAsset: (url, destinationPath) => assetFetchAdapter.fetchAsset(url, destinationPath),
    checkCurlAvailable: () => checkCurlAvailable({ cwd: targetDir }),
    oidcFetch: createInstallOidcFetchAdapter({ cwd: targetDir }),
    configurationScript: createInstallConfigurationScriptAdapter({ cwd: targetDir }),
    guidedConfiguration: createInstallGuidedConfigurationAdapter({ cwd: targetDir }),
    answers: UNREACHABLE_ANSWERS,
  };

  const context: InstallOrchestratorContext = {
    targetDir,
    requestedAction: action,
    repository: config.repository,
    registry: config.registry,
    channel: config.channel,
    requestedComposeProjectName,
    fallbackBasename,
    // This CLI has no controlling terminal to hand a spawned configure.sh
    // the way install.sh's own `exec {fd}<>/dev/tty` does — see
    // InstallOrchestratorContext's own doc in install-orchestrator.ts.
    hasControllingTerminal: false,
    readinessTimeoutSeconds: config.readinessTimeoutSeconds,
    readinessPollSeconds: config.readinessPollSeconds,
  };

  const startedAt = Date.now();
  runInstall(context, adapters, (event) => {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    process.stdout.write(`${formatEngineEventLine(event, elapsedSeconds)}\n`);
  })
    .then((outcome) => {
      if (outcome.status === "ok") {
        process.stdout.write(
          `orbit: ${action} complete. resolvedReference=${outcome.resolvedReference} version=${outcome.imageVersion} profile=${outcome.selectedProfile}\n`,
        );
        process.exit(0);
      }
      if (outcome.status === "cancelled") {
        process.stderr.write(`orbit: ${action} cancelled.\n`);
        process.exit(130);
      }
      process.stderr.write(`orbit: ${outcome.message}\n`);
      for (const line of outcome.guidance ?? []) {
        process.stderr.write(`${line}\n`);
      }
      process.exit(1);
    })
    .catch((error: unknown) => {
      process.stderr.write(`orbit: unexpected error during ${action}: ${(error as Error).message}\n`);
      process.exit(1);
    });
}

function main(): void {
  const [, , command, ...rest] = process.argv;

  if (command === "__install-transaction-rehearse") {
    const scenarioPath = rest[0];
    if (!scenarioPath) fail("orbit: __install-transaction-rehearse requires a scenario file path");
    commandInstallTransactionRehearse(scenarioPath);
    return;
  }

  if (command === "__restore-engine-rehearse") {
    const scenarioPath = rest[0];
    if (!scenarioPath) fail("orbit: __restore-engine-rehearse requires a scenario file path");
    commandRestoreEngineRehearse(scenarioPath);
    return;
  }

  let deployDirArg: string | undefined;
  const commandArgs: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--dir" && rest[index + 1]) {
      deployDirArg = rest[index + 1];
      index += 1;
    } else {
      commandArgs.push(rest[index]);
    }
  }
  // check/backup/restore/bundle commands operate on an existing deployment,
  // so an omitted --dir defaults to cwd; install/update mutate a real
  // target and require --dir explicitly — see commandInstallOrUpdate's own
  // header comment for why that deliberately does not default to cwd.
  const deployDir = deployDirArg !== undefined ? resolve(deployDirArg) : process.cwd();

  try {
    switch (command) {
      case "check":
        if (commandArgs.length > 0) fail(`orbit: unknown option ${commandArgs[0]}`);
        commandCheck(deployDir);
        break;
      case "configure":
        commandConfigure(deployDir, commandArgs);
        break;
      case "install":
      case "update":
        if (commandArgs.length > 0) fail(`orbit: unknown option ${commandArgs[0]}`);
        commandInstallOrUpdate(command, deployDirArg);
        break;
      case "backup":
        commandBackup(deployDir, commandArgs);
        break;
      case "restore":
        commandRestore(deployDir, commandArgs);
        break;
      case "export-recovery-bundle":
        commandExportRecoveryBundle(deployDir, commandArgs);
        break;
      case "import-recovery-bundle":
        commandImportRecoveryBundle(deployDir, commandArgs);
        break;
      default:
        failUsage();
    }
  } catch (error) {
    // Every refusal class in the modules this CLI wires together throws a
    // stable, category-only message (no secret material, no
    // attacker-controlled path/member names — asserted by each module's own
    // no-leak sweep), so surfacing `error.message` directly here is safe;
    // anything else is a genuine bug and should keep its stack trace.
    if (error instanceof RecoveryBundleRefusal || error instanceof RestoreEngineRefusal || error instanceof BackupRestoreCliRefusal) {
      fail(`orbit: ${error.message}`);
    }
    throw error;
  }
}

function failUsage(): never {
  fail(
    "orbit: supported commands: check, configure [--init|--set-oidc-secret|--set-deployment-profile PRESET [MODEL]], backup, restore, export-recovery-bundle, import-recovery-bundle [--dir <deployment>] | install --dir <deployment> | update --dir <deployment>",
  );
}

main();
