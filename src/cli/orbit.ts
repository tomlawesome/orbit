import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { evaluateReadiness, type OidcSecretFileFacts } from "../lib/config-contract";
import { parseEnvOrbitContent } from "../lib/env-orbit-file";
import { InstallTransaction, type ManagedPath } from "../lib/install-transaction";

// The orbit engine CLI (ADR-0011, issue #294). First flow: `check` — the
// value-free readiness report, output-identical to `configure.sh --check`
// (proven by src/lib/config-contract.parity.test.ts). Non-interactive by
// design; interactive presentation belongs to orbit-launcher.

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
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

function main(): void {
  const [, , command, ...rest] = process.argv;

  if (command === "__install-transaction-rehearse") {
    const scenarioPath = rest[0];
    if (!scenarioPath) fail("orbit: __install-transaction-rehearse requires a scenario file path");
    commandInstallTransactionRehearse(scenarioPath);
    return;
  }

  let deployDir = process.cwd();
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--dir" && rest[index + 1]) {
      deployDir = resolve(rest[index + 1]);
      index += 1;
    } else {
      fail(`orbit: unknown option ${rest[index]}`);
    }
  }
  switch (command) {
    case "check":
      commandCheck(deployDir);
      break;
    default:
      fail("orbit: supported commands: check [--dir <deployment>]");
  }
}

main();
