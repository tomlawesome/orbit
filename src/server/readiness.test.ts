import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkDatabase: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn() },
  getKeyState: vi.fn(),
}));

vi.mock("@/db", () => ({
  getDb: () => ({ execute: mocks.checkDatabase }),
}));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));
/* #1405: readiness reads the process's key verdict; the cases above are about
   something else, so by default the key is usable. */
vi.mock("@/server/key-state", () => ({ getKeyState: mocks.getKeyState }));

import { checkDatabaseReachable, getPublicReadiness, setReadinessDependenciesForTests } from "./readiness";

describe("public readiness", () => {
  beforeEach(() => {
    mocks.getKeyState.mockReturnValue({ verdict: "usable", heldKeyId: "a".repeat(24) });
  });

  afterEach(() => {
    mocks.getKeyState.mockReset();
    mocks.checkDatabase.mockReset();
    mocks.log.info.mockReset();
    mocks.log.warn.mockReset();
    setReadinessDependenciesForTests(undefined);
  });

  it("reports ready only after the required database dependency responds", async () => {
    mocks.checkDatabase.mockResolvedValueOnce([]);
    setReadinessDependenciesForTests({ readMaintenance: async () => ({ effectivelyActive: false }) });
    await expect(getPublicReadiness()).resolves.toEqual({ status: "ready" });
    expect(mocks.checkDatabase).toHaveBeenCalledTimes(1);
    expect(mocks.log.info).toHaveBeenCalledWith({ event: "application.startup", state: "ready", action: "none" });
  });

  it("reports maintenance as its own healthy category (#523)", async () => {
    mocks.checkDatabase.mockResolvedValueOnce([]);
    setReadinessDependenciesForTests({ readMaintenance: async () => ({ effectivelyActive: true }) });
    await expect(getPublicReadiness()).resolves.toEqual({ status: "maintenance" });
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it("degrades rather than guessing when the maintenance state is unreadable", async () => {
    mocks.checkDatabase.mockResolvedValueOnce([]);
    setReadinessDependenciesForTests({ readMaintenance: async () => { throw new Error("relation missing"); } });
    await expect(getPublicReadiness()).resolves.toEqual({ status: "degraded" });
    expect(mocks.log.warn).toHaveBeenCalledWith({
      event: "application.startup",
      state: "degraded",
      reason: "dependency_unavailable",
      action: "check_migrations",
      impact: "application_degraded",
    });
  });

  it("fails closed without exposing a dependency error", async () => {
    mocks.checkDatabase.mockRejectedValueOnce(new Error("postgres://secret@example.invalid/private"));
    await expect(getPublicReadiness()).resolves.toEqual({ status: "degraded" });
    expect(mocks.log.warn).toHaveBeenCalledWith({
      event: "application.startup",
      state: "degraded",
      reason: "dependency_unavailable",
      action: "check_database",
      impact: "database_unavailable",
    });
  });

  it("supports deterministic dependency failure characterization", async () => {
    setReadinessDependenciesForTests({ checkDatabase: async () => { throw new Error("synthetic failure"); } });
    await expect(getPublicReadiness()).resolves.toEqual({ status: "degraded" });
  });
});

describe("database reachability", () => {
  afterEach(() => {
    mocks.checkDatabase.mockReset();
    setReadinessDependenciesForTests(undefined);
  });

  it("reports true once the database answers", async () => {
    mocks.checkDatabase.mockResolvedValueOnce([]);
    await expect(checkDatabaseReachable()).resolves.toBe(true);
  });

  it("reports false, not the error, when the database is unreachable (#863)", async () => {
    setReadinessDependenciesForTests({
      checkDatabase: async () => { throw new Error("postgres://secret@example.invalid/private"); },
    });
    await expect(checkDatabaseReachable()).resolves.toBe(false);
  });

  /*
   * #1405: a locked instance is closed on purpose and a restart cannot help, so
   * health says "maintenance" (200, the healthcheck stays green) exactly as it
   * does for an operator's window (ADR-0013 decision 6), and answers before
   * the operator-maintenance state is even read.
   */
  it("reports maintenance, not ready, when the encryption key is unusable (#1405)", async () => {
    mocks.checkDatabase.mockResolvedValueOnce([]);
    mocks.getKeyState.mockReturnValue({ verdict: "unusable", reason: "missing" });
    const readMaintenance = vi.fn(async () => ({ effectivelyActive: false }));
    setReadinessDependenciesForTests({ readMaintenance });

    await expect(getPublicReadiness()).resolves.toEqual({ status: "maintenance" });

    expect(readMaintenance).not.toHaveBeenCalled();
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it("still reports degraded for a database that cannot answer, key or no key (an outage is not this mode, #1405)", async () => {
    mocks.checkDatabase.mockRejectedValueOnce(new Error("connection refused"));
    mocks.getKeyState.mockReturnValue({ verdict: "unusable", reason: "missing" });
    setReadinessDependenciesForTests({ readMaintenance: async () => ({ effectivelyActive: false }) });

    await expect(getPublicReadiness()).resolves.toEqual({ status: "degraded" });
  });
});
