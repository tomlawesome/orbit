import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard, processWatchdog } from "../../scripts/process-budget.mjs";

// Issue #296 slice 4 safety requirement: `orbit backup` / `orbit restore` /
// `orbit export-recovery-bundle` / `orbit import-recovery-bundle` must be
// explicit-invocation only (no default/implied execution) and must refuse
// without their required arguments — asserted here by actually spawning the
// real CLI entry point (never invoking it through a mocked argv), mirroring
// src/lib/config-contract.parity.test.ts's own CLI-spawn convention.

// Every test here spawns the real CLI, some three times over, and a spawn
// that takes 0.7s quiet took 4.3s on a starved core (#698). The budget and
// the reasoning live in scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = fileURLToPath(new URL("./orbit.ts", import.meta.url));
const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "orbit-cli-explicit-invocation-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function runCli(args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): { status: number; stdout: string; stderr: string } {
  const result = failOnProcessDeadline(spawnSync("node", [tsx, cli, ...args], {
    encoding: "utf8",
    input: options.input,
    // backup, restore and the recovery-bundle commands run only inside the
    // deployment since #1211; ORBIT_ENGINE_CONTEXT=container is what the
    // image bakes in, so these tests set it too.
    env: options.env ?? { ...process.env, ORBIT_ENGINE_CONTEXT: "container" },
    ...processGuard(),
  }), { label: "runCli" });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("no default/implied execution", () => {
  it("invoking the CLI with no subcommand never touches the filesystem and exits nonzero with a usage message", () => {
    const result = runCli(["--dir", sandbox]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("orbit:");
    expect(existsSync(join(sandbox, "backups"))).toBe(false);
    expect(existsSync(join(sandbox, ".orbit-secrets"))).toBe(false);
  });

  it("an unrecognised subcommand refuses rather than falling through to any backup/restore action", () => {
    const result = runCli(["totally-not-a-command", "--dir", sandbox]);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(sandbox, "backups"))).toBe(false);
  });
});

function writeValidDocumentKek(deployDir: string): void {
  const kekDir = join(deployDir, ".orbit-secrets");
  mkdirSync(kekDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(kekDir, "document-kek"), `${"a".repeat(64)}\n`, { mode: 0o600 });
}

describe("orbit backup: refuses without its required document KEK / arguments", () => {
  it("refuses when the document KEK file is missing, before creating a backup directory", () => {
    const result = runCli(["backup", "--dir", sandbox]);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(sandbox, "backups"))).toBe(false);
  });

  it("--verify requires exactly one bundle path argument", () => {
    // backup.sh itself reads the document KEK before dispatching on
    // --verify (backup.sh:181-193's require_tools/read_document_kek runs
    // ahead of the --verify branch) — this CLI mirrors that order exactly,
    // so a usage-argument test provides a valid KEK first to actually reach
    // the argument-count check being tested.
    writeValidDocumentKek(sandbox);
    const result = runCli(["backup", "--verify", "--dir", sandbox]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("usage");
  });

  it("rejects extra positional arguments", () => {
    writeValidDocumentKek(sandbox);
    const result = runCli(["backup", "unexpected-argument", "--dir", sandbox]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("usage");
  });
});

describe("orbit restore: refuses without its required backup-bundle argument", () => {
  it("refuses with a usage message when no bundle path and no --recover are given", () => {
    const result = runCli(["restore", "--dir", sandbox]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("usage");
    expect(existsSync(join(sandbox, "backups"))).toBe(false);
  });

  it("--recover refuses if combined with a bundle path", () => {
    const result = runCli(["restore", "--recover", "some-bundle.tar", "--dir", sandbox]);
    expect(result.status).not.toBe(0);
  });

  it("a nonexistent bundle path refuses cleanly rather than crashing", () => {
    const result = runCli(["restore", join(sandbox, "does-not-exist.tar"), "--dir", sandbox]);
    expect(result.status).not.toBe(0);
  });
});

describe("orbit export-recovery-bundle: refuses without its required backup-bundle argument", () => {
  it("refuses with a usage message when no bundle path is given", () => {
    const result = runCli(["export-recovery-bundle", "--dir", sandbox]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("usage");
  });

  it("refuses on a nonexistent source bundle before ever prompting for a passphrase", () => {
    const result = runCli(["export-recovery-bundle", join(sandbox, "does-not-exist.tar"), "--dir", sandbox], { input: "" });
    expect(result.status).not.toBe(0);
  });
});

describe("orbit import-recovery-bundle: refuses without its required recovery-bundle argument", () => {
  it("refuses with a usage message when no bundle path is given", () => {
    const result = runCli(["import-recovery-bundle", "--dir", sandbox]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("usage");
  });

  it("refuses on a nonexistent recovery bundle before ever prompting for a passphrase", () => {
    const result = runCli(["import-recovery-bundle", join(sandbox, "does-not-exist.tar"), "--dir", sandbox], { input: "" });
    expect(result.status).not.toBe(0);
  });
});

describe("ORBIT_RECOVERY_PROMPTS=machine end-to-end (docs/engine-events.md's extended vocabulary)", () => {
  it("export-recovery-bundle drives the machine-prompt grammar over stdin/stdout and still refuses cleanly for a missing bundle", () => {
    // A full happy-path machine-mode export needs a real document KEK/backup
    // bundle (covered end-to-end, Docker-free, in
    // src/lib/backup-restore-cli.test.ts); this proves the CLI layer itself
    // switches into the line-grammar rather than the TTY path when the
    // bundle is missing, refusing before any prompt is ever written.
    const result = runCli(["export-recovery-bundle", join(sandbox, "missing.tar"), "--dir", sandbox], {
      input: "",
      env: { ...process.env, ORBIT_ENGINE_CONTEXT: "container", ORBIT_RECOVERY_PROMPTS: "machine" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("prompt field=");
  });
});

describe("no shipped path reaches the hidden rehearsal subcommands", () => {
  it("the usage message never mentions the hidden __*-rehearse subcommands", () => {
    const result = runCli([]);
    expect(result.stderr).not.toContain("rehearse");
  });
});

describe("secrets hygiene: no argv, stdout, or stderr ever carries a passphrase", () => {
  it("a machine-mode export-recovery-bundle run never echoes the supplied passphrase anywhere in its own output", () => {
    const secretMarker = "zzz-unmistakable-secret-marker-zzz";
    const passphrase = `${secretMarker}-0123456789ab`;
    const result = runCli(["export-recovery-bundle", join(sandbox, "missing.tar"), "--dir", sandbox], {
      input: `${passphrase}\n${passphrase}\n`,
      env: { ...process.env, ORBIT_ENGINE_CONTEXT: "container", ORBIT_RECOVERY_PROMPTS: "machine" },
    });
    expect(result.stdout).not.toContain(secretMarker);
    expect(result.stderr).not.toContain(secretMarker);
  });
});

// A regular file, not a symlink or missing path, so `backup --verify`
// reaches its actual verification logic (proving the refusal is a real
// bundle-content refusal, not just an argument-count refusal).
describe("orbit backup --verify: reaches real verification for a present-but-invalid bundle", () => {
  it("refuses a non-tar file with a content-level (not usage-level) message", () => {
    const kekDir = join(sandbox, ".orbit-secrets");
    mkdirSync(kekDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(kekDir, "document-kek"), `${"a".repeat(64)}\n`, { mode: 0o600 });
    const notATar = join(sandbox, "not-a-tar.tar");
    writeFileSync(notATar, "definitely not a tar file");

    const result = runCli(["backup", "--verify", notATar, "--dir", sandbox]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("usage");
  });
});

// Engine-delivery slice (issue #295, owner decision 2026-08-13: "the engine
// can never manage the Docker socket. Ever."): ORBIT_ENGINE_CONTEXT=container
// is the one fact refuseDockerInContainer trusts (baked into the shipped
// image via a Dockerfile ENV instruction — see docs/engine-events.md,
// "In-container engine invocation (v0)"). Every command whose adapters would
// spawn `docker` must refuse before constructing that adapter; `check` must
// be completely unaffected. Proven here by actually spawning the CLI with a
// booby-trapped `docker` ahead of the real one on PATH, so a passing test
// means the code path was never reached, not merely that it failed cleanly.
describe("in-container fail-closed guard (ORBIT_ENGINE_CONTEXT=container)", () => {
  const DOCKER_NEEDING_COMMANDS = ["install", "update"];
  // #1211: these spawn no docker at all now; they run only inside the deployment.
  const DEPLOYMENT_COMMANDS = ["backup", "restore", "export-recovery-bundle", "import-recovery-bundle"];

  // Placed inside `sandbox` (not a separate mkdtemp) so the shared afterEach
  // cleanup above removes it along with everything else.
  function makeBoobyTrappedDockerBinDir(callLogPath: string): string {
    const binDir = join(sandbox, "fakebin");
    mkdirSync(binDir, { recursive: true });
    const script = ["#!/usr/bin/env bash", `printf 'TRAPPED: docker %s\\n' "$*" >> '${callLogPath}'`, "exit 99", ""].join("\n");
    writeFileSync(join(binDir, "docker"), script, { mode: 0o755 });
    return binDir;
  }

  it.each(DOCKER_NEEDING_COMMANDS)("%s refuses with exit 9 and the reason enum, before ever constructing a docker adapter", (command) => {
    const callLogPath = join(sandbox, "docker-calls.log");
    writeFileSync(callLogPath, "");
    const trapBinDir = makeBoobyTrappedDockerBinDir(callLogPath);

    const result = runCli([command, "--dir", sandbox], {
      env: { ...process.env, PATH: `${trapBinDir}:${process.env.PATH}`, ORBIT_ENGINE_CONTEXT: "container" },
    });

    expect(result.status).toBe(9);
    expect(result.stderr).toContain(`orbit: refused command=${command} reason=docker-command-forbidden-in-container`);
    expect(readFileSync(callLogPath, "utf8")).toBe("");
  });

  it.each(DEPLOYMENT_COMMANDS)("%s runs in container mode without ever calling docker", (command) => {
    const callLogPath = join(sandbox, "docker-calls.log");
    writeFileSync(callLogPath, "");
    const trapBinDir = makeBoobyTrappedDockerBinDir(callLogPath);

    const result = runCli([command, "--dir", sandbox], {
      env: { ...process.env, PATH: `${trapBinDir}:${process.env.PATH}`, ORBIT_ENGINE_CONTEXT: "container" },
    });

    expect(result.status).not.toBe(9);
    expect(result.stderr).not.toContain("docker-command-forbidden-in-container");
    expect(readFileSync(callLogPath, "utf8")).toBe("");
  });

  it.each(DEPLOYMENT_COMMANDS)("%s refuses outside the deployment, naming the script that runs it there", (command) => {
    const result = runCli([command, "--dir", sandbox], { env: { ...process.env, ORBIT_ENGINE_CONTEXT: "" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(new RegExp(`^orbit: ${command} runs inside the deployment; use bash scripts/[a-z-]+\\.sh\\.\\n$`));
    expect(existsSync(join(sandbox, "backups"))).toBe(false);
  });

  it("check is completely unaffected: it works fully against a bind-mounted-shaped deploy directory in container mode", () => {
    mkdirSync(join(sandbox, ".orbit-secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(join(sandbox, ".orbit-secrets", "oidc-client-secret"), "fixture-secret\n", { mode: 0o600 });
    const record = [
      "APP_URL=https://orbit.guard-test.invalid",
      "OIDC_ISSUER=https://oidc.guard-test.invalid/application/o/orbit/",
      "OIDC_CLIENT_ID=orbit-guard-test",
      "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret",
      "OIDC_CALLBACK_URL=https://orbit.guard-test.invalid/api/auth/callback",
      `ORBIT_IMAGE=registry.guard-test.invalid/acceptance/orbit@sha256:${"a".repeat(64)}`,
      "",
    ].join("\n");
    writeFileSync(join(sandbox, ".env-orbit"), record, { mode: 0o600 });

    const callLogPath = join(sandbox, "docker-calls.log");
    writeFileSync(callLogPath, "");
    const trapBinDir = makeBoobyTrappedDockerBinDir(callLogPath);

    const result = runCli(["check", "--dir", sandbox], {
      env: { ...process.env, PATH: `${trapBinDir}:${process.env.PATH}`, ORBIT_ENGINE_CONTEXT: "container" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ready APP_URL");
    expect(readFileSync(callLogPath, "utf8")).toBe("");
  });

  // Both "inert" tests below deliberately still put a fake `docker` on PATH
  // (never the real binary): the point of these two tests is only that
  // refuseDockerInContainer itself doesn't fire outside container mode, not
  // that the full real install flow against a real Docker daemon succeeds
  // or fails a particular way. An earlier version of this test used the
  // sandbox's own real PATH/docker — under CI's coverage-instrumented,
  // resource-constrained run, that let a real, un-mocked `docker compose
  // version` subprocess call (install-docker-adapter.ts's
  // checkDockerAvailable, which has no spawnSync-level timeout of its own)
  // run loose from inside a test for the first time in this suite, which is
  // exactly the kind of call that can turn into an indefinite hang under
  // load rather than a clean pass/fail — this fake is fast and
  // deterministic regardless of host conditions.
  it("the guard is inert when ORBIT_ENGINE_CONTEXT is unset: host-mode behavior is unchanged", () => {
    // The install target must stay empty (a fresh subdirectory of `sandbox`,
    // not `sandbox` itself): once the guard doesn't fire, install's own
    // pre-existing target-content validation runs for real, and it refuses
    // a non-empty target before ever reaching the docker check — that would
    // fail this test for an unrelated reason (an empty callLog, but from a
    // different early refusal, not from the guard).
    const targetDir = join(sandbox, "target");
    mkdirSync(targetDir);
    const callLogPath = join(sandbox, "docker-calls.log");
    writeFileSync(callLogPath, "");
    const trapBinDir = makeBoobyTrappedDockerBinDir(callLogPath);

    const result = runCli(["install", "--dir", targetDir], {
      env: { ...process.env, PATH: `${trapBinDir}:${process.env.PATH}` },
    });

    // No ORBIT_ENGINE_CONTEXT set: the guard never fires, so install
    // proceeds to its own (pre-existing) docker-availability check, which
    // does reach the fake docker — proving the guard adds a refusal only in
    // container mode, without altering host-mode behavior.
    expect(result.status).not.toBe(9);
    expect(result.stderr).not.toContain("docker-command-forbidden-in-container");
    expect(readFileSync(callLogPath, "utf8")).not.toBe("");
  });

  it("the guard is inert when ORBIT_ENGINE_CONTEXT is set to any value other than the literal \"container\"", () => {
    const targetDir = join(sandbox, "target");
    mkdirSync(targetDir);
    const callLogPath = join(sandbox, "docker-calls.log");
    writeFileSync(callLogPath, "");
    const trapBinDir = makeBoobyTrappedDockerBinDir(callLogPath);

    const result = runCli(["install", "--dir", targetDir], {
      env: { ...process.env, PATH: `${trapBinDir}:${process.env.PATH}`, ORBIT_ENGINE_CONTEXT: "host" },
    });

    expect(result.status).not.toBe(9);
    expect(result.stderr).not.toContain("docker-command-forbidden-in-container");
    expect(readFileSync(callLogPath, "utf8")).not.toBe("");
  });
});

// #1151 O1-R1: Ctrl-C (SIGINT) or a supervisor's SIGTERM during `orbit
// backup`/`orbit restore` used to leave the private mkdtempSync scratch
// directory — which can hold decrypted document bytes and database dumps —
// behind in os.tmpdir() forever. Two distinct bugs, both fixed by
// withScratchDirectory in src/cli/orbit.ts: (1) commandBackup/commandRestore
// called `process.exit(0)` *inside* their try block on the success path, and
// process.exit() does not run a pending `finally` — confirmed directly: a
// bare `try { process.exit(0) } finally { ... }` never runs the finally at
// all, signal or no signal, so every successful run leaked its scratch
// directory, not only an interrupted one; (2) a signal is not JS-exception
// unwinding, so it never ran a pending `finally` either.
//
// The hidden `__scratch-directory-signal-rehearse` subcommand exercises the
// same withScratchDirectory/signal-handler code those commands now share,
// blocking on a real `spawnSync("sleep", ...)` call — the same blocking
// shape the real docker-compose adapters use — rather than needing a real
// docker backup/restore run to create a window to test against.
//
// Run through `node --import tsx` (a loader hook, not tsx's own CLI, which
// spawns the script as a forked child and relays signals to it on its own
// schedule): that would test tsx's relay behavior, not this file's.
const nodeImportTsxArgs = ["--import", "tsx", cli];

describe("backup/restore scratch directories are cleaned up on exit and on SIGINT/SIGTERM (#1151 O1-R1)", () => {
  it("removes the scratch directory on ordinary successful completion (the process.exit(0)-inside-try bug)", async () => {
    const workDir = await new Promise<string>((resolvePromise, reject) => {
      const child = spawn("node", [...nodeImportTsxArgs, "__scratch-directory-signal-rehearse", "0.2"]);
      let stdout = "";
      let stderr = "";
      let capturedWorkDir: string | undefined;
      const watchdog = processWatchdog({ label: "scratchRehearsalNormalExit", kill: () => child.kill("SIGKILL") });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        watchdog.touch();
        const match = stdout.match(/^workDir=(.+)$/m);
        if (match) capturedWorkDir = match[1];
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        watchdog.touch();
      });
      child.on("error", (error) => {
        watchdog.stop();
        reject(error);
      });
      child.on("close", (status, signal) => {
        watchdog.stop();
        if (watchdog.reason) {
          reject(watchdog.error({ stdout, stderr }));
          return;
        }
        if (capturedWorkDir === undefined) {
          reject(new Error(`the rehearsal process closed before printing its workDir (status ${status}, signal ${signal}; stdout: ${stdout}; stderr: ${stderr})`));
          return;
        }
        if (status !== 0 || signal !== null) {
          reject(new Error(`expected a clean exit 0, got status ${status} signal ${signal} (stdout: ${stdout}; stderr: ${stderr})`));
          return;
        }
        resolvePromise(capturedWorkDir);
      });
    });
    expect(existsSync(workDir)).toBe(false);
  });

  it.each([["SIGINT"], ["SIGTERM"]] as const)(
    "removes the scratch directory, without needing SIGKILL, when %s is sent to the whole process group mid-run",
    async (signal) => {
      const { workDir, killedOnDeadline } = await new Promise<{ workDir: string; killedOnDeadline: boolean }>((resolvePromise, reject) => {
        // detached: true gives this process its own process group (pgid ===
        // its own pid), matching src/lib/install-transaction.interruption.test.ts's
        // established convention — and matching the real mechanism a
        // terminal Ctrl-C uses: the signal reaches every process in the
        // group at once, including whatever the rehearsal (or a real `orbit
        // backup`) has blocked on via spawnSync, which is what actually lets
        // that blocking call return.
        const child = spawn("node", [...nodeImportTsxArgs, "__scratch-directory-signal-rehearse", "20"], {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let capturedWorkDir: string | undefined;
        let killedOnDeadline = false;
        const watchdog = processWatchdog({
          label: "scratchRehearsalSignalled",
          kill: () => {
            killedOnDeadline = true;
            process.kill(-child.pid!, "SIGKILL");
          },
        });
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          watchdog.touch();
          if (capturedWorkDir === undefined) {
            const match = stdout.match(/^workDir=(.+)$/m);
            if (match) {
              capturedWorkDir = match[1];
              if (!existsSync(capturedWorkDir)) {
                reject(new Error(`expected the scratch directory to exist before signalling it: ${capturedWorkDir}`));
                return;
              }
              // A short delay rather than signalling the instant the
              // "workDir=" line arrives: printing that line and starting
              // the blocking spawnSync("sleep", ...) call are two separate
              // steps in the child, and signalling the process group before
              // the sleep grandchild actually exists sends the signal to a
              // group that does not yet contain it — the signal is not
              // "lost" exactly, but spawnSync's own wait loop (confirmed
              // separately not to service the default loop's pending signal
              // data) then blocks for the full sleep duration regardless.
              setTimeout(() => process.kill(-child.pid!, signal), 300);
            }
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
          watchdog.touch();
        });
        child.on("error", (error) => {
          watchdog.stop();
          reject(error);
        });
        child.on("close", () => {
          watchdog.stop();
          if (capturedWorkDir === undefined) {
            reject(new Error(`the rehearsal process closed before printing its workDir (stdout: ${stdout}; stderr: ${stderr})`));
            return;
          }
          resolvePromise({ workDir: capturedWorkDir, killedOnDeadline });
        });
      });
      // The point of this test: the process actually exits on its own —
      // via withScratchDirectory's finally or the signal handler, either is
      // a correct cleanup — rather than needing the watchdog's SIGKILL.
      expect(killedOnDeadline).toBe(false);
      expect(existsSync(workDir)).toBe(false);
    },
  );
});

// #1151 O1-R6: commandEndMaintenance, commandAuthRecoveryLink and
// commandAuthClearAddresses each resolve their dynamic import()s inside a
// `void (async () => {...})()` IIFE; a module-load failure in one of those
// imports used to escape as an unhandled promise rejection instead of the
// command's own clean, bounded failure message, because the imports ran
// before any try block. Driving a real import failure would mean breaking
// a real module file out from under a real CLI process, which risks leaving
// it broken for whatever else reads the same checkout; this instead proves
// the structural fix directly from the source: each command's own
// `import(` call sites are now textually inside that function's own `try`,
// not before it, so a regression moving them back out fails here.
describe("orbit end-maintenance/auth commands keep their dynamic imports inside a try (#1151 O1-R6)", () => {
  const source = readFileSync(cli, "utf8");

  function functionBody(name: string): string {
    const match = source.match(new RegExp(`function ${name}\\([^)]*\\): void \\{([\\s\\S]*?)\\n\\}\\n`, "mu"));
    if (!match) throw new Error(`Could not find function ${name} in ${cli}`);
    return match[1];
  }

  it.each(["commandEndMaintenance", "commandAuthRecoveryLink", "commandAuthClearAddresses"])(
    "%s's first import( call comes after its first try {",
    (name) => {
      const body = functionBody(name);
      const firstTry = body.indexOf("try {");
      const firstImport = body.indexOf("import(");
      expect(firstTry).toBeGreaterThanOrEqual(0);
      expect(firstImport).toBeGreaterThanOrEqual(0);
      expect(firstTry).toBeLessThan(firstImport);
    },
  );
});
