import { beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "@/lib/logger";

/**
 * #1421: the administrator alert never throws into its caller. The database is
 * stood in for; who is mailed, what is said and the repeat limit are in
 * tests/integration/admin-alert.test.ts, against a real database.
 */
const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  sendBoundedMail: vi.fn(),
}));

vi.mock("@/db", () => ({ getDb: mocks.getDb }));

vi.mock("@/server/invitations/send", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/invitations/send")>(),
  sendBoundedMail: mocks.sendBoundedMail,
}));

const alert = {
  kind: "import_undo_failed" as const,
  faultKey: "import-harlow-1",
  householdName: "Harlow",
  occurredAt: new Date("2026-11-07T14:05:00Z"),
};

const logLines = () => JSON.stringify([
  ...vi.mocked(log.info).mock.calls,
  ...vi.mocked(log.warn).mock.calls,
  ...vi.mocked(log.error).mock.calls,
]);
const logCount = () => vi.mocked(log.info).mock.calls.length + vi.mocked(log.warn).mock.calls.length + vi.mocked(log.error).mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
  mocks.sendBoundedMail.mockResolvedValue({ sentAt: new Date(), sendError: null });
  mocks.getDb.mockReset();
});

describe("raiseAdminAlert never throws (#1421)", () => {
  it("resolves, logs and sends nothing when the database read throws, without putting the connection string in the log", async () => {
    mocks.getDb.mockImplementation(() => {
      throw new Error("connect ECONNREFUSED host db.harlow.example password-marker-xyz");
    });
    const { raiseAdminAlert } = await import("@/server/admin-alert");

    await expect(raiseAdminAlert(alert)).resolves.toBeUndefined();

    expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
    expect(logCount()).toBeGreaterThan(0);
    expect(logLines()).not.toContain("password-marker-xyz");
  });

  it("resolves, logs and sends nothing when the database rejects the query", async () => {
    const failing: Record<string, unknown> = {};
    failing.select = () => failing;
    failing.from = () => failing;
    failing.where = () => failing;
    failing.orderBy = () => failing;
    failing.limit = () => failing;
    failing.then = (_resolve: unknown, reject: (reason: unknown) => unknown) => reject(new Error("terminating connection"));
    mocks.getDb.mockReturnValue(failing);
    const { raiseAdminAlert } = await import("@/server/admin-alert");

    await expect(raiseAdminAlert(alert)).resolves.toBeUndefined();

    expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
    expect(logCount()).toBeGreaterThan(0);
  });
});
