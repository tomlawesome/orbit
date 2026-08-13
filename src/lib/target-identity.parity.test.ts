import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  ComposeProjectNameRefusal,
  TargetValidationRefusal,
  deriveComposeProjectName,
  isPreprovisionedInput,
  validateTarget,
} from "./target-identity";

// Byte-for-byte decision parity between scripts/install.sh's
// is_preprovisioned_input, validate_target and derive_compose_project_name
// and this module (issue #295 slice 2), extracted (via awk, by function
// name, never hand-copied) from the real, unmodified scripts/install.sh —
// mirrors install-transaction.parity.test.ts's approach for slice 1. If a
// cited function is ever renamed in install.sh, extraction returns empty
// and this test fails loudly rather than silently comparing against stale
// text — see docs/adr-notes/295-install-port-plan.md's Flags section.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const installScriptPath = join(repoRoot, "scripts", "install.sh");

function extractFunction(name: string): string {
  const script = `
    $0 ~ "^${name}\\\\(\\\\) \\\\{" { found = 1 }
    found { print; if ($0 == "}") { found = 0; exit } }
  `;
  const result = spawnSync("awk", [script, installScriptPath], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not extract ${name}() from install.sh; it may have been renamed.`);
  }
  return result.stdout;
}

const driverDir = mkdtempSync(join(tmpdir(), "orbit-target-identity-parity-driver-"));
const driverPath = join(driverDir, "driver.sh");

function buildDriverScript(): string {
  const functions = [
    "is_regular_non_symlink_file",
    "is_real_non_symlink_directory",
    "target_is_empty",
    "has_mode",
    "read_environment_value",
    "is_preprovisioned_input",
    "validate_target",
    "derive_compose_project_name",
  ]
    .map(extractFunction)
    .join("\n");

  return [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    // A minimal fail() stub standing in for install.sh's real one (which
    // pulls in installer_ui_event bookkeeping this driver doesn't need):
    // print the exact refusal message to stderr and exit 1, which is all
    // validate_target/derive_compose_project_name need from `fail`.
    "fail() { printf '%s\\n' \"$1\" >&2; exit 1; }",
    "",
    'readonly environment_file=".env-orbit"',
    'readonly compose_file="docker-compose.yml"',
    'readonly secrets_directory=".orbit-secrets"',
    "target_was_empty=0",
    'compose_project_name=""',
    "compose_project_name_explicit=0",
    "",
    functions,
    "",
    'mode="$1"; target_dir="$2"; shift 2',
    'cd -- "$target_dir"',
    "",
    'case "$mode" in',
    "  preprovisioned)",
    "    if is_preprovisioned_input; then printf 'true\\n'; else printf 'false\\n'; fi",
    "    ;;",
    "  validate)",
    "    validate_target",
    "    printf 'target_was_empty=%s\\n' \"$target_was_empty\"",
    "    ;;",
    "  derive)",
    '    requested="${1:-}"',
    '    if [[ -n "$requested" ]]; then export COMPOSE_PROJECT_NAME="$requested"; fi',
    "    derive_compose_project_name",
    "    printf 'compose_project_name=%s explicit=%s\\n' \"$compose_project_name\" \"$compose_project_name_explicit\"",
    "    ;;",
    "esac",
    "",
  ].join("\n");
}

writeFileSync(driverPath, buildDriverScript(), { mode: 0o755 });

interface DriverResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runDriver(mode: string, targetDir: string, ...args: string[]): DriverResult {
  const result = spawnSync("bash", [driverPath, mode, targetDir, ...args], { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

const sandboxes: string[] = [];
function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "orbit-target-identity-parity-"));
  sandboxes.push(dir);
  return dir;
}

afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
  rmSync(driverDir, { recursive: true, force: true });
});

function seedPreprovisioned(dir: string): void {
  writeFileSync(join(dir, ".env-orbit"), "APP_URL=https://parity.invalid\n", { mode: 0o600 });
  const secretsDir = join(dir, ".orbit-secrets");
  mkdirSync(secretsDir, { mode: 0o700 });
  writeFileSync(join(secretsDir, "oidc-client-secret"), "s3cr3t", { mode: 0o600 });
}

describe("is_preprovisioned_input parity", () => {
  it("agrees: exact pre-provisioned contract is accepted", () => {
    const dir = makeSandbox();
    seedPreprovisioned(dir);
    const bash = runDriver("preprovisioned", dir);
    expect(bash.stdout).toBe("true");
    expect(isPreprovisionedInput(dir)).toBe(true);
  });

  it("agrees: an extraneous file in the target directory is refused", () => {
    const dir = makeSandbox();
    seedPreprovisioned(dir);
    writeFileSync(join(dir, "notes.txt"), "hello\n");
    const bash = runDriver("preprovisioned", dir);
    expect(bash.stdout).toBe("false");
    expect(isPreprovisionedInput(dir)).toBe(false);
  });

  it("agrees: a symlinked secrets directory is refused", () => {
    const dir = makeSandbox();
    writeFileSync(join(dir, ".env-orbit"), "APP_URL=https://parity.invalid\n", { mode: 0o600 });
    mkdirSync(join(dir, "real-secrets"), { mode: 0o700 });
    writeFileSync(join(dir, "real-secrets", "oidc-client-secret"), "s3cr3t", { mode: 0o600 });
    symlinkSync(join(dir, "real-secrets"), join(dir, ".orbit-secrets"));
    const bash = runDriver("preprovisioned", dir);
    expect(bash.stdout).toBe("false");
    expect(isPreprovisionedInput(dir)).toBe(false);
  });

  it("agrees: an empty secret file is refused", () => {
    const dir = makeSandbox();
    seedPreprovisioned(dir);
    writeFileSync(join(dir, ".orbit-secrets", "empty-secret"), "", { mode: 0o600 });
    const bash = runDriver("preprovisioned", dir);
    expect(bash.stdout).toBe("false");
    expect(isPreprovisionedInput(dir)).toBe(false);
  });
});

describe("validate_target parity", () => {
  it("agrees: empty target reports target_was_empty=1", () => {
    const dir = makeSandbox();
    const bash = runDriver("validate", dir);
    expect(bash.status).toBe(0);
    expect(bash.stdout).toBe("target_was_empty=1");
    expect(validateTarget(dir)).toEqual({ targetWasEmpty: true });
  });

  it("agrees: a recognized existing deployment reports target_was_empty=0", () => {
    const dir = makeSandbox();
    writeFileSync(join(dir, ".env-orbit"), "APP_URL=https://parity.invalid\n", { mode: 0o600 });
    writeFileSync(join(dir, "docker-compose.yml"), "services: {}\n");
    mkdirSync(join(dir, ".orbit-secrets"), { mode: 0o700 });
    const bash = runDriver("validate", dir);
    expect(bash.status).toBe(0);
    expect(bash.stdout).toBe("target_was_empty=0");
    expect(validateTarget(dir)).toEqual({ targetWasEmpty: false });
  });

  it("agrees: pre-provisioned input reports target_was_empty=1 despite a non-empty directory", () => {
    const dir = makeSandbox();
    seedPreprovisioned(dir);
    const bash = runDriver("validate", dir);
    expect(bash.status).toBe(0);
    expect(bash.stdout).toBe("target_was_empty=1");
    expect(validateTarget(dir)).toEqual({ targetWasEmpty: true });
  });

  it("agrees: an unrecognizable non-empty directory refuses with install.sh's exact message", () => {
    const dir = makeSandbox();
    writeFileSync(join(dir, "README.md"), "hello\n");
    const bash = runDriver("validate", dir);
    expect(bash.status).toBe(1);
    let message = "";
    try {
      validateTarget(dir);
    } catch (error) {
      message = (error as TargetValidationRefusal).message;
    }
    expect(bash.stderr).toBe(message);
  });
});

describe("derive_compose_project_name parity", () => {
  it("agrees: sanitized fallback basename when nothing is configured", () => {
    const dir = makeSandbox();
    const bash = runDriver("derive", dir);
    expect(bash.status).toBe(0);
    const result = deriveComposeProjectName(dir, undefined, basename(realpathSync(dir)));
    expect(bash.stdout).toBe(`compose_project_name=${result.composeProjectName} explicit=${result.explicit ? 1 : 0}`);
  });

  it("agrees: a configured .env-orbit value wins over the fallback", () => {
    const dir = makeSandbox();
    writeFileSync(join(dir, ".env-orbit"), "COMPOSE_PROJECT_NAME=configured-project\n", { mode: 0o600 });
    const bash = runDriver("derive", dir);
    expect(bash.status).toBe(0);
    expect(bash.stdout).toBe("compose_project_name=configured-project explicit=1");
    expect(deriveComposeProjectName(dir, undefined, basename(realpathSync(dir)))).toEqual({
      composeProjectName: "configured-project",
      explicit: true,
    });
  });

  it("agrees: a conflicting requested name against a configured file value refuses with the exact message", () => {
    const dir = makeSandbox();
    writeFileSync(join(dir, ".env-orbit"), "COMPOSE_PROJECT_NAME=configured-project\n", { mode: 0o600 });
    const bash = runDriver("derive", dir, "other-project");
    expect(bash.status).toBe(1);
    let message = "";
    try {
      deriveComposeProjectName(dir, "other-project", basename(realpathSync(dir)));
    } catch (error) {
      message = (error as ComposeProjectNameRefusal).message;
    }
    expect(bash.stderr).toBe(message);
  });

  it("agrees: an explicitly requested valid name is accepted with no configured file", () => {
    const dir = makeSandbox();
    const bash = runDriver("derive", dir, "requested-project");
    expect(bash.status).toBe(0);
    expect(bash.stdout).toBe("compose_project_name=requested-project explicit=1");
    expect(deriveComposeProjectName(dir, "requested-project", basename(realpathSync(dir)))).toEqual({
      composeProjectName: "requested-project",
      explicit: true,
    });
  });
});
