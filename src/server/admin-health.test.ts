import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkDatabaseReachable: vi.fn(),
  getNotificationWorkerHealth: vi.fn(),
  getImapIngestionConfig: vi.fn(),
  getImapIngestionWorkerHealth: vi.fn(),
  getDocumentConfig: vi.fn(),
  pingClamAv: vi.fn(),
  getTikaHealth: vi.fn(),
}));

vi.mock("@/server/readiness", () => ({ checkDatabaseReachable: mocks.checkDatabaseReachable }));
vi.mock("@/server/notification-worker", () => ({ getNotificationWorkerHealth: mocks.getNotificationWorkerHealth }));
vi.mock("@/server/mail-in/imap-ingestion", () => ({
  getImapIngestionConfig: mocks.getImapIngestionConfig,
  getImapIngestionWorkerHealth: mocks.getImapIngestionWorkerHealth,
}));
vi.mock("@/server/documents/config", () => ({ getDocumentConfig: mocks.getDocumentConfig }));
vi.mock("@/server/documents/scanner", () => ({ pingClamAv: mocks.pingClamAv }));
vi.mock("@/server/documents/tika", () => ({ getTikaHealth: mocks.getTikaHealth }));

import { getAdministratorHealth } from "./admin-health";

const REQUIRED_DOCUMENT_CONFIG = {
  scanMode: "required" as const,
  clamAv: { host: "orbit-clamav", port: 3310, timeoutMs: 30_000 },
  tika: { url: new URL("http://orbit-tika:9998"), timeoutMs: 45_000 },
};

const originalEnv = { ...process.env };

describe("getAdministratorHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ORBIT_VERSION = "1.3.0";
    process.env.ORBIT_CHANNEL = "preview";
    process.env.ORBIT_REVISION = "fd6a7e6abc1234";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("reports every sidecar down without throwing, never a fault mid-request", async () => {
    mocks.checkDatabaseReachable.mockResolvedValue(false);
    mocks.getNotificationWorkerHealth.mockReturnValue({ started: false, running: false, lastSuccessAt: null, lastErrorAt: null });
    mocks.getImapIngestionConfig.mockResolvedValue({ configured: true, enabled: true });
    mocks.getImapIngestionWorkerHealth.mockReturnValue({ started: false, running: false, lastSuccessAt: null, lastErrorAt: null });
    mocks.getDocumentConfig.mockReturnValue(REQUIRED_DOCUMENT_CONFIG);
    mocks.pingClamAv.mockResolvedValue(false);
    mocks.getTikaHealth.mockResolvedValue({ status: "unavailable" });

    const health = await getAdministratorHealth();

    expect(health.services).toHaveLength(5);
    expect(health.services.map((service) => service.state)).toEqual(["down", "down", "down", "down", "down"]);
    expect(health.services.map((service) => service.id)).toEqual([
      "database",
      "notification-worker",
      "mailbox-ingestion",
      "virus-scanner",
      "document-parser",
    ]);
  });

  it("reports the scanner and parser off when document processing is disabled", async () => {
    mocks.checkDatabaseReachable.mockResolvedValue(true);
    mocks.getNotificationWorkerHealth.mockReturnValue({ started: true, running: false, lastSuccessAt: "2026-09-14T00:00:00.000Z", lastErrorAt: null });
    mocks.getImapIngestionConfig.mockResolvedValue({ configured: false, enabled: false });
    mocks.getImapIngestionWorkerHealth.mockReturnValue({ started: false, running: false, lastSuccessAt: null, lastErrorAt: null });
    mocks.getDocumentConfig.mockReturnValue({ ...REQUIRED_DOCUMENT_CONFIG, scanMode: "disabled", tika: { url: null, timeoutMs: 45_000 } });

    const health = await getAdministratorHealth();

    const byId = Object.fromEntries(health.services.map((service) => [service.id, service.state]));
    expect(byId["virus-scanner"]).toBe("off");
    expect(byId["document-parser"]).toBe("off");
    expect(byId["mailbox-ingestion"]).toBe("off");
    expect(mocks.pingClamAv).not.toHaveBeenCalled();
    expect(mocks.getTikaHealth).not.toHaveBeenCalled();
  });

  it("reports null build fields when the release environment is unset", async () => {
    delete process.env.ORBIT_VERSION;
    delete process.env.ORBIT_CHANNEL;
    delete process.env.ORBIT_REVISION;
    mocks.checkDatabaseReachable.mockResolvedValue(true);
    mocks.getNotificationWorkerHealth.mockReturnValue({ started: true, running: false, lastSuccessAt: null, lastErrorAt: null });
    mocks.getImapIngestionConfig.mockResolvedValue({ configured: false, enabled: false });
    mocks.getImapIngestionWorkerHealth.mockReturnValue({ started: false, running: false, lastSuccessAt: null, lastErrorAt: null });
    mocks.getDocumentConfig.mockReturnValue({ ...REQUIRED_DOCUMENT_CONFIG, scanMode: "disabled", tika: { url: null, timeoutMs: 45_000 } });

    const health = await getAdministratorHealth();

    expect(health.build).toEqual({ version: null, channel: null, revision: null });
  });

  it("never throws even when a probe rejects", async () => {
    mocks.checkDatabaseReachable.mockRejectedValue(new Error("synthetic-db-error"));
    mocks.getNotificationWorkerHealth.mockReturnValue({ started: false, running: false, lastSuccessAt: null, lastErrorAt: null });
    mocks.getImapIngestionConfig.mockRejectedValue(new Error("synthetic-credential-locked"));
    mocks.getImapIngestionWorkerHealth.mockReturnValue({ started: false, running: false, lastSuccessAt: null, lastErrorAt: null });
    mocks.getDocumentConfig.mockImplementation(() => {
      throw new Error("synthetic-missing-kek");
    });

    await expect(getAdministratorHealth()).resolves.toBeTruthy();
  });
});
