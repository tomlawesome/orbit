import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkDatabaseReachable: vi.fn(),
  getNotificationWorkerHealth: vi.fn(),
  getImapIngestionConfig: vi.fn(),
  getImapIngestionWorkerHealth: vi.fn(),
  getDocumentConfig: vi.fn(),
  readClamAvVersion: vi.fn(),
  getTikaHealth: vi.fn(),
}));

vi.mock("@/server/readiness", () => ({ checkDatabaseReachable: mocks.checkDatabaseReachable }));
vi.mock("@/server/notification-worker", () => ({ getNotificationWorkerHealth: mocks.getNotificationWorkerHealth }));
vi.mock("@/server/mail-in/imap-ingestion", () => ({
  getImapIngestionConfig: mocks.getImapIngestionConfig,
  getImapIngestionWorkerHealth: mocks.getImapIngestionWorkerHealth,
}));
vi.mock("@/server/documents/config", () => ({ getDocumentConfig: mocks.getDocumentConfig }));
vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/documents/scanner")>()),
  readClamAvVersion: mocks.readClamAvVersion,
}));
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
    mocks.readClamAvVersion.mockResolvedValue(null);
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
    expect(mocks.readClamAvVersion).not.toHaveBeenCalled();
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

  describe("virus scanner signature age (#1296)", () => {
    const NOW = new Date("2026-10-07T12:00:00.000Z");

    async function scannerRow(versionReply: string | null) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      try {
        mocks.checkDatabaseReachable.mockResolvedValue(true);
        mocks.getNotificationWorkerHealth.mockReturnValue({ started: true, running: false, lastSuccessAt: null, lastErrorAt: null });
        mocks.getImapIngestionConfig.mockResolvedValue({ configured: false, enabled: false });
        mocks.getImapIngestionWorkerHealth.mockReturnValue({ started: false, running: false, lastSuccessAt: null, lastErrorAt: null });
        mocks.getDocumentConfig.mockReturnValue({ ...REQUIRED_DOCUMENT_CONFIG, tika: { url: null, timeoutMs: 45_000 } });
        mocks.readClamAvVersion.mockResolvedValue(versionReply);
        const health = await getAdministratorHealth();
        return health.services.find((service) => service.id === "virus-scanner");
      } finally {
        vi.useRealTimers();
      }
    }

    it("is ok, with the signature date, when the signatures are fresh", async () => {
      const row = await scannerRow("ClamAV 1.5.4/28146/Wed Oct  7 06:24:18 2026");
      expect(row?.state).toBe("ok");
      expect(row?.signaturesAt).toBe("2026-10-07T06:24:18.000Z");
    });

    it("stays ok just inside the seven-day limit", async () => {
      // 2026-09-30T12:00:01Z is 6 days 23:59:59 before NOW.
      const row = await scannerRow("ClamAV 1.5.4/28140/Wed Sep 30 12:00:01 2026");
      expect(row?.state).toBe("ok");
    });

    it("warns, with the signature date, when the signatures are older than seven days", async () => {
      const row = await scannerRow("ClamAV 1.5.4/28137/Mon Sep 28 06:24:12 2026");
      expect(row?.state).toBe("warn");
      expect(row?.signaturesAt).toBe("2026-09-28T06:24:12.000Z");
    });

    it("warns, with no date, when clamd answers but the reply carries no readable date", async () => {
      for (const reply of ["ClamAV 1.5.4", "", "ClamAV 1.5.4/28137/not a date", "unexpected"]) {
        const row = await scannerRow(reply);
        expect(row?.state, reply).toBe("warn");
        expect(row?.signaturesAt ?? null, reply).toBeNull();
      }
    });

    it("is down, not warn, when clamd cannot be reached at all", async () => {
      const row = await scannerRow(null);
      expect(row?.state).toBe("down");
      expect(row?.signaturesAt ?? null).toBeNull();
    });
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
