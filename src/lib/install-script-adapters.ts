import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

import {
  type ConfigurationMigrationTarget,
  type ConfigurationScriptAdapter,
  buildMigrateArgv,
  buildPreflightArgv,
} from "./configuration-migration";
import {
  type GuidedConfigurationAdapter,
  type MachinePromptAnswerProvider,
  type MachinePromptLine,
  type MachinePromptRequest,
  type MachinePromptSessionResult,
  parseMachinePromptLine,
} from "./guided-configuration";

// The real `bash scripts/configuration.sh` / `bash scripts/configure.sh`
// subprocess adapters (issue #295 slice 5) — the shipped production
// implementations the plan deferred from slice 3
// (ConfigurationScriptAdapter) and slice 4 (GuidedConfigurationAdapter).
// Both spawn a fixed argv array built entirely from this module's caller-
// supplied paths plus the exact argv builders configuration-migration.ts and
// guided-configuration.ts's own module comments already document (never a
// shell string) — the same reference-adapter shape
// configuration-migration.parity.test.ts's and guided-configuration.parity.
// test.ts's own local (unshipped) reference adapters already proved against
// the real, unmodified scripts.

export interface InstallScriptAdapterOptions {
  /** Working directory for the spawned script (defaults to the current process's cwd). */
  cwd?: string;
  /** Overrides the `bash` executable name/path. Defaults to `"bash"`. */
  bashBinary?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The real ConfigurationScriptAdapter (slice 3 deferral): `bash
 * <configurationScript> --preflight --file <environmentFile>` /
 * `bash <configurationScript> --migrate --transaction ...`, driven entirely
 * through configuration-migration.ts's own `buildPreflightArgv`/
 * `buildMigrateArgv` — the same technique configuration-migration.parity.
 * test.ts's local reference adapter already used to prove these argv
 * builders drive the live script correctly.
 */
export function createInstallConfigurationScriptAdapter(options: InstallScriptAdapterOptions = {}): ConfigurationScriptAdapter {
  const bashBinary = options.bashBinary ?? "bash";
  const cwd = options.cwd;
  const env = options.env ?? process.env;

  function run(configurationScript: string, argv: string[]): { status: number; stdout: string } {
    const result = spawnSync(bashBinary, [configurationScript, ...argv], { cwd, env, encoding: "utf8" });
    return { status: result.status ?? -1, stdout: result.stdout };
  }

  return {
    runPreflight: (configurationScript, environmentFile) => run(configurationScript, buildPreflightArgv(environmentFile)),
    runMigrate: (configurationScript, target: ConfigurationMigrationTarget) => run(configurationScript, buildMigrateArgv(target)),
  };
}

/**
 * Spawns `bash <configureScript> <args...>` with `ORBIT_CONFIGURE_PROMPTS=
 * machine` set and drives the #297 machine-prompt exchange to completion:
 * for every parsed `prompt` line, asks `answers` for a value and writes it
 * (plus a trailing newline) to the child's stdin — never logging or
 * otherwise retaining the answer value itself (docs/engine-events.md
 * §Security: "no prompt line ... ever carries a value"). Mirrors
 * guided-configuration.parity.test.ts's own local (unshipped) reference
 * adapter, which proved this exact driving loop against the real,
 * unmodified configure.sh.
 */
export function runMachinePromptSession(
  bashBinary: string,
  args: string[],
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  answers: MachinePromptAnswerProvider,
): Promise<MachinePromptSessionResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(bashBinary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const events: MachinePromptLine[] = [];

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const parsed = parseMachinePromptLine(line);
      if (!parsed) return;
      events.push(parsed);
      if (parsed.type === "prompt") {
        const request: MachinePromptRequest = { field: parsed.field, kind: parsed.kind, attempt: parsed.attempt };
        Promise.resolve(answers.answer(request)).then((answer) => {
          child.stdin.write(`${answer}\n`);
        });
      }
    });
    // Discard stderr — never retained or logged, matching the same
    // secret-handling discipline as stdout above.
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ ok: exitCode === 0, events });
    });
  });
}

/**
 * The real GuidedConfigurationAdapter (slice 4 deferral). `runInit`/
 * `runSetOidcSecret` drive the live #297 machine-prompt exchange via
 * `runMachinePromptSession` above; `runDefault`/`runSetDeploymentProfile`/
 * `runCheck` are ordinary blocking `spawnSync` calls, exactly mirroring
 * every synchronous adapter method shipped so far. `confirmApply` always
 * resolves "apply": install-orchestrator.ts (this slice) only ever drives
 * `stageGuidedInstallConfiguration` with `hasControllingTerminal: false`
 * (see that module's own header comment for why), so `confirmApply` is
 * unreachable from the shipped CLI path today — implemented here, and
 * exercised directly by this file's own tests, purely so the adapter is a
 * complete, correct implementation ready for a future slice that wires a
 * real interactive/CLI-flag review step, rather than left as a stub that
 * would throw if ever reached.
 */
export function createInstallGuidedConfigurationAdapter(options: InstallScriptAdapterOptions = {}): GuidedConfigurationAdapter {
  const bashBinary = options.bashBinary ?? "bash";
  const cwd = options.cwd;
  const baseEnv = options.env ?? process.env;

  function runSync(
    configureScript: string,
    args: string[],
    envOverrides: Partial<NodeJS.ProcessEnv> = {},
  ): { status: number; stdout: string } {
    const result = spawnSync(bashBinary, [configureScript, ...args], {
      cwd,
      env: { ...baseEnv, ...envOverrides },
      encoding: "utf8",
    });
    return { status: result.status ?? -1, stdout: result.stdout };
  }

  return {
    runInit: (configureScript, orbitImage, answers) =>
      runMachinePromptSession(
        bashBinary,
        [configureScript, "--init"],
        cwd,
        { ...baseEnv, ORBIT_IMAGE: orbitImage, ORBIT_CONFIGURE_PROMPTS: "machine" },
        answers,
      ),
    runDefault: (configureScript, orbitImage) => runSync(configureScript, [], { ORBIT_IMAGE: orbitImage }),
    runSetOidcSecret: (configureScript, answers) =>
      runMachinePromptSession(
        bashBinary,
        [configureScript, "--set-oidc-secret"],
        cwd,
        { ...baseEnv, ORBIT_CONFIGURE_PROMPTS: "machine" },
        answers,
      ),
    runSetDeploymentProfile: (configureScript, orbitImage, profile, model) =>
      runSync(
        configureScript,
        model === undefined ? ["--set-deployment-profile", profile] : ["--set-deployment-profile", profile, model],
        { ORBIT_IMAGE: orbitImage },
      ),
    runCheck: (configureScript) => runSync(configureScript, ["--check"]),
    confirmApply: () => Promise.resolve("apply"),
  };
}
