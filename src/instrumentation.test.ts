import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {
    scanMode: "required",
    clamAv: { host: "private-scanner.internal", port: 3310, timeoutMs: 30_000 },
  },
  pingClamAv: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/server/documents/config", () => ({
  getDocumentConfig: () => mocks.config,
}));

vi.mock("@/server/documents/scanner", () => ({
  pingClamAv: mocks.pingClamAv,
}));

vi.mock("@/lib/logger", () => ({
  log: mocks.log,
}));

import { reportScannerReadiness } from "./instrumentation";

describe("scanner readiness diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.config.scanMode = "required";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports readiness without disclosing scanner connection details", async () => {
    mocks.pingClamAv.mockResolvedValue(true);

    await reportScannerReadiness();

    expect(mocks.log.info).toHaveBeenCalledWith("document.scanner", { state: "ready" });
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain(mocks.config.clamAv.host);
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain(String(mocks.config.clamAv.port));
  });

  it("reports a failed first ping as starting and temporarily blocks uploads", async () => {
    mocks.pingClamAv.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await reportScannerReadiness();

    expect(mocks.log.info).toHaveBeenCalledWith("document.scanner", {
      state: "starting",
      impact: "document_upload_blocked",
    });
    expect(mocks.log.error).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.pingClamAv).toHaveBeenCalledTimes(2);
    expect(mocks.log.info).toHaveBeenCalledWith("document.scanner", { state: "ready" });
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain(mocks.config.clamAv.host);
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain(String(mocks.config.clamAv.port));
  });

  it("reports unreachable only after the bounded startup window is exhausted", async () => {
    mocks.pingClamAv.mockResolvedValue(false);

    await reportScannerReadiness();

    expect(mocks.log.info).toHaveBeenCalledWith("document.scanner", {
      state: "starting",
      impact: "document_upload_blocked",
    });

    await vi.advanceTimersByTimeAsync(180_000);

    expect(mocks.log.error).toHaveBeenCalledWith("document.scanner", {
      state: "unreachable",
      impact: "document_upload_blocked",
    });
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain(mocks.config.clamAv.host);
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain(String(mocks.config.clamAv.port));
  });

  it("treats a thrown ping as a temporary startup failure", async () => {
    mocks.pingClamAv.mockRejectedValueOnce(new Error("private scanner details")).mockResolvedValueOnce(true);

    await reportScannerReadiness();

    expect(mocks.log.info).toHaveBeenCalledWith("document.scanner", {
      state: "starting",
      impact: "document_upload_blocked",
    });
    expect(mocks.log.error).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.log.info).toHaveBeenCalledWith("document.scanner", { state: "ready" });
  });

  it("does not probe a scanner when scanning is disabled", async () => {
    mocks.config.scanMode = "disabled";

    await reportScannerReadiness();

    expect(mocks.pingClamAv).not.toHaveBeenCalled();
    expect(mocks.log.info).toHaveBeenCalledWith("document.scanner", {
      state: "disabled",
      reason: "scan_mode_disabled",
    });
  });
});
