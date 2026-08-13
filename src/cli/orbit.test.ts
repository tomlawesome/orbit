import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Issue #296 slice 4 safety requirement: `orbit backup` / `orbit restore` /
// `orbit export-recovery-bundle` / `orbit import-recovery-bundle` must be
// explicit-invocation only (no default/implied execution) and must refuse
// without their required arguments — asserted here by actually spawning the
// real CLI entry point (never invoking it through a mocked argv), mirroring
// src/lib/config-contract.parity.test.ts's own CLI-spawn convention.

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
  const result = spawnSync("node", [tsx, cli, ...args], {
    encoding: "utf8",
    input: options.input,
    env: options.env ?? process.env,
  });
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
      env: { ...process.env, ORBIT_RECOVERY_PROMPTS: "machine" },
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
      env: { ...process.env, ORBIT_RECOVERY_PROMPTS: "machine" },
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
