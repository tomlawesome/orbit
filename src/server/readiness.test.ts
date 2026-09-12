import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkDatabase: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/db", () => ({
  getDb: () => ({ execute: mocks.checkDatabase }),
}));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));

import { checkDatabaseReachable, getPublicReadiness, setReadinessDependenciesForTests } from "./readiness";

describe("public readiness", () => {
  afterEach(() => {
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
});
