import { closeSync, constants as fsConstants, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readGolden } from "./__fixtures__/golden";
import { InstallTransaction, type ManagedPath } from "./install-transaction";

// Evidence-layout parity between scripts/install.sh's staging transaction
// (prepare_rollback_area, rollback_transaction, remove_target_path,
// is_real_non_symlink_directory) and InstallTransaction (issue #295 slice
// 1), against what the bash produced, captured from 9757e42f before #1212
// deleted it (src/lib/__fixtures__/README.md). Golden-file
// characterization: the fixtures are bash's, never regenerated from this
// module.
//
// Each golden holds the managed paths and, from the bash run, the
// rollback/original backup tree right after prepare_rollback_area, the
// rollback status, and the restored entries afterwards (symlink targets
// written relative to the target as `<target>`). The seed and the
// mid-transaction mutation are the same code bash ran against, below.

const FLOW = "install-transaction";

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
    // No check-then-use pairs (CodeQL js/file-system-race): readlink IS the
    // symlink probe, and everything else is fstat+read on one O_NOFOLLOW
    // descriptor, so every recorded fact comes from the operation itself.
    let linkTarget: string | undefined;
    try {
      linkTarget = readlinkSync(absolute);
    } catch {
      linkTarget = undefined;
    }
    if (linkTarget !== undefined) {
      snapshot[entry] = { mode: 0o777, type: "symlink", linkTarget };
      continue;
    }
    const fd = openSync(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.isDirectory()) {
        snapshot[entry] = { mode: opened.mode & 0o777, type: "directory", entries: snapshotTree(absolute) };
      } else {
        snapshot[entry] = { mode: opened.mode & 0o777, type: "file", content: readFileSync(fd, "utf8") };
      }
    } finally {
      closeSync(fd);
    }
  }
  return snapshot;
}

interface TransactionGolden {
  managedPaths: ManagedPath[];
  bash: { originalSnapshot: Snapshot; rollbackStatus: number; final: Snapshot };
}

let target: string;

beforeEach(() => {
  target = mkdtempSync(join(tmpdir(), "orbit-install-tx-parity-"));
});

afterEach(() => {
  rmSync(target, { recursive: true, force: true });
});

function seedInitialState(dir: string): void {
  writeFileSync(join(dir, ".env-orbit"), "APP_URL=https://parity.invalid\n", { mode: 0o600 });
  const secretsDir = join(dir, ".orbit-secrets");
  mkdirSync(secretsDir, { mode: 0o700 });
  writeFileSync(join(secretsDir, "oidc-client-secret"), "original-secret-bytes", { mode: 0o600 });
}

describe("install-transaction parity against install.sh's staging functions (golden)", () => {
  it("produces install.sh's rollback/original backup layout and restores the original state", () => {
    const golden = readGolden<TransactionGolden>(FLOW, "rollback restores managed paths");
    seedInitialState(target);

    const tx = InstallTransaction.begin(target, golden.managedPaths);
    // Same relative paths, permission bits and bytes as bash's backup.
    expect(snapshotTree(tx.originalDir)).toEqual(golden.bash.originalSnapshot);

    // Mirrors what configure.sh would do mid-transaction: rewrite
    // .env-orbit and rotate the OIDC secret file.
    writeFileSync(join(target, ".env-orbit"), "APP_URL=https://parity.invalid\nOIDC_ISSUER=https://idp.invalid\n", {
      mode: 0o600,
    });
    const secretsDir = join(target, ".orbit-secrets");
    rmSync(secretsDir, { recursive: true, force: true });
    mkdirSync(secretsDir, { mode: 0o700 });
    writeFileSync(join(secretsDir, "oidc-client-secret"), "rotated-secret-bytes", { mode: 0o600 });

    const rollback = tx.rollback();
    expect(golden.bash.rollbackStatus).toBe(0);
    expect(rollback.ok).toBe(true);
    const final = snapshotTree(target);
    expect({ ".env-orbit": final[".env-orbit"], ".orbit-secrets": final[".orbit-secrets"] }).toEqual(golden.bash.final);
  });

  it("refuses to restore a pre-existing path through a symlinked parent, as install.sh did (guarantee #8)", () => {
    // The file pre-exists, so rollback takes the *restore* branch: install.sh
    // folds a symlinked parent into the same "missing or unsafe" refusal as a
    // missing one (`is_real_non_symlink_directory "$parent"`), and
    // InstallTransaction mirrors that (reason "unsafe-parent"). The
    // remove-newly-created branch's distinct "symlinked-parent" refusal is
    // characterized in install-transaction.test.ts.
    const golden = readGolden<TransactionGolden>(FLOW, "symlinked parent refuses restore");
    mkdirSync(join(target, "config"));
    writeFileSync(join(target, "config", "tika-config.json"), "{}", { mode: 0o644 });

    const tx = InstallTransaction.begin(target, golden.managedPaths);
    expect(snapshotTree(tx.originalDir)).toEqual(golden.bash.originalSnapshot);

    rmSync(join(target, "config"), { recursive: true, force: true });
    mkdirSync(join(target, "elsewhere"));
    symlinkSync(join(target, "elsewhere"), join(target, "config"));
    const rollback = tx.rollback();

    // install.sh's rollback_transaction returned non-zero; so must rollback().
    expect(golden.bash.rollbackStatus).not.toBe(0);
    expect(rollback.ok).toBe(false);
    expect(rollback.failures[0]).toMatchObject({ path: "config/tika-config.json", reason: "unsafe-parent" });
    // Nothing was restored through the symlink. (The mode of `elsewhere`
    // follows the umask, so only its entries are compared.)
    const final = JSON.parse(JSON.stringify(snapshotTree(target)).split(target).join("<target>")) as Snapshot;
    expect(final.config).toEqual(golden.bash.final.config);
    expect(final.elsewhere.entries).toEqual(golden.bash.final.elsewhere.entries);
  });
});
