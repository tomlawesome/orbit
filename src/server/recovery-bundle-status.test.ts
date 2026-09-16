import { describe, expect, it, vi } from "vitest";

/**
 * #968 (slice 1 of #966): whether a recovery bundle covering the currently
 * active document KEK has been recorded, for the administration screen's
 * persistent "no recovery bundle exported" card.
 *
 * `computeRecoveryBundleStatus` is exercised against a fake executor, the
 * same seam `openRotationStartWith`/`getKekRotationStatus` expose but never
 * unit-test themselves (only tests/integration/document-kek-rotation.test.ts
 * covers that path, against a real database). This file proves the row-to-
 * result mapping only — the SQL's own started-vs-completed comparison window
 * is Postgres's job and is not re-verified here; that needs the real
 * producer, which this fast unit suite deliberately does not stand up.
 */

const mocks = vi.hoisted(() => ({
  execute: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@/db", () => ({
  getDb: () => ({ execute: mocks.execute }),
}));

const { computeRecoveryBundleStatus, getRecoveryBundleStatus } = await import("./recovery-bundle-status");

/**
 * `StatusExecutor` is `Pick<ReturnType<typeof getDb>, "execute">`, whose real
 * return type is Drizzle's own `PgRaw` query-builder object, not a bare
 * `Promise` — a plain fake can never structurally satisfy it, which is
 * exactly why this shape has never actually been unit-tested before (only
 * tests/integration/document-kek-rotation.test.ts covers its rewrap-worker
 * sibling, against a real database). The cast is deliberate: at runtime
 * `computeRecoveryBundleStatus` only ever `await`s the result, which this
 * fake satisfies perfectly well.
 */
function fakeExecutor(rows: unknown[]): Parameters<typeof computeRecoveryBundleStatus>[0] {
  return { execute: async () => rows } as unknown as Parameters<typeof computeRecoveryBundleStatus>[0];
}

describe("computeRecoveryBundleStatus", () => {
  it("reports not exported when no qualifying row exists", async () => {
    await expect(computeRecoveryBundleStatus(fakeExecutor([{ exportedAt: null }]))).resolves.toEqual({
      exported: false,
      exportedAt: null,
    });
    await expect(computeRecoveryBundleStatus(fakeExecutor([]))).resolves.toEqual({
      exported: false,
      exportedAt: null,
    });
  });

  it("reports exported with an ISO timestamp when the row carries a Date", async () => {
    const exportedAt = new Date("2026-09-11T12:00:00Z");
    await expect(computeRecoveryBundleStatus(fakeExecutor([{ exportedAt }]))).resolves.toEqual({
      exported: true,
      exportedAt: "2026-09-11T12:00:00.000Z",
    });
  });

  it("reports exported with an ISO timestamp when the driver hands back a string instead of a Date", async () => {
    await expect(
      computeRecoveryBundleStatus(fakeExecutor([{ exportedAt: "2026-09-11T12:00:00.000Z" }])),
    ).resolves.toEqual({ exported: true, exportedAt: "2026-09-11T12:00:00.000Z" });
  });
});

describe("getRecoveryBundleStatus", () => {
  it("delegates to computeRecoveryBundleStatus against the real db handle", async () => {
    mocks.execute.mockResolvedValueOnce([{ exportedAt: "2026-09-11T12:00:00.000Z" }]);
    await expect(getRecoveryBundleStatus()).resolves.toEqual({
      exported: true,
      exportedAt: "2026-09-11T12:00:00.000Z",
    });
  });

  it("never throws, and fails toward SHOWING the card, not hiding it — the opposite of getKekRotationStatus's own direction", async () => {
    // An unreadable audit_log is exactly the kind of instance where the
    // warning matters most, so this must not silently look "exported".
    mocks.execute.mockRejectedValueOnce(new Error("audit_log unreachable"));
    await expect(getRecoveryBundleStatus()).resolves.toEqual({ exported: false, exportedAt: null });
  });
});
