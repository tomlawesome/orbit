import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ checkDatabase: vi.fn() }));

vi.mock("@/db", () => ({
  getDb: () => ({ execute: mocks.checkDatabase }),
}));

import { getPublicReadiness, setReadinessDependenciesForTests } from "./readiness";

describe("public readiness", () => {
  afterEach(() => {
    mocks.checkDatabase.mockReset();
    setReadinessDependenciesForTests(undefined);
  });

  it("reports ready only after the required database dependency responds", async () => {
    mocks.checkDatabase.mockResolvedValueOnce([]);
    await expect(getPublicReadiness()).resolves.toEqual({ status: "ready" });
    expect(mocks.checkDatabase).toHaveBeenCalledTimes(1);
  });

  it("fails closed without exposing a dependency error", async () => {
    mocks.checkDatabase.mockRejectedValueOnce(new Error("postgres://secret@example.invalid/private"));
    await expect(getPublicReadiness()).resolves.toEqual({ status: "degraded" });
  });

  it("supports deterministic dependency failure characterization", async () => {
    setReadinessDependenciesForTests({ checkDatabase: async () => { throw new Error("synthetic failure"); } });
    await expect(getPublicReadiness()).resolves.toEqual({ status: "degraded" });
  });
});
