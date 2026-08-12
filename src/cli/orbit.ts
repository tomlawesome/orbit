import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { evaluateReadiness, type OidcSecretFileFacts } from "../lib/config-contract";
import { parseEnvOrbitContent } from "../lib/env-orbit-file";

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

function main(): void {
  const [, , command, ...rest] = process.argv;
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
