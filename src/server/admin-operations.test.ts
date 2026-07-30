import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  now: 1_000,
  verify: vi.fn(),
  requireAdmin: vi.fn(async () => undefined),
}));

vi.mock("@/server/authorization", () => ({ requireInstanceAdministrator: mocks.requireAdmin }));
vi.mock("@/server/notification-worker", () => ({
  getNotificationWorkerConfig: vi.fn(() => ({})),
  getNotificationWorkerHealth: vi.fn(() => ({ started: false, running: false, lastSuccessAt: null, lastErrorAt: null, lastErrorCategory: null })),
  notificationFailureCategories: [],
  verifySmtpProviderConnection: vi.fn(),
}));
vi.mock("@/server/imap-ingestion", () => ({
  getImapIngestionConfig: vi.fn(() => ({})),
  getImapIngestionWorkerHealth: vi.fn(() => ({ started: false, running: false, lastSuccessAt: null, lastErrorAt: null, lastErrorCode: null, preflightStatus: "not_configured" })),
  getImapProviderPreflightState: vi.fn(() => ({ status: "not_configured", smtp: "not_configured", imap: "not_configured", checkedAt: null })),
  verifyImapIngestionProviders: mocks.verify,
}));

import { setImapProviderVerificationDependenciesForTests, verifyImapIngestionProvider } from "./admin-operations";

describe("administrator mailbox provider verification bounds", () => {
  beforeEach(() => {
    mocks.now = 1_000;
    mocks.verify.mockReset();
    mocks.requireAdmin.mockClear();
    setImapProviderVerificationDependenciesForTests({ now: () => mocks.now, verify: mocks.verify });
  });

  afterEach(() => setImapProviderVerificationDependenciesForTests(undefined));

  it("deduplicates in-flight checks, throttles completed failures, and later recovers", async () => {
    let resolveFirst: ((value: string) => void) | undefined;
    mocks.verify.mockReturnValueOnce(new Promise<string>((resolve) => { resolveFirst = resolve; }));

    const first = verifyImapIngestionProvider("admin-user");
    await vi.waitFor(() => expect(mocks.verify).toHaveBeenCalledTimes(1));
    await expect(verifyImapIngestionProvider("admin-user")).resolves.toEqual({ result: "verification_pending" });
    resolveFirst?.("available");
    await expect(first).resolves.toEqual({ result: "available" });
    await expect(verifyImapIngestionProvider("admin-user")).resolves.toEqual({ result: "retrying" });
    expect(mocks.verify).toHaveBeenCalledTimes(1);

    mocks.now += 1_001;
    mocks.verify.mockResolvedValueOnce("provider_unavailable");
    await expect(verifyImapIngestionProvider("admin-user")).resolves.toEqual({ result: "provider_unavailable" });
    await expect(verifyImapIngestionProvider("admin-user")).resolves.toEqual({ result: "retrying" });
    expect(mocks.verify).toHaveBeenCalledTimes(2);

    mocks.now += 1_001;
    mocks.verify.mockResolvedValueOnce("available");
    await expect(verifyImapIngestionProvider("admin-user")).resolves.toEqual({ result: "available" });
    expect(mocks.verify).toHaveBeenCalledTimes(3);
  });
});
