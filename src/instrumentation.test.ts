import { beforeEach, describe, expect, it, vi } from "vitest";

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
    mocks.config.scanMode = "required";
  });

  it("reports readiness without disclosing scanner connection details", async () => {
    mocks.pingClamAv.mockResolvedValue(true);

    await reportScannerReadiness();

    expect(mocks.log.info).toHaveBeenCalledWith("document.scanner", { state: "ready" });
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain(mocks.config.clamAv.host);
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain(String(mocks.config.clamAv.port));
  });

  it("reports an unavailable scanner without disclosing scanner connection details", async () => {
    mocks.pingClamAv.mockResolvedValue(false);

    await reportScannerReadiness();

    expect(mocks.log.error).toHaveBeenCalledWith("document.scanner", {
      state: "unreachable",
      impact: "document_upload_blocked",
    });
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain(mocks.config.clamAv.host);
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain(String(mocks.config.clamAv.port));
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
