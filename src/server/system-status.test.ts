import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * getSystemStatus assembles the drawer's per-service rows from checks the
 * instance already runs elsewhere, so each of those is mocked at its own
 * module boundary rather than reimplemented here -- same approach
 * availability-route.test.mjs and readiness.test.ts use for their own
 * collaborators (#863).
 */
const mocks = vi.hoisted(() => ({
  getPublicReadiness: vi.fn(),
  checkDatabaseReachable: vi.fn(),
  getBootPhase: vi.fn(),
  getMaintenanceWorkerHealth: vi.fn(),
  getDocumentConfig: vi.fn(),
  pingClamAv: vi.fn(),
  getTikaHealth: vi.fn(),
}));

vi.mock("@/server/readiness", () => ({
  getPublicReadiness: mocks.getPublicReadiness,
  checkDatabaseReachable: mocks.checkDatabaseReachable,
}));
vi.mock("@/server/boot", () => ({ getBootPhase: mocks.getBootPhase }));
vi.mock("@/server/maintenance-worker", () => ({ getMaintenanceWorkerHealth: mocks.getMaintenanceWorkerHealth }));
vi.mock("@/server/documents/config", () => ({ getDocumentConfig: mocks.getDocumentConfig }));
vi.mock("@/server/documents/scanner", () => ({ pingClamAv: mocks.pingClamAv }));
vi.mock("@/server/documents/tika", () => ({ getTikaHealth: mocks.getTikaHealth }));

import { getSystemStatus } from "./system-status";

const HEALTHY_CONFIG = {
  scanMode: "required" as const,
  clamAv: { host: "orbit-clamav", port: 3310, timeoutMs: 2_000 },
};

function resetAll() {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getPublicReadiness.mockResolvedValue({ status: "ready" });
  mocks.checkDatabaseReachable.mockResolvedValue(true);
  mocks.getBootPhase.mockReturnValue("running");
  mocks.getMaintenanceWorkerHealth.mockReturnValue({
    started: true,
    running: false,
    lastSuccessAt: "2026-09-12T09:59:48.000Z",
    lastErrorAt: null,
  });
  mocks.getDocumentConfig.mockReturnValue(HEALTHY_CONFIG);
  mocks.pingClamAv.mockResolvedValue(true);
  mocks.getTikaHealth.mockResolvedValue({ status: "ready" });
}

describe("getSystemStatus (#863)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports every dependency healthy and the handle following real readiness -- not always degraded", async () => {
    resetAll();

    const status = await getSystemStatus();

    expect(status.handle).toBe("ready");
    expect(status.lastCheck).toEqual({ scan: "ready", application: "ready" });
    expect(status.services.map((row) => [row.service, row.state])).toEqual([
      ["orbit-app", "healthy"],
      ["orbit-postgres", "healthy"],
      ["orbit-clamav", "healthy"],
      ["orbit-tika", "healthy"],
      ["scheduler", "healthy"],
    ]);
    // Live-probed rows carry the instant they were actually checked.
    for (const row of status.services) {
      if (row.service === "scheduler") continue;
      expect(() => new Date(row.observedAt as string).toISOString()).not.toThrow();
    }
    // The scheduler's timestamp is its own last real tick, not this request's clock.
    expect(status.services.find((row) => row.service === "scheduler")?.observedAt)
      .toBe("2026-09-12T09:59:48.000Z");
  });

  it("moves the postgres row and the handle together when the database is unreachable, independently of the scanner", async () => {
    resetAll();
    mocks.checkDatabaseReachable.mockResolvedValue(false);
    mocks.getPublicReadiness.mockResolvedValue({ status: "degraded" });

    const status = await getSystemStatus();

    expect(status.handle).toBe("degraded");
    expect(status.services.find((row) => row.service === "orbit-postgres")?.state).toBe("unreachable");
    // The scanner answered fine and says so, unaffected by the database fault.
    expect(status.services.find((row) => row.service === "orbit-clamav")?.state).toBe("healthy");
    expect(status.lastCheck.scan).toBe("ready");
  });

  it("reports the scanner unreachable and folds it into scan readiness, without a reason string anywhere in the answer", async () => {
    resetAll();
    mocks.pingClamAv.mockResolvedValue(false);

    const status = await getSystemStatus();

    expect(status.services.find((row) => row.service === "orbit-clamav")?.state).toBe("unreachable");
    expect(status.lastCheck.scan).toBe("failed");
    // The application stays ready: scanning is fail-closed for uploads, not for the app (boot.ts).
    expect(status.handle).toBe("ready");
    expect(status.lastCheck.application).toBe("ready");
    expect(JSON.stringify(status)).not.toMatch(/unreachable-scanner|scanner-unreachable|timeout|host|port/i);
  });

  it("reports the scanner disabled rather than unreachable when scanning is turned off", async () => {
    resetAll();
    mocks.getDocumentConfig.mockReturnValue({ scanMode: "disabled", clamAv: HEALTHY_CONFIG.clamAv });

    const status = await getSystemStatus();

    expect(status.services.find((row) => row.service === "orbit-clamav")).toEqual({
      service: "orbit-clamav",
      state: "not_enabled",
    });
    expect(status.lastCheck.scan).toBe("disabled");
    expect(mocks.pingClamAv).not.toHaveBeenCalled();
  });

  it("drops the clamav row and the scan-readiness word entirely when configuration cannot be read, rather than guessing", async () => {
    resetAll();
    mocks.getDocumentConfig.mockImplementation(() => { throw new Error("DOCUMENT_KEK missing"); });

    const status = await getSystemStatus();

    expect(status.services.some((row) => row.service === "orbit-clamav")).toBe(false);
    expect(status.lastCheck.scan).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("DOCUMENT_KEK");
  });

  it("reports tika not enabled when no parser URL is configured, and drops the row on failure rather than asserting", async () => {
    resetAll();
    mocks.getTikaHealth.mockResolvedValue({ status: "disabled" });
    let status = await getSystemStatus();
    expect(status.services.find((row) => row.service === "orbit-tika")).toEqual({
      service: "orbit-tika",
      state: "not_enabled",
    });

    mocks.getTikaHealth.mockRejectedValue(new Error("unexpected"));
    status = await getSystemStatus();
    expect(status.services.some((row) => row.service === "orbit-tika")).toBe(false);
  });

  it("reports the scheduler starting when it has not run its first tick yet, with no invented timestamp", async () => {
    resetAll();
    mocks.getMaintenanceWorkerHealth.mockReturnValue({
      started: true,
      running: false,
      lastSuccessAt: null,
      lastErrorAt: null,
    });

    const status = await getSystemStatus();

    expect(status.services.find((row) => row.service === "scheduler")).toEqual({
      service: "scheduler",
      state: "starting",
    });
  });

  it("reports the scheduler unreachable when its last event was a failure more recent than any success", async () => {
    resetAll();
    mocks.getMaintenanceWorkerHealth.mockReturnValue({
      started: true,
      running: false,
      lastSuccessAt: "2026-09-12T09:00:00.000Z",
      lastErrorAt: "2026-09-12T09:30:00.000Z",
    });

    const status = await getSystemStatus();

    expect(status.services.find((row) => row.service === "scheduler")).toEqual({
      service: "scheduler",
      state: "unreachable",
      observedAt: "2026-09-12T09:30:00.000Z",
    });
  });

  it("reports orbit-app starting rather than healthy before boot has finished", async () => {
    resetAll();
    mocks.getBootPhase.mockReturnValue("starting");

    const status = await getSystemStatus();

    expect(status.services.find((row) => row.service === "orbit-app")?.state).toBe("starting");
  });

  it("reports maintenance as its own handle word, matching /api/health's own contract", async () => {
    resetAll();
    mocks.getPublicReadiness.mockResolvedValue({ status: "maintenance" });

    const status = await getSystemStatus();

    expect(status.handle).toBe("maintenance");
    expect(status.lastCheck.application).toBe("maintenance");
  });
});
