import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  InstallTransaction,
  InstallTransactionRefusal,
  SECURE_DIRECTORY_MODE,
  STAGING_DIRECTORY_PREFIX,
  preflightManagedPaths,
  type ManagedPath,
} from "./install-transaction";

// Ported from scripts/install.sh's preflight_final_paths, prepare_rollback_area,
// rollback_transaction and cleanup (docs/installer-guarantees.md, Part 1 /
// install.sh, guarantees #6-11 and #46-56 — cited by number in test names
// below). See docs/adr-notes/295-install-port-plan.md for the slice this
// belongs to and byte-for-byte parity coverage against the real script.

let targetDir: string;

beforeEach(() => {
  targetDir = mkdtempSync(join(tmpdir(), "orbit-install-tx-"));
});

afterEach(() => {
  rmSync(targetDir, { recursive: true, force: true });
});

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

const envManaged: ManagedPath = { path: ".env-orbit", type: "file" };
const secretsManaged: ManagedPath = { path: ".orbit-secrets", type: "directory" };

describe("preflightManagedPaths (guarantee #46)", () => {
  it("passes when no managed path exists yet", () => {
    expect(() => preflightManagedPaths(targetDir, [envManaged, secretsManaged])).not.toThrow();
  });

  it("passes when an existing managed path is already the safe type", () => {
    writeFileSync(join(targetDir, ".env-orbit"), "APP_URL=https://example.invalid\n", { mode: 0o600 });
    expect(() => preflightManagedPaths(targetDir, [envManaged])).not.toThrow();
  });

  it("refuses a symlinked .env-orbit before any mutation", () => {
    writeFileSync(join(targetDir, "real-target"), "content");
    symlinkSync(join(targetDir, "real-target"), join(targetDir, ".env-orbit"));
    expect(() => preflightManagedPaths(targetDir, [envManaged])).toThrow(InstallTransactionRefusal);
  });

  it("refuses a directory where a managed file is expected", () => {
    mkdirSync(join(targetDir, ".env-orbit"));
    let error: unknown;
    try {
      preflightManagedPaths(targetDir, [envManaged]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InstallTransactionRefusal);
    expect((error as InstallTransactionRefusal).code).toBe("unsafe-final-type");
  });

  it("refuses a symlinked .orbit-secrets directory", () => {
    mkdirSync(join(targetDir, "real-secrets"));
    symlinkSync(join(targetDir, "real-secrets"), join(targetDir, ".orbit-secrets"));
    expect(() => preflightManagedPaths(targetDir, [secretsManaged])).toThrow(InstallTransactionRefusal);
  });

  it("refuses a regular file where a managed directory is expected", () => {
    writeFileSync(join(targetDir, ".orbit-secrets"), "not a directory");
    expect(() => preflightManagedPaths(targetDir, [secretsManaged])).toThrow(InstallTransactionRefusal);
  });
});

describe("InstallTransaction.begin staging layout (guarantees #47, #48, #49)", () => {
  it("creates a private 0700 staging directory under the target with the mktemp prefix", () => {
    const tx = InstallTransaction.begin(targetDir, [envManaged]);
    expect(tx.stagingDir.startsWith(join(targetDir, STAGING_DIRECTORY_PREFIX))).toBe(true);
    expect(mode(tx.stagingDir)).toBe(SECURE_DIRECTORY_MODE);
    tx.dispose();
  });

  it("creates the rollback and rollback/original areas at 0700 (#47)", () => {
    const tx = InstallTransaction.begin(targetDir, [envManaged]);
    expect(mode(tx.rollbackDir)).toBe(SECURE_DIRECTORY_MODE);
    expect(mode(tx.originalDir)).toBe(SECURE_DIRECTORY_MODE);
    tx.dispose();
  });

  it("backs up an existing managed file into rollback/original before any mutation, preserving mode and content (#47)", () => {
    const envPath = join(targetDir, ".env-orbit");
    writeFileSync(envPath, "APP_URL=https://example.invalid\n", { mode: 0o600 });
    const tx = InstallTransaction.begin(targetDir, [envManaged]);
    const backupPath = join(tx.originalDir, ".env-orbit");
    expect(readFileSync(backupPath, "utf8")).toBe("APP_URL=https://example.invalid\n");
    expect(mode(backupPath)).toBe(0o600);
    // Nothing in the real target has been touched yet.
    expect(readFileSync(envPath, "utf8")).toBe("APP_URL=https://example.invalid\n");
    tx.dispose();
  });

  it("backs up an existing managed directory recursively, preserving nested modes and content (#47, #9)", () => {
    const secretsPath = join(targetDir, ".orbit-secrets");
    mkdirSync(secretsPath, { mode: 0o700 });
    writeFileSync(join(secretsPath, "oidc-client-secret"), "s3cr3t", { mode: 0o600 });
    const tx = InstallTransaction.begin(targetDir, [secretsManaged]);
    const backupSecret = join(tx.originalDir, ".orbit-secrets", "oidc-client-secret");
    expect(readFileSync(backupSecret, "utf8")).toBe("s3cr3t");
    expect(mode(backupSecret)).toBe(0o600);
    expect(mode(join(tx.originalDir, ".orbit-secrets"))).toBe(0o700);
    tx.dispose();
  });

  it("refuses to begin when a managed path is unsafe, and creates no staging directory at all (#46, #49)", () => {
    mkdirSync(join(targetDir, ".env-orbit"));
    expect(() => InstallTransaction.begin(targetDir, [envManaged])).toThrow(InstallTransactionRefusal);
    const leftovers = readdirSync(targetDir).filter((name) => name.startsWith(STAGING_DIRECTORY_PREFIX));
    expect(leftovers).toEqual([]);
  });
});

describe("commit (guarantees #51, #52, #53/#54, #56)", () => {
  it("moves staged content onto the final destination via rename, not copy", () => {
    const tx = InstallTransaction.begin(targetDir, [envManaged]);
    const staged = tx.writeStagedFile(".env-orbit", "APP_URL=https://example.invalid\n", 0o600);
    expect(existsSync(staged)).toBe(true);
    tx.commitMove(".env-orbit", "file");
    expect(existsSync(staged)).toBe(false);
    const finalPath = join(targetDir, ".env-orbit");
    expect(readFileSync(finalPath, "utf8")).toBe("APP_URL=https://example.invalid\n");
    expect(mode(finalPath)).toBe(0o600);
    tx.commit();
    const result = tx.dispose();
    expect(result.stagingDirectoryRemoved).toBe(true);
    expect(existsSync(tx.stagingDir)).toBe(false);
  });

  it("forces the staged file's mode before any content is written (#53/#54)", () => {
    const tx = InstallTransaction.begin(targetDir, [envManaged]);
    const staged = tx.writeStagedFile(".env-orbit", "secret-bearing content", 0o600);
    expect(mode(staged)).toBe(0o600);
    tx.commitMove(".env-orbit", "file");
    tx.commit();
    tx.dispose();
  });

  it("re-checks the final destination's type immediately before overwriting it (TOCTOU, #51)", () => {
    const tx = InstallTransaction.begin(targetDir, [envManaged]);
    tx.writeStagedFile(".env-orbit", "content", 0o600);
    // Something replaced the final destination with a symlink after
    // begin()'s preflight but before commitMove — the recheck must refuse.
    symlinkSync(join(targetDir, "elsewhere"), join(targetDir, ".env-orbit"));
    expect(() => tx.commitMove(".env-orbit", "file")).toThrow(InstallTransactionRefusal);
    tx.dispose();
  });

  it("creates a managed directory and records it as created, for a fresh install (#10 provenance)", () => {
    const tx = InstallTransaction.begin(targetDir, [secretsManaged]);
    tx.ensureManagedDirectory(".orbit-secrets");
    expect(lstatSync(join(targetDir, ".orbit-secrets")).isDirectory()).toBe(true);
    tx.commit();
    tx.dispose();
  });

  it("dispose() after commit() never rolls back (#56)", () => {
    const envPath = join(targetDir, ".env-orbit");
    writeFileSync(envPath, "original\n", { mode: 0o600 });
    const tx = InstallTransaction.begin(targetDir, [envManaged]);
    tx.writeStagedFile(".env-orbit", "replaced\n", 0o600);
    tx.commitMove(".env-orbit", "file");
    tx.commit();
    tx.dispose();
    expect(readFileSync(envPath, "utf8")).toBe("replaced\n");
  });
});

describe("rollback (guarantees #8, #9, #10)", () => {
  it("removes a newly-created path that did not exist before the transaction", () => {
    const tx = InstallTransaction.begin(targetDir, [envManaged]);
    tx.writeStagedFile(".env-orbit", "new content\n", 0o600);
    tx.commitMove(".env-orbit", "file");
    const result = tx.rollback();
    expect(result.ok).toBe(true);
    expect(existsSync(join(targetDir, ".env-orbit"))).toBe(false);
  });

  it("restores a previously-existing path byte-for-byte with a same-filesystem rename (#9)", () => {
    const envPath = join(targetDir, ".env-orbit");
    writeFileSync(envPath, "original content\n", { mode: 0o600 });
    const tx = InstallTransaction.begin(targetDir, [envManaged]);
    tx.writeStagedFile(".env-orbit", "mutated content\n", 0o600);
    tx.commitMove(".env-orbit", "file");
    expect(readFileSync(envPath, "utf8")).toBe("mutated content\n");
    const result = tx.rollback();
    expect(result.ok).toBe(true);
    expect(readFileSync(envPath, "utf8")).toBe("original content\n");
    expect(mode(envPath)).toBe(0o600);
  });

  it("restores a previously-existing directory recursively", () => {
    const secretsPath = join(targetDir, ".orbit-secrets");
    mkdirSync(secretsPath, { mode: 0o700 });
    writeFileSync(join(secretsPath, "oidc-client-secret"), "original-secret", { mode: 0o600 });
    const tx = InstallTransaction.begin(targetDir, [secretsManaged]);
    // Simulate configure.sh rotating a secret in place mid-transaction.
    rmSync(secretsPath, { recursive: true, force: true });
    mkdirSync(secretsPath, { mode: 0o700 });
    writeFileSync(join(secretsPath, "oidc-client-secret"), "rotated-secret", { mode: 0o600 });
    const result = tx.rollback();
    expect(result.ok).toBe(true);
    expect(readFileSync(join(secretsPath, "oidc-client-secret"), "utf8")).toBe("original-secret");
    expect(mode(secretsPath)).toBe(0o700);
  });

  it("only removes a directory this invocation created, leaving a pre-existing empty directory alone (#10)", () => {
    const configDir = join(targetDir, "config");
    mkdirSync(configDir);
    const tx = InstallTransaction.begin(targetDir, []);
    // "config" pre-existed; this invocation did not create it, so it must
    // never appear in rollback's directory-removal pass even though it is
    // (still) empty after restoration.
    const result = tx.rollback();
    expect(result.ok).toBe(true);
    expect(existsSync(configDir)).toBe(true);
    tx.dispose();
  });

  it("removes a directory this invocation itself created (#10)", () => {
    const tx = InstallTransaction.begin(targetDir, []);
    tx.ensureManagedDirectory("config");
    expect(existsSync(join(targetDir, "config"))).toBe(true);
    const result = tx.rollback();
    expect(result.ok).toBe(true);
    expect(existsSync(join(targetDir, "config"))).toBe(false);
  });

  it("refuses to remove a newly-created path through a symlinked parent (#8)", () => {
    // config/ is itself the newly-created thing being tracked; nest one
    // level deeper so its parent can be swapped for a symlink mid-flight.
    mkdirSync(join(targetDir, "config"));
    const nested: ManagedPath = { path: "config/tika-config.xml", type: "file" };
    const tx = InstallTransaction.begin(targetDir, [nested]);
    tx.writeStagedFile("config/tika-config.xml", "<config/>", 0o644);
    tx.commitMove("config/tika-config.xml", "file");
    // Replace config/ with a symlink to another directory between the move
    // and rollback, exactly the untrusted-parent scenario install.sh guards.
    rmSync(join(targetDir, "config"), { recursive: true, force: true });
    const elsewhere = join(targetDir, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(targetDir, "config"));
    const result = tx.rollback();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([{ path: "config/tika-config.xml", reason: "symlinked-parent" }]);
    // The symlink itself, and its target, must be untouched.
    expect(lstatSync(join(targetDir, "config")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(elsewhere, "tika-config.xml"))).toBe(false);
  });

  it("reports (not throws) a restore failure when a to-be-restored path's parent is missing", () => {
    mkdirSync(join(targetDir, "config"));
    const nested: ManagedPath = { path: "config/tika-config.xml", type: "file" };
    writeFileSync(join(targetDir, "config", "tika-config.xml"), "<original/>", { mode: 0o644 });
    const tx = InstallTransaction.begin(targetDir, [nested]);
    tx.writeStagedFile("config/tika-config.xml", "<replaced/>", 0o644);
    tx.commitMove("config/tika-config.xml", "file");
    rmSync(join(targetDir, "config"), { recursive: true, force: true });
    const result = tx.rollback();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([{ path: "config/tika-config.xml", reason: "unsafe-parent" }]);
  });
});

describe("dispose() cleanup semantics (guarantee #11, the EXIT trap)", () => {
  it("rolls back and removes staging on a normal uncommitted dispose", () => {
    const envPath = join(targetDir, ".env-orbit");
    writeFileSync(envPath, "original\n", { mode: 0o600 });
    const tx = InstallTransaction.begin(targetDir, [envManaged]);
    tx.writeStagedFile(".env-orbit", "mutated\n", 0o600);
    tx.commitMove(".env-orbit", "file");
    const result = tx.dispose();
    expect(result.rollbackAttempted).toBe(true);
    expect(result.rollbackSucceeded).toBe(true);
    expect(result.stagingDirectoryRemoved).toBe(true);
    expect(readFileSync(envPath, "utf8")).toBe("original\n");
  });

  it("is idempotent: a second dispose() is a harmless no-op", () => {
    const tx = InstallTransaction.begin(targetDir, [envManaged]);
    tx.dispose();
    const second = tx.dispose();
    expect(second).toEqual({ rollbackAttempted: false, rollbackSucceeded: true, stagingDirectoryRemoved: true });
  });

  it("preserves staging evidence and reports its path when rollback fails, rather than deleting it", () => {
    mkdirSync(join(targetDir, "config"));
    writeFileSync(join(targetDir, "config", "tika-config.xml"), "<original/>", { mode: 0o644 });
    const nested: ManagedPath = { path: "config/tika-config.xml", type: "file" };
    const tx = InstallTransaction.begin(targetDir, [nested]);
    tx.writeStagedFile("config/tika-config.xml", "<replaced/>", 0o644);
    tx.commitMove("config/tika-config.xml", "file");
    rmSync(join(targetDir, "config"), { recursive: true, force: true }); // parent goes missing
    const result = tx.dispose();
    expect(result.rollbackAttempted).toBe(true);
    expect(result.rollbackSucceeded).toBe(false);
    expect(result.stagingDirectoryRemoved).toBe(false);
    expect(result.preservedStagingDirectory).toBe(tx.stagingDir);
    expect(existsSync(tx.stagingDir)).toBe(true);
    expect(mode(tx.stagingDir)).toBe(SECURE_DIRECTORY_MODE);
  });
});

describe("interruption evidence, no dispose() ever called (mirrors a hard SIGKILL)", () => {
  it("leaves the staging and rollback-backup evidence in place, owner-only, with the real target untouched for uncommitted paths", () => {
    const envPath = join(targetDir, ".env-orbit");
    writeFileSync(envPath, "original\n", { mode: 0o600 });
    const tx = InstallTransaction.begin(targetDir, [envManaged, secretsManaged]);
    tx.ensureManagedDirectory(".orbit-secrets");
    tx.writeStagedFile(".env-orbit", "would-be-new-content\n", 0o600);
    // Deliberately never call commitMove/commit/dispose — this is the exact
    // moment a SIGKILL, which bypasses any trap in Bash or Node, would land.
    expect(readFileSync(envPath, "utf8")).toBe("original\n");
    expect(mode(tx.stagingDir)).toBe(SECURE_DIRECTORY_MODE);
    expect(mode(tx.rollbackDir)).toBe(SECURE_DIRECTORY_MODE);
    expect(readFileSync(join(tx.originalDir, ".env-orbit"), "utf8")).toBe("original\n");
    // Recovery is operator-driven (as in install.sh): a fresh
    // InstallTransaction.begin() over the same paths would refuse only if
    // the *managed* paths themselves became unsafe, not because staging
    // evidence exists — matching validate_target's separate, distinct
    // refusal of stale staging evidence (install.sh #7 / repair.sh
    // staging-evidence-present), which this module does not reimplement.
    rmSync(tx.stagingDir, { recursive: true, force: true });
    expect(existsSync(tx.stagingDir)).toBe(false);
  });
});

describe("commit marker (issue #383 finding 2, install.sh:1569-1582 parity)", () => {
  it("writes a `committed` marker file into the staging directory at commit, and not before", () => {
    const target = mkdtempSync(join(tmpdir(), "orbit-tx-marker-"));
    try {
      const tx = InstallTransaction.begin(target, []);
      expect(existsSync(join(tx.stagingDir, "committed"))).toBe(false);
      tx.commit();
      expect(existsSync(join(tx.stagingDir, "committed"))).toBe(true);
      tx.dispose();
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
