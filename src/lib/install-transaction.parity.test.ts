import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InstallTransaction, type ManagedPath } from "./install-transaction";

// Byte-for-byte evidence-layout parity between scripts/install.sh's staging
// transaction and InstallTransaction (issue #295 slice 1).
//
// install.sh has no standalone entry point for just the transaction phase
// (unlike scripts/configuration.sh's --preflight/--migrate, which
// config-contract.parity.test.ts spawns directly), so this test cannot
// spawn the whole script the way that parity suite does. Instead it
// mechanically extracts the current bodies of prepare_rollback_area,
// rollback_transaction, is_real_non_symlink_directory and
// remove_target_path from the real, unmodified scripts/install.sh via awk
// keyed on function name (never hand-copied), wraps them in a minimal
// driver that reproduces install.sh's own top-level variable contract
// (managed_paths, managed_was_present, created_directories, staging_dir,
// rollback_dir), and diffs the resulting directory tree against
// InstallTransaction driven through the identical scenario. If a cited
// function is ever renamed in install.sh, extraction returns empty and
// this test fails loudly rather than silently comparing against stale text
// — see docs/adr-notes/295-install-port-plan.md's Flags section.

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

const driverDir = mkdtempSync(join(tmpdir(), "orbit-install-tx-parity-driver-"));
const driverPath = join(driverDir, "driver.sh");

function buildDriverScript(): string {
  const functions = [
    "is_real_non_symlink_directory",
    "remove_target_path",
    "prepare_rollback_area",
    "rollback_transaction",
  ]
    .map(extractFunction)
    .join("\n");

  return [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "fail() { printf '%s\\n' \"$*\" >&2; exit 1; }",
    "",
    functions,
    "",
    'target_dir="$1"; staging_dir="$2"; shift 2',
    'managed_paths=("$@")',
    "declare -A managed_was_present=()",
    "declare -a created_directories=()",
    'cd -- "$target_dir"',
    "prepare_rollback_area",
    "printf 'prepared\\n'",
    "IFS= read -r _continue_signal",
    "rollback_status=0",
    "rollback_transaction || rollback_status=$?",
    'printf "rolled-back status=%s\\n" "$rollback_status"',
    "",
  ].join("\n");
}

writeFileSync(driverPath, buildDriverScript(), { mode: 0o755 });

interface Snapshot {
  [name: string]: {
    mode: number;
    type: "file" | "directory" | "symlink";
    content?: string;
    entries?: Snapshot;
    linkTarget?: string;
  };
}

function snapshotTree(root: string): Snapshot {
  const snapshot: Snapshot = {};
  for (const entry of readdirSync(root).sort()) {
    const absolute = join(root, entry);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      snapshot[entry] = { mode: stat.mode & 0o777, type: "symlink", linkTarget: readlinkSync(absolute) };
    } else if (stat.isDirectory()) {
      snapshot[entry] = { mode: stat.mode & 0o777, type: "directory", entries: snapshotTree(absolute) };
    } else {
      // Single-descriptor read: O_NOFOLLOW open, then fstat and read the SAME
      // descriptor, so the content provably belongs to the statted inode
      // (CodeQL js/file-system-race).
      const fd = openSync(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const fileStat = fstatSync(fd);
        snapshot[entry] = { mode: fileStat.mode & 0o777, type: "file", content: readFileSync(fd, "utf8") };
      } finally {
        closeSync(fd);
      }
    }
  }
  return snapshot;
}

/** Runs the bash driver, applying `mutate` to targetDir between prepare and rollback. */
function runBashRoundTrip(
  targetDir: string,
  managedPaths: ManagedPath[],
  mutate: () => void,
): Promise<{ originalSnapshot: Snapshot; finalSnapshot: Snapshot; rollbackStatus: number }> {
  return new Promise((resolvePromise, reject) => {
    const stagingDir = mkdtempSync(join(targetDir, ".orbit-install-staging."));
    chmodSync(stagingDir, 0o700);
    const child = spawn(
      "bash",
      [driverPath, targetDir, stagingDir, ...managedPaths.map((managed) => managed.path)],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let originalSnapshot: Snapshot | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (!originalSnapshot && stdout.includes("prepared\n")) {
        originalSnapshot = snapshotTree(join(stagingDir, "rollback", "original"));
        mutate();
        child.stdin.write("continue\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (!originalSnapshot) {
        reject(new Error(`bash driver never reported "prepared" (exit ${code}): ${stderr}`));
        return;
      }
      const match = /rolled-back status=(\d+)/.exec(stdout);
      if (!match) {
        reject(new Error(`bash driver did not report a rollback status: ${stdout}\n${stderr}`));
        return;
      }
      resolvePromise({
        originalSnapshot,
        finalSnapshot: snapshotTree(targetDir),
        rollbackStatus: Number(match[1]),
      });
    });
  });
}

let targetA: string;
let targetB: string;

beforeEach(() => {
  targetA = mkdtempSync(join(tmpdir(), "orbit-install-tx-parity-bash-"));
  targetB = mkdtempSync(join(tmpdir(), "orbit-install-tx-parity-ts-"));
});

afterEach(() => {
  rmSync(targetA, { recursive: true, force: true });
  rmSync(targetB, { recursive: true, force: true });
});

function seedIdenticalInitialState(target: string): void {
  writeFileSync(join(target, ".env-orbit"), "APP_URL=https://parity.invalid\n", { mode: 0o600 });
  const secretsDir = join(target, ".orbit-secrets");
  mkdirSync(secretsDir, { mode: 0o700 });
  writeFileSync(join(secretsDir, "oidc-client-secret"), "original-secret-bytes", { mode: 0o600 });
}

describe("install-transaction parity against the real install.sh staging functions", () => {
  const managedPaths: ManagedPath[] = [
    { path: ".env-orbit", type: "file" },
    { path: ".orbit-secrets", type: "directory" },
  ];

  it("produces a byte-for-byte identical rollback/original backup layout to install.sh's prepare_rollback_area", async () => {
    seedIdenticalInitialState(targetA);
    seedIdenticalInitialState(targetB);

    const applyMutation = (target: string) => () => {
      // Mirrors what configure.sh would do mid-transaction: rewrite
      // .env-orbit and rotate the OIDC secret file.
      writeFileSync(join(target, ".env-orbit"), "APP_URL=https://parity.invalid\nOIDC_ISSUER=https://idp.invalid\n", {
        mode: 0o600,
      });
      const secretsDir = join(target, ".orbit-secrets");
      rmSync(secretsDir, { recursive: true, force: true });
      mkdirSync(secretsDir, { mode: 0o700 });
      writeFileSync(join(secretsDir, "oidc-client-secret"), "rotated-secret-bytes", { mode: 0o600 });
    };

    const bashResult = await runBashRoundTrip(targetA, managedPaths, applyMutation(targetA));

    const tx = InstallTransaction.begin(targetB, managedPaths);
    const tsOriginalSnapshot = snapshotTree(tx.originalDir);
    applyMutation(targetB)();
    const rollback = tx.rollback();

    // The backup evidence captured before either implementation touched
    // anything must match exactly: same relative paths, same permission
    // bits, same bytes.
    expect(tsOriginalSnapshot).toEqual(bashResult.originalSnapshot);

    // Both implementations must restore to the identical, original state.
    expect(bashResult.rollbackStatus).toBe(0);
    expect(rollback.ok).toBe(true);
    const bashFinal = bashResult.finalSnapshot;
    const tsFinal = snapshotTree(targetB);
    // Compare only the managed entries (the bash driver's target directory
    // has no staging-directory leftover to exclude here because the driver
    // is invoked with stagingDir already outside the snapshot loop's
    // concern — assert the managed paths directly).
    expect(tsFinal[".env-orbit"]).toEqual(bashFinal[".env-orbit"]);
    expect(tsFinal[".orbit-secrets"]).toEqual(bashFinal[".orbit-secrets"]);
    expect(tsFinal[".env-orbit"].content).toBe("APP_URL=https://parity.invalid\n");
  });

  it("refuses to restore a pre-existing path through a symlinked parent identically in both implementations (guarantee #8)", async () => {
    // The file pre-exists (managed_was_present=1), so both implementations
    // take the *restore* branch of rollback, not the *remove-newly-created*
    // branch: install.sh's own restore-branch check
    // (`is_real_non_symlink_directory "$parent"`, install.sh:348) folds a
    // symlinked parent into the same "missing or unsafe" refusal as a
    // genuinely missing parent, rather than a distinct symlink-specific
    // message — InstallTransaction mirrors that exactly (reason
    // "unsafe-parent"). The remove-newly-created branch's distinct
    // "symlinked-parent" refusal is characterized separately in
    // install-transaction.test.ts's "refuses to remove a newly-created path
    // through a symlinked parent" case.
    mkdirSync(join(targetA, "config"));
    mkdirSync(join(targetB, "config"));
    writeFileSync(join(targetA, "config", "tika-config.xml"), "<original/>", { mode: 0o644 });
    writeFileSync(join(targetB, "config", "tika-config.xml"), "<original/>", { mode: 0o644 });
    const nested: ManagedPath[] = [{ path: "config/tika-config.xml", type: "file" }];

    const swapParentForSymlink = (target: string) => () => {
      rmSync(join(target, "config"), { recursive: true, force: true });
      const elsewhere = join(target, "elsewhere");
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(target, "config"));
    };

    const bashResult = await runBashRoundTrip(targetA, nested, swapParentForSymlink(targetA));

    const tx = InstallTransaction.begin(targetB, nested);
    swapParentForSymlink(targetB)();
    const rollback = tx.rollback();

    // install.sh's rollback_transaction returns non-zero when it refuses to
    // restore through an unsafe parent; so must InstallTransaction.rollback().
    expect(bashResult.rollbackStatus).not.toBe(0);
    expect(rollback.ok).toBe(false);
    expect(rollback.failures[0]).toMatchObject({ path: "config/tika-config.xml", reason: "unsafe-parent" });
  });
});
