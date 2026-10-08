import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEPLOY_LOCK_FILE_NAME, acquireDeployLock } from "./deploy-lock";

// The one deploy lock (#1210 D9). configure-engine.test.ts and
// install-transaction.test.ts keep their own caller-level lock cases; these
// cover the shared algorithm directly.

class TestLockRefusal extends Error {}
const makeError = (message: string): Error => new TestLockRefusal(message);

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orbit-deploy-lock-"));
  lockPath = join(dir, DEPLOY_LOCK_FILE_NAME);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("acquireDeployLock", () => {
  it("creates a mode-600 lock naming its holder and removes it on release", () => {
    const release = acquireDeployLock(dir, "test op", makeError);
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(lockPath, "utf8")).toMatch(new RegExp(`^${process.pid}:[0-9a-f-]{36}\\n$`));
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("refuses with the caller's own error while a fresh lock is held", () => {
    writeFileSync(lockPath, "someone-else\n");
    expect(() => acquireDeployLock(dir, "test op", makeError)).toThrow(TestLockRefusal);
    expect(() => acquireDeployLock(dir, "test op", makeError)).toThrow(/Another test op is already running/);
    expect(readFileSync(lockPath, "utf8")).toBe("someone-else\n");
  });

  it("reclaims a lock older than the staleness window", () => {
    writeFileSync(lockPath, "crashed\n");
    const old = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(lockPath, old, old);
    const release = acquireDeployLock(dir, "test op", makeError);
    expect(readFileSync(lockPath, "utf8")).not.toBe("crashed\n");
    release();
  });

  it("never removes a lock that now belongs to another run", () => {
    const release = acquireDeployLock(dir, "test op", makeError);
    writeFileSync(lockPath, "reclaimed-by-another-run\n");
    release();
    expect(readFileSync(lockPath, "utf8")).toBe("reclaimed-by-another-run\n");
  });

  it("release is idempotent", () => {
    const release = acquireDeployLock(dir, "test op", makeError);
    release();
    const second = acquireDeployLock(dir, "test op", makeError);
    release();
    expect(existsSync(lockPath)).toBe(true);
    second();
  });

  it("refuses rather than keeping a lock it cannot hand to the host operator (#1258)", () => {
    if (process.getuid?.() === 0) return; // root can chown anywhere; the refusal needs an unprivileged run
    const saved = { uid: process.env.ORBIT_HOST_UID, gid: process.env.ORBIT_HOST_GID };
    process.env.ORBIT_HOST_UID = String((process.getuid?.() ?? 0) + 1);
    process.env.ORBIT_HOST_GID = "0";
    try {
      expect(() => acquireDeployLock(dir, "test op", makeError)).toThrow(/Could not hand .* to the host operator/);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      for (const [key, value] of [["ORBIT_HOST_UID", saved.uid], ["ORBIT_HOST_GID", saved.gid]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("lets work done on the holder's behalf inside share() take the same lock without refusing (#1212)", async () => {
    const release = acquireDeployLock(dir, "install", makeError);
    const owner = readFileSync(lockPath, "utf8");
    const nested = release.share(() => {
      const inner = acquireDeployLock(dir, "orbit configure", makeError);
      inner();
      return readFileSync(lockPath, "utf8");
    });
    // The nested release left the holder's lock in place.
    expect(nested).toBe(owner);
    expect(readFileSync(lockPath, "utf8")).toBe(owner);
    await release.share(async () => {
      await Promise.resolve();
      acquireDeployLock(dir, "configuration migration", makeError)();
    });
    expect(readFileSync(lockPath, "utf8")).toBe(owner);
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("shares nothing outside share(), and nothing once the lock is no longer the holder's", () => {
    const release = acquireDeployLock(dir, "install", makeError);
    expect(() => acquireDeployLock(dir, "orbit configure", makeError)).toThrow(TestLockRefusal);
    writeFileSync(lockPath, "reclaimed-by-another-run\n");
    expect(() => release.share(() => acquireDeployLock(dir, "orbit configure", makeError))).toThrow(TestLockRefusal);
    release();
  });
});

