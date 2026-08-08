import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  config: {
    scanMode: "required",
    clamAv: { host: "private-scanner.internal", port: 3310, timeoutMs: 30_000 },
  },
  getAuthConfig: vi.fn(),
  pingClamAv: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
  },
  registerNode: vi.fn(),
}));

vi.mock("@/server/documents/config", () => ({
  getDocumentConfig: () => mocks.config,
}));

vi.mock("@/server/documents/scanner", () => ({
  pingClamAv: mocks.pingClamAv,
}));

vi.mock("@/lib/env", () => ({
  getAuthConfig: mocks.getAuthConfig,
}));

vi.mock("@/lib/logger", () => ({
  log: mocks.log,
}));

import { resetAuthObservabilityForTests } from "@/lib/auth/observability";

describe("instrumentation runtime boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    resetAuthObservabilityForTests();
  });

  afterEach(() => {
    vi.doUnmock("./instrumentation-node");
    vi.resetModules();
    resetAuthObservabilityForTests();
    vi.unstubAllEnvs();
  });

  it("returns immediately without loading Node implementation when not in Node runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");

    vi.doMock("./instrumentation-node", () => ({
      registerNode: mocks.registerNode,
    }));

    const { register } = await import("./instrumentation");

    await register();

    expect(mocks.registerNode).not.toHaveBeenCalled();
  });

  it("loads and executes Node implementation when in Node runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");

    vi.doMock("./instrumentation-node", () => ({
      registerNode: mocks.registerNode,
    }));

    const { register } = await import("./instrumentation");

    await register();

    expect(mocks.registerNode).toHaveBeenCalledTimes(1);
  });

  it("keeps the Edge entry free of static imports", () => {
    const source = readFileSync(new URL("./instrumentation.ts", import.meta.url), "utf8");
    const staticImports = source.match(/^\s*import\s+(?!\()[^;]+;\s*$/gmu) ?? [];

    expect(staticImports).toEqual([]);
    expect(source).not.toContain("@/");
  });
});

describe("scanner readiness diagnostics", () => {
  let reportAuthConfigurationReadinessNode: () => Promise<void>;
  let reportScannerReadinessNode: () => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.config.scanMode = "required";
    resetAuthObservabilityForTests();
    vi.doUnmock("./instrumentation-node");
    vi.resetModules();

    const nodeModule = await import("./instrumentation-node");
    reportAuthConfigurationReadinessNode = nodeModule.reportAuthConfigurationReadiness;
    reportScannerReadinessNode = nodeModule.reportScannerReadiness;
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAuthObservabilityForTests();
  });

  it("reports ready authentication configuration without delaying startup", async () => {
    mocks.getAuthConfig.mockReturnValue({});

    await expect(reportAuthConfigurationReadinessNode()).resolves.toBeUndefined();

    expect(mocks.log.info).toHaveBeenCalledWith("auth.configuration", { state: "ready" });
    expect(mocks.log.info).toHaveBeenCalledTimes(1);
    expect(mocks.log.error).not.toHaveBeenCalled();
  });

  it("reports invalid authentication configuration without throwing or exposing validation details", async () => {
    const secret = "startup-client-secret-sentinel";
    mocks.getAuthConfig.mockImplementation(() => {
      throw new Error(`OIDC_CLIENT_SECRET ${secret} failed validation`);
    });

    await expect(reportAuthConfigurationReadinessNode()).resolves.toBeUndefined();

    expect(mocks.log.error).toHaveBeenCalledWith("auth.configuration", {
      state: "invalid",
      impact: "sign_in_blocked",
    });
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain(secret);
  });

  it("reports readiness without disclosing scanner connection details", async () => {
    mocks.pingClamAv.mockResolvedValue(true);

    await reportScannerReadinessNode();

    expect(mocks.log.info).toHaveBeenCalledWith("document.scanner", { state: "ready" });
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain(mocks.config.clamAv.host);
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain(String(mocks.config.clamAv.port));
  });

  it("reports a failed first ping as starting and temporarily blocks uploads", async () => {
    mocks.pingClamAv.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await reportScannerReadinessNode();

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

    await reportScannerReadinessNode();

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

    await reportScannerReadinessNode();

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

    await reportScannerReadinessNode();

    expect(mocks.pingClamAv).not.toHaveBeenCalled();
    expect(mocks.log.info).toHaveBeenCalledWith("document.scanner", {
      state: "disabled",
      reason: "scan_mode_disabled",
    });
  });
});
