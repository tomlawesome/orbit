import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../../scripts/process-budget.mjs";
import { readGolden } from "../lib/__fixtures__/golden";
import { buildRecoveryManifest } from "../lib/recovery-bundle";

// `orbit import-recovery-bundle` and `orbit backup --verify` inside the
// deployment (#1211), compared with what import-recovery-bundle.sh and
// backup.sh --verify printed for the same inputs before they became thin
// shells (src/lib/__fixtures__/import-recovery-bundle-sh/, backup-sh-verify/;
// build note D10). Each refusal here happens before the engine's first
// database call, so the real CLI runs with no deployment behind it.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = fileURLToPath(new URL("./orbit.ts", import.meta.url));
const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const KEK_A = "a".repeat(64);

const sandboxes: string[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

interface Golden {
  status: number;
  stderr: string;
}

/** The shape the capture used: secrets and backups beside the deployment, as ORBIT_SECRETS_DIR/ORBIT_BACKUP_DIR. */
function deployment(): { root: string; directoryArgs: string[] } {
  const root = mkdtempSync(join(tmpdir(), "orbit-cli-backup-restore-"));
  sandboxes.push(root);
  mkdirSync(join(root, "secrets"));
  writeFileSync(join(root, "secrets", "document-kek"), `${KEK_A}\n`, { mode: 0o600 });
  return { root, directoryArgs: ["--dir", root, "--secrets-dir", join(root, "secrets"), "--backup-dir", join(root, "backups")] };
}

function runCli(args: string[], { input = "", env = {} }: { input?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = failOnProcessDeadline(
    spawnSync("node", [tsx, cli, ...args], {
      encoding: "utf8",
      input,
      env: { ...process.env, ORBIT_ENGINE_CONTEXT: "container", ...env },
      ...processGuard(),
    }),
    { label: `orbit ${args[0]}` },
  );
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function tarOf(directory: string, output: string, members: string[]): string {
  spawnSync("tar", ["-C", directory, "-cf", output, ...members]);
  return output;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** A recovery bundle whose members are present and whose checksums hold, but whose contents are not a real backup. */
function structurallyValidRecoveryBundle(root: string, manifest = buildRecoveryManifest(), badChecksum = false): string {
  const contents = join(root, `members-${Math.random().toString(36).slice(2)}`);
  mkdirSync(contents);
  const inner = "fake-inner-bundle-bytes";
  const envelope = "ORBKEK01-not-a-real-envelope";
  writeFileSync(join(contents, "manifest"), manifest);
  writeFileSync(join(contents, "orbit-backup.tar"), inner);
  writeFileSync(join(contents, "document-kek.enc"), envelope);
  writeFileSync(join(contents, "checksums.sha256"), `${badChecksum ? "0".repeat(64) : sha256(inner)}  orbit-backup.tar\n${sha256(envelope)}  document-kek.enc\n`);
  return tarOf(contents, join(root, "recovery.tar"), ["checksums.sha256", "document-kek.enc", "manifest", "orbit-backup.tar"]);
}

function importGolden(name: string): Golden {
  return readGolden<Golden>("import-recovery-bundle-sh", name);
}

function withoutPrefix(stderr: string, prefix: string): string {
  return stderr.trim().startsWith(prefix) ? stderr.trim().slice(prefix.length) : stderr.trim();
}

describe("orbit import-recovery-bundle refuses as import-recovery-bundle.sh did (golden)", () => {
  function expectSameRefusal(bundle: string, name: string, directoryArgs: string[]): void {
    const golden = importGolden(name);
    const result = runCli(["import-recovery-bundle", bundle, ...directoryArgs], { env: { ORBIT_RECOVERY_TEST_MODE: "true" } });
    expect(result.status).toBe(golden.status);
    expect(withoutPrefix(result.stderr, "orbit: ")).toBe(withoutPrefix(golden.stderr, "Orbit recovery import: "));
  }

  it("malformed archive", () => {
    const { root, directoryArgs } = deployment();
    const bundle = join(root, "malformed.tar");
    writeFileSync(bundle, "not a tar archive\n");
    expectSameRefusal(bundle, "malformed archive", directoryArgs);
  });

  it("unexpected member, without naming it", () => {
    const { root, directoryArgs } = deployment();
    mkdirSync(join(root, "unexpected"));
    writeFileSync(join(root, "unexpected", "attacker-controlled-member"), "attacker-controlled-content\n");
    const bundle = tarOf(join(root, "unexpected"), join(root, "unexpected.tar"), ["attacker-controlled-member"]);
    expectSameRefusal(bundle, "unexpected member", directoryArgs);
  });

  it("corrupt checksum, without raw checksum output or a member name", () => {
    const { root, directoryArgs } = deployment();
    expectSameRefusal(structurallyValidRecoveryBundle(root, undefined, true), "corrupt checksum", directoryArgs);
  });

  it("unsupported format version", () => {
    const { root, directoryArgs } = deployment();
    expectSameRefusal(
      structurallyValidRecoveryBundle(root, buildRecoveryManifest().replace("format_version=1", "format_version=2")),
      "unsupported format version",
      directoryArgs,
    );
  });

  it("a prior restore journal, before the bundle is even read", () => {
    const { root, directoryArgs } = deployment();
    mkdirSync(join(root, "backups", ".orbit-restore"), { recursive: true });
    writeFileSync(join(root, "backups", ".orbit-restore", "restore.journal"), "format_version=1\n");
    const bundle = join(root, "irrelevant.tar");
    writeFileSync(bundle, "not a tar archive\n");
    expectSameRefusal(bundle, "prior restore journal", directoryArgs);
  });

  it("an open document-KEK rotation: the same category, the engine's own wording", () => {
    const { root, directoryArgs } = deployment();
    writeFileSync(join(root, "secrets", "document-kek-next"), `${"b".repeat(64)}\n`);
    const bundle = join(root, "irrelevant.tar");
    writeFileSync(bundle, "not a tar archive\n");
    const golden = importGolden("open rotation");
    const result = runCli(["import-recovery-bundle", bundle, ...directoryArgs], { env: { ORBIT_RECOVERY_TEST_MODE: "true" } });
    expect(result.status).toBe(golden.status);
    const category = "preflight/rotation failed; a document-KEK rotation is open (";
    expect(withoutPrefix(golden.stderr, "Orbit recovery import: ")).toMatch(new RegExp(`^${category.replace(/[()]/g, "\\$&")}`));
    expect(withoutPrefix(result.stderr, "orbit: ")).toContain(`${category}${join(root, "secrets", "document-kek-next")} exists)`);
  });
});

describe("ORBIT_RECOVERY_TEST_MODE: answers as plain lines on standard input (#1211 E4)", () => {
  it("refuses a passphrase shorter than 12 characters, once the archive has passed", () => {
    const { root, directoryArgs } = deployment();
    const result = runCli(["import-recovery-bundle", structurallyValidRecoveryBundle(root), ...directoryArgs], {
      input: "too-short\n",
      env: { ORBIT_RECOVERY_TEST_MODE: "true" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("orbit: A recovery passphrase of at least 12 characters is required.\n");
    expect(result.stdout).toBe("");
  });

  it("refuses when standard input ends before a passphrase", () => {
    const { root, directoryArgs } = deployment();
    const result = runCli(["import-recovery-bundle", structurallyValidRecoveryBundle(root), ...directoryArgs], { env: { ORBIT_RECOVERY_TEST_MODE: "true" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("orbit: A recovery passphrase is required on standard input.\n");
  });

  it("refuses a passphrase that does not decrypt the key, under preflight/decryption", () => {
    const { root, directoryArgs } = deployment();
    const result = runCli(["import-recovery-bundle", structurallyValidRecoveryBundle(root), ...directoryArgs], {
      input: "orbit-wrong-recovery-passphrase\n",
      env: { ORBIT_RECOVERY_TEST_MODE: "true" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("orbit: preflight/decryption failed; the recovery key could not be decrypted.\n");
  });
});

describe("orbit backup --verify refuses as backup.sh --verify did (golden)", () => {
  function expectSameRefusal(bundle: string, name: string, directoryArgs: string[]): void {
    const golden = readGolden<Golden>("backup-sh-verify", name);
    const result = runCli(["backup", "--verify", bundle, ...directoryArgs]);
    expect(result.status).toBe(golden.status);
    expect(withoutPrefix(result.stderr, "orbit: ")).toBe(withoutPrefix(golden.stderr, "Orbit backup: "));
  }

  it("malformed archive", () => {
    const { root, directoryArgs } = deployment();
    const bundle = join(root, "malformed.tar");
    writeFileSync(bundle, "not a tar archive\n");
    expectSameRefusal(bundle, "malformed archive", directoryArgs);
  });

  it("missing member", () => {
    const { root, directoryArgs } = deployment();
    mkdirSync(join(root, "missing"));
    const members = ["checksums.sha256", "database.dump", "documents.tar.enc", "manifest"];
    for (const member of members) writeFileSync(join(root, "missing", member), "x");
    expectSameRefusal(tarOf(join(root, "missing"), join(root, "missing.tar"), members), "missing member", directoryArgs);
  });

  it("unsupported format version", () => {
    const { root, directoryArgs } = deployment();
    mkdirSync(join(root, "version"));
    writeFileSync(join(root, "version", "manifest"), "format_version=2\ncreated_at=2026-08-13T00:00:00Z\n");
    for (const member of ["database.dump", "documents.tar.enc", "checksums.sha256", "manifest.hmac"]) writeFileSync(join(root, "version", member), "x");
    const bundle = tarOf(join(root, "version"), join(root, "version.tar"), ["checksums.sha256", "database.dump", "documents.tar.enc", "manifest", "manifest.hmac"]);
    expectSameRefusal(bundle, "unsupported format version", directoryArgs);
  });

  it("takes no backup/restore lock and creates no backup directory: it only reads a bundle", () => {
    const { root, directoryArgs } = deployment();
    const bundle = join(root, "malformed.tar");
    writeFileSync(bundle, "not a tar archive\n");
    runCli(["backup", "--verify", bundle, ...directoryArgs]);
    expect(existsSync(join(root, "backups"))).toBe(false);
  });
});

describe("the backup/restore lock's own exit status (#1211 E3)", () => {
  function holdLock(lockPath: string): ChildProcess {
    const holder = spawn("flock", [lockPath, "-c", "sleep 30"], { detached: true, stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    while (spawnSync("flock", ["-n", lockPath, "true"]).status === 0) {
      if (Date.now() > deadline) throw new Error("the lock was never taken");
    }
    return holder;
  }

  it("restore --recover exits 75 while another backup or restore holds the lock, so the shell leaves orbit-app alone", () => {
    const { root, directoryArgs } = deployment();
    mkdirSync(join(root, "backups"), { mode: 0o700 });
    const holder = holdLock(join(root, "backups", ".orbit-backup-restore.lock"));
    try {
      const result = runCli(["restore", "--recover", ...directoryArgs]);
      expect(result.status).toBe(75);
      expect(result.stderr).toContain("Another orbit backup or restore is already running");
    } finally {
      if (holder.pid !== undefined) process.kill(-holder.pid, "SIGKILL");
    }
  });
});
