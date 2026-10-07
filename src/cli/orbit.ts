import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isatty } from "node:tty";
import { join, resolve } from "node:path";

import {
  BackupRestoreCliRefusal,
  type RestoreOrchestrationTestHooks,
  runBackup,
  runExportRecoveryBundle,
  runImportRecoveryBundle,
  runRecoverRestore,
  runRestore,
  verifyBackupBundle,
} from "../lib/backup-restore-cli";
import { isValidClientId, isValidOidcIssuer, normalizePublicOrigin } from "../lib/config-contract";
import { runConfigurationCommand } from "../lib/configuration-migration";
import { readinessReport } from "../lib/deployment-readiness";
import { InstallTransaction, type ManagedPath } from "../lib/install-transaction";
import { createInContainerAdapter, preflightPostgresClient } from "../lib/in-container-adapter";
import {
  type BackupDockerAdapter,
  RecoveryBundleRefusal,
  createTar,
  extractTar,
  isValidDocumentKekHex,
  isValidPassphrase,
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
  type RestoreDurabilityHooks,
  deriveRestorePaths,
  recoverRestore,
} from "../lib/restore-engine";
import { formatEngineEventLine } from "../lib/engine-event";
import { displayHostPaths } from "../lib/host-paths";
import { type InstallOutcome, REPAIR_SIGNPOST, runInstall, runInterruptCleanups } from "../lib/install-orchestrator";
import { type HostFacts, HostFactsRefusal, parseHostFacts } from "../lib/host-facts";
import { HostOwnershipError, applyHostOwnership } from "../lib/host-ownership";
import { type InstallTerminal, declined } from "../lib/install-terminal";
import { DEPLOYMENT_ASSETS_ROOT } from "../lib/deployment-assets";
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
  type GuidedInitInput,
} from "../lib/configure-engine";

// The orbit engine CLI (ADR-0011, issue #294). Flows: `check` — the
// value-free readiness report, output-identical to `configure.sh --check`
// (proven by src/lib/config-contract.parity.test.ts); `install`/`update` —
// the install transaction scripts/install.sh runs as a one-off from the
// image it has verified (src/lib/install-orchestrator.ts, #1212), which
// asks its questions on the terminal install.sh passes through.

function fail(message: string): never {
  process.stderr.write(`${displayHostPaths(message)}\n`);
  process.exit(1);
}

function writeResult(line: string): void {
  process.stdout.write(`${displayHostPaths(line)}\n`);
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
// No command spawns `docker` any more. backup, restore and the
// recovery-bundle commands stopped in #1211: they run only here, inside the
// deployment, through the in-container adapter
// (src/lib/in-container-adapter.ts), and refuse anywhere else
// (requireDeploymentContext below). install/update stopped in #1212 (build
// note F7): they refuse the other way round, outside the engine container.
// refuseDockerInContainer stays as the guard any future command that spawns
// `docker` must call as the FIRST statement in its command function, before
// any adapter is constructed. `check` (and any other pure-logic command)
// never calls it and is unaffected.
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

/**
 * `orbit check [--rollback]`: the value-free readiness report configure.sh
 * --check (and, with --rollback, --check-rollback) prints. --rollback reads
 * the configuration migration's rollback copy, `.env-orbit.orbit-config.
 * rollback`, under the same rules (#1210 D6, ADR-0014 decision 7); the
 * secrets directory is still the live one. No file at all reports every
 * field missing, as configure.sh --check did; a file that is not a regular,
 * owner-only file, or does not parse, fails with its configuration_* code.
 */
function commandCheck(deployDir: string, rollback = false): never {
  const outcome = readinessReport(deployDir, { rollback });
  if (outcome.status === "refused") fail(outcome.code);
  process.stdout.write(outcome.lines.join("\n") + "\n");
  process.exit(outcome.ok ? 0 : 1);
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
  backupDirectory: string;
  documentKekFile: string;
}

/** `--backup-dir`/`--secrets-dir`: where the shell mounted ORBIT_BACKUP_DIR/ORBIT_SECRETS_DIR when they lie outside the deployment (#1211 E5). */
interface BackupRestoreDirectories {
  backupDir?: string;
  secretsDir?: string;
}

// Everything is derived from `--dir` (matching `check`'s convention above),
// except the two directories an operator may keep elsewhere: the shells map
// ORBIT_BACKUP_DIR and ORBIT_SECRETS_DIR onto mounts and pass them as
// `--backup-dir`/`--secrets-dir` (#1211 build note E5).
function resolveBackupRestorePaths(deployDir: string, directories: BackupRestoreDirectories): BackupRestorePaths {
  const secretsDirectory = directories.secretsDir !== undefined ? resolve(directories.secretsDir) : join(deployDir, ".orbit-secrets");
  return {
    backupDirectory: directories.backupDir !== undefined ? resolve(directories.backupDir) : join(deployDir, "backups"),
    documentKekFile: join(secretsDirectory, "document-kek"),
  };
}

/** EX_TEMPFAIL: another backup or restore holds the backup/restore lock; try again once it finishes. */
const BACKUP_RESTORE_LOCKED_EXIT_CODE = 75;

const DEPLOYMENT_SHELLS: Record<string, string> = {
  backup: "backup.sh",
  restore: "restore.sh",
  "export-recovery-bundle": "export-recovery-bundle.sh",
  "import-recovery-bundle": "import-recovery-bundle.sh",
};

/**
 * backup, restore and the recovery-bundle commands reach orbit-db, the
 * mounted secrets and the document volume directly, so they run only inside
 * the deployment, as the one-off scripts/backup.sh and its siblings start
 * (#1211 build note E1). Anywhere else there is nothing for them to reach.
 */
function requireDeploymentContext(command: string): void {
  if (isRunningAsEngineContainer()) return;
  fail(`orbit: ${command} runs inside the deployment; use bash scripts/${DEPLOYMENT_SHELLS[command]}.`);
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

/**
 * ORBIT_RECOVERY_TEST_MODE=true: the recovery-bundle scripts' own test mode,
 * which scripts/test-backup-restore.sh drives — each answer is one line on
 * standard input, with no prompt text, exactly as the bash scripts read it
 * (`read -r -s -p ''`). The shell forwards the variable (#1211 build note E4).
 */
function isStdinLinePromptMode(): boolean {
  return process.env.ORBIT_RECOVERY_TEST_MODE === "true";
}

function readStdinAnswer(missing: string): string {
  const line = readSyncLine(0);
  if (line === undefined) fail(`orbit: ${missing}`);
  return line;
}

/** export-recovery-bundle.sh:37-45 (guarantees #6-7): passphrase, then its confirmation, entered twice with no retry loop in TTY mode (matching the Bash original's single-attempt fail-closed behavior exactly); machine mode gets the bounded-3-attempt retry protocol docs/engine-events.md now documents. */
function collectRecoveryPassphraseWithConfirmation(): string {
  if (isMachinePromptMode()) return collectMachineRecoveryPassphrase(stdoutMachineDriver());
  if (isStdinLinePromptMode()) {
    const passphrase = readStdinAnswer("A recovery passphrase is required on standard input.");
    requireValidPassphrase(passphrase);
    requireMatchingPassphrase(passphrase, readStdinAnswer("A recovery passphrase confirmation is required on standard input."));
    return passphrase;
  }
  const passphrase = readTtyMaskedLine("Recovery passphrase: ");
  requireValidPassphrase(passphrase);
  const confirmation = readTtyMaskedLine("Confirm recovery passphrase: ");
  requireMatchingPassphrase(passphrase, confirmation);
  return passphrase;
}

/** import-recovery-bundle.sh:73-74: a single passphrase entry, no confirmation (only IMPORT_CONFIRMATION below is a typed phrase). */
function collectImportPassphrase(): string {
  if (isMachinePromptMode()) return collectMachineRecoveryPassphraseNoConfirm(stdoutMachineDriver());
  const passphrase = isStdinLinePromptMode()
    ? readStdinAnswer("A recovery passphrase is required on standard input.")
    : readTtyMaskedLine("Recovery passphrase: ");
  // import-recovery-bundle.sh:76: refused before any decryption is attempted.
  if (!isValidPassphrase(passphrase)) fail("orbit: A recovery passphrase of at least 12 characters is required.");
  return passphrase;
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
  writeResult(`This will replace the local document KEK and restore:\n  ${bundlePath}`);
  const answer = isStdinLinePromptMode()
    ? readStdinAnswer("A recovery confirmation is required on standard input.")
    : readTtyLine("Type IMPORT RECOVERY to continue: ");
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
    const answer = isStdinLinePromptMode()
      ? readStdinAnswer("A restore confirmation is required on standard input.")
      : readTtyLine("Type RESTORE to continue: ");
    return answer === RESTORE_CONFIRMATION_PHRASE;
  };
}

// ---------------------------------------------------------------------------
// orbit configure / --init / --set-oidc-secret / --set-deployment-profile /
// --preflight / --migrate: everything scripts/configure.sh does (#294,
// #1210). File work only, no `docker`, so unlike install/backup/restore
// above this never calls refuseDockerInContainer. scripts/configure.sh is
// now only the shell that runs this command as a `docker run --rm` one-off
// with the deployment directory mounted at /orbit-deploy (docs/
// engine-events.md, "In-container engine invocation").
//
// Answers for --init and --set-oidc-secret come, in order of precedence,
// from the ORBIT_CONFIGURE_* environment set, the #297
// `ORBIT_CONFIGURE_PROMPTS=machine` line grammar, the operator's terminal
// (the shell passes one through with `docker run -t`), or for the secret a
// single piped line.
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
    const result = runConfigureApply(deployDir, process.env.ORBIT_IMAGE, {
      trustOrbitImage: process.env.ORBIT_CONFIGURE_TRUST_ORBIT_IMAGE === "1",
    });
    for (const message of result.messages) {
      // The one advisory line goes to stderr, where configure.sh printed it.
      if (message.startsWith("Orbit configure: ignoring")) process.stderr.write(`${message}\n`);
      else process.stdout.write(`${message}\n`);
    }
    process.stdout.write("Orbit configuration is ready. Existing values were preserved.\n");
    process.exit(0);
  } catch (error) {
    if (error instanceof ConfigureEngineRefusal) fail(`orbit: ${error.message}`);
    throw error;
  }
}

/** O1-F1: ORBIT_CONFIGURE_AUTH_MODE, read the same way guided_init reads it in configure.sh (unset means "let the rest of commandConfigureInit decide"). */
function readConfigureAuthMode(): "local" | "oidc" | undefined {
  const raw = process.env.ORBIT_CONFIGURE_AUTH_MODE;
  if (raw === undefined || raw === "") return undefined;
  if (raw === "local" || raw === "oidc") return raw;
  fail("orbit: ORBIT_CONFIGURE_AUTH_MODE must be 'local' or 'oidc'.");
}

// --- terminal prompting for --init / --set-oidc-secret (#1210 D3) ----------
//
// scripts/configure.sh gives the one-off container the operator's terminal
// (`docker run -t`) when there is one, and this engine prompts on it itself,
// as git and ssh do: the questions, validators, wording and retry rules of
// configure.sh's own guided_init / set_oidc_secret, which are deleted.

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

/** One byte from fd 0, blocking; retries EAGAIN, which a TTY stream Node has opened in non-blocking mode returns. undefined at end of input. */
function readTerminalByte(): number | undefined {
  const buffer = Buffer.alloc(1);
  for (;;) {
    try {
      return readSync(0, buffer, 0, 1, null) === 0 ? undefined : buffer[0];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      Atomics.wait(sleepBuffer, 0, 0, 20);
    }
  }
}

/** A visible line from the terminal; undefined on end of input (Ctrl-D on an empty line). */
function readTerminalLine(promptText: string): string | undefined {
  process.stdout.write(promptText);
  const bytes: number[] = [];
  for (;;) {
    const byte = readTerminalByte();
    if (byte === undefined) return bytes.length > 0 ? Buffer.from(bytes).toString("utf8") : undefined;
    if (byte === 10) return Buffer.from(bytes).toString("utf8");
    if (byte !== 13) bytes.push(byte);
  }
}

/** A hidden line (no echo); undefined on end of input. Ctrl-C restores the terminal and exits 130. */
function readTerminalSecret(promptText: string): string | undefined {
  // Echo goes off before the prompt appears, so nothing typed early is echoed or lost.
  process.stdin.setRawMode(true);
  process.stdout.write(promptText);
  const bytes: number[] = [];
  let ended = false;
  try {
    for (;;) {
      const byte = readTerminalByte();
      if (byte === undefined || (byte === 4 && bytes.length === 0)) {
        ended = true;
        break;
      }
      if (byte === 3) {
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        process.exit(130);
      }
      if (byte === 13 || byte === 10) break;
      if (byte === 127 || byte === 8) {
        bytes.pop();
        continue;
      }
      bytes.push(byte);
    }
  } finally {
    process.stdin.setRawMode(false);
  }
  process.stdout.write("\n");
  return ended ? undefined : Buffer.from(bytes).toString("utf8");
}

function hasTerminal(): boolean {
  return isatty(0) && isatty(1);
}

/** Why a guided answer could not be collected; commandConfigureInit/SetOidcSecret print it and exit 1, install fails the step. */
class GuidedAnswerStop extends Error {}

/** Where guided questions are asked: the configure command's own terminal, or the install engine's (src/lib/install-terminal.ts). */
interface GuidedPromptIo {
  line(promptText: string): string | undefined;
  secret(promptText: string): string | undefined;
  /** A rejection or advice line. */
  notice(text: string): void;
}

const configureTerminalIo: GuidedPromptIo = {
  line: readTerminalLine,
  secret: readTerminalSecret,
  notice: (text) => process.stderr.write(`${text}\n`),
};

/** Asks until a valid answer or end of input (configure.sh's prompt_* loops). */
function promptUntilValid<T>(io: GuidedPromptIo, promptText: string, validate: (input: string) => T | undefined, rejection: string): T {
  for (;;) {
    const input = io.line(promptText);
    if (input === undefined) throw new GuidedAnswerStop("orbit: Guided configuration was cancelled.");
    const value = validate(input);
    if (value !== undefined) return value;
    io.notice(rejection);
  }
}

/** prompt_auth_mode (ADR-0023 section 1): local accounts by default. */
function promptAuthMode(io: GuidedPromptIo): "local" | "oidc" {
  return promptUntilValid(
    io,
    "Sign in with local accounts only, or also with an identity provider? OIDC can be added later with configure.sh. [local/oidc] (default: local): ",
    (input) => {
      const answer = input.toLowerCase();
      if (answer === "" || answer === "local") return "local" as const;
      if (answer === "oidc") return "oidc" as const;
      return undefined;
    },
    'Enter "local" for local accounts only, or "oidc" to also enable an identity provider.',
  );
}

/**
 * guided_init's answers, from the first source that has them: the
 * ORBIT_CONFIGURE_* environment, the machine-prompt grammar on stdio, or the
 * operator's terminal (`io`, absent when there is none). `authMode` is
 * ORBIT_CONFIGURE_AUTH_MODE, else what the caller already knows. Throws
 * GuidedAnswerStop with configure's own message on anything else.
 */
function collectGuidedInitInput(authMode: "local" | "oidc" | undefined, io: GuidedPromptIo | undefined): GuidedInitInput {
  const envAppUrl = process.env.ORBIT_CONFIGURE_APP_URL;
  const envIssuer = process.env.ORBIT_CONFIGURE_OIDC_ISSUER;
  const envClientId = process.env.ORBIT_CONFIGURE_OIDC_CLIENT_ID;
  const providedCount = [envAppUrl, envIssuer, envClientId].filter((value) => !!value).length;

  if (authMode === "local" && envAppUrl) {
    // guided_init's local-only environment form: APP_URL alone.
    if (envIssuer || envClientId) {
      throw new GuidedAnswerStop("orbit: ORBIT_CONFIGURE_AUTH_MODE=local conflicts with a supplied OIDC issuer/client ID environment set.");
    }
    return { appUrl: envAppUrl, authMode: "local" };
  }
  if (providedCount === 3) {
    if (authMode === "local") {
      throw new GuidedAnswerStop("orbit: ORBIT_CONFIGURE_AUTH_MODE=local conflicts with a supplied OIDC issuer/client ID environment set.");
    }
    return { appUrl: envAppUrl as string, authMode: "oidc", issuer: envIssuer as string, clientId: envClientId as string };
  }
  if (providedCount > 0) {
    throw new GuidedAnswerStop(
      "orbit: Guided configuration requires all of ORBIT_CONFIGURE_APP_URL, ORBIT_CONFIGURE_OIDC_ISSUER and ORBIT_CONFIGURE_OIDC_CLIENT_ID together, not a partial set.",
    );
  }
  if (isConfigureMachinePromptMode()) {
    // O1-F1: a local-only machine-prompt init only ever needs APP_URL.
    const resolvedAuthMode = authMode ?? "oidc";
    try {
      return { ...collectMachineGuidedInit(stdoutConfigureMachineDriver(), resolvedAuthMode), authMode: resolvedAuthMode };
    } catch (error) {
      if (error instanceof ConfigureMachinePromptAbortedError) throw new GuidedAnswerStop("orbit: Guided configuration was cancelled.");
      throw error;
    }
  }
  if (io) {
    const resolvedAuthMode = authMode ?? promptAuthMode(io);
    const appUrl = promptUntilValid(
      io,
      "Public Orbit origin (e.g. https://orbit.your-domain.tld): ",
      (input) => normalizePublicOrigin(input) ?? undefined,
      "Enter a complete https:// public origin with no credentials, path, query, fragment, loopback address or example.com placeholder.",
    );
    if (resolvedAuthMode === "local") return { appUrl, authMode: "local" };
    const issuer = promptUntilValid(
      io,
      "OIDC issuer URL (e.g. https://sso.your-domain.tld/application/o/orbit/): ",
      (input) => (isValidOidcIssuer(input) ? input : undefined),
      "Enter a complete https:// issuer URL with no credentials, query, fragment, loopback address or example.com placeholder.",
    );
    const clientId = promptUntilValid(
      io,
      "OIDC client ID: ",
      (input) => (isValidClientId(input) ? input : undefined),
      "Enter a non-empty OIDC client ID with no whitespace or control characters.",
    );
    return { appUrl, authMode: "oidc", issuer, clientId };
  }
  throw new GuidedAnswerStop(
    "orbit: Guided configuration needs a controlling terminal, or the complete ORBIT_CONFIGURE_APP_URL, ORBIT_CONFIGURE_OIDC_ISSUER and ORBIT_CONFIGURE_OIDC_CLIENT_ID environment set for non-interactive use.",
  );
}

/** set_oidc_secret's answer: machine prompts, one hidden entry on the terminal (no retry), or one raw line piped in. */
function collectOidcSecret(io: GuidedPromptIo | undefined): string {
  if (isConfigureMachinePromptMode()) {
    try {
      return collectMachineOidcSecret(stdoutConfigureMachineDriver());
    } catch (error) {
      if (error instanceof ConfigureMachinePromptAbortedError) {
        throw new GuidedAnswerStop("orbit: could not read a complete OIDC client secret from standard input.");
      }
      throw error;
    }
  }
  if (io) {
    // An empty or oversized answer is refused by applySetOidcSecret.
    const line = io.secret("OIDC client secret (input hidden): ");
    if (line === undefined) throw new GuidedAnswerStop("orbit: Could not read a complete OIDC client secret from the controlling terminal.");
    return line;
  }
  // A single raw line piped in (configure.sh's `read -r` fallback).
  const line = readSyncLine(0);
  if (line === undefined) throw new GuidedAnswerStop("orbit: could not read a complete OIDC client secret from standard input.");
  return line;
}

function commandConfigureInit(deployDir: string): never {
  let input: GuidedInitInput;
  try {
    input = collectGuidedInitInput(readConfigureAuthMode(), hasTerminal() ? configureTerminalIo : undefined);
  } catch (error) {
    if (error instanceof GuidedAnswerStop) fail(error.message);
    throw error;
  }
  try {
    const message = applyGuidedInit(deployDir, input);
    process.stdout.write(`${message}\n`);
    process.exit(0);
  } catch (error) {
    if (error instanceof ConfigureEngineRefusal) fail(`orbit: ${error.message}`);
    throw error;
  }
}

function commandConfigureSetOidcSecret(deployDir: string): never {
  let secret: string;
  try {
    secret = collectOidcSecret(hasTerminal() && !isConfigureMachinePromptMode() ? configureTerminalIo : undefined);
  } catch (error) {
    if (error instanceof GuidedAnswerStop) fail(error.message);
    throw error;
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

/** `orbit configure --preflight|--migrate ...`: the retired scripts/configuration.sh's grammar over the port (#1210 D8). */
function commandConfigureMigration(deployDir: string, args: string[]): never {
  const result = runConfigurationCommand(args, join(deployDir, ".env-orbit"));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status);
}

function commandConfigure(deployDir: string, args: string[]): never {
  if (args.length === 0) {
    commandConfigureApply(deployDir);
  }
  const [first, ...rest] = args;
  if (first === "--preflight" || first === "--migrate") commandConfigureMigration(deployDir, args);
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
      usageExit(
        `orbit: unknown option ${first} (usage: orbit configure [--init|--set-oidc-secret|--set-deployment-profile PRESET [MODEL]|--preflight ...|--migrate ...])`,
      );
  }
}

// ---------------------------------------------------------------------------
// Scratch-directory cleanup for backup/restore (#1151 O1-R1). Each of
// commandBackup's --verify branch and commandRestore's --recover and
// <backup.tar> branches creates a private mkdtempSync workDir under
// os.tmpdir() that can hold decrypted document bytes and database dumps
// while the command runs. A try/finally alone misses two cases: (1) a
// signal (Ctrl-C/SIGINT, or SIGTERM from a supervisor) does not unwind JS
// try/finally at all by default, so the directory is orphaned in /tmp
// forever; (2) the success path in each branch calls `process.exit(0)`
// *inside* the try, and process.exit() terminates immediately without
// running a pending `finally` — confirmed empirically, not merely assumed —
// so a plain try/finally around a process.exit() call never actually ran
// its cleanup either. withScratchDirectory fixes both: callers never call
// process.exit() from inside the wrapped callback, and the same tracked-set
// cleanup runs on normal completion, on a thrown error, and on SIGINT/SIGTERM.
const activeScratchDirectories = new Set<string>();
let scratchCleanupSignalHandlersInstalled = false;

function removeScratchDirectory(workDir: string): void {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Best effort: nothing more useful to do if removal itself fails.
  }
}

function installScratchCleanupSignalHandlers(): void {
  if (scratchCleanupSignalHandlersInstalled) return;
  scratchCleanupSignalHandlersInstalled = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      for (const workDir of activeScratchDirectories) removeScratchDirectory(workDir);
      activeScratchDirectories.clear();
      // 128 + signal number, the conventional shell-reported exit status
      // (SIGINT=2, SIGTERM=15); matches the 130 already used for Ctrl-C
      // during masked TTY entry above.
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

/** Runs `run` with `workDir` tracked for signal cleanup, always removing it afterward — on normal return, on a thrown error, and (via the signal handlers above) on SIGINT/SIGTERM. `run` must never call process.exit() itself; callers call it, with the result of `run`, only after this returns. */
function withScratchDirectory<T>(workDir: string, run: () => T): T {
  installScratchCleanupSignalHandlers();
  activeScratchDirectories.add(workDir);
  try {
    return run();
  } finally {
    activeScratchDirectories.delete(workDir);
    removeScratchDirectory(workDir);
  }
}

// Hidden/experimental, mirroring __install-transaction-rehearse and
// __restore-engine-rehearse above: exercises withScratchDirectory's signal
// cleanup end-to-end for src/cli/orbit.test.ts, without needing a real
// docker backup/restore run to create a window to signal during.
//
// Blocks the same way the real docker-compose adapters block (a
// synchronous spawnSync call), rather than a pure-JS wait: that is not a
// cosmetic choice. A tight synchronous loop (e.g. Atomics.wait) never
// returns control to the event loop, so a signal arriving during one is
// never actually delivered to a `process.on` listener until the loop is
// unblocked some other way — proven directly against this file's own
// mkdtempSync/spawnSync pattern before writing this comment. What actually
// happens on a real Ctrl-C is: the terminal's SIGINT reaches the whole
// foreground process group, so the blocked `docker` child dies from the
// same signal, spawnSync returns, and only then does the event loop
// deliver the pending SIGINT/SIGTERM callback registered below. Spawning a
// real `sleep` child here, signalled as a process group, reproduces that
// exact sequence instead of a shape nothing in production ever hits.
function commandScratchDirectorySignalRehearse(sleepSeconds: string): never {
  const workDir = mkdtempSync(join(tmpdir(), "orbit-scratch-signal-rehearse-"));
  withScratchDirectory(workDir, () => {
    process.stdout.write(`workDir=${workDir}\n`);
    spawnSync("sleep", [sleepSeconds]);
  });
  process.exit(0);
}

/**
 * restore.sh's test switches, which scripts/test-backup-restore.sh still sets
 * on `bash scripts/restore.sh` and the shell forwards (#1211 build step 5).
 * Inert unless ORBIT_RESTORE_TEST_MODE=true. Each maps onto a seam the
 * engine already had: the durability hooks (journal sync failures), the
 * orchestration hooks (a cutover failure, a hard kill) and
 * beforeCheckpointRestore (a checkpoint that will not reapply).
 */
function restoreTestHooksFromEnvironment(): { hooks: RestoreDurabilityHooks; testHooks: RestoreOrchestrationTestHooks } {
  const env = process.env;
  if (env.ORBIT_RESTORE_TEST_MODE !== "true") return { hooks: {}, testHooks: {} };
  const syncStage = env.ORBIT_RESTORE_TEST_SYNC_FAILURE_STAGE ?? "";
  const failureStage = env.ORBIT_RESTORE_TEST_FAILURE_STAGE ?? "";
  const requested = (): never => {
    throw new Error("A restore test failure was requested.");
  };
  return {
    hooks: {
      beforeJournalFileSync: (state) => {
        if (syncStage === "journal-file" || (syncStage === "journal-replacement" && state !== "checkpointed")) requested();
      },
      beforeJournalDirectorySync: (state) => {
        if (syncStage === "journal-directory" || (syncStage === "journal-replacement-directory" && state !== "checkpointed")) requested();
      },
      beforeCheckpointRestore: () => {
        if (failureStage === "checkpoint-restore" || env.ORBIT_RESTORE_TEST_CHECKPOINT_FAILURE === "true") requested();
      },
    },
    testHooks: {
      afterCheckpoint: () => {
        if (env.ORBIT_RESTORE_TEST_HARD_INTERRUPT_STAGE !== "after-checkpoint") return;
        // As abrupt as restore.sh's `kill -KILL "$$"`: no finally block, no
        // dispose(). Inside the one-off, node is PID 1, which ignores a
        // SIGKILL sent from inside its own namespace, so exit straight
        // after with the status a SIGKILL would have left.
        process.kill(process.pid, "SIGKILL");
        process.exit(137);
      },
      afterDocumentsReplaced: () => {
        if (failureStage === "after-document-replacement") {
          throw new BackupRestoreCliRefusal("cutover/test-failure requested; prior state will be restored.", "test-failure-requested");
        }
      },
    },
  };
}

function commandBackup(deployDir: string, args: string[], directories: BackupRestoreDirectories): never {
  requireDeploymentContext("backup");
  const paths = resolveBackupRestorePaths(deployDir, directories);
  const adapter = createInContainerAdapter();

  if (args[0] === "--verify") {
    if (args.length !== 2 || !args[1]) fail("orbit: usage: orbit backup --verify <backup.tar>");
    const documentKekHex = readDocumentKekHex(paths.documentKekFile);
    const target = resolve(args[1]);
    const workDir = mkdtempSync(join(tmpdir(), "orbit-backup-verify-"));
    withScratchDirectory(workDir, () => {
      verifyBackupBundle(target, documentKekHex, workDir, adapter);
      writeResult(`Orbit backup is valid: ${target}`);
    });
    process.exit(0);
  }

  if (args.length !== 0) fail("orbit: usage: orbit backup [--verify <backup.tar>]");
  preflightPostgresClient();
  const result = runBackup({ backupDirectory: paths.backupDirectory, documentKekHex: () => readDocumentKekHex(paths.documentKekFile), adapter, now: new Date() });
  writeResult(`Orbit backup created: ${result.finalTarPath}`);
  process.exit(0);
}

function commandRestore(deployDir: string, args: string[], directories: BackupRestoreDirectories): never {
  requireDeploymentContext("restore");
  const paths = resolveBackupRestorePaths(deployDir, directories);
  const restorePaths = deriveRestorePaths(paths.backupDirectory, paths.documentKekFile);
  const adapter = createInContainerAdapter();
  const { hooks, testHooks } = restoreTestHooksFromEnvironment();

  const usage = "orbit: usage: orbit restore [--yes] <backup.tar> | orbit restore --preflight <backup.tar> | orbit restore --recover";
  let yesFlag = false;
  let recoverMode = false;
  let preflightOnly = false;
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
    if (arg === "--preflight") {
      preflightOnly = true;
      continue;
    }
    if (backupFile === undefined) {
      backupFile = arg;
      continue;
    }
    fail(usage);
  }
  // --preflight only validates (amendment E3a): it never asks, so --yes has
  // nothing to answer, and it never recovers.
  if (preflightOnly && (yesFlag || recoverMode)) fail("orbit: usage: --preflight accepts neither --yes nor --recover");

  if (recoverMode) {
    if (backupFile !== undefined || yesFlag) fail("orbit: usage: --recover accepts no other arguments");
    const workDir = mkdtempSync(join(tmpdir(), "orbit-restore-recover-"));
    withScratchDirectory(workDir, () => {
      runRecoverRestore({ adapter, paths: restorePaths, workDir, hooks });
      writeResult("Orbit recovery completed; the prior database, document tree, and key state were restored.");
    });
    process.exit(0);
  }

  if (backupFile === undefined) fail(usage);
  const documentKekHex = readDocumentKekHex(paths.documentKekFile);
  preflightPostgresClient();
  const workDir = mkdtempSync(join(tmpdir(), "orbit-restore-"));
  withScratchDirectory(workDir, () => {
    runRestore({
      backupTarPath: resolve(backupFile),
      documentKekHex,
      paths: restorePaths,
      adapter,
      workDir,
      confirm: makeRestoreConfirmer(yesFlag),
      hooks,
      testHooks,
      preflightOnly,
    });
    // A passed preflight prints nothing: restore.sh goes on to stop Orbit.
    if (!preflightOnly) writeResult("Orbit restore completed successfully.");
  });
  process.exit(0);
}

function commandExportRecoveryBundle(deployDir: string, args: string[], directories: BackupRestoreDirectories): never {
  requireDeploymentContext("export-recovery-bundle");
  if (args.length !== 1 || !args[0]) fail("orbit: usage: orbit export-recovery-bundle <backup.tar>");
  const paths = resolveBackupRestorePaths(deployDir, directories);
  const documentKekHex = readDocumentKekHex(paths.documentKekFile);
  const adapter = createInContainerAdapter();
  const result = runExportRecoveryBundle({
    sourceBundlePath: resolve(args[0]),
    documentKekHex,
    // export-recovery-bundle.sh asked only once the source bundle had passed --verify.
    collectPassphrase: collectRecoveryPassphraseWithConfirmation,
    backupDirectory: paths.backupDirectory,
    adapter,
    now: new Date(),
  });
  writeResult(`Orbit recovery bundle created: ${result.finalPath}`);
  process.exit(0);
}

function commandImportRecoveryBundle(deployDir: string, args: string[], directories: BackupRestoreDirectories): never {
  requireDeploymentContext("import-recovery-bundle");
  // --preflight (amendment E3a): check the bundle while Orbit still runs, asking nothing.
  const preflightOnly = args[0] === "--preflight";
  const bundleArgs = preflightOnly ? args.slice(1) : args;
  if (bundleArgs.length !== 1 || !bundleArgs[0]) fail("orbit: usage: orbit import-recovery-bundle [--preflight] <recovery.tar>");
  const recoveryBundlePath = resolve(bundleArgs[0]);
  const paths = resolveBackupRestorePaths(deployDir, directories);
  const adapter = createInContainerAdapter();
  const { hooks, testHooks } = restoreTestHooksFromEnvironment();
  // import-recovery-bundle.sh's order: the archive is checked before the
  // passphrase is asked for, and the key is decrypted before IMPORT RECOVERY.
  runImportRecoveryBundle({
    recoveryBundlePath,
    passphrase: collectImportPassphrase,
    liveDocumentKekFile: paths.documentKekFile,
    backupDirectory: paths.backupDirectory,
    adapter,
    importConfirmed: () => collectImportConfirmation(recoveryBundlePath),
    confirmRestore: makeRestoreConfirmer(false),
    beforeRestore: preflightPostgresClient,
    hooks,
    testHooks,
    preflightOnly,
  });
  if (!preflightOnly) writeResult("Orbit recovery import completed successfully.");
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
    // This rehearsal only exercises runBackup, never runExportRecoveryBundle,
    // so there is nothing for this throwaway adapter to record.
    recordRecoveryBundleExported(): void {},
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

// `orbit install|update --dir /orbit-deploy [--action install|update|auto]
// [--outcome FILE]` (#1212): the install engine, run only by
// scripts/install.sh as a disposable one-off from the image it has just
// resolved and verified (build note F1). The shell hands over what it knows
// as environment: ORBIT_IMAGE (the verified digest reference),
// ORBIT_INSTALL_HOST_FACTS (its Docker facts, F3), ORBIT_CHANNEL,
// COMPOSE_PROJECT_NAME, ORBIT_INSTALLER_PLAIN, ORBIT_INSTALL_INTERACTIVE (it
// had a terminal and passed it through), ORBIT_INSTALLER_ELAPSED (seconds
// already spent, so event times continue) and the ORBIT_CONFIGURE_* answers.
// It reads the result back from FILE: what to start and how the run ended
// (docs/engine-events.md, "In-container engine invocation").

const IMMUTABLE_REFERENCE = /^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/;
/** install.sh:148-151 (ORBIT_CHANNEL). */
const CHANNEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The install engine's terminal: raw mode, so Ctrl-C arrives as a byte the
 * engine handles (rolling back) rather than a signal it could not act on
 * while blocked reading, with the line echoed by hand.
 */
function installTerminal(): InstallTerminal {
  const read = (promptText: string, echo: boolean): string | undefined => {
    process.stdout.write(promptText);
    process.stdin.setRawMode(true);
    const bytes: number[] = [];
    try {
      for (;;) {
        const byte = readTerminalByte();
        if (byte === undefined || (byte === 4 && bytes.length === 0)) {
          process.stdout.write("\r\n");
          return undefined;
        }
        if (byte === 3) {
          process.stdout.write("\r\n");
          throw declined();
        }
        if (byte === 13 || byte === 10) {
          process.stdout.write("\r\n");
          return Buffer.from(bytes).toString("utf8");
        }
        if (byte === 127 || byte === 8) {
          if (bytes.length > 0) {
            bytes.pop();
            if (echo) process.stdout.write("\b \b");
          }
          continue;
        }
        if (byte < 32) continue;
        bytes.push(byte);
        if (echo) process.stdout.write(Buffer.from([byte]));
      }
    } finally {
      process.stdin.setRawMode(false);
    }
  };
  return {
    write: (text) => process.stdout.write(text),
    readLine: (promptText) => read(promptText, true),
    readSecret: (promptText) => read(promptText, false),
  };
}

function guidedIoFor(terminal: InstallTerminal | undefined): GuidedPromptIo | undefined {
  if (!terminal) return undefined;
  return {
    line: (promptText) => terminal.readLine(promptText),
    secret: (promptText) => terminal.readSecret(promptText),
    notice: (text) => terminal.write(`${text}\n`),
  };
}

function outcomeLines(outcome: InstallOutcome): string[] {
  const clean = (value: string) => value.replace(/[\r\n]+/g, " ");
  switch (outcome.status) {
    case "ok":
      return [
        "status=ok",
        `fresh=${outcome.fresh ? 1 : 0}`,
        `profile=${outcome.selectedProfile}`,
        `model-pull=${outcome.modelPullRequested ? 1 : 0}`,
        `database-volume=${outcome.databaseVolume ?? ""}`,
      ];
    case "failed":
      return [
        "status=failed",
        `phase=${outcome.phase}`,
        `component=${outcome.component}`,
        `reason=${outcome.reason}`,
        `action=${outcome.action}`,
        `message=${clean(outcome.message)}`,
      ];
    case "stopped":
      return ["status=stopped", `message=${clean(outcome.message)}`];
    case "repair":
      return ["status=repair"];
  }
}

/** The result install.sh reads: key=value lines, owner-only, the operator's. */
function writeInstallOutcome(path: string | undefined, outcome: InstallOutcome): void {
  if (!path) return;
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    applyHostOwnership(path);
    writeSync(descriptor, `${outcomeLines(outcome).join("\n")}\n`);
  } finally {
    closeSync(descriptor);
  }
}

function commandInstallOrUpdate(command: "install" | "update", deployDirArg: string | undefined, args: string[]): void {
  // F7: the engine runs inside its own image, never on a host.
  if (!isRunningAsEngineContainer()) {
    fail(`orbit: ${command} runs only inside the Orbit image, started by scripts/install.sh.`);
  }
  if (!deployDirArg) fail(`orbit: ${command} requires --dir <deployment>`);
  let requestedAction: "install" | "update" | undefined = command === "update" ? "update" : "install";
  let outcomePath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--action" && command === "install" && (value === "install" || value === "update" || value === "auto")) {
      requestedAction = value === "auto" ? undefined : value;
      index += 1;
    } else if (flag === "--outcome" && value) {
      outcomePath = value;
      index += 1;
    } else {
      usageExit(`orbit: usage: orbit ${command} --dir <deployment> [--action install|update|auto] [--outcome FILE]`);
    }
  }
  const targetDir = resolve(deployDirArg);
  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) fail(`orbit: ${targetDir} is not a directory.`);

  const resolvedReference = process.env.ORBIT_IMAGE ?? "";
  if (!IMMUTABLE_REFERENCE.test(resolvedReference)) fail("orbit: ORBIT_IMAGE must be the immutable digest reference install.sh resolved.");
  const channel = process.env.ORBIT_CHANNEL ?? "latest";
  if (!CHANNEL_PATTERN.test(channel)) fail("orbit: ORBIT_CHANNEL is invalid.");
  let facts: HostFacts;
  try {
    facts = parseHostFacts(process.env.ORBIT_INSTALL_HOST_FACTS);
  } catch (error) {
    if (error instanceof HostFactsRefusal) fail(`orbit: ${error.message}`);
    throw error;
  }
  const elapsedOffset = /^[0-9]{1,6}$/.test(process.env.ORBIT_INSTALLER_ELAPSED ?? "") ? Number(process.env.ORBIT_INSTALLER_ELAPSED) : 0;
  const interactive = process.env.ORBIT_INSTALL_INTERACTIVE === "1" && hasTerminal();
  const terminal = interactive ? installTerminal() : undefined;
  const guidedIo = guidedIoFor(terminal);
  const configureAuthMode = readConfigureAuthMode();

  // A signal does not unwind try/finally: roll back first, then leave with
  // the signal's status (F8). Registered before anything else listens.
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.on(signal, () => {
      runInterruptCleanups();
      try {
        writeInstallOutcome(outcomePath, { status: "stopped", exitCode: 130, message: "Interrupted; the previous file state was restored." });
      } catch {
        /* the shell treats a missing outcome as a failure */
      }
      process.exit(code);
    });
  }

  const startedAt = Date.now();
  runInstall(
    {
      targetDir,
      requestedAction,
      plainMode: process.env.ORBIT_INSTALLER_PLAIN === "1",
      interactive,
      resolvedReference,
      channel,
      requestedComposeProjectName: process.env.COMPOSE_PROJECT_NAME || undefined,
      facts,
      assetsRoot: process.env.ORBIT_INSTALL_TEST_ASSETS_ROOT || DEPLOYMENT_ASSETS_ROOT,
    },
    {
      terminal,
      answers: {
        guidedInit: (hint) => collectGuidedInitInput(configureAuthMode ?? hint, guidedIo),
        oidcSecret: () => collectOidcSecret(guidedIo),
      },
      say: (line) => process.stdout.write(`${line}\n`),
    },
    (event) => {
      const elapsedSeconds = elapsedOffset + Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      process.stdout.write(`${formatEngineEventLine(event, elapsedSeconds)}\n`);
    },
  )
    .then((outcome) => {
      if (outcome.status === "failed") {
        for (const line of outcome.guidance ?? []) process.stderr.write(`${line}\n`);
      } else if (outcome.status === "stopped") {
        process.stderr.write(`Orbit installer: ${outcome.message}\n`);
      } else if (outcome.status === "repair") {
        process.stderr.write(`${REPAIR_SIGNPOST}\n`);
      }
      writeInstallOutcome(outcomePath, outcome);
      // Without an outcome file there is no shell to emit the terminal event.
      if (outcome.status === "failed" && !outcomePath) {
        process.stdout.write(`${formatEngineEventLine({ ...outcome, state: "failed" }, elapsedOffset)}\n`);
        process.stderr.write(`Orbit installer: ${outcome.message}\n`);
      }
      const exitCodes = { ok: 0, failed: 1, repair: 3 } as const;
      process.exit(outcome.status === "stopped" ? outcome.exitCode : exitCodes[outcome.status]);
    })
    .catch((error: unknown) => {
      runInterruptCleanups();
      process.stderr.write(`orbit: unexpected error during ${command}: ${(error as Error).message}\n`);
      process.exit(1);
    });
}

/**
 * `orbit end-maintenance` — the emergency recovery path of ADR-0013 decision
 * 4, packaged here per ADR-0015 decision 2 (#524).
 *
 * It calls the application's own domain function rather than touching the
 * database directly, so the write is versioned and audited exactly as an
 * administrator's would be, with a null actor and `origin: operator_shell`.
 * It spawns no `docker`, so the in-container guard above does not apply —
 * this is pure logic against the database, like `check`.
 *
 * The domain module is imported lazily. Every other command here runs on a
 * bare host with no database in sight, and loading the driver and schema for
 * `install` or `backup` would be pointless weight on paths that never use it.
 *
 * Idempotent: exits 0 whether or not anything changed, so an operator who is
 * unsure whether it worked may simply run it again.
 */
function commandEndMaintenance(args: string[]): void {
  if (args.length > 0) fail(`orbit: unknown option ${args[0]} (usage: orbit end-maintenance)`);
  void (async () => {
    try {
      const [{ endMaintenanceFromOperatorShell }, { closeDatabase }] = await Promise.all([
        import("../server/maintenance"),
        import("../db"),
      ]);
      try {
        const { changed, cancelledWindows } = await endMaintenanceFromOperatorShell();
        if (!changed) {
          process.stdout.write("orbit: maintenance was not active; nothing to change\n");
        } else if (cancelledWindows > 0) {
          const plural = cancelledWindows === 1 ? "window" : "windows";
          process.stdout.write(
            `orbit: maintenance ended; cancelled ${cancelledWindows} due scheduled ${plural}\n`,
          );
        } else {
          process.stdout.write("orbit: maintenance ended\n");
        }
      } catch {
        // Category only, like every other refusal this CLI surfaces: a
        // connection failure's own message can carry the connection string,
        // and this command runs in the one place an operator is most likely to
        // be pasting output to someone else. The container's logs hold the
        // detail if it is needed.
        process.stderr.write("orbit: end-maintenance failed; the database could not be updated\n");
        await closeDatabase().catch(() => {});
        process.exit(1);
      }
      await closeDatabase();
    } catch {
      // #1151 O1-R6: the dynamic import() above used to run outside any
      // try/catch, so a module-load failure (a broken image, a missing
      // file) became an unhandled promise rejection instead of this
      // command's own clean, bounded failure message. There is no
      // closeDatabase to call here -- a failed import never produced one.
      process.stderr.write("orbit: end-maintenance failed; the database could not be updated\n");
      process.exit(1);
    }
  })();
}

/**
 * `orbit auth recovery-link` (#912, ADR-0022 §5): the primary administrator's
 * own lost-access path, run from the deployment host —
 * `docker compose --env-file .env-orbit exec orbit-app node /opt/orbit/cli/orbit.js auth recovery-link`.
 *
 * Reads `instance_authority`, mints a `recovery` setup token through the same
 * `issueSetupToken` every setup/recovery link uses (five minute expiry,
 * sha256 digest at rest, single use — nothing new here), revokes every
 * session the primary administrator held with the existing sign-out-of-every-
 * device helper, writes the `recovery_link_issued` audit record the ADR
 * names, and prints the one resulting URL. The command's whole contract is
 * that one line: nothing else reaches stdout, and nothing reaches the
 * operational logger either — the only thing on this path that otherwise
 * would is `@/db`'s own connect/disconnect notice, so the log level is
 * raised past it before the database is touched. Neither `issueSetupToken`
 * nor `revokeUserSessions` logs anything themselves.
 */
function commandAuthRecoveryLink(): void {
  process.env.ORBIT_LOG_LEVEL = "error";
  void (async () => {
    try {
      const [{ getDb, closeDatabase }, { instanceAuthority, auditLog }, { issueSetupToken }, { revokeUserSessions }, { getAuthConfig }] =
        await Promise.all([
          import("../db"),
          import("../db/schema"),
          import("../server/local-credentials"),
          import("../lib/auth/session"),
          import("../lib/env"),
        ]);
      try {
        const db = getDb();
        const [authority] = await db.select({ primaryUserId: instanceAuthority.primaryUserId }).from(instanceAuthority).limit(1);
        const primaryUserId = authority?.primaryUserId ?? null;
        if (!primaryUserId) {
          process.stderr.write("orbit: this Orbit instance has no primary administrator to recover\n");
          await closeDatabase().catch(() => {});
          process.exit(1);
          return;
        }

        const { token } = await issueSetupToken(primaryUserId, "recovery", { createdByUserId: null });
        await revokeUserSessions(primaryUserId);
        await db.insert(auditLog).values({
          householdId: null,
          actorUserId: primaryUserId,
          entityType: "user",
          entityId: primaryUserId,
          action: "recovery_link_issued",
          changes: {},
        });

        const config = getAuthConfig();
        const url = new URL(`/setup/${token}`, config.appUrl).toString();
        process.stdout.write(`${url}\n`);
      } catch {
        // Category only, like every other refusal this CLI surfaces (see
        // commandEndMaintenance's own comment): a connection or driver failure
        // can carry the connection string, and this command's output is the
        // one thing an operator recovering access is most likely to paste
        // somewhere else.
        process.stderr.write("orbit: recovery-link failed; the database could not be updated\n");
        await closeDatabase().catch(() => {});
        process.exit(1);
        return;
      }
      await closeDatabase();
    } catch {
      // #1151 O1-R6: see commandEndMaintenance's matching comment -- the
      // dynamic imports above used to run outside any try/catch, turning a
      // module-load failure into an unhandled promise rejection instead of
      // this command's own clean, bounded failure message.
      process.stderr.write("orbit: recovery-link failed; the database could not be updated\n");
      process.exit(1);
    }
  })();
}

/** The phrase typed to confirm `orbit auth clear-addresses` (#970). */
const CLEAR_ADDRESSES_CONFIRMATION_PHRASE = "CLEAR ADDRESSES";

/**
 * `orbit auth clear-addresses` (#970, ADR-0022 §5's host-CLI pattern): the
 * last resort when the encryption key and the recovery bundle are both gone —
 *
 * `docker compose --env-file .env-orbit exec orbit-app node /opt/orbit/cli/orbit.js auth clear-addresses`
 *
 * It recovers nothing, and says so before it does anything. Documents and
 * encrypted metadata are gone with the key. What it prevents is the second
 * loss: Orbit finds an account by its address, the address is encrypted
 * (#969), so with the key gone nobody can sign in at all and the instance
 * becomes a brick with intact accounts inside it. Clearing the addresses it
 * cannot read lets the primary administrator back in through
 * `auth recovery-link` — which never touches an address — to re-enter members'
 * addresses by hand.
 *
 * Two refusals stand in front of it, both in `account-addresses-reset.ts` so a
 * second caller could not skip them: it will not run while the key still
 * works, and nothing network-reachable may call it. The typed phrase is the
 * third, and the only one a human is asked for.
 */
function commandAuthClearAddresses(): void {
  process.env.ORBIT_LOG_LEVEL = "error";
  void (async () => {
    try {
      const [{ closeDatabase }, { clearUnreadableAddresses, encryptionKeyIsUsable }] = await Promise.all([
        import("../db"),
        import("../server/account-addresses-reset"),
      ]);
      try {
        /* The refusal that matters most. An operator who sees "instance locked"
           and assumes the worst would otherwise destroy addresses that were
           perfectly recoverable — the key was fine, and only the bundle needed
           restoring. Checked before a single word about clearing anything. */
        if (await encryptionKeyIsUsable()) {
          process.stderr.write(
            "orbit: refused — this instance can still read its encrypted data, so its addresses are not lost.\n"
            + "orbit: if members cannot sign in, the fault is elsewhere; this command would destroy addresses for nothing.\n",
          );
          await closeDatabase().catch(() => {});
          process.exit(1);
          return;
        }

        process.stdout.write(
          "This does NOT recover anything. Documents and encrypted details stay unreadable.\n"
          + "It clears the account addresses this instance can no longer read, so that people can be let back in:\n"
          + "  - every unreadable account address is removed; the accounts themselves survive\n"
          + "  - every unreadable mail-forwarding address is removed, and must be added and proved again\n"
          + "  - addresses this instance CAN still read are left alone\n"
          + "Afterwards, run `orbit auth recovery-link` to get back in as the primary administrator,\n"
          + "then re-enter members' addresses by hand.\n",
        );
        const answer = readTtyLine(`Type ${CLEAR_ADDRESSES_CONFIRMATION_PHRASE} to continue: `);
        if (answer !== CLEAR_ADDRESSES_CONFIRMATION_PHRASE) {
          process.stderr.write("orbit: not confirmed; nothing was changed\n");
          await closeDatabase().catch(() => {});
          process.exit(1);
          return;
        }

        const outcome = await clearUnreadableAddresses();
        process.stdout.write(
          `orbit: cleared ${outcome.users} account address(es) and removed ${outcome.senderAddresses} `
          + "mail-forwarding address(es).\n"
          + "orbit: next, run `orbit auth recovery-link`.\n",
        );
      } catch {
        // Category only, for the same reason recovery-link gives above: a driver
        // failure can carry the connection string, and an operator in the middle
        // of this is the likeliest person to paste their terminal somewhere.
        process.stderr.write("orbit: clear-addresses failed; the database could not be updated\n");
        await closeDatabase().catch(() => {});
        process.exit(1);
        return;
      }
      await closeDatabase();
    } catch {
      // #1151 O1-R6: see commandEndMaintenance's matching comment -- the
      // dynamic imports above used to run outside any try/catch, turning a
      // module-load failure into an unhandled promise rejection instead of
      // this command's own clean, bounded failure message.
      process.stderr.write("orbit: clear-addresses failed; the database could not be updated\n");
      process.exit(1);
    }
  })();
}

function commandAuth(args: string[]): void {
  if (args.length !== 1 || (args[0] !== "recovery-link" && args[0] !== "clear-addresses")) {
    usageExit("orbit: unknown auth subcommand (usage: orbit auth recovery-link | orbit auth clear-addresses)");
  }
  if (args[0] === "clear-addresses") {
    commandAuthClearAddresses();
    return;
  }
  commandAuthRecoveryLink();
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

  if (command === "__scratch-directory-signal-rehearse") {
    commandScratchDirectorySignalRehearse(rest[0] ?? "5");
    return;
  }

  let deployDirArg: string | undefined;
  const directories: BackupRestoreDirectories = {};
  const commandArgs: string[] = [];
  const takesDirectories = command !== undefined && command in DEPLOYMENT_SHELLS;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--dir" && rest[index + 1]) {
      deployDirArg = rest[index + 1];
      index += 1;
    } else if (takesDirectories && rest[index] === "--backup-dir" && rest[index + 1]) {
      directories.backupDir = rest[index + 1];
      index += 1;
    } else if (takesDirectories && rest[index] === "--secrets-dir" && rest[index + 1]) {
      directories.secretsDir = rest[index + 1];
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
        if (commandArgs.length > 1 || (commandArgs.length === 1 && commandArgs[0] !== "--rollback")) {
          usageExit(`orbit: unknown option ${commandArgs.at(-1)} (usage: orbit check [--rollback])`);
        }
        commandCheck(deployDir, commandArgs[0] === "--rollback");
        break;
      case "configure":
        commandConfigure(deployDir, commandArgs);
        break;
      case "install":
      case "update":
        commandInstallOrUpdate(command, deployDirArg, commandArgs);
        break;
      case "backup":
        commandBackup(deployDir, commandArgs, directories);
        break;
      case "restore":
        commandRestore(deployDir, commandArgs, directories);
        break;
      case "export-recovery-bundle":
        commandExportRecoveryBundle(deployDir, commandArgs, directories);
        break;
      case "import-recovery-bundle":
        commandImportRecoveryBundle(deployDir, commandArgs, directories);
        break;
      case "end-maintenance":
        commandEndMaintenance(commandArgs);
        break;
      case "auth":
        commandAuth(commandArgs);
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
    // Another backup or restore holds the lock: a status of its own, so the
    // shell leaves orbit-app to the run that owns it (#1211 E3).
    if (error instanceof BackupRestoreCliRefusal && error.code === "restore-locked") {
      process.stderr.write(`${displayHostPaths(`orbit: ${error.message}`)}\n`);
      process.exit(BACKUP_RESTORE_LOCKED_EXIT_CODE);
    }
    if (
      error instanceof RecoveryBundleRefusal ||
      error instanceof RestoreEngineRefusal ||
      error instanceof BackupRestoreCliRefusal ||
      error instanceof HostOwnershipError
    ) {
      fail(`orbit: ${error.message}`);
    }
    throw error;
  }
}

function failUsage(): never {
  fail(
    "orbit: supported commands: check, configure [--init|--set-oidc-secret|--set-deployment-profile PRESET [MODEL]], backup, restore, export-recovery-bundle, import-recovery-bundle, end-maintenance, auth recovery-link, auth clear-addresses [--dir <deployment>] | install --dir <deployment> | update --dir <deployment>",
  );
}

main();
